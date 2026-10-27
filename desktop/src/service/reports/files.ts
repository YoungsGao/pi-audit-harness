import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath, mkdir, writeFile, rename, unlink, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ApiError } from '../../shared/api-error.ts'
import { reportId } from '../../shared/report-contracts.ts'
import type { ReportFile } from '../../shared/report-contracts'

const same = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
async function ownedDirectory(dataRoot: string): Promise<string> {
  const dir = join(resolve(dataRoot), 'reports')
  const info = await lstat(dir)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !same(await realpath(dir), join(await realpath(dataRoot), 'reports'))
  )
    throw new ApiError('REPORT_UNSAFE_FILE', '报告目录不是应用持有的普通目录', 409)
  return dir
}
export function reportFilePath(dataRoot: string, id: string): string {
  if (!reportId(id)) throw new ApiError('REPORT_INVALID_INPUT', '报告标识无效', 400)
  return join(resolve(dataRoot), 'reports', id + '.html')
}
export async function publishReport(dataRoot: string, id: string, html: string): Promise<string> {
  if (Buffer.byteLength(html) > 20 * 1024 * 1024)
    throw new ApiError('REPORT_LIMIT', 'HTML 报告超过 20MiB，未静默截断', 413)
  await mkdir(join(dataRoot, 'reports'), { recursive: true })
  await ownedDirectory(dataRoot)
  const file = reportFilePath(dataRoot, id)
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, html, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return createHash('sha256').update(html).digest('hex')
}
export async function verifyReportFile(dataRoot: string, file: ReportFile): Promise<void> {
  if (!same(resolve(file.filePath), reportFilePath(dataRoot, file.reportId)))
    throw new ApiError('REPORT_UNSAFE_FILE', '报告文件不属于当前应用报告目录', 409)
  try {
    const dir = await ownedDirectory(dataRoot)
    const info = await lstat(file.filePath)
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.size > 20 * 1024 * 1024 ||
      !same(await realpath(file.filePath), join(await realpath(dir), file.reportId + '.html'))
    )
      throw new ApiError('REPORT_UNSAFE_FILE', '报告文件类型或归属无效', 409)
    const bytes = await readFile(file.filePath)
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw new ApiError(
        'REPORT_FILE_CHANGED',
        '报告文件已被修改，拒绝作为原报告打开；请重新生成',
        409
      )
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('REPORT_FILE_MISSING', '报告文件不存在或无法读取，请重新生成', 404)
  }
}
