import { ApiError } from '../../shared/api-error.ts'
import type { AnalysisAccepted, PathDetail } from '../../shared/scan-contracts'
import type { ReviewResult } from '../storage/scan-repository.ts'
import type { CodeQueryService } from '../query/service.ts'
import type { CallChainRepository } from '../storage/call-chain-repository.ts'
import { builtinRules } from '../rules/builtin.ts'
import type { EventInput, QueueAccepted } from '../../shared/agent-contracts'
import { validateTaint, reconcileTaint } from './taint-validation.ts'
import { retryWrite } from '../storage/retry-write.ts'

export interface ReviewInput {
  projectId: string
  runId: string
  pathId: string
  modelConfigId: string
  rulesVersion: string
  rule: unknown
  path: PathDetail
  evidence: {
    filePath: string
    startLine: number
    endLine: number
    text: string
    complete?: boolean
    ranges?: { filePath: string; startLine: number; endLine: number; text: string }[]
  }[]
  readStep?: (stepIndex: number) => Promise<ReviewInput['evidence'][number]>
  recordEvent?: (event: EventInput) => void
}
export type PathReviewer = (input: ReviewInput, signal: AbortSignal) => Promise<unknown>
export function validateResult(
  value: unknown,
  input: ReviewInput,
  requireTaint = false
): ReviewResult {
  if (!value || typeof value !== 'object')
    throw new ApiError('ANALYSIS_RESULT_INVALID', '模型没有返回结构化结论', 502)
  const result = value as ReviewResult
  if (
    !['unknown', 'safe', 'dangerous', 'invalid'].includes(result.verdict) ||
    typeof result.summary !== 'string' ||
    !result.summary.trim() ||
    result.summary.length > 6000 ||
    !Array.isArray(result.steps) ||
    result.steps.length !== input.path.steps.length
  )
    throw new ApiError('ANALYSIS_RESULT_INVALID', '模型结论字段或步骤数量无效', 502)
  const seen = new Set<number>()
  for (const step of result.steps) {
    if (!step || typeof step !== 'object')
      throw new ApiError('ANALYSIS_RESULT_INVALID', '步骤结构无效', 502)
    const evidence = input.evidence[step.stepIndex]
    if (
      !Number.isInteger(step.stepIndex) ||
      !evidence ||
      seen.has(step.stepIndex) ||
      ![null, 0, 1].includes(step.dangerous) ||
      typeof step.reason !== 'string' ||
      step.reason.length > 2000 ||
      !Array.isArray(step.quotes) ||
      !step.quotes.length ||
      step.quotes.length > 5 ||
      step.quotes.some(
        (q) =>
          typeof q !== 'string' ||
          !q.trim() ||
          q.length > 2000 ||
          !(evidence.ranges ?? [evidence]).some((r) => r.text.includes(q))
      )
    )
      throw new ApiError(
        'ANALYSIS_EVIDENCE_INVALID',
        '模型证据必须逐步骤引用本次实际读取的原文',
        502
      )
    seen.add(step.stepIndex)
    if (requireTaint) validateTaint(step, evidence.ranges?.map((r) => r.text) ?? evidence.text)
  }
  if (result.verdict === 'dangerous' && !result.steps.every((s) => s.dangerous === 1))
    throw new ApiError('ANALYSIS_RESULT_INVALID', '风险结论缺少对应步骤证据', 502)
  if (result.verdict === 'safe' && !result.steps.some((s) => s.dangerous === 0))
    throw new ApiError('ANALYSIS_RESULT_INVALID', '阻断结论缺少防护步骤', 502)
  return result
}
export class PathAnalysisService {
  private readonly repo: CallChainRepository
  private readonly query: CodeQueryService
  private readonly reviewer: PathReviewer
  private readonly closing = new AbortController()
  private active?: Promise<void>
  private readonly agentMode: boolean
  private persistenceFailure?: { projectId: string; runId: string; pathId: string }
  assertPersistence(projectId: string, runId: string, pathId?: string): void {
    const fault = this.persistenceFailure
    if (
      fault &&
      fault.projectId === projectId &&
      fault.runId === runId &&
      (!pathId || fault.pathId === pathId)
    )
      throw new ApiError(
        'ANALYSIS_PERSISTENCE_FAILED',
        `结果或失败状态写库未确认；停止领取任务，请检查磁盘后重启服务恢复。projectId=${fault.projectId} runId=${fault.runId} chainId=${fault.pathId}`,
        503
      )
  }
  private assertWritable(): void {
    if (this.persistenceFailure)
      this.assertPersistence(this.persistenceFailure.projectId, this.persistenceFailure.runId)
  }
  constructor(
    repo: CallChainRepository,
    query: CodeQueryService,
    reviewer: PathReviewer,
    agentMode = false
  ) {
    this.agentMode = agentMode
    this.repo = repo
    this.query = query
    this.reviewer = reviewer
  }
  start(projectId: string, runId: string, pathId: string, modelConfigId: string): AnalysisAccepted {
    this.assertWritable()
    if (this.closing.signal.aborted) throw new ApiError('ANALYSIS_STOPPED', '分析服务已停止', 503)
    if (this.active) throw new ApiError('ANALYSIS_BUSY', '已有路径正在分析，请等待结束', 409, true)
    const path = this.repo.detail({ projectId, runId, pathId }) as unknown as PathDetail
    if (path.steps.length > 16)
      throw new ApiError('ANALYSIS_LIMIT', '当前单路径分析最多读取 16 步，请缩小展开深度', 413)
    const attempt = this.repo.scans.claim(projectId, runId, pathId, modelConfigId)
    this.active = this.review({ projectId, runId, pathId, modelConfigId, path }, attempt).finally(
      () => {
        this.active = undefined
      }
    )
    return { projectId, runId, pathId, status: 'analyzing' }
  }
  startPending(
    projectId: string,
    runId: string,
    modelConfigId: string,
    maxPaths = 10
  ): QueueAccepted {
    this.assertWritable()
    if (this.closing.signal.aborted) throw new ApiError('ANALYSIS_STOPPED', '分析服务已停止', 503)
    if (this.active) throw new ApiError('ANALYSIS_BUSY', '已有路径正在分析，请等待结束', 409, true)
    if (!Number.isInteger(maxPaths) || maxPaths < 1 || maxPaths > 100)
      throw new ApiError('QUERY_INVALID_INPUT', '每次队列最多处理 100 条路径', 400)
    const first = this.repo.scans.claimNext(projectId, runId, modelConfigId)
    if (!first)
      throw new ApiError('ANALYSIS_EMPTY_QUEUE', '没有 pending 路径；失败路径需明确单独重试', 409)
    const deadline = Date.now() + 10 * 60 * 1000
    this.active = (async () => {
      let item: typeof first | null = first
      for (let index = 0; item && index < maxPaths; index++) {
        const path = this.repo.detail({
          projectId,
          runId,
          pathId: item.pathId
        }) as unknown as PathDetail
        await this.review(
          { projectId, runId, modelConfigId, pathId: item.pathId, path },
          item.attempt
        )
        if (this.persistenceFailure) break
        const final = this.repo.detail({
          projectId,
          runId,
          pathId: item.pathId
        }) as unknown as PathDetail
        if (
          final.status === 'failed' ||
          this.repo.scans.state(projectId, runId).errorCode !== null ||
          this.closing.signal.aborted ||
          Date.now() >= deadline ||
          index + 1 >= maxPaths
        )
          break
        item = this.repo.scans.claimNext(projectId, runId, modelConfigId)
      }
    })()
      .catch(() => {
        // Individual path failures are persisted in review(); leave unclaimed work pending.
        try {
          this.repo.scans.events.append(projectId, runId, null, {
            type: 'process',
            status: 'queue_stopped',
            summary: '队列停止，未领取路径保留 pending'
          })
        } catch {
          /* Disk failure is exposed by assertPersistence; do not create an unhandled rejection. */
        }
      })
      .finally(() => {
        this.active = undefined
      })
    return { projectId, runId, status: 'running', maxPaths }
  }
  private async review(
    base: Pick<ReviewInput, 'projectId' | 'runId' | 'pathId' | 'modelConfigId' | 'path'>,
    attempt: number
  ): Promise<void> {
    const signal = AbortSignal.any([
      this.closing.signal,
      AbortSignal.timeout(this.agentMode ? 120000 : 90000)
    ])
    try {
      if (base.path.steps.length === 0 || base.path.steps.length > 16)
        throw new ApiError('ANALYSIS_LIMIT', '单路径必须包含 1 到 16 步', 413)
      const run = this.repo.scans.state(base.projectId, base.runId)
      if (this.query.project(base.projectId).sourceStamp !== run.sourceStamp)
        throw new ApiError(
          'ANALYSIS_SOURCE_CHANGED',
          '任务源码版本与登记版本不一致，请重新预处理',
          409
        )
      const evidence: ReviewInput['evidence'] = []
      const readStep = async (stepIndex: number): Promise<ReviewInput['evidence'][number]> => {
        const step = base.path.steps[stepIndex]
        if (!Number.isInteger(stepIndex) || !step)
          throw new ApiError('ANALYSIS_TOOL_SCOPE', '步骤不属于当前路径', 400)
        const read = (await this.query.action(
          'read',
          {
            projectId: base.projectId,
            filePath: step.edge.filePath,
            startLine: Math.max(1, step.edge.callLine - 5),
            endLine: Math.max(step.edge.callLine, ...step.edge.arguments.map((a) => a.endLine))
          },
          signal
        )) as ReviewInput['evidence'][number] & { sourceStamp: string }
        let item: ReviewInput['evidence'][number] = {
          filePath: read.filePath,
          startLine: read.startLine,
          endLine: read.endLine,
          text: read.text
        }
        if (this.agentMode) {
          const caller = await this.query.methodContext(
            base.projectId,
            step.edge.filePath,
            step.edge.callerKey,
            signal
          )
          const callee = step.edge.calledFilePath
            ? await this.query.methodContext(
                base.projectId,
                step.edge.calledFilePath,
                step.edge.calleeKey,
                signal
              )
            : null
          const ranges = [caller ?? item, ...(callee ? [callee] : [])]
          item = {
            ...item,
            ranges,
            text: ranges
              .map((r) => `${r.filePath}:${r.startLine}-${r.endLine}\n${r.text}`)
              .join('\n'),
            complete: !!caller?.complete && (!step.edge.calledFilePath || !!callee?.complete)
          }
        }
        evidence[stepIndex] = item
        return item
      }
      if (!this.agentMode) for (const step of base.path.steps) await readStep(step.stepIndex)
      const listing = this.repo.list({ projectId: base.projectId, runId: base.runId })
      const input: ReviewInput = {
        ...base,
        rulesVersion: String(listing.rulesVersion),
        rule: builtinRules.rules.find((r) => r.id === base.path.ruleId),
        evidence,
        readStep,
        recordEvent: (event) =>
          this.repo.scans.events.append(base.projectId, base.runId, base.pathId, {
            ...event,
            attemptId: attempt
          })
      }
      if (input.rulesVersion !== builtinRules.version)
        throw new ApiError('ANALYSIS_RULES_CHANGED', '历史规则版本不匹配，请重新预处理', 409)
      let result = validateResult(await this.reviewer(input, signal), input, this.agentMode)
      if (this.agentMode)
        result = reconcileTaint(
          result,
          base.path.truncated ||
            evidence.some((e) => e.complete === false) ||
            base.path.steps.some((s) => s.edge.resolutionStatus === 'unresolved'),
          base.path.sourceRef
        )
      if (signal.aborted) throw new ApiError('ANALYSIS_CANCELLED', '分析已取消', 499)
      if (
        !base.path.sourceRef?.startsWith('http-entry-candidate:') &&
        result.verdict === 'dangerous'
      )
        result.verdict = 'unknown'
      await retryWrite(() =>
        this.repo.scans.complete(
          base.pathId,
          attempt,
          result,
          evidence,
          base.path.truncated ||
            base.path.steps.some((s) => s.edge.resolutionStatus === 'unresolved')
        )
      )
    } catch (error) {
      try {
        await retryWrite(() =>
          this.repo.scans.analysisFailed(
            base.pathId,
            attempt,
            error instanceof ApiError ? error.code : 'ANALYSIS_FAILED'
          )
        )
      } catch {
        // DB may be unwritable. Do not invent a terminal event or claim it was persisted.
        // Startup recover() will settle the unfinished attempt once storage works again.
        this.persistenceFailure = {
          projectId: base.projectId,
          runId: base.runId,
          pathId: base.pathId
        }
      }
    }
  }
  async close(): Promise<void> {
    this.closing.abort()
    await this.active
  }
  async waitForIdle(): Promise<void> {
    await this.active
  }
}
