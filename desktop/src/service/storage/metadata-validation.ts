import { ApiError } from '../../shared/api-error.ts'
import type { ModelInput, ProjectInput } from '../../shared/metadata-contracts'

function invalid(): never {
  throw new ApiError('INVALID_METADATA', '元数据字段不完整或格式无效', 400)
}
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    return invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    return invalid()
  return value.trim()
}
function identity(row: Record<string, unknown>, key: string): void {
  if (
    row[key] !== undefined &&
    (typeof row[key] !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(String(row[key])))
  )
    invalid()
  if (
    row[key] === undefined
      ? row.expectedRevision !== undefined
      : !Number.isSafeInteger(row.expectedRevision) || Number(row.expectedRevision) < 1
  )
    invalid()
}
export function cleanUrl(value: unknown): string {
  const input = text(value, 2048)
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return invalid()
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    invalid()
  return url.toString().replace(/\/$/, '')
}
export function parseProject(value: unknown): ProjectInput {
  const row = fields(value, [
    'projectId',
    'expectedRevision',
    'projectName',
    'path',
    'sourceType',
    'gitUrl'
  ])
  identity(row, 'projectId')
  if (!['local', 'git'].includes(String(row.sourceType))) invalid()
  const gitUrl =
    row.gitUrl === undefined || row.gitUrl === null || row.gitUrl === ''
      ? null
      : cleanUrl(row.gitUrl)
  if (row.sourceType === 'git' && !gitUrl) invalid()
  return {
    projectId: row.projectId as string | undefined,
    expectedRevision: row.expectedRevision as number | undefined,
    projectName: text(row.projectName, 200),
    path: text(row.path, 4096),
    sourceType: row.sourceType as 'local' | 'git',
    gitUrl
  }
}
export function parseModel(value: unknown): ModelInput {
  const row = fields(value, [
    'configId',
    'expectedRevision',
    'name',
    'baseUrl',
    'modelId',
    'apiKey'
  ])
  identity(row, 'configId')
  const result: ModelInput = {
    configId: row.configId as string | undefined,
    expectedRevision: row.expectedRevision as number | undefined,
    name: text(row.name, 200),
    baseUrl: cleanUrl(row.baseUrl),
    modelId: text(row.modelId, 200)
  }
  if (row.apiKey !== undefined) {
    if (
      typeof row.apiKey !== 'string' ||
      !row.apiKey.trim() ||
      Buffer.byteLength(row.apiKey, 'utf8') > 2048 ||
      Array.from(row.apiKey).some((character) => character.charCodeAt(0) < 32)
    )
      invalid()
    result.apiKey = row.apiKey // 不擅自修剪真实密钥；读取接口绝不返回此字段。
  }
  return result
}
