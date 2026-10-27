import { readFile, lstat, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative, isAbsolute, sep } from 'node:path'
import { ApiError } from '../../shared/api-error.ts'
import type {
  CodeQueryAction,
  RiskQueryResult,
  SourceRange
} from '../../shared/code-query-contracts.ts'
import type { SourceRepository } from '../sources/repository.ts'
import { scanJava } from '../sources/scan.ts'
import type { SourceScan } from '../sources/scan.ts'
import { command } from '../sources/process.ts'
import { builtinRules, findRiskCandidates } from '../rules/builtin.ts'
import { indexJavaFile } from '../scanning/java-index.ts'

export function queryInput(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new ApiError('QUERY_INVALID_INPUT', '查询字段无效', 400)
  return value as Record<string, unknown>
}
export function queryText(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32)
  )
    throw new ApiError('QUERY_INVALID_INPUT', '查询文本为空、过长或包含控制字符', 400)
  return value
}
export function queryInteger(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max)
    throw new ApiError('QUERY_INVALID_INPUT', `查询数值必须为 1 到 ${max} 的整数`, 400)
  return Number(value)
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw new ApiError('QUERY_CANCELLED', '代码查询已取消', 499)
}

export class CodeQueryService {
  private readonly repo: SourceRepository
  private readonly closing = new AbortController()
  private readonly tasks = new Set<Promise<unknown>>()
  constructor(repo: SourceRepository) {
    this.repo = repo
  }
  project(projectId: string): import('../../shared/source-contracts').SourceProject {
    const project = this.repo.get(queryText(projectId, 80))
    if (!project) throw new ApiError('SOURCE_NOT_FOUND', '未找到已登记源码项目', 404)
    return project
  }
  async methodContext(
    projectId: string,
    filePath: string,
    methodKey: string,
    signal: AbortSignal
  ): Promise<{
    filePath: string
    startLine: number
    endLine: number
    text: string
    complete: boolean
  } | null> {
    const { scan } = await this.scope(projectId, signal)
    const source = await this.readSource(scan, filePath, signal)
    if (Buffer.byteLength(source) > 256 * 1024) return null
    let method
    try {
      method = indexJavaFile(filePath, source).methods.find((m) => m.key === methodKey)
    } catch {
      return null
    }
    if (!method) return null
    const first = source.slice(0, method.start).split('\n').length
    const last = source.slice(0, method.end + 1).split('\n').length
    const endLine = Math.min(last, first + 79)
    const full = source
      .split('\n')
      .slice(first - 1, endLine)
      .join('\n')
    return {
      filePath,
      startLine: first,
      endLine,
      text: full.slice(0, 12000),
      complete: endLine === last && full.length <= 12000
    }
  }

  async action(action: CodeQueryAction, value: unknown, signal?: AbortSignal): Promise<unknown> {
    const combined = AbortSignal.any([this.closing.signal, ...(signal ? [signal] : [])])
    check(combined)
    if (this.tasks.size >= 2) throw new ApiError('QUERY_BUSY', '已有代码查询执行中', 429, true)
    const task = this.execute(action, value, combined)
    this.tasks.add(task)
    try {
      return await task
    } finally {
      this.tasks.delete(task)
    }
  }
  async close(): Promise<void> {
    this.closing.abort()
    await Promise.allSettled(this.tasks)
  }

  async sourceSnapshot(
    projectId: string,
    signal: AbortSignal
  ): Promise<{ sourceStamp: string; files: { filePath: string; source: string }[] }> {
    const { scan } = await this.scope(projectId, signal)
    const files: { filePath: string; source: string }[] = []
    for (const file of scan.files)
      files.push({
        filePath: file.filePath,
        source: await this.readSource(scan, file.filePath, signal)
      })
    return { sourceStamp: scan.stamp, files }
  }

  private async scope(
    projectId: unknown,
    signal: AbortSignal
  ): Promise<{ projectId: string; scan: SourceScan }> {
    const id = queryText(projectId, 80),
      project = this.repo.get(id)
    if (!project) throw new ApiError('SOURCE_NOT_FOUND', '未找到已登记源码项目', 404)
    const scan = await scanJava(project.path, signal)
    check(signal)
    if (scan.stamp !== project.sourceStamp)
      throw new ApiError(
        'QUERY_SOURCE_CHANGED',
        'Java 源码已变化，请重新登记后查询，避免引用旧证据',
        409
      )
    return { projectId: id, scan }
  }

  private async readSource(
    scan: SourceScan,
    filePath: string,
    signal: AbortSignal
  ): Promise<string> {
    check(signal)
    const file = scan.files.find((item) => item.filePath === filePath)
    if (!file) throw new ApiError('QUERY_FILE_OUT_OF_SCOPE', '文件不在当前 Java 查询范围', 403)
    // 再次检查中间目录，防止登记后用目录联接把文件替换到工程外。
    let current = scan.path
    for (const part of filePath.split('/')) {
      current = join(current, part)
      if ((await lstat(current)).isSymbolicLink())
        throw new ApiError('QUERY_SOURCE_CHANGED', '源码路径变为链接，请重试', 409)
    }
    const actual = await realpath(current),
      rel = relative(scan.path, actual)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
      throw new ApiError('QUERY_FILE_OUT_OF_SCOPE', '源码文件超出工程范围', 403)
    const info = await lstat(current)
    if (!info.isFile() || info.size > 2 * 1024 * 1024)
      throw new ApiError('QUERY_SOURCE_CHANGED', '源码文件发生变化', 409)
    const bytes = await readFile(current, { signal })
    check(signal)
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw new ApiError('QUERY_SOURCE_CHANGED', '读取期间源码发生变化，请重试', 409)
    return bytes.toString('utf8')
  }

