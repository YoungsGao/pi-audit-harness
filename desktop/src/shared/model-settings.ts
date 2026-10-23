import type { ModelRecord } from './metadata-contracts'
export interface ModelSelectionInput {
  configId: string | null
  expectedRevision: number
}
export interface ModelCatalog {
  models: ModelRecord[]
  total: number
  selection: { configId: string | null; revision: number; model: ModelRecord | null }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function isModelRecord(value: unknown): value is ModelRecord {
  return (
    object(value) &&
    Object.keys(value).length === 6 &&
    ['configId', 'name', 'baseUrl', 'modelId'].every(
      (key) => typeof value[key] === 'string' && String(value[key]).trim().length > 0
    ) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    ['missing', 'referenced'].includes(String(value.credentialState))
  )
}
export function isModelCatalog(value: unknown): value is ModelCatalog {
  if (
    !object(value) ||
    Object.keys(value).length !== 3 ||
    !Array.isArray(value.models) ||
    value.models.length > 100 ||
    !value.models.every(isModelRecord) ||
    !Number.isSafeInteger(value.total) ||
    Number(value.total) < value.models.length ||
    !object(value.selection)
  )
    return false
  if (new Set(value.models.map((item) => item.configId)).size !== value.models.length) return false
  const selection = value.selection
  return (
    Object.keys(selection).length === 3 &&
    Number.isSafeInteger(selection.revision) &&
    Number(selection.revision) >= 0 &&
    (selection.configId === null
      ? selection.model === null
      : typeof selection.configId === 'string' &&
        isModelRecord(selection.model) &&
        selection.model.configId === selection.configId)
  )
}
