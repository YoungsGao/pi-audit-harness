import { randomUUID } from 'node:crypto'
import type { ReviewAction, ReviewData } from '../shared/review-contracts.ts'
import { reviewInput, isReviewData } from '../shared/review-contracts.ts'
import type { ApiResult } from '../shared/service-protocol'
export async function reviewRequest(
  port: number,
  token: string,
  action: ReviewAction,
  input: unknown
): Promise<ApiResult<ReviewData>> {
  const failed = (): ApiResult<ReviewData> => ({
    ok: false,
    requestId: randomUUID(),
    error: {
      code: 'REVIEW_TRANSPORT_FAILED',
      message: '复核服务通信或响应未确认，请刷新记录后核对',
      retryable: true
    }
  })
  try {
    const scope = reviewInput(action, input)
    const response = await fetch(`http://127.0.0.1:${port}/reviews/${action}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      redirect: 'error',
      signal: AbortSignal.timeout(10000)
    })
    const raw = await response.text()
    if (raw.length > 64000) return failed()
    const body = JSON.parse(raw)
    if (
      body?.ok === false &&
      typeof body.requestId === 'string' &&
      typeof body.error?.code === 'string' &&
      typeof body.error?.message === 'string' &&
      typeof body.error?.retryable === 'boolean'
    )
      return {
        ok: false,
        requestId: body.requestId,
        error: {
          code: body.error.code,
          message: body.error.message,
          retryable: body.error.retryable
        }
      }
    if (
      !response.ok ||
      body?.ok !== true ||
      typeof body.requestId !== 'string' ||
      !isReviewData(action, body.data) ||
      body.data.projectId !== scope.projectId ||
      body.data.runId !== scope.runId ||
      body.data.pathId !== scope.pathId ||
      (action === 'source' &&
        (!('stepIndex' in body.data) ||
          body.data.stepIndex !== scope.stepIndex ||
          body.data.target !== scope.target))
    )
      return failed()
    return { ok: true, requestId: body.requestId, data: body.data }
  } catch {
    return failed()
  }
}
