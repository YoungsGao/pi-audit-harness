import { randomUUID } from 'node:crypto'
import { ApiError } from '../../shared/api-error.ts'
import type { CodeQueryService } from '../query/service.ts'
import { queryInput, queryText, queryInteger } from '../query/service.ts'
import { CallChainRepository } from '../storage/call-chain-repository.ts'
import { preprocessJava } from '../scanning/preprocess.ts'
import { builtinRules } from '../rules/builtin.ts'
import type { AuditAction, PreparedScan } from '../../shared/scan-contracts'
import type { PathAnalysisService } from './path-analysis.ts'
import { validateAnalyze } from '../../shared/sse-contracts.ts'
import type { AnalyzeRequest, StreamFrame } from '../../shared/sse-contracts.ts'
import { retryWrite } from '../storage/retry-write.ts'

export type ChainAction = AuditAction
export class CallChainService {
  private readonly repo: CallChainRepository
  private readonly query: CodeQueryService
  private readonly closing = new AbortController()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly scanning = new Set<string>()
  private scanWriteFault?: { projectId: string; runId: string }
  analysis?: PathAnalysisService
  constructor(repo: CallChainRepository, query: CodeQueryService) {
    this.repo = repo
    this.query = query
  }
  openStream(value: unknown): AnalyzeRequest {
    let input: AnalyzeRequest
    try {
      input = validateAnalyze(value)
    } catch {
      throw new ApiError('INVALID_ANALYZE', '分析请求字段或会话游标无效', 400)
    }
    if (input.sessionId) {
      this.repo.scans.streams.session(input)
      return input
    }
    const prior = this.repo.scans.streams.current(input.projectId, input.runId, input.chainId)
    if (prior && ['queue', 'analyze'].includes(String(prior.state))) {
      input = { ...input, sessionId: String(prior.session_id) }
      this.repo.scans.streams.session(input)
      return input
    }
    if (!this.analysis) throw new ApiError('ANALYSIS_NOT_READY', '分析服务尚未接入', 503)
    this.analysis.start(input.projectId, input.runId, input.chainId, input.modelConfigId)
    const created = this.repo.scans.streams.current(input.projectId, input.runId, input.chainId)!
    return { ...input, sessionId: String(created.session_id) }
  }
  readStream(input: AnalyzeRequest): {
    frames: StreamFrame[]
    terminal: boolean
    lastEventId: number
  } {
    this.analysis?.assertPersistence(input.projectId, input.runId, input.chainId)
    return this.repo.scans.streams.list(input)
  }
  async action(action: ChainAction, value: unknown, signal?: AbortSignal): Promise<unknown> {
    const combined = AbortSignal.any([this.closing.signal, ...(signal ? [signal] : [])])
    if (combined.aborted) throw new ApiError('QUERY_CANCELLED', '调用链操作已取消', 499)
    if (action === 'analyzePending') {
      const row = queryInput(value, ['projectId', 'runId', 'modelConfigId', 'maxPaths'])
      if (!this.analysis) throw new ApiError('ANALYSIS_NOT_READY', '分析服务尚未接入', 503)
      return this.analysis.startPending(
        queryText(row.projectId, 80),
        queryText(row.runId, 80),
        queryText(row.modelConfigId, 80),
        queryInteger(row.maxPaths, 10, 100)
      )
    }
    if (action === 'events') {
      const row = queryInput(value, ['projectId', 'runId', 'pathId', 'afterSeq', 'limit'])
      return this.repo.scans.events.list(
        queryText(row.projectId, 80),
        queryText(row.runId, 80),
        row.pathId === undefined ? null : queryText(row.pathId, 100),
        row.afterSeq === undefined ? 0 : (row.afterSeq as number),
        queryInteger(row.limit, 50, 100)
      )
    }
    if (action === 'runState') {
      const row = queryInput(value, ['projectId', 'runId'])
      const projectId = queryText(row.projectId, 80),
        runId = queryText(row.runId, 80)
      if (this.scanWriteFault?.projectId === projectId && this.scanWriteFault.runId === runId)
        throw new ApiError(
          'SCAN_PERSISTENCE_FAILED',
          `扫描已停止，数据库状态未确认；检查磁盘后重启服务。projectId=${projectId} runId=${runId} chainId=尚未生成`,
          503
        )
      this.analysis?.assertPersistence(projectId, runId)
      return this.repo.scans.state(projectId, runId)
    }
    if (action === 'history') {
      const row = queryInput(value, ['projectId', 'runId', 'pathId', 'sessionId', 'afterId'])
      const projectId = queryText(row.projectId, 80),
        runId = queryText(row.runId, 80),
        pathId = queryText(row.pathId, 100)
      this.analysis?.assertPersistence(projectId, runId, pathId)
      return this.repo.scans.streams.history(
        projectId,
        runId,
        pathId,
        row.sessionId === undefined ? undefined : queryText(row.sessionId, 100),
        row.afterId === undefined ? 0 : (row.afterId as number)
      )
    }
    const allowed =
      action === 'prepare'
        ? ['projectId', 'maxResults', 'maxDepth', 'maxNodes', 'maxPaths']
        : action === 'runs'
          ? ['projectId']
          : action === 'list'
            ? ['projectId', 'runId', 'limit', 'offset']
            : action === 'statistics'
              ? ['projectId', 'runId']
              : action === 'analyze'
                ? ['projectId', 'runId', 'pathId', 'modelConfigId']
                : ['projectId', 'runId', 'pathId']
    const row = queryInput(value, allowed),
      projectId = queryText(row.projectId, 80)
    if (action === 'runs') return this.repo.scans.runs(projectId)
    if (action === 'statistics')
      return this.repo.scans.statistics(projectId, queryText(row.runId, 80))
    if (action === 'list')
      return this.repo.list({
        projectId,
        runId: queryText(row.runId, 80),
        limit: row.limit as number | undefined,
        offset: row.offset as number | undefined
      })
    if (action === 'detail')
      return this.repo.detail({
        projectId,
        runId: queryText(row.runId, 80),
        pathId: queryText(row.pathId, 100)
      })
    if (action === 'analyze') {
      if (!this.analysis) throw new ApiError('ANALYSIS_NOT_READY', '单路径分析服务尚未接入', 503)
      return this.analysis.start(
        projectId,
        queryText(row.runId, 80),
        queryText(row.pathId, 100),
        queryText(row.modelConfigId, 80)
      )
    }
    if (this.scanWriteFault)
      throw new ApiError(
        'SCAN_PERSISTENCE_FAILED',
        '上次扫描写库失败，请检查磁盘后重启服务恢复',
        503
      )
    if (this.scanning.has(projectId))
      throw new ApiError('SCAN_BUSY', '该项目正在预处理，请等待并刷新任务', 409, true)
    const limits = {
      maxResults: queryInteger(row.maxResults, 100, 100),
      maxDepth: queryInteger(row.maxDepth, 16, 32),
      maxNodes: queryInteger(row.maxNodes, 512, 2000),
      maxPaths: queryInteger(row.maxPaths, 100, 100)
    }
    const project = this.query.project(projectId),
      runId = randomUUID()
    this.repo.scans.begin(projectId, runId, project.sourceStamp, builtinRules.version)
    this.scanning.add(projectId)
    const task = (async (): Promise<PreparedScan> => {
      try {
        const snapshot = await this.query.sourceSnapshot(projectId, combined)
        const output = await preprocessJava(
          projectId,
          runId,
          snapshot.sourceStamp,
          snapshot.files,
          combined,
          limits
        )
        if (combined.aborted) throw new ApiError('QUERY_CANCELLED', '预处理已取消', 499)
        const saved = this.repo.saveGraph(output.graph, output.summary)
        return {
          ...saved,
          ...output.summary,
          sourceStamp: snapshot.sourceStamp,
          rulesVersion: builtinRules.version,
          scope: 'bounded-java-call-paths'
        }
      } catch (error) {
        const scope = `projectId=${projectId} runId=${runId} chainId=尚未生成`
        try {
          await retryWrite(() =>
            this.repo.scans.fail(runId, error instanceof ApiError ? error.code : 'SCAN_FAILED')
          )
        } catch {
          this.scanWriteFault = { projectId, runId }
          throw new ApiError(
            'SCAN_PERSISTENCE_FAILED',
            '扫描停止，失败状态写库未确认；请检查磁盘并重启服务恢复。' + scope,
            503
          )
        }
        throw new ApiError(
          error instanceof ApiError ? error.code : 'SCAN_FAILED',
          '预处理失败，任务已保留失败状态，请检查源码与范围。' + scope,
          error instanceof ApiError ? error.status : 500
        )
      }
    })()
    this.tasks.add(task)
    try {
      return await task
    } finally {
      this.scanning.delete(projectId)
      this.tasks.delete(task)
    }
  }
  async close(): Promise<void> {
    this.closing.abort()
    await Promise.allSettled(this.tasks)
    await this.analysis?.close()
  }
}
