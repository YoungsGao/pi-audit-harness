import { randomUUID } from 'node:crypto'
import { ApiError } from '../../shared/api-error.ts'
import type { CodeQueryService } from '../query/service.ts'
import { queryInput, queryText, queryInteger } from '../query/service.ts'
import { CallChainRepository } from '../storage/call-chain-repository.ts'
import { preprocessJava } from '../scanning/preprocess.ts'
import { builtinRules } from '../rules/builtin.ts'
import type { AuditAction, PreparedScan } from '../../shared/scan-contracts'
import type { PathAnalysisService } from './path-analysis.ts'

export type ChainAction = AuditAction
export class CallChainService {
  private readonly repo: CallChainRepository
  private readonly query: CodeQueryService
  private readonly closing = new AbortController()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly scanning = new Set<string>()
  analysis?: PathAnalysisService
  constructor(repo: CallChainRepository, query: CodeQueryService) {
    this.repo = repo
    this.query = query
  }
  async action(action: ChainAction, value: unknown, signal?: AbortSignal): Promise<unknown> {
    const combined = AbortSignal.any([this.closing.signal, ...(signal ? [signal] : [])])
    if (combined.aborted) throw new ApiError('QUERY_CANCELLED', '调用链操作已取消', 499)
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
        this.repo.scans.fail(runId, error instanceof ApiError ? error.code : 'SCAN_FAILED')
        if (error instanceof ApiError) throw error
        throw new ApiError('SCAN_FAILED', '预处理失败，任务已保留失败状态，请检查源码与范围', 500)
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
