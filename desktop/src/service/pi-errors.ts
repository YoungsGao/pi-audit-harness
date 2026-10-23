import { ApiError } from '../shared/api-error.ts'

export function normalizePiFailure(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  if (/\b(?:401|403)\b/.test(text))
    return new ApiError('MODEL_AUTH_FAILED', '模型服务鉴权失败，请检查凭据和访问权限', 502)
  if (/\b429\b/.test(text))
    return new ApiError('MODEL_RATE_LIMIT', '模型服务额度不足或请求频率受限', 502, true)
  if (/\b404\b/.test(text))
    return new ApiError('MODEL_OR_ENDPOINT_NOT_FOUND', '模型或接口不存在，请核对地址与模型 ID', 502)
  if (/\b(?:408|504)\b|timed?\s*out|timeout/i.test(text))
    return new ApiError('MODEL_TIMEOUT', '模型服务请求超时，请稍后重试', 504, true)
  if (/\b(?:500|502|503)\b/.test(text))
    return new ApiError('MODEL_SERVICE_FAILED', '模型服务暂时不可用，请稍后重试', 502, true)
  if (/fetch failed|ECONN|ENOTFOUND|network|socket|connection|closed|terminated/i.test(text))
    return new ApiError('MODEL_NETWORK_FAILED', '无法连接模型服务，请检查网络和地址', 502, true)
  return new ApiError('PI_CALL_FAILED', 'Pi 调用失败，请根据请求编号排查', 502)
}
