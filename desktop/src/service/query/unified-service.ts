import { ApiError } from '../../shared/api-error.ts'
import type { QueryRequest, QueryResult, QueryOperation } from '../../shared/query-contracts.ts'
import type { SourceRepository } from '../sources/repository.ts'
import { defaultLanguages } from './language-registry.ts'
import type { QuerySnapshot, RuntimeOptions } from './query-runtime.ts'
import { encodePosition } from './positions.ts'
import type { JavaMethod, JavaCall } from '../scanning/java-index.ts'
import type { ScanWarning } from '../../shared/scan-contracts.ts'
import { CodeGraphEngine } from './codegraph-engine.ts'
import { basicQuery } from './basic-adapter.ts'
import type { QueryEngine, QueryBackend } from './graph-contracts.ts'
import { GRAPH_ADAPTER } from './graph-contracts.ts'
import { graphHash } from '../storage/graph-repository.ts'
import { isSnapshotPath } from '../../shared/snapshot-path.ts'
const operations: QueryOperation[] = [
  'capabilities',
  'status',
  'prepare',
  'read',
  'search',
  'symbols',
  'definition',
  'references',
  'incomingCalls',
  'outgoingCalls'
]
export function validateQuery(value: unknown): QueryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError('QUERY_INVALID_INPUT', '查询必须为对象', 400)
  const row = value as Record<string, unknown>,
    operation = row.operation as QueryOperation
  const fields = [
    'operation',
    'language',
    'projectId',
    'runId',
    'maxResults',
    'fallback',
    ...(operation === 'search' ? ['text'] : []),
    ...(['read', 'symbols', 'definition', 'references', 'incomingCalls', 'outgoingCalls'].includes(
      operation
    )
      ? ['filePath']
      : []),
    ...(['definition', 'references', 'incomingCalls', 'outgoingCalls'].includes(operation)
      ? ['line', 'column']
      : []),
    ...(operation === 'read' ? ['line', 'endLine'] : [])
  ]
  if (!operations.includes(operation) || Object.keys(row).some((k) => !fields.includes(k)))
    throw new ApiError('QUERY_INVALID_INPUT', '操作或查询字段无效', 400)
  for (const key of ['projectId', 'runId', 'language'])
    if (typeof row[key] !== 'string' || !/^[\w-]{1,80}$/.test(row[key] as string))
      throw new ApiError('QUERY_INVALID_INPUT', '查询范围或语言无效', 400)
  if (row.filePath !== undefined && !isSnapshotPath(row.filePath))
    throw new ApiError('QUERY_INVALID_INPUT', '查询文件必须为快照内相对路径', 400)
  for (const key of ['line', 'column', 'endLine', 'maxResults'])
    if (
      row[key] !== undefined &&
      (!Number.isInteger(row[key]) ||
        Number(row[key]) < 1 ||
        Number(row[key]) > (key === 'maxResults' ? 100 : 1000000))
    )
      throw new ApiError('QUERY_INVALID_INPUT', '位置或结果上限无效', 400)
  if (row.fallback !== undefined && typeof row.fallback !== 'boolean')
    throw new ApiError('QUERY_INVALID_INPUT', 'fallback 必须为布尔值', 400)
  if (
    operation === 'search' &&
    (typeof row.text !== 'string' ||
      !row.text.trim() ||
      row.text.length > 200 ||
      [...row.text].some((c) => c.charCodeAt(0) < 32))
  )
    throw new ApiError('QUERY_INVALID_INPUT', '搜索文本无效', 400)
  if (
    ['read', 'symbols', 'definition', 'references', 'incomingCalls', 'outgoingCalls'].includes(
      operation
    ) &&
    row.filePath === undefined
  )
    throw new ApiError('QUERY_INVALID_INPUT', '操作需要 filePath', 400)
  if (
    ['definition', 'references', 'incomingCalls', 'outgoingCalls'].includes(operation) &&
    (row.line === undefined || row.column === undefined)
  )
    throw new ApiError('QUERY_INVALID_INPUT', '操作需要行列', 400)
  if (
    operation === 'read' &&
    (row.line === undefined ||
      row.endLine === undefined ||
      Number(row.endLine) < Number(row.line) ||
      Number(row.endLine) - Number(row.line) >= 80)
  )
    throw new ApiError('QUERY_INVALID_INPUT', '读取范围必须为 1 到 80 行', 400)
  return row as unknown as QueryRequest
}
export class UnifiedQueryService {
  readonly languages: ReturnType<typeof defaultLanguages>
  private readonly engine?: QueryEngine
  readonly backend: QueryBackend
  readonly backends = new Map<string, QueryEngine>()
  private readonly repo: SourceRepository
  constructor(repo: SourceRepository, options: RuntimeOptions = {}) {
    this.repo = repo
    const backend = options.backend ?? process.env.PI_AUDIT_QUERY_BACKEND ?? 'codegraph'
    if (!['codegraph', 'basic'].includes(backend))
      throw new ApiError('QUERY_BACKEND_INVALID', '查询后端配置无效', 503)
    this.backend = backend as QueryBackend
    this.languages = defaultLanguages(this.backend)
    if (backend === 'codegraph')
      this.engine = new CodeGraphEngine(options, options.dataRoot ?? repo.dataRoot, repo.graphs)
    else
      this.engine = {
        backend: 'basic',
        semantic: false,
        status: () => ({
          state: 'ready',
          index: 'quiescent',
          starts: 0,
          pending: 0,
          errorCode: null,
          wholeWorkspaceIndexed: false,
          positionEncoding: 'utf-16',
          capabilities: ['symbols', 'definition', 'references', 'incomingCalls', 'outgoingCalls']
        }),
        query: async (snapshot, request) => ({
          ...basicQuery(snapshot, request),
          gaps: ['BASIC_CANDIDATES_NOT_SEMANTIC']
        }),
        close: async () => {}
      }
    this.backends.set('java-' + backend, this.engine)
  }
  async execute(value: unknown, signal: AbortSignal): Promise<QueryResult> {
    const originalSignal = signal
    const deadline = AbortSignal.timeout(90000)
    signal = AbortSignal.any([signal, deadline])
    const request = validateQuery(value)
    if (!this.repo.get(request.projectId))
      throw new ApiError('SOURCE_NOT_FOUND', '源码项目不存在', 404)
    const info = this.repo.snapshots.info(request.projectId, request.runId)
    const result: QueryResult = {
      contractVersion: 1,
      operation: request.operation,
      status: 'ok',
      language: request.language,
      backend: 'none',
      projectId: request.projectId,
      runId: request.runId,
      snapshotId: info.snapshotId,
      sourceStamp: info.sourceStamp,
      positionEncoding: 'utf-16',
      items: [],
      truncated: false,
      gaps: [],
      runtime: null,
      errorCode: null
    }
    const adapter = this.languages.get(request.language)
    const engine = adapter ? this.backends.get(adapter.backend) : undefined
    if (!adapter || !engine)
      return {
        ...result,
        status: 'unsupported',
        errorCode: 'QUERY_LANGUAGE_UNSUPPORTED',
        gaps: ['仅交付 Java，语言注册不代表跨语言传播']
      }
    if (!adapter.operations.includes(request.operation))
      return {
        ...result,
        status: 'unsupported',
        errorCode: 'QUERY_UNSUPPORTED',
        gaps: ['LANGUAGE_OPERATION_UNSUPPORTED']
      }
    if (signal.aborted) return { ...result, status: 'cancelled', errorCode: 'QUERY_CANCELLED' }
    // 每次访问仍验证SQLite原文摘要；图缓存不代替原文校验。
    const snapshot: QuerySnapshot = {
      projectId: request.projectId,
      runId: request.runId,
      snapshotId: info.snapshotId,
      sourceStamp: info.sourceStamp,
      files: info.files.map((f) => ({
        filePath: f.filePath,
        source: this.repo.snapshots.read(request.projectId, request.runId, f.filePath)
      }))
    }
    const file = snapshot.files.find((f) => f.filePath === request.filePath)
    if (request.filePath && !file)
      throw new ApiError('QUERY_FILE_OUT_OF_SCOPE', '文件不在任务快照范围', 403)
    if (request.line && file)
      encodePosition(file.source, { line: request.line, column: request.column ?? 1 }, 'utf-16')
    if (request.operation === 'read') {
      const lines = file!.source.split('\n')
      if (request.endLine! > lines.length)
        throw new ApiError('QUERY_INVALID_POSITION', '读取行号越界', 400)
      const text = lines.slice(request.line! - 1, request.endLine).join('\n')
      if (text.length > 12000) throw new ApiError('QUERY_OUTPUT_LIMIT', '片段超过 12000 字符', 413)
      return {
        ...result,
        backend: 'basic',
        items: [
          {
            location: {
              filePath: request.filePath!,
              start: { line: request.line!, column: 1 },
              end: {
                line: request.endLine!,
                column: lines[request.endLine! - 1].replace(/\r$/, '').length + 1
              }
            },
            symbol: null,
            text,
            resolution: 'source'
          }
        ]
      }
    }
    if (request.operation === 'search') {
      if (!adapter.basic)
        return { ...result, status: 'unsupported', errorCode: 'QUERY_UNSUPPORTED' }
      const basic = adapter.basic(snapshot, request)
      return this.bounded({ ...result, backend: 'basic', ...basic }, request)
    }
    const fixedGraph = this.repo.graphs.get(request.projectId, request.runId)
    if (fixedGraph && fixedGraph.backend !== 'basic' && fixedGraph.backend !== this.backend)
      return {
        ...result,
        status: 'failed',
        errorCode: 'RUN_GRAPH_BACKEND_CHANGED',
        gaps: ['RUN_GRAPH_BACKEND_CHANGED']
      }
    if (engine) {
      const fixed = this.repo.graphs.get(request.projectId, request.runId)
      if (fixed?.backend === 'basic') {
        if (['status', 'capabilities'].includes(request.operation))
          return {
            ...result,
            runtime: { ...engine.status(snapshot), state: 'ready', starts: 0 },
            capabilities: [{ language: 'java', operations, semantic: false }]
          }
        const output =
          request.operation === 'prepare' ? { items: [], gaps: [] } : basicQuery(snapshot, request)
        return this.bounded(
          {
            ...result,
            ...output,
            backend: 'basic',
            gaps: [...new Set([...fixed.gaps, ...output.gaps])],
            runtime: engine.status(snapshot)
          },
          request
        )
      }
      const runtime = engine.status(snapshot)
      if (['capabilities', 'status'].includes(request.operation))
        return {
          ...result,
          runtime,
          capabilities: this.languages.list().map((a) => ({
            language: a.language,
            operations: [...a.operations],
            semantic: a.backend === adapter.backend ? engine.semantic : false
          }))
        }
      try {
        const output = await engine.query(snapshot, request, signal)
        return this.bounded(
          { ...result, backend: engine.backend, ...output, runtime: engine.status(snapshot) },
          request
        )
      } catch (error) {
        const code = signal.aborted
          ? originalSignal.aborted
            ? 'QUERY_CANCELLED'
            : 'QUERY_TIMEOUT'
          : error instanceof ApiError
            ? error.code
            : 'QUERY_BACKEND_ERROR'
        if (
          request.fallback !== false &&
          request.operation !== 'prepare' &&
          !['QUERY_CANCELLED', 'RUN_GRAPH_CHANGED', 'RUN_GRAPH_CORRUPT'].includes(code) &&
          adapter.basic
        ) {
          const output = adapter.basic(snapshot, request)
          return this.bounded(
            {
              ...result,
              ...output,
              backend: 'basic',
              status: 'partial',
              errorCode: code,
              gaps: [code, 'BASIC_CANDIDATES_NOT_SEMANTIC', ...output.gaps],
              runtime: engine.status(snapshot)
            },
            request
          )
        }
        return {
          ...result,
          status:
            code === 'QUERY_CANCELLED'
              ? 'cancelled'
              : code === 'QUERY_TIMEOUT'
                ? 'timeout'
                : code === 'QUERY_UNSUPPORTED'
                  ? 'unsupported'
                  : code === 'QUERY_RUNTIME_BUSY'
                    ? 'not-ready'
                    : 'failed',
          errorCode: code,
          gaps: [code],
          runtime: engine.status(snapshot)
        }
      }
    }
    throw new ApiError('QUERY_BACKEND_INVALID', '查询引擎不可用', 503)
  }
  private bounded(result: QueryResult, request: QueryRequest): QueryResult {
    if (result.gaps.includes('QUERY_RESULT_LIMIT') || result.gaps.includes('HIERARCHY_ROOT_LIMIT'))
      result.truncated = true
    const max = request.maxResults ?? 50
    let bytes = 0
    const items: QueryResult['items'] = []
    for (const item of result.items) {
      bytes += Buffer.byteLength(JSON.stringify(item))
      if (items.length >= max || bytes > 192 * 1024) {
        result.truncated = true
        break
      }
      items.push(item)
    }
    result.items = items
    result.gaps = [
      ...new Set([...result.gaps, ...(result.truncated ? ['QUERY_RESULT_LIMIT'] : [])])
    ].slice(0, 50)
    if (result.gaps.length) result.status = 'partial'
    else if (!items.length && request.operation !== 'prepare') result.status = 'no-match'
    return result
  }
  restoreCalls(projectId: string, runId: string, methods: JavaMethod[], calls: JavaCall[]): void {
    const binding = this.repo.graphs.get(projectId, runId)
    if (!binding || binding.backend === 'basic') return
    if (!binding.facts) throw new ApiError('RUN_GRAPH_CORRUPT', '任务缺少已固定的调用定位事实', 409)
    const targets = new Map(methods.map((method) => [method.key, method]))
    const facts = new Map(
      binding.facts.map((fact) => [JSON.stringify([fact.filePath, fact.line, fact.column]), fact])
    )
    for (const call of calls) {
      const fact = facts.get(JSON.stringify([call.filePath, call.line, call.column]))
      if (!fact) throw new ApiError('RUN_GRAPH_CHANGED', '调用位置与任务固定图不一致', 409)
      call.semantic = false
      if (fact.targets.length > 1) {
        call.target = null
        continue
      }
      if (fact.targets.length === 1) {
        const target = targets.get(fact.targets[0])
        if (!target) throw new ApiError('RUN_GRAPH_CHANGED', '固定调用目标无法映射到快照声明', 409)
        if (!call.target || call.target.key === target.key) call.target = target
      }
    }
  }
  async resolveCalls(
    projectId: string,
    runId: string,
    methods: JavaMethod[],
    calls: JavaCall[],
    signal: AbortSignal
  ): Promise<ScanWarning[]> {
    const info = this.repo.snapshots.info(projectId, runId)
    const snapshot: QuerySnapshot = {
      projectId,
      runId,
      snapshotId: info.snapshotId,
      sourceStamp: info.sourceStamp,
      files: info.files.map((f) => ({
        filePath: f.filePath,
        source: this.repo.snapshots.read(projectId, runId, f.filePath)
      }))
    }
    const warnings: ScanWarning[] = []
    if (this.engine instanceof CodeGraphEngine) {
      try {
        const gaps = await this.engine.resolveCalls(snapshot, methods, calls, signal)
        return gaps.map((code) => ({
          code,
          filePath: null,
          message: 'CodeGraph结构关系与快照核验；结构推断不等于Java类型绑定或漏洞证明。'
        }))
      } catch (error) {
        if (signal.aborted) throw new ApiError('QUERY_CANCELLED', '构图已取消', 499)
        const code = error instanceof ApiError ? error.code : 'QUERY_GRAPH_BUILD_FAILED'
        if (/^(DB_|RUN_GRAPH_)/.test(code)) throw error
        this.repo.graphs.save(projectId, runId, {
          version: 1,
          backend: 'basic',
          engine: 'basic/java-parser/3.0.1',
          adapter: GRAPH_ADAPTER,
          graphKey: graphHash([projectId, info.snapshotId, 'basic']),
          graphDigest: graphHash(calls.map((c) => [c.filePath, c.start, c.target?.key ?? null])),
          gaps: [code, 'BASIC_CANDIDATES_NOT_SEMANTIC']
        })
        return [
          { code, filePath: null, message: 'CodeGraph未完成，已固定基础候选模式；未自动启动Java。' }
        ]
      }
    }
    if (this.backend === 'basic') {
      this.repo.graphs.save(projectId, runId, {
        version: 1,
        backend: 'basic',
        engine: 'basic/java-parser/3.0.1',
        adapter: GRAPH_ADAPTER,
        graphKey: graphHash([projectId, info.snapshotId, 'basic']),
        graphDigest: graphHash(calls.map((c) => [c.filePath, c.start, c.target?.key ?? null])),
        gaps: ['BASIC_CANDIDATES_NOT_SEMANTIC']
      })
      return [
        {
          code: 'BASIC_CANDIDATES_NOT_SEMANTIC',
          filePath: null,
          message: '已显式选择基础候选后端。'
        }
      ]
    }
    return warnings
  }
  async close(): Promise<void> {
    await Promise.allSettled([...new Set(this.backends.values())].map((engine) => engine.close()))
  }
}
