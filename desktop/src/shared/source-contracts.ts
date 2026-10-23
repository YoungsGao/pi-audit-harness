export interface ToolState {
  state: 'available' | 'missing' | 'failed'
  version: string
}
export interface SourceTools {
  git: ToolState
  rg: ToolState
}
export interface SourceProject {
  projectId: string
  projectName: string
  path: string
  sourceType: 'local' | 'git'
  gitUrl: string | null
  commit: string | null
  dirty: boolean | null
  sourceStamp: string
  fileCount: number
  totalBytes: number
  registeredAt: string
}
export interface SourceCatalog {
  projects: SourceProject[]
  total: number
}
export interface SourceOpened {
  project: SourceProject
  currentStamp: string
  changed: boolean
}
export type DuplicateChoice = 'reject' | 'open' | 'new'
export function isTools(v: unknown): v is SourceTools {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    Object.keys(r).length === 2 &&
    ['git', 'rg'].every((k) => {
      const t = r[k] as ToolState | undefined
      return (
        !!t &&
        Object.keys(t).length === 2 &&
        ['available', 'missing', 'failed'].includes(t.state) &&
        typeof t.version === 'string' &&
        t.version.length < 200
      )
    })
  )
}
export function isSourceProject(v: unknown): v is SourceProject {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const r = v as Record<string, unknown>
  const keys = [
    'projectId',
    'projectName',
    'path',
    'sourceType',
    'gitUrl',
    'commit',
    'dirty',
    'sourceStamp',
    'fileCount',
    'totalBytes',
    'registeredAt'
  ]
  return (
    Object.keys(r).length === keys.length &&
    keys.every((k) => k in r) &&
    ['projectId', 'projectName', 'path', 'sourceStamp', 'registeredAt'].every(
      (k) => typeof r[k] === 'string' && !!r[k]
    ) &&
    ['local', 'git'].includes(String(r.sourceType)) &&
    (r.gitUrl === null || typeof r.gitUrl === 'string') &&
    (r.commit === null || typeof r.commit === 'string') &&
    (r.dirty === null || typeof r.dirty === 'boolean') &&
    Number.isSafeInteger(r.fileCount) &&
    Number(r.fileCount) > 0 &&
    Number.isSafeInteger(r.totalBytes) &&
    Number(r.totalBytes) >= 0
  )
}
export function isSourceCatalog(v: unknown): v is SourceCatalog {
  const r = v as SourceCatalog | null
  return (
    !!r &&
    Object.keys(r).length === 2 &&
    Array.isArray(r.projects) &&
    r.projects.length <= 100 &&
    r.projects.every(isSourceProject) &&
    Number.isSafeInteger(r.total) &&
    r.total >= r.projects.length
  )
}
export function isSourceOpened(v: unknown): v is SourceOpened {
  const r = v as SourceOpened | null
  return (
    !!r &&
    Object.keys(r).length === 3 &&
    isSourceProject(r.project) &&
    typeof r.currentStamp === 'string' &&
    typeof r.changed === 'boolean'
  )
}
