export const templateCategories = [
  'sql-injection',
  'command-injection',
  'path-traversal',
  'custom'
] as const
export const reviewFields = [
  'businessWrappers',
  'inputSources',
  'defenseConventions',
  'focus'
] as const
export const TEMPLATE_BODY_BYTES = 16384
export const REVIEW_CONTEXT_BYTES = 12288
export type TemplateCategory = (typeof templateCategories)[number]
export type TemplateOrigin = 'builtin' | 'manual' | 'markdown' | 'skill'
export interface TemplateDraft {
  name: string
  language: string
  category: TemplateCategory
  description: string
  markdown: string
  origin: TemplateOrigin
  sourceName: string | null
}
export interface TemplateRecord extends TemplateDraft {
  templateId: string
  revision: number
  createdAt: string
  verification: 'builtin-reference' | 'unverified'
}
export interface TemplateReference {
  templateId: string
  revision: number
}
export interface TemplateInput extends TemplateDraft {
  templateId?: string
  expectedRevision?: number
}
export interface ProjectReview {
  projectId: string
  revision: number
  businessWrappers: string
  inputSources: string
  defenseConventions: string
  focus: string
  updatedAt: string | null
}
export interface RunReviewConfig {
  projectId: string
  runId: string
  state: 'saved' | 'legacy-missing'
  templates: TemplateRecord[]
  projectReview: ProjectReview
  contextHash: string
  createdAt: string | null
}
export interface TemplateCatalog {
  templates: TemplateRecord[]
  total: number
}
export interface TemplateImport {
  draft: TemplateDraft
  notices: string[]
}
export type TemplateAction = 'list' | 'save' | 'import' | 'project' | 'saveProject' | 'run'
export type TemplateData =
  TemplateCatalog | TemplateRecord | TemplateImport | ProjectReview | RunReviewConfig
export const templateActions: TemplateAction[] = [
  'list',
  'save',
  'import',
  'project',
  'saveProject',
  'run'
]
export function emptyProjectReview(projectId: string): ProjectReview {
  return {
    projectId,
    revision: 0,
    businessWrappers: '',
    inputSources: '',
    defenseConventions: '',
    focus: '',
    updatedAt: null
  }
}
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  object(v) && Object.keys(v).length === keys.length && keys.every((k) => k in v)
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max && !v.includes('\0')
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v)
const revision = (v: unknown, min = 1): boolean => Number.isSafeInteger(v) && Number(v) >= min
export function isTemplateDraft(v: unknown): v is TemplateDraft {
  return (
    exact(v, ['name', 'language', 'category', 'description', 'markdown', 'origin', 'sourceName']) &&
    text(v.name, 120) &&
    !!v.name.trim() &&
    text(v.language, 40) &&
    templateCategories.includes(v.category as TemplateCategory) &&
    text(v.description, 1000) &&
    !!v.description.trim() &&
    text(v.markdown, TEMPLATE_BODY_BYTES) &&
    utf8Bytes(v.markdown) <= TEMPLATE_BODY_BYTES &&
    !!v.markdown.trim() &&
    ['builtin', 'manual', 'markdown', 'skill'].includes(String(v.origin)) &&
    (v.sourceName === null || (text(v.sourceName, 200) && !/[\\/]/.test(v.sourceName)))
  )
}
export function isTemplateRecord(v: unknown): v is TemplateRecord {
  if (!object(v)) return false
  const { templateId, revision: rev, createdAt, verification, ...draft } = v
  return (
    isTemplateDraft(draft) &&
    id(templateId) &&
    revision(rev) &&
    text(createdAt, 40) &&
    verification === (draft.origin === 'builtin' ? 'builtin-reference' : 'unverified') &&
    draft.language === 'java'
  )
}
export function isProjectReview(v: unknown): v is ProjectReview {
  return (
    exact(v, ['projectId', 'revision', ...reviewFields, 'updatedAt']) &&
    id(v.projectId) &&
    revision(v.revision, 0) &&
    reviewFields.every((k) => text(v[k], 2000)) &&
    (v.updatedAt === null || text(v.updatedAt, 40)) &&
    utf8Bytes(JSON.stringify(v)) <= 9000
  )
}
export function isRunReviewConfig(v: unknown): v is RunReviewConfig {
  return (
    exact(v, [
      'projectId',
      'runId',
      'state',
      'templates',
      'projectReview',
      'contextHash',
      'createdAt'
    ]) &&
    id(v.projectId) &&
    id(v.runId) &&
    ['saved', 'legacy-missing'].includes(String(v.state)) &&
    Array.isArray(v.templates) &&
    v.templates.length <= 4 &&
    v.templates.every(isTemplateRecord) &&
    isProjectReview(v.projectReview) &&
    v.projectReview.projectId === v.projectId &&
    text(v.contextHash, 64) &&
    /^[a-f0-9]{64}$/.test(v.contextHash) &&
    (v.createdAt === null || text(v.createdAt, 40))
  )
}
export function isTemplateData(action: TemplateAction, data: unknown): data is TemplateData {
  if (action === 'list')
    return (
      exact(data, ['templates', 'total']) &&
      Array.isArray(data.templates) &&
      data.templates.length <= 105 &&
      data.templates.every(isTemplateRecord) &&
      data.total === data.templates.length &&
      new Set(data.templates.map((t) => t.templateId)).size === data.templates.length
    )
  if (action === 'save') return isTemplateRecord(data)
  if (action === 'import')
    return (
      exact(data, ['draft', 'notices']) &&
      isTemplateDraft(data.draft) &&
      data.draft.origin !== 'builtin' &&
      Array.isArray(data.notices) &&
      data.notices.length <= 10 &&
      data.notices.every((n) => text(n, 1000))
    )
  if (action === 'run') return isRunReviewConfig(data)
  return isProjectReview(data)
}
