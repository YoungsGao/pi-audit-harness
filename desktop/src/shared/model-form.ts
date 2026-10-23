import type { ModelInput } from './metadata-contracts'
export type ModelFormErrors = Partial<Record<'name' | 'baseUrl' | 'modelId' | 'apiKey', string>>
export function validateModelForm(
  draft: ModelInput,
  key: string
): { input: ModelInput; errors: ModelFormErrors } {
  const errors: ModelFormErrors = {}
  const control = (text: string): boolean => Array.from(text).some((c) => c.charCodeAt(0) < 32)
  const name = draft.name.trim(),
    modelId = draft.modelId.trim()
  let baseUrl = draft.baseUrl.trim()
  if (!name || name.length > 200 || control(name)) errors.name = '请输入 1～200 字符的配置名称'
  if (!modelId || modelId.length > 200 || control(modelId))
    errors.modelId = '请输入服务要求的模型 ID（1～200 字符）'
  try {
    const url = new URL(baseUrl)
    if (
      baseUrl.length > 2048 ||
      control(baseUrl) ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error()
    baseUrl = url.toString().replace(/\/$/, '')
  } catch {
    errors.baseUrl = '请输入 http/https 地址，不能包含用户名、密码、查询参数或片段'
  }
  if (key && (!key.trim() || new TextEncoder().encode(key).length > 2048 || control(key)))
    errors.apiKey = '密钥不能为空白，不能有换行或控制字符，最多 2048 字节'
  const input: ModelInput = {
    configId: draft.configId,
    expectedRevision: draft.expectedRevision,
    name,
    baseUrl,
    modelId,
    ...(key ? { apiKey: key } : {})
  }
  return { input, errors }
}
