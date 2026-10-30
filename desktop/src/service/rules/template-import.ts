import { lstat, open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import { ApiError } from '../../shared/api-error.ts'
import {
  TEMPLATE_BODY_BYTES,
  templateCategories,
  utf8Bytes
} from '../../shared/template-contracts.ts'
import type { TemplateImport, TemplateDraft } from '../../shared/template-contracts'
import { templateObject } from './template-validation.ts'

export function parseTemplateDocument(
  document: string,
  sourceName: string,
  skill = false
): TemplateImport {
  if (document.includes('\0'))
    throw new ApiError('TEMPLATE_ENCODING_INVALID', '文档包含 NUL 字节，请使用纯 UTF-8 文本', 400)
  const source = document.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const front = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/),
    fields: Record<string, string> = {}
  if (front) {
    const rows = front[1].split('\n')
    for (let i = 0; i < rows.length; i++) {
      const pair = rows[i].match(/^(name|title|description|language|category):\s*(.*?)\s*$/)
      if (!pair) continue
      let value = pair[2]
      if (/^[|>][-+]?\s*$/.test(value)) {
        const lines: string[] = []
        while (i + 1 < rows.length && /^\s+\S/.test(rows[i + 1])) lines.push(rows[++i].trim())
        value = lines.join(' ')
      }
      fields[pair[1]] = value.replace(/^(['"])([\s\S]*)\1$/, '$2')
    }
  }
  const markdown = (front ? source.slice(front[0].length) : source).trim()
  if (!markdown || utf8Bytes(markdown) > TEMPLATE_BODY_BYTES)
    throw new ApiError(
      'TEMPLATE_DOCUMENT_LIMIT',
      '文档正文不能为空且最多 16KiB，请缩减后再导入',
      413
    )
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
  const paragraph = markdown
    .split(/\n\s*\n/)
    .find((p) => !/^\s*(#|```|~~~|<)/.test(p))
    ?.replace(/\n/g, ' ')
    .trim()
  const category = templateCategories.includes(fields.category as TemplateDraft['category'])
    ? (fields.category as TemplateDraft['category'])
    : 'custom'
  const draft: TemplateDraft = {
    name: (fields.name || fields.title || heading || sourceName.replace(/\.md$/i, '')).slice(
      0,
      120
    ),
    language: (fields.language || 'java').toLowerCase().slice(0, 40),
    category,
    description: (
      fields.description ||
      paragraph ||
      '导入的审计知识文档，请补充简介并核对适用范围。'
    ).slice(0, 1000),
    markdown,
    origin: skill ? 'skill' : 'markdown',
    sourceName: sourceName.slice(0, 200)
  }
  return {
    draft,
    notices: [
      '自定义审计知识未经验证，不代表新增完整漏洞发现能力。',
      '仅导入文档正文；不执行脚本、安装命令、扩展或外部链接，不递归读取引用文件。',
      ...(front ? ['仅提取已识别的前置信息标量；复杂 YAML 不解释，请核对字段。'] : [])
    ]
  }
}

export async function importTemplateDocument(
  value: unknown,
  signal?: AbortSignal
): Promise<TemplateImport> {
  const row = templateObject(value, ['path', 'kind'])
  if (
    typeof row.path !== 'string' ||
    row.path.length > 4096 ||
    !isAbsolute(row.path) ||
    !['file', 'directory'].includes(String(row.kind))
  )
    throw new ApiError(
      'TEMPLATE_IMPORT_INVALID',
      '请选择本地 Markdown 文件或包含 SKILL.md 的目录',
      400
    )
  if (signal?.aborted) throw new ApiError('TEMPLATE_CANCELLED', '模板导入已取消', 499)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const selected = await lstat(row.path)
    if (selected.isSymbolicLink())
      throw new ApiError('TEMPLATE_IMPORT_UNSAFE', '不导入符号链接或目录联接', 400)
    const root = await realpath(row.path)
    const file = row.kind === 'directory' ? join(root, 'SKILL.md') : root
    if (row.kind === 'directory' && !selected.isDirectory()) throw new Error('not directory')
    if (!/\.md$/i.test(file)) throw new ApiError('TEMPLATE_IMPORT_INVALID', '只支持 .md 文档', 400)
    const before = await lstat(file)
    if (!before.isFile() || before.isSymbolicLink() || before.size > 32768)
      throw new ApiError(
        'TEMPLATE_DOCUMENT_LIMIT',
        '文档必须为普通文件且最多 32KiB（含前置信息）',
        413
      )
    const actual = await realpath(file)
    if (row.kind === 'directory' && relative(root, actual) !== 'SKILL.md')
      throw new ApiError('TEMPLATE_IMPORT_UNSAFE', 'Skill 文档超出所选目录', 400)
    handle = await open(file, 'r')
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.size > 32768
    )
      throw new ApiError('TEMPLATE_IMPORT_CHANGED', '读取前文件发生变化，请重新选择', 409)
    const bytes = Buffer.alloc(32769)
    const read = await handle.read(bytes, 0, bytes.length, 0),
      after = await handle.stat(),
      pathAfter = await lstat(file)
    if (
      read.bytesRead > 32768 ||
      read.bytesRead !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      pathAfter.isSymbolicLink() ||
      pathAfter.ino !== opened.ino ||
      pathAfter.dev !== opened.dev
    )
      throw new ApiError('TEMPLATE_IMPORT_CHANGED', '读取期间文件发生变化，请重试', 409)
    if (signal?.aborted) throw new ApiError('TEMPLATE_CANCELLED', '模板导入已取消', 499)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead))
    } catch {
      throw new ApiError('TEMPLATE_ENCODING_INVALID', '请将文档保存为 UTF-8 编码', 400)
    }
    return parseTemplateDocument(
      text,
      basename(file),
      row.kind === 'directory' || basename(file).toUpperCase() === 'SKILL.MD'
    )
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(
      'TEMPLATE_IMPORT_UNAVAILABLE',
      '无法读取所选文档；Skill 目录必须直接包含 SKILL.md',
      400
    )
  } finally {
    await handle?.close()
  }
}
