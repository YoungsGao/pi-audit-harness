import { ApiError } from '../../shared/api-error.ts'
import type { AnalysisAccepted, PathDetail } from '../../shared/scan-contracts'
import type { ReviewResult } from '../storage/scan-repository.ts'
import type { CodeQueryService } from '../query/service.ts'
import type { CallChainRepository } from '../storage/call-chain-repository.ts'
import { builtinRules } from '../rules/builtin.ts'

export interface ReviewInput {
  projectId: string
  runId: string
  pathId: string
  modelConfigId: string
  rulesVersion: string
  rule: unknown
  path: PathDetail
  evidence: { filePath: string; startLine: number; endLine: number; text: string }[]
}
export type PathReviewer = (input: ReviewInput, signal: AbortSignal) => Promise<unknown>
function validateResult(value: unknown, input: ReviewInput): ReviewResult {
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
        (q) => typeof q !== 'string' || !q.trim() || q.length > 2000 || !evidence.text.includes(q)
      )
    )
      throw new ApiError(
        'ANALYSIS_EVIDENCE_INVALID',
        '模型证据必须逐步骤引用本次实际读取的原文',
        502
      )
    seen.add(step.stepIndex)
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
  constructor(repo: CallChainRepository, query: CodeQueryService, reviewer: PathReviewer) {
    this.repo = repo
    this.query = query
    this.reviewer = reviewer
  }
  start(projectId: string, runId: string, pathId: string, modelConfigId: string): AnalysisAccepted {
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
  private async review(
    base: Pick<ReviewInput, 'projectId' | 'runId' | 'pathId' | 'modelConfigId' | 'path'>,
    attempt: number
  ): Promise<void> {
    const signal = AbortSignal.any([this.closing.signal, AbortSignal.timeout(90000)])
    try {
      const evidence: ReviewInput['evidence'] = []
      for (const step of base.path.steps) {
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
        evidence.push({
          filePath: read.filePath,
          startLine: read.startLine,
          endLine: read.endLine,
          text: read.text
        })
      }
      const listing = this.repo.list({ projectId: base.projectId, runId: base.runId })
      const input: ReviewInput = {
        ...base,
        rulesVersion: String(listing.rulesVersion),
        rule: builtinRules.rules.find((r) => r.id === base.path.ruleId),
        evidence
      }
      if (input.rulesVersion !== builtinRules.version)
        throw new ApiError('ANALYSIS_RULES_CHANGED', '历史规则版本不匹配，请重新预处理', 409)
      const result = validateResult(await this.reviewer(input, signal), input)
      if (signal.aborted) throw new ApiError('ANALYSIS_CANCELLED', '分析已取消', 499)
      if (
        !base.path.sourceRef?.startsWith('http-entry-candidate:') &&
        result.verdict === 'dangerous'
      )
        result.verdict = 'unknown'
      this.repo.scans.complete(
        base.pathId,
        attempt,
        result,
        evidence,
        base.path.truncated || base.path.steps.some((s) => s.edge.resolutionStatus === 'unresolved')
      )
    } catch (error) {
      this.repo.scans.analysisFailed(
        base.pathId,
        attempt,
        error instanceof ApiError ? error.code : 'ANALYSIS_FAILED'
      )
    }
  }
  async close(): Promise<void> {
    this.closing.abort()
    await this.active
  }
}
