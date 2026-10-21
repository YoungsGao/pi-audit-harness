import { realpath, readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import type { AuditWorkItem, SourceEvidence } from '../../../shared/pi-contracts.ts'
import { ApiError } from '../../../shared/api-error.ts'
import { PiResultCollector } from '../../pi-result-collector.ts'

export async function readWorkItemEvidence(work: AuditWorkItem): Promise<SourceEvidence> {
  if (
    !Number.isInteger(work.startLine) ||
    !Number.isInteger(work.endLine) ||
    work.startLine < 1 ||
    work.endLine < work.startLine ||
    work.endLine - work.startLine >= 80
  ) {
    throw new ApiError('INVALID_AUDIT_INPUT', '证据范围必须为最多 80 行的有效行号', 400)
  }
  const root = await realpath(work.projectRoot)
  const target = await realpath(resolve(root, work.file))
  const inside = relative(root, target)
  if (
    !inside ||
    inside === '..' ||
    inside.startsWith('..\\') ||
    inside.startsWith('../') ||
    isAbsolute(inside)
  ) {
    throw new ApiError('SOURCE_OUT_OF_SCOPE', '源码文件超出本次项目范围', 403)
  }
  const info = await stat(target)
  if (!info.isFile() || info.size > 256 * 1024) {
    throw new ApiError('SOURCE_TOO_LARGE', '样例源码必须为不超过 256 KiB 的普通文件', 400)
  }
  const source = await readFile(target, 'utf8')
  const lines = source.split(/\r?\n/)
  if (work.endLine > lines.length)
    throw new ApiError('INVALID_AUDIT_INPUT', '证据行号超出文件范围', 400)
  const content = lines.slice(work.startLine - 1, work.endLine).join('\n')
  if (content.length > 12000) throw new ApiError('SOURCE_TOO_LARGE', '证据片段过长', 400)
  return {
    file: inside.replaceAll('\\', '/'),
    startLine: work.startLine,
    endLine: work.endLine,
    content,
    sha256: createHash('sha256').update(source).digest('hex')
  }
}

export function createAuditExtension(
  work: AuditWorkItem,
  collector: PiResultCollector
): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: 'audit_read_evidence',
      label: '读取当前工作项证据',
      description: '读取应用已经指定的项目文件与行号，不接受模型指定的任意路径。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        const evidence = await readWorkItemEvidence(work)
        collector.evidence.push(evidence)
        return { content: [{ type: 'text', text: JSON.stringify(evidence) }], details: evidence }
      }
    })
  }
}
