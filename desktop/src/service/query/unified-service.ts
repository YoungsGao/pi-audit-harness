import { isAbsolute } from 'node:path'
import { ApiError } from '../../shared/api-error.ts'
import type {
  QueryRequest,
  QueryResult,
  QueryOperation,
  QueryStatus
} from '../../shared/query-contracts.ts'
import type { SourceRepository } from '../sources/repository.ts'
import { defaultLanguages } from './language-registry.ts'
import type { QueryRuntimeProvider } from './language-registry.ts'
import { JavaRuntimePool } from './java-runtime.ts'
import type { QuerySnapshot, RuntimeOptions } from './java-runtime.ts'
import { semanticJava } from './semantic-java.ts'
import { toLspPosition } from './positions.ts'
import type { JavaMethod, JavaCall } from '../scanning/java-index.ts'
import type { ScanWarning } from '../../shared/scan-contracts.ts'
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
  if (
    row.filePath !== undefined &&
    (typeof row.filePath !== 'string' ||
      row.filePath.length > 1000 ||
      row.filePath.includes('\\') ||
      [...row.filePath].some((c) => c.charCodeAt(0) < 32) ||
      isAbsolute(row.filePath) ||
      row.filePath.split('/').some((p) => !p || p === '.' || p === '..'))
  )
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
  readonly languages = defaultLanguages()
  private readonly pool: JavaRuntimePool
  readonly backends = new Map<string, QueryRuntimeProvider>()
  private readonly repo: SourceRepository
  constructor(repo: SourceRepository, options: RuntimeOptions = {}) {
    this.repo = repo
    this.pool = new JavaRuntimePool(options)
    this.backends.set('java-jdtls', this.pool)
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
    const provider = adapter ? this.backends.get(adapter.backend) : undefined
    if (!adapter || !provider)
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
    // 每次访问仍验证 SQLite 原文摘要；不拿已启动 LSP 的缓存替代证据校验。
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
      toLspPosition(file.source, { line: request.line, column: request.column ?? 1 }, 'utf-16')
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
    let runtime
    try {
      runtime = provider.get(snapshot)
    } catch (error) {
      return {
        ...result,
        status: 'not-ready',
        errorCode: error instanceof ApiError ? error.code : 'QUERY_RUNTIME_BUSY',
        gaps: ['QUERY_RUNTIME_CAPACITY']
      }
    }
    if (request.operation === 'capabilities' || request.operation === 'status')
      return {
        ...result,
        runtime: runtime.status(),
        capabilities: this.languages.list().map((a) => ({
          language: a.language,
          operations: [...a.operations],
          semantic: this.backends.has(a.backend)
        }))
      }
    try {
      const output = await runtime.use(async (active) => {
        if (request.operation === 'prepare') return { items: [], gaps: active.sourceGaps }
        if (!active.state.capabilities.includes(request.operation))
          throw new ApiError('QUERY_UNSUPPORTED', '语言服务器未声明此能力', 501)
        return adapter.query(active, request, signal)
      }, signal)
      return this.bounded(
        { ...result, backend: adapter.backendLabel, ...output, runtime: runtime.status() },
        request
      )
    } catch (error) {
      const code =
        deadline.aborted && !originalSignal.aborted
          ? 'QUERY_TIMEOUT'
          : error instanceof ApiError
            ? error.code
            : 'QUERY_BACKEND_ERROR'
      const status: QueryStatus =
        code === 'QUERY_TIMEOUT'
          ? 'timeout'
          : code === 'QUERY_CANCELLED'
            ? 'cancelled'
            : code === 'QUERY_UNSUPPORTED'
              ? 'unsupported'
              : ['QUERY_RUNTIME_MISSING', 'QUERY_RUNTIME_EXITED'].includes(code)
                ? 'not-ready'
                : 'failed'
      if (
        request.fallback !== false &&
        !['prepare', 'status', 'capabilities'].includes(request.operation) &&
        status !== 'cancelled' &&
        adapter.basic
      ) {
        const basic = adapter.basic(snapshot, request)
        return this.bounded(
          {
            ...result,
            ...basic,
            backend: 'basic',
            status: 'partial',
            errorCode: code,
            gaps: [code, 'BASIC_CANDIDATES_NOT_SEMANTIC', ...basic.gaps],
            runtime: runtime.status()
          },
          request
        )
      }
      return { ...result, status, errorCode: code, runtime: runtime.status(), gaps: [code] }
    }
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
    const add = (code: string, message: string): void => {
      if (!warnings.some((w) => w.code === code)) warnings.push({ code, filePath: null, message })
    }
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(90000)])
    try {
      await this.pool.get(snapshot).use(async (runtime) => {
        if (!runtime.state.capabilities.includes('definition'))
          throw new ApiError('QUERY_UNSUPPORTED', '定义能力不可用', 501)
        for (const call of calls.slice(0, 64)) {
          if (bounded.aborted)
            throw new ApiError(
              signal.aborted ? 'QUERY_CANCELLED' : 'QUERY_TIMEOUT',
              '语义预处理达到时间预算',
              504
            )
          const output = await semanticJava(
            runtime,
            {
              operation: 'definition',
              language: 'java',
              projectId,
              runId,
              filePath: call.filePath,
              line: call.line,
              column: call.column,
              maxResults: 4,
              fallback: false
            },
            bounded
          )
          for (const gap of output.gaps)
            add(gap, '语义查询只覆盖固定 Java 源文件；外部依赖、动态分派和未解析关系仍需人工核查。')
          const targets = output.items.flatMap((item) => {
            const file = snapshot.files.find((f) => f.filePath === item.location.filePath)!
            const lines = file.source.split('\n')
            const offset =
              lines
                .slice(0, item.location.start.line - 1)
                .reduce((n, line) => n + line.length + 1, 0) +
              item.location.start.column -
              1
            return methods.filter(
              (m) =>
                m.filePath === item.location.filePath &&
                m.name === call.name &&
                m.start <= offset &&
                m.end >= offset
            )
          })
          const unique = [...new Set(targets)]
          if (
            unique.length === 1 &&
            !output.gaps.some((gap) =>
              ['EXTERNAL_LOCATION_OMITTED', 'QUERY_RESULT_LIMIT'].includes(gap)
            )
          ) {
            call.target = unique[0]
            call.semantic = true
          } else if (output.items.length) {
            call.target = null
            add('SEMANTIC_TARGET_OUTSIDE_INDEX', '语义定义不能映射到当前受控方法索引，保留未知。')
          }
          // 未取得语义定义时，原 CST 关系仍是 candidate，不能提升成 confirmed。
        }
        if (calls.length > 64)
          add(
            'SEMANTIC_CALL_LIMIT',
            '最多核查 64 个调用，其余保留 CST 候选；未覆盖部分不表示安全。'
          )
      }, bounded)
    } catch (error) {
      if (signal.aborted) throw new ApiError('QUERY_CANCELLED', '语义预处理已取消', 499)
      add(
        bounded.aborted && !signal.aborted
          ? 'QUERY_TIMEOUT'
          : error instanceof ApiError
            ? error.code
            : 'QUERY_BACKEND_ERROR',
        'Java 语义查询未完成，已保留基础候选图和覆盖缺口；不能据此判定安全。'
      )
    }
    return warnings
  }
  async close(): Promise<void> {
    await Promise.allSettled(
      [...new Set(this.backends.values())].map((provider) => provider.close())
    )
  }
}
