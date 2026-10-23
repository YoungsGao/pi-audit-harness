import { ApiError } from '../shared/api-error.ts'
import type { ModelConfig, ModelPorts } from '../shared/pi-contracts.ts'
import { throwIfCancelled, waitWithSignal } from './pi-runtime.ts'

export interface ResolvedModel {
  config: Readonly<ModelConfig>
  apiKey: string
}

export async function resolveModelConfig(
  id: string,
  ports: ModelPorts,
  signal: AbortSignal
): Promise<ResolvedModel> {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    throw new ApiError('INVALID_CONFIG_ID', '模型配置编号无效', 400)
  }
  const snapshot = ports.resolveSnapshot
    ? await waitWithSignal(ports.resolveSnapshot(id, signal), signal)
    : undefined
  const stored = ports.resolveSnapshot
    ? snapshot?.config
    : await waitWithSignal(ports.getConfig(id), signal)
  throwIfCancelled(signal)
  if (!stored) throw new ApiError('MODEL_CONFIG_NOT_FOUND', '请先保存并选择模型配置', 404)
  const config = { ...stored }
  if (
    config.id !== id ||
    !Number.isInteger(config.revision) ||
    config.revision < 1 ||
    typeof config.modelId !== 'string' ||
    !config.modelId.trim() ||
    typeof config.secretRef !== 'string' ||
    config.api !== 'openai-completions'
  )
    throw new ApiError('INVALID_MODEL_CONFIG', '模型配置字段无效或协议尚未支持', 400)
  let url: URL
  try {
    url = new URL(config.baseUrl)
  } catch {
    throw new ApiError('INVALID_MODEL_CONFIG', '模型服务地址无效', 400)
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ApiError('INVALID_MODEL_CONFIG', '模型地址不能携带凭据、查询参数或片段', 400)
  }
  if (!config.secretRef)
    throw new ApiError('MODEL_CREDENTIAL_MISSING', '模型凭据不存在，请重新保存密钥', 400)
  const apiKey = ports.resolveSnapshot
    ? snapshot?.apiKey
    : await waitWithSignal(ports.readSecret(config.secretRef), signal)
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new ApiError('MODEL_CREDENTIAL_MISSING', '模型凭据不存在，请重新保存密钥', 400)
  }
  throwIfCancelled(signal)
  return { config: Object.freeze(config), apiKey }
}

// 保留给未接入存储的探针/测试；正式服务使用 MetadataService.modelPorts()。
export const unconfiguredModelPorts: ModelPorts = {
  getConfig: async () => undefined,
  readSecret: async () => undefined
}
