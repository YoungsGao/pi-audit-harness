import type { DuplicateChoice, SourceOpened, SourceProject } from '../../shared/source-contracts'
import { ApiError } from '../../shared/api-error.ts'
import type { SourceRepository } from './repository'
import { scanJava } from './scan.ts'
export function input(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw new ApiError('SOURCE_INPUT_INVALID', '源码输入字段无效', 400)
  return value as Record<string, unknown>
}
export function text(v: unknown, max = 4096): string {
  if (
    typeof v !== 'string' ||
    !v.trim() ||
    v.length > max ||
    Array.from(v).some((c) => c.charCodeAt(0) < 32)
  )
    throw new ApiError('SOURCE_INPUT_INVALID', '源码输入字段为空或格式无效', 400)
  return v.trim()
}
export function duplicate(v: unknown): DuplicateChoice {
  if (v === undefined) return 'reject'
  if (!['reject', 'open', 'new'].includes(String(v)))
    throw new ApiError('SOURCE_INPUT_INVALID', '重复导入选项无效', 400)
  return v as DuplicateChoice
}
export async function openProject(
  repo: SourceRepository,
  id: string,
  signal?: AbortSignal
): Promise<SourceOpened> {
  const saved = repo.get(id)
  if (!saved) throw new ApiError('SOURCE_NOT_FOUND', '未找到已登记的源码项目', 404)
  const scan = await scanJava(saved.path, signal)
  return { project: saved, currentStamp: scan.stamp, changed: scan.stamp !== saved.sourceStamp }
}
export async function importLocal(
  repo: SourceRepository,
  value: unknown,
  signal?: AbortSignal
): Promise<SourceProject> {
  const row = input(value, ['projectName', 'path', 'duplicate']),
    name = text(row.projectName, 200),
    choice = duplicate(row.duplicate)
  const scan = await scanJava(text(row.path), signal),
    key = 'local:' + scan.path.toLowerCase(),
    old = repo.find(key)
  if (old && choice === 'reject')
    throw new ApiError('SOURCE_DUPLICATE', '该来源已有记录，请明确选择打开已有或创建新记录', 409)
  if (old && choice === 'open') return (await openProject(repo, old.projectId, signal)).project
  return repo.save(name, key, scan)
}
