import { randomUUID } from 'node:crypto'
import { ApiError } from '../shared/api-error.ts'
import { isModelCatalog } from '../shared/model-settings.ts'
import type { ModelCatalog } from '../shared/model-settings'
import type { ApiResult } from '../shared/service-protocol'
export async function modelSettingsRequest(
  port: number,
  token: string,
  input?: unknown,
  selecting = input !== undefined
): Promise<ApiResult<ModelCatalog>> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}` + (selecting ? '/models/selection' : '/models'),
      {
        method: selecting ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        ...(selecting ? { body: JSON.stringify(input) } : {}),
        signal: AbortSignal.timeout(20000),
        redirect: 'error'
      }
    )
    const body = (await response.json()) as ApiResult<unknown>
    if (!body || typeof body.requestId !== 'string')
      throw new ApiError('INVALID_MODEL_SETTINGS_RESPONSE', '模型配置响应无效', 502)
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
    if (!response.ok || body.ok !== true || !isModelCatalog(body.data))
      throw new ApiError('INVALID_MODEL_SETTINGS_RESPONSE', '模型配置字段格式无效', 502)
    return { ok: true, requestId: body.requestId, data: body.data }
  } catch (error) {
    const known =
      error instanceof ApiError
        ? error
        : new ApiError('LOCAL_SERVICE_UNAVAILABLE', '无法读取或选择模型配置', 503, true)
    return {
      ok: false,
      requestId: known.requestId ?? randomUUID(),
      error: { code: known.code, message: known.message, retryable: known.retryable }
    }
  }
}
