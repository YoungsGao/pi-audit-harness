import { randomUUID } from 'node:crypto'
import { ApiError } from '../shared/api-error.ts'
import { isStorageOverview } from '../shared/storage-contracts.ts'
import type { StorageOverview } from '../shared/storage-contracts'
import type { ApiResult } from '../shared/service-protocol'

export async function readStorageOverview(
  port: number,
  token: string
): Promise<ApiResult<StorageOverview>> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/storage/overview`, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(3000),
      redirect: 'error'
    })
    const body = (await response.json()) as ApiResult<unknown>
    // TS 类型断言不等于运行时校验；HTTP 对端响应必须再次检查。
    if (!body || typeof body.requestId !== 'string')
      throw new ApiError('INVALID_STORAGE_RESPONSE', '存储响应缺少请求编号', 502)
    if (
      !response.ok &&
      body.ok === false &&
      body.error &&
      typeof body.error.code === 'string' &&
      typeof body.error.message === 'string' &&
      typeof body.error.retryable === 'boolean'
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
    if (!response.ok || body.ok !== true || !isStorageOverview(body.data))
      throw new ApiError('INVALID_STORAGE_RESPONSE', '存储响应格式无效', 502)
    return { ok: true, requestId: body.requestId, data: body.data }
  } catch (error) {
    const known =
      error instanceof ApiError
        ? error
        : new ApiError('LOCAL_SERVICE_UNAVAILABLE', '无法读取本地存储', 503, true)
    return {
      ok: false,
      requestId: known.requestId ?? randomUUID(),
      error: { code: known.code, message: known.message, retryable: known.retryable }
    }
  }
}
