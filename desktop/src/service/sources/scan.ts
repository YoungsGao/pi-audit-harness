import { lstat, realpath, readdir, readFile } from 'node:fs/promises'
import { join, isAbsolute, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { ApiError } from '../../shared/api-error.ts'
export interface SourceScan {
  path: string
  stamp: string
  fileCount: number
  totalBytes: number
  files: { filePath: string; sha256: string; size: number }[]
}
const skipped = new Set([
  '.git',
  '.svn',
  'node_modules',
  'target',
  'build',
  'dist',
  '.idea',
  '.gradle',
  'vendor'
])
// 首批支持 Java/Spring 源码。这里只验证可读源码并生成指纹，不编译、不运行项目脚本。
export async function scanJava(directory: string, signal?: AbortSignal): Promise<SourceScan> {
  const check = (): void => {
    if (signal?.aborted) throw new ApiError('SOURCE_CANCELLED', '源码操作已取消', 499)
  }
  if (!isAbsolute(directory)) throw new ApiError('SOURCE_PATH_INVALID', '请选择本地绝对目录', 400)
  let root: string
  try {
    root = await realpath(directory)
    if (!(await lstat(root)).isDirectory()) throw new Error()
  } catch {
    throw new ApiError('SOURCE_PATH_UNAVAILABLE', '源码目录不存在或无法读取', 400)
  }
  const hashes: string[] = []
  const files: SourceScan['files'] = []
  let totalBytes = 0,
    visited = 0
  async function walk(folder: string, depth: number): Promise<void> {
    check()
    if (depth > 32) throw new ApiError('SOURCE_LIMIT', '目录深度超过 32 层', 413)
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      check()
      if (++visited > 20000)
        throw new ApiError('SOURCE_LIMIT', '目录项超过 20000，请选择较小源码目录', 413)
      if (skipped.has(entry.name)) continue
      const file = join(folder, entry.name),
        before = await lstat(file)
      if (before.isSymbolicLink()) continue // 不跟随链接/目录联接到工程外。
      if (before.isDirectory()) {
        await walk(file, depth + 1)
        continue
      }
      if (!before.isFile() || !entry.name.toLowerCase().endsWith('.java')) continue
      if (
        before.size > 2 * 1024 * 1024 ||
        totalBytes + before.size > 20 * 1024 * 1024 ||
        hashes.length >= 2000
      )
        throw new ApiError('SOURCE_LIMIT', '最多 2000 个 Java 文件、单文件 2MiB、总计 20MiB', 413)
      const actual = await realpath(file),
        rel = relative(root, actual)
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
        throw new ApiError('SOURCE_CHANGED', '源码目录发生变化，请重试', 409)
      const content = await readFile(file),
        after = await lstat(file)
      if (
        after.isSymbolicLink() ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        content.length !== before.size
      )
        throw new ApiError('SOURCE_CHANGED', '读取期间文件发生变化，请重试', 409)
      totalBytes += content.length
      const filePath = relative(root, file).split(sep).join('/'),
        sha256 = createHash('sha256').update(content).digest('hex')
      files.push({ filePath, sha256, size: content.length })
      hashes.push(JSON.stringify([filePath, sha256]))
    }
  }
  try {
    await walk(root, 0)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('SOURCE_PATH_UNAVAILABLE', '源码文件无法读取，请检查权限', 400)
  }
  check()
  if (!hashes.length)
    throw new ApiError('SOURCE_NO_JAVA', '没有可读 Java 源文件；请检查目录或支持范围', 400)
  return {
    path: root,
    stamp: 'java-sha256:' + createHash('sha256').update(hashes.sort().join('\n')).digest('hex'),
    fileCount: hashes.length,
    totalBytes,
    files: files.sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0))
  }
}
