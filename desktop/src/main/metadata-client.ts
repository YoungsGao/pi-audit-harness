import { randomUUID } from 'node:crypto'
import { ApiError } from '../shared/api-error.ts'
import { isMetadataOverview } from '../shared/metadata-contracts.ts'
import type { MetadataOverview, ProjectRecord, ModelSaveResult } from '../shared/metadata-contracts'
import type { ApiResult } from '../shared/service-protocol'

export async function metadataRequest<T extends MetadataOverview | ProjectRecord | ModelSaveResult>(
  port: number,
  token: string,
  action: 'list' | 'project' | 'model',
  input?: unknown
): Promise<ApiResult<T>> {
  try {
    const path = { list: '/metadata', project: '/metadata/projects', model: '/metadata/models' }[
      action
    ]
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: action === 'list' ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(action === 'list' ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.timeout(20000),
      redirect: 'error'
    })
    const body = (await response.json()) as ApiResult<unknown>
    if (!body || typeof body.requestId !== 'string')
      throw new ApiError('INVALID_METADATA_RESPONSE', '元数据响应缺少请求编号', 502)
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
    if (!response.ok || body.ok !== true)
      throw new ApiError('INVALID_METADATA_RESPONSE', '元数据响应无效', 502)
    const empty = { projects: [], models: [], totals: { projects: 0, models: 0 } }
    const value = body.data
    const valid =
      action === 'list'
        ? isMetadataOverview(value)
        : action === 'project'
          ? isMetadataOverview({ ...empty, projects: [value] })
          : !!value &&
            typeof value === 'object' &&
            'model' in value &&
            'cleanupPending' in value &&
            typeof value.cleanupPending === 'boolean' &&
            isMetadataOverview({ ...empty, models: [value.model] })
    if (!valid) throw new ApiError('INVALID_METADATA_RESPONSE', '元数据字段格式无效', 502)
    return { ok: true, requestId: body.requestId, data: value as T }
  } catch (error) {
    const known =
      error instanceof ApiError
        ? error
        : new ApiError('LOCAL_SERVICE_UNAVAILABLE', '无法访问本地元数据服务', 503, true)
    return {
      ok: false,
      requestId: known.requestId ?? randomUUID(),
      error: { code: known.code, message: known.message, retryable: known.retryable }
    }
  }
}
