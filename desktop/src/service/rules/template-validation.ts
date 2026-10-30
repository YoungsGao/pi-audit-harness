import { ApiError } from '../../shared/api-error.ts'
import { isTemplateDraft, reviewFields, utf8Bytes } from '../../shared/template-contracts.ts'
import type { TemplateInput, ProjectReview } from '../../shared/template-contracts'
export function templateObject(v: unknown, keys: string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    throw new ApiError('TEMPLATE_INPUT_INVALID', '模板请求字段无效', 400)
  return v as Record<string, unknown>
}
export function templateId(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(v))
    throw new ApiError('TEMPLATE_INPUT_INVALID', '模板或项目标识无效', 400)
  return v
}
export function validateTemplate(v: unknown): TemplateInput {
  const row = templateObject(v, [
    'templateId',
    'expectedRevision',
    'name',
    'language',
    'category',
    'description',
    'markdown',
    'origin',
    'sourceName'
  ])
  const { templateId: id, expectedRevision, ...draft } = row
  if (
    !isTemplateDraft(draft) ||
    draft.language !== 'java' ||
    draft.origin === 'builtin' ||
    /[\r\n\t]/.test(draft.name) ||
    (draft.sourceName !== null && /[\r\n\t]/.test(draft.sourceName))
  )
    throw new ApiError(
      'TEMPLATE_FIELDS_INVALID',
      '请填写名称、Java 语言、分类、简介和 Markdown 正文（最多 16KiB）；自定义模板不可标为内置',
      400
    )
  if (id !== undefined) {
    templateId(id)
    if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1)
      throw new ApiError('TEMPLATE_INPUT_INVALID', '编辑模板需要当前版本号', 400)
  } else if (expectedRevision !== undefined)
    throw new ApiError('TEMPLATE_INPUT_INVALID', '新模板不应携带旧版本号', 400)
  return {
    ...draft,
    name: draft.name.trim(),
    description: draft.description.trim(),
    ...(id === undefined
      ? {}
      : { templateId: id as string, expectedRevision: Number(expectedRevision) })
  }
}
export function validateProjectReview(
  v: unknown
): Omit<ProjectReview, 'revision' | 'updatedAt'> & { expectedRevision: number } {
  const row = templateObject(v, ['projectId', 'expectedRevision', ...reviewFields])
  templateId(row.projectId)
  if (
    !Number.isSafeInteger(row.expectedRevision) ||
    Number(row.expectedRevision) < 0 ||
    reviewFields.some(
      (k) =>
        typeof row[k] !== 'string' || String(row[k]).length > 2000 || String(row[k]).includes('\0')
    ) ||
    utf8Bytes(JSON.stringify(row)) > 8192
  )
    throw new ApiError(
      'PROJECT_REVIEW_INVALID',
      '补充要求每项最多 2000 字符，总计最多 8KiB，并需携带当前版本',
      400
    )
  return row as unknown as ReturnType<typeof validateProjectReview>
}
