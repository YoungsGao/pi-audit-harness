import { randomUUID } from 'node:crypto'
import { ApiError } from '../shared/api-error.ts'
import type { ApiResult, RequestContext } from '../shared/service-protocol'

export function createRequestContext(ids: unknown = {}): RequestContext {
  if (!ids || typeof ids !== 'object')
    throw new ApiError('INVALID_REQUEST', '请求标识必须是对象', 400)
  const context: RequestContext = { requestId: randomUUID() }
  for (const name of ['projectId', 'runId'] as const) {
    if (!(name in ids)) continue
    const value: unknown = ids[name]
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
      throw new ApiError('INVALID_REQUEST', `${name} 必须是 1～128 字符的非空字符串`, 400)
    }
    context[name] = value
  }
  if (context.runId && !context.projectId) {
    throw new ApiError('INVALID_REQUEST', '传入 runId 时必须同时传入 projectId', 400)
  }
  return context
}

export function successResult<T>(context: RequestContext, data: T): ApiResult<T> {
  return { ...context, ok: true, data }
}

export function failureResult(
  context: RequestContext,
  error: unknown
): {
  status: number
  body: ApiResult<never>
} {
  const safe =
    error instanceof ApiError
      ? error
      : new ApiError('INTERNAL_ERROR', '服务内部错误，请根据请求编号排查')
  return {
    status: safe.status,
    body: {
      ...context,
      ok: false,
      error: { code: safe.code, message: safe.message, retryable: safe.retryable }
    }
  }
}
