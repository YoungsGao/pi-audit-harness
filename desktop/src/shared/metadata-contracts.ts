export interface ProjectInput {
  projectId?: string
  expectedRevision?: number
  projectName: string
  path: string
  sourceType: 'local' | 'git'
  gitUrl?: string | null
}
export interface ProjectRecord {
  projectId: string
  projectName: string
  path: string
  sourceType: 'local' | 'git'
  gitUrl: string | null
  commit: string | null
  dirty: boolean | null
  revision: number
  needsMetadata: boolean
}
export interface ModelInput {
  configId?: string
  expectedRevision?: number
  name: string
  baseUrl: string
  modelId: string
  // 只允许写入时传递；任何读取 DTO 都不包含 Key 或凭据引用。
  apiKey?: string
}
export interface ModelRecord {
  configId: string
  name: string
  baseUrl: string
  modelId: string
  revision: number
  credentialState: 'missing' | 'referenced'
}
export interface MetadataOverview {
  projects: ProjectRecord[]
  models: ModelRecord[]
  totals: { projects: number; models: number }
}
export interface ModelSaveResult {
  model: ModelRecord
  cleanupPending: boolean
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function isMetadataOverview(value: unknown): value is MetadataOverview {
  if (
    !object(value) ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.models) ||
    !object(value.totals)
  )
    return false
  const str = (row: Record<string, unknown>, keys: string[]): boolean =>
    keys.every((key) => typeof row[key] === 'string')
  const nullable = (v: unknown): boolean => v === null || typeof v === 'string'
  const revision = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) > 0
  return (
    value.projects.length <= 100 &&
    value.models.length <= 100 &&
    value.projects.every(
      (row) =>
        object(row) &&
        str(row, ['projectId', 'projectName', 'path']) &&
        ['local', 'git'].includes(String(row.sourceType)) &&
        nullable(row.gitUrl) &&
        nullable(row.commit) &&
        (row.dirty === null || typeof row.dirty === 'boolean') &&
        revision(row.revision) &&
        typeof row.needsMetadata === 'boolean'
    ) &&
    value.models.every(
      (row) =>
        object(row) &&
        str(row, ['configId', 'name', 'baseUrl', 'modelId']) &&
        revision(row.revision) &&
        ['missing', 'referenced'].includes(String(row.credentialState)) &&
        !('apiKey' in row) &&
        !('secretRef' in row)
    ) &&
    ['projects', 'models'].every(
      (key) =>
        Number.isSafeInteger((value.totals as Record<string, unknown>)[key]) &&
        Number((value.totals as Record<string, unknown>)[key]) >= 0
    )
  )
}
