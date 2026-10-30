import type { LocalDatabase } from '../storage/database.ts'
import { ReviewRepository } from '../storage/review-repository.ts'
import { CallChainRepository } from '../storage/call-chain-repository.ts'
import type { CodeQueryService } from '../query/service.ts'
import { reviewInput } from '../../shared/review-contracts.ts'
import type {
  ReviewAction,
  ReviewData,
  ReviewSave,
  PathSource
} from '../../shared/review-contracts.ts'
import type { PathDetail } from '../../shared/scan-contracts.ts'
import { publicAnalysisText } from '../../shared/path-detail-view.ts'
import { ApiError } from '../../shared/api-error.ts'
export class ReviewService {
  private readonly repository: ReviewRepository
  private readonly paths: CallChainRepository
  private readonly query: CodeQueryService
  constructor(db: LocalDatabase, query: CodeQueryService) {
    this.repository = new ReviewRepository(db)
    this.paths = new CallChainRepository(db)
    this.query = query
  }
  async action(action: ReviewAction, value: unknown, signal?: AbortSignal): Promise<ReviewData> {
    let input: ReturnType<typeof reviewInput>
    try {
      input = reviewInput(action, value)
    } catch {
      throw new ApiError('REVIEW_INVALID_INPUT', '复核或源码定位参数无效', 400)
    }
    if (signal?.aborted) throw new ApiError('REVIEW_CANCELLED', '本次复核操作已取消', 499)
    const scope = { projectId: input.projectId, runId: input.runId, pathId: input.pathId }
    if (action === 'get') return this.repository.get(scope)
    if (action === 'save') return this.repository.save(input as ReviewSave)
    const detail = this.paths.detail(scope) as unknown as PathDetail
    const step = detail.steps.find((s) => s.stepIndex === input.stepIndex)
    if (!step) throw new ApiError('PATH_SOURCE_UNAVAILABLE', '步骤不属于当前路径', 404)
    const filePath = input.target === 'callee' ? step.edge.calledFilePath : step.edge.filePath
    if (!filePath)
      throw new ApiError('PATH_SOURCE_UNAVAILABLE', '当前关系没有定位到快照内的被调用函数', 409)
    const info = this.query.snapshots.info(scope.projectId, scope.runId)
    const abort = signal ?? new AbortController().signal
    const method = await this.query.methodContext(
      scope.projectId,
      filePath,
      input.target === 'callee' ? step.edge.calleeKey : step.edge.callerKey,
      abort,
      scope.runId
    )
    if (!method && input.target === 'callee')
      throw new ApiError('PATH_SOURCE_UNAVAILABLE', '当前被调用函数没有可验证的方法范围', 409)
    const source =
      method ??
      ((await this.query.action(
        'read',
        {
          projectId: scope.projectId,
          runId: scope.runId,
          filePath,
          startLine: step.edge.callLine,
          endLine: step.edge.callLine
        },
        abort
      )) as { filePath: string; startLine: number; endLine: number; text: string })
    return {
      ...scope,
      stepIndex: input.stepIndex!,
      target: input.target!,
      snapshotId: info.snapshotId,
      sourceStamp: info.sourceStamp,
      filePath: source.filePath,
      startLine: source.startLine,
      endLine: source.endLine,
      text: publicAnalysisText(source.text),
      complete: method?.complete ?? false
    } satisfies PathSource
  }
}
