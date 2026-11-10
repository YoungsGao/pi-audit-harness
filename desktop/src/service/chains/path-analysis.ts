import { ApiError } from '../../shared/api-error.ts'
import type { AnalysisAccepted, PathDetail } from '../../shared/scan-contracts'
import type { ReviewResult } from '../storage/scan-repository.ts'
import type { CodeQueryService } from '../query/service.ts'
import type { CallChainRepository } from '../storage/call-chain-repository.ts'
import { builtinRules } from '../rules/builtin.ts'
import type { EventInput, QueueAccepted } from '../../shared/agent-contracts'
import { validateTaint, reconcileTaint } from './taint-validation.ts'
import { retryWrite } from '../storage/retry-write.ts'
import type { RecoveryExecution } from './recovery.ts'
import { MAX_AGENT_STEPS } from '../../shared/path-limits.ts'
import { invalidResult, ResultValidationError } from './result-validation.ts'
import { constantRiskArguments } from './constant-arguments.ts'

export interface ReviewInput {
  recovery?: RecoveryExecution
  reviewConfig?: import('../../shared/template-contracts').RunReviewConfig
  authorizeModel?: (model: Readonly<import('../../shared/pi-contracts').ModelConfig>) => void
  observedModel?: (modelId: string) => void
  beforeModelRequest?: (estimate: { inputBytes: number; maxOutputTokens: number }) => void
  observeDecision?: (text: string, stopReason: string) => void
  manualPoint?: unknown
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
    facts?: { constantRiskArguments: boolean }
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
    invalidResult('ANALYSIS_RESULT_INVALID', 'result', 'object', '模型必须返回结构化结论对象')
  const result = value as ReviewResult
  if (
    !['unknown', 'safe', 'dangerous', 'invalid'].includes(result.verdict) ||
    typeof result.summary !== 'string' ||
    !result.summary.trim() ||
    result.summary.length > 6000 ||
    !Array.isArray(result.steps) ||
    result.steps.length !== input.path.steps.length
  )
    invalidResult(
      'ANALYSIS_RESULT_INVALID',
      'result',
      'shape',
      `结论须有有效verdict、非空summary以及${input.path.steps.length}个步骤`
    )
  const seen = new Set<number>()
  for (const step of result.steps) {
    if (!step || typeof step !== 'object')
      invalidResult('ANALYSIS_RESULT_INVALID', 'steps', 'object', '每个步骤必须是对象')
    const evidence = input.evidence[step.stepIndex]
    const fail = (field: string, rule: string, message: string): never =>
      invalidResult(
        'ANALYSIS_EVIDENCE_INVALID',
        `steps[${Number.isInteger(step.stepIndex) ? step.stepIndex : '?'}].${field}`,
        rule,
        message,
        Number.isInteger(step.stepIndex) ? step.stepIndex : null
      )
    if (!Number.isInteger(step.stepIndex) || !evidence || seen.has(step.stepIndex))
      fail('stepIndex', 'unique-read-step', '步骤编号必须有效、已经读取且不能重复')
    if (![null, 0, 1].includes(step.dangerous))
      fail('dangerous', 'tri-state', 'dangerous只能是null、0或1')
    if (typeof step.reason !== 'string' || step.reason.length > 2000)
      fail('reason', 'text-limit', 'reason必须是2000字符以内的字符串')
    if (!Array.isArray(step.quotes) || !step.quotes.length || step.quotes.length > 5)
      fail('quotes', 'count', '每步需要1至5条原文引用或有效证据编号')
    for (let i = 0; i < step.quotes.length; i++) {
      const q = step.quotes[i]
      if (
        typeof q !== 'string' ||
        !q.trim() ||
        q.length > 2000 ||
        !(evidence.ranges ?? [evidence]).some((r) => r.text.includes(q))
      )
        fail(
          `quotes[${i}]`,
          'exact-source',
          '引用必须逐字出现在本步骤实际读取的源码中；可改用工具返回的证据编号'
        )
    }
    seen.add(step.stepIndex)
    if (requireTaint)
      validateTaint(
        step,
        evidence.ranges?.map((r) => r.text) ?? evidence.text,
        constantRiskArguments(input.path.steps[step.stepIndex].edge, evidence)
      )
  }
  if (result.verdict === 'dangerous' && !result.steps.every((s) => s.dangerous === 1))
    invalidResult(
      'ANALYSIS_RESULT_INVALID',
      'verdict',
      'dangerous-path',
      'dangerous要求每个步骤dangerous=1且证据完整'
    )
  if (result.verdict === 'safe' && !result.steps.some((s) => s.dangerous === 0))
    invalidResult(
      'ANALYSIS_RESULT_INVALID',
      'verdict',
      'safe-path',
      'safe要求至少一个有证据的阻断步骤dangerous=0'
    )
  return result
}
export class PathAnalysisService {
  private readonly repo: CallChainRepository
  private readonly query: CodeQueryService
  private readonly reviewer: PathReviewer
  private readonly closing = new AbortController()
  private active?: Promise<void>
  private activeScope?: { projectId: string; runId: string }
  private runCancellation?: AbortController
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
  private finishActive(projectId: string, runId: string): void {
    try {
      this.repo.scans.recovery.settle({ projectId, runId })
    } catch {
      this.persistenceFailure ??= { projectId, runId, pathId: '' }
    }
    this.active = undefined
    this.activeScope = undefined
    this.runCancellation = undefined
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
    this.repo.scans.recovery.assertStart({ projectId, runId })
    const path = this.repo.detail({ projectId, runId, pathId }) as unknown as PathDetail
    if (path.steps.length > MAX_AGENT_STEPS)
      throw new ApiError('ANALYSIS_LIMIT', '当前单路径分析最多读取 16 步，请缩小展开深度', 413)
    this.repo.scans.disclosure.require(projectId, runId, modelConfigId)
    if (this.agentMode)
      this.repo.scans.recovery.binding({ projectId, runId }, pathId, modelConfigId)
    let execution: RecoveryExecution | undefined
    const attempt = this.repo.scans.claim(
      projectId,
      runId,
      pathId,
      modelConfigId,
      (_path, claimedAttempt) => {
        if (this.agentMode)
          execution = this.repo.scans.recovery.begin(
            { projectId, runId },
            pathId,
            modelConfigId,
            claimedAttempt,
            false
          )
        else this.repo.scans.recovery.setState({ projectId, runId }, 'running')
      }
    )
    this.runCancellation = new AbortController()
    this.activeScope = { projectId, runId }
    this.active = this.review(
      { projectId, runId, pathId, modelConfigId, path },
      attempt,
      execution
    ).finally(() => {
      this.finishActive(projectId, runId)
    })
    return { projectId, runId, pathId, status: 'analyzing' }
  }
  startPending(
    projectId: string,
    runId: string,
    modelConfigId: string,
    maxPaths = 10,
    recoveryPathId?: string
  ): QueueAccepted {
    this.assertWritable()
    if (this.closing.signal.aborted) throw new ApiError('ANALYSIS_STOPPED', '分析服务已停止', 503)
    if (this.active) throw new ApiError('ANALYSIS_BUSY', '已有路径正在分析，请等待结束', 409, true)
    this.repo.scans.recovery.assertStart({ projectId, runId })
    if (!Number.isInteger(maxPaths) || maxPaths < 1 || maxPaths > 100)
      throw new ApiError('QUERY_INVALID_INPUT', '每次队列最多处理 100 条路径', 400)
    this.repo.scans.disclosure.require(projectId, runId, modelConfigId)
    let executionForItem: RecoveryExecution | undefined
    const onClaim = (pathId: string, attempt: number): void => {
      executionForItem = this.agentMode
        ? this.repo.scans.recovery.begin(
            { projectId, runId },
            pathId,
            modelConfigId,
            attempt,
            pathId === recoveryPathId &&
              !!this.repo.scans.recovery.db.get(
                'SELECT path_id FROM path_recovery WHERE path_id=?',
                pathId
              )
          )
        : undefined
      if (!this.agentMode) this.repo.scans.recovery.setState({ projectId, runId }, 'running')
      if (executionForItem && pathId === recoveryPathId && !executionForItem.resuming)
        this.repo.scans.recovery.db.run(
          'UPDATE path_recovery SET receipt_json=? WHERE path_id=?',
          JSON.stringify({
            mode: 'restart',
            checkpointId: null,
            reusedSteps: [],
            reason: '从已提交路径边界继续，先前完成路径不重复调查',
            createdAt: new Date().toISOString()
          }),
          pathId
        )
    }
    const first = recoveryPathId
      ? {
          pathId: recoveryPathId,
          attempt: this.repo.scans.claim(projectId, runId, recoveryPathId, modelConfigId, onClaim)
        }
      : this.repo.scans.claimNext(projectId, runId, modelConfigId, onClaim)
    if (!first)
      throw new ApiError('ANALYSIS_EMPTY_QUEUE', '没有 pending 路径；失败路径需明确单独重试', 409)
    const deadline = Date.now() + 10 * 60 * 1000
    this.runCancellation = new AbortController()
    this.activeScope = { projectId, runId }
    this.active = (async () => {
      let item: typeof first | null = first
      for (let index = 0; item && index < maxPaths; index++) {
        const path = this.repo.detail({
          projectId,
          runId,
          pathId: item.pathId
        }) as unknown as PathDetail
        const execution = executionForItem
        await this.review(
          { projectId, runId, modelConfigId, pathId: item.pathId, path },
          item.attempt,
          execution
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
          this.runCancellation?.signal.aborted ||
          Date.now() >= deadline ||
          index + 1 >= maxPaths
        )
          break
        item = this.repo.scans.claimNext(projectId, runId, modelConfigId, onClaim)
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
        this.finishActive(projectId, runId)
      })
    return { projectId, runId, status: 'running', maxPaths }
  }
  private async review(
    base: Pick<ReviewInput, 'projectId' | 'runId' | 'pathId' | 'modelConfigId' | 'path'>,
    attempt: number,
    execution?: RecoveryExecution
  ): Promise<void> {
    const signal = AbortSignal.any([
      this.closing.signal,
      ...(this.runCancellation ? [this.runCancellation.signal] : []),
      AbortSignal.timeout(this.agentMode ? 120000 : 90000)
    ])
    try {
      if (base.path.steps.length === 0 || base.path.steps.length > 16)
        throw new ApiError('ANALYSIS_LIMIT', '单路径必须包含 1 到 16 步', 413)
      const run = this.repo.scans.state(base.projectId, base.runId)
      if (!execution && this.query.project(base.projectId).sourceStamp !== run.sourceStamp)
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
            runId: base.runId,
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
            signal,
            base.runId
          )
          const callee = step.edge.calledFilePath
            ? await this.query.methodContext(
                base.projectId,
                step.edge.calledFilePath,
                step.edge.calleeKey,
                signal,
                base.runId
              )
            : null
          const ranges = [caller ?? item, ...(callee ? [callee] : [])]
          item = {
            ...item,
            filePath: ranges[0].filePath,
            startLine: ranges[0].startLine,
            endLine: ranges[0].endLine,
            ranges,
            text: ranges
              .map((r) => `${r.filePath}:${r.startLine}-${r.endLine}\n${r.text}`)
              .join('\n'),
            complete: !!caller?.complete && (!step.edge.calledFilePath || !!callee?.complete)
          }
        }
        item.facts = { constantRiskArguments: constantRiskArguments(step.edge, item) }
        evidence[stepIndex] = item
        return item
      }
      if (!this.agentMode) for (const step of base.path.steps) await readStep(step.stepIndex)
      const listing = this.repo.list({ projectId: base.projectId, runId: base.runId })
      const disclosure = this.repo.scans.disclosure.require(
        base.projectId,
        base.runId,
        base.modelConfigId
      )
      let transmissionId = ''
      const input: ReviewInput = {
        ...(execution ? { recovery: execution } : {}),
        ...base,
        reviewConfig: this.repo.scans.templates.run(base.projectId, base.runId),
        rulesVersion: String(listing.rulesVersion),
        rule: builtinRules.rules.find((r) => r.id === base.path.ruleId),
        evidence,
        readStep,
        manualPoint: this.repo.manualPoint(base.projectId, base.runId, base.pathId),
        authorizeModel: (model) => {
          execution?.assertLive()
          transmissionId = this.repo.scans.disclosure.beforeSend(
            disclosure,
            base.pathId,
            attempt,
            model
          )
        },
        observedModel: (modelId) => {
          if (transmissionId) this.repo.scans.disclosure.observed(transmissionId, modelId)
        },
        recordEvent: (event) => {
          execution?.assertLive()
          this.repo.scans.events.append(base.projectId, base.runId, base.pathId, {
            ...event,
            attemptId: attempt
          })
        }
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
      await retryWrite(() => {
        execution?.assertLive()
        return this.repo.scans.complete(
          base.pathId,
          attempt,
          result,
          evidence,
          base.path.truncated ||
            base.path.steps.some((s) => s.edge.resolutionStatus === 'unresolved')
        )
      })
    } catch (error) {
      try {
        if (error instanceof ResultValidationError)
          this.repo.scans.events.append(base.projectId, base.runId, base.pathId, {
            type: 'process',
            status: 'validation_failed',
            attemptId: attempt,
            summary: `第${error.issue.stepIndex === null ? '?' : error.issue.stepIndex + 1}步：${error.issue.message}`,
            payload: { validation: error.issue, errorCode: error.code }
          })
        await retryWrite(() =>
          this.repo.scans.analysisFailed(
            base.pathId,
            attempt,
            this.closing.signal.aborted
              ? 'RUN_INTERRUPTED'
              : this.runCancellation?.signal.aborted
                ? 'RUN_USER_STOP'
                : error instanceof ApiError
                  ? error.code
                  : 'ANALYSIS_FAILED'
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
  stop(projectId: string, runId: string): import('../../shared/run-contracts').RunRecoveryView {
    const scope = { projectId, runId },
      active =
        !!this.active &&
        this.activeScope?.projectId === projectId &&
        this.activeScope.runId === runId
    this.repo.scans.recovery.requestStop(scope, active)
    if (active && this.repo.scans.recovery.control(scope).state === 'stop_requested') {
      this.runCancellation?.abort(new ApiError('RUN_USER_STOP', '用户请求停止当前任务', 409))
      this.repo.scans.recovery.setState(scope, 'waiting_external')
    }
    return this.repo.scans.recovery.view(scope)
  }
  recovery(projectId: string, runId: string): import('../../shared/run-contracts').RunRecoveryView {
    return this.repo.scans.recovery.view({ projectId, runId })
  }
  resume(
    projectId: string,
    runId: string,
    key: string,
    maxPaths: number
  ): import('../../shared/run-contracts').RunRecoveryView {
    this.assertWritable()
    if (this.active) throw new ApiError('ANALYSIS_BUSY', '已有执行正在退出或运行，请等待', 409)
    const scope = { projectId, runId },
      plan = this.recovery(projectId, runId)
    if (plan.recoveryKey !== key)
      throw new ApiError('RUN_PLAN_CHANGED', '恢复清单已变化，请刷新后核对', 409)
    if (!plan.canResume || !plan.candidatePathId || !plan.modelConfigId)
      throw new ApiError('RUN_RECOVERY_BLOCKED', '当前任务不满足恢复条件，请查看恢复说明', 409)
    this.repo.scans.disclosure.require(projectId, runId, plan.modelConfigId)
    this.repo.scans.recovery.setState(scope, 'idle')
    try {
      this.startPending(projectId, runId, plan.modelConfigId, maxPaths, plan.candidatePathId)
    } catch (error) {
      this.repo.scans.recovery.setState(scope, plan.state)
      throw error
    }
    return this.recovery(projectId, runId)
  }
  async waitForIdle(): Promise<void> {
    await this.active
  }
}