  private async execute(
    action: CodeQueryAction,
    value: unknown,
    signal: AbortSignal
  ): Promise<unknown> {
    try {
      const row = queryInput(
        value,
        action === 'search'
          ? ['projectId', 'text', 'maxResults']
          : action === 'read'
            ? ['projectId', 'filePath', 'startLine', 'endLine']
            : ['projectId', 'maxResults']
      )
      const { projectId, scan } = await this.scope(row.projectId, signal)
      if (action === 'read') {
        const filePath = queryText(row.filePath, 1000)
        if (
          isAbsolute(filePath) ||
          filePath.includes('\\') ||
          filePath.split('/').some((p) => !p || p === '.' || p === '..')
        )
          throw new ApiError('QUERY_INVALID_INPUT', '必须使用工程内相对文件路径', 400)
        const startLine = queryInteger(row.startLine, 1, 1000000),
          endLine = queryInteger(row.endLine, startLine, 1000000)
        if (endLine < startLine || endLine - startLine >= 80)
          throw new ApiError('QUERY_INVALID_INPUT', '每次读取最多 80 行', 400)
        const source = await this.readSource(scan, filePath, signal),
          lines = source.split('\n')
        if (endLine > lines.length)
          throw new ApiError('QUERY_INVALID_INPUT', '源码行号超出文件范围', 400)
        const text = lines.slice(startLine - 1, endLine).join('\n')
        if (text.length > 12000)
          throw new ApiError('QUERY_OUTPUT_LIMIT', '源码片段超过 12000 字符，请缩小行范围', 413)
        return {
          projectId,
          sourceStamp: scan.stamp,
          filePath,
          startLine,
          endLine,
          text,
          fileSha256: scan.files.find((f) => f.filePath === filePath)!.sha256
        }
      }
      const limit = queryInteger(row.maxResults, 50, 100)
      if (action === 'risks') {
        const candidates: RiskQueryResult['candidates'] = []
        for (const file of scan.files) {
          const source = await this.readSource(scan, file.filePath, signal)
          candidates.push(
            ...findRiskCandidates(file.filePath, source, limit + 1 - candidates.length)
          )
          if (candidates.length > limit) break
        }
        return {
          projectId,
          sourceStamp: scan.stamp,
          rulesVersion: builtinRules.version,
          candidates: candidates.slice(0, limit),
          truncated: candidates.length > limit
        } satisfies RiskQueryResult
      }
      const text = queryText(row.text, 200),
        matches: (SourceRange & { resolutionStatus: 'candidate' })[] = []
      // Windows 命令行长度有限；只传已验证清单，分批限制参数总长度。
      const pending = [...scan.files]
      while (pending.length && matches.length <= limit) {
        const batch: SourceScan['files'] = []
        let length = 0
        while (pending.length && batch.length < 32 && length + pending[0].filePath.length < 12000) {
          const file = pending.shift()!
          length += file.filePath.length + 3
          batch.push(file)
        }
        if (!batch.length) throw new ApiError('QUERY_INVALID_INPUT', '源码相对路径过长', 400)
        const output = await command(
          'rg',
          [
            '--json',
            '--no-config',
            '--no-ignore',
            '--text',
            '--fixed-strings',
            '--case-sensitive',
            '--max-count',
            String(limit + 1),
            '--',
            text,
            ...batch.map((f) => f.filePath)
          ],
          { cwd: scan.path, signal, allowedExitCodes: [0, 1] }
        )
        for (const line of output.split('\n').filter(Boolean)) {
          const event = JSON.parse(line)
          if (event.type !== 'match') continue
          const filePath = String(event.data.path.text).split('\\').join('/').replace(/^\.\//, '')
          if (!batch.some((file) => file.filePath === filePath))
            throw new ApiError('QUERY_TOOL_OUTPUT_INVALID', '查询工具返回范围外文件', 502)
          const source = await this.readSource(scan, filePath, signal),
            lineNumber = Number(event.data.line_number)
          const raw = source.split('\n')[lineNumber - 1]
          const offset = raw?.indexOf(text) ?? -1
          if (offset < 0)
            throw new ApiError('QUERY_TOOL_OUTPUT_INVALID', '查询位置与源码不一致', 502)
          if (raw.length > 12000)
            throw new ApiError('QUERY_OUTPUT_LIMIT', '匹配行过长，请改用小范围读取', 413)
          matches.push({
            filePath,
            startLine: lineNumber,
            endLine: lineNumber,
            startColumn: offset + 1,
            endColumn: offset + text.length + 1,
            text: raw,
            resolutionStatus: 'candidate'
          })
          if (matches.length > limit) break
        }
      }
      return {
        projectId,
        sourceStamp: scan.stamp,
        backend: 'rg',
        matches: matches.slice(0, limit),
        truncated: matches.length > limit
      }
    } catch (error) {
      check(signal)
      if (error instanceof ApiError) throw error
      throw new ApiError('QUERY_FAILED', '代码查询失败，请检查文件与工具状态', 502)
    }
  }
}
