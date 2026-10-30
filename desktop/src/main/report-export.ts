import { dirname, basename, extname, relative, isAbsolute, join } from 'node:path'
import { lstat, realpath, writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { ApiError } from '../shared/api-error.ts'
import type { ReportFile } from '../shared/report-contracts.ts'
import { readVerifiedReport } from '../service/reports/files.ts'

// destination is only supplied by the native save dialog (or a trusted test adapter).
export async function saveReportCopy(
  dataRoot: string,
  file: ReportFile,
  destination: string
): Promise<string> {
  if (!isAbsolute(destination) || extname(destination).toLowerCase() !== '.' + file.format)
    throw new ApiError('REPORT_SAVE_EXTENSION', '请选择匹配的 .' + file.format + ' 文件名', 400)
  const bytes = await readVerifiedReport(dataRoot, file)
  const parent = await realpath(dirname(destination)),
    root = await realpath(dataRoot)
  const rel = relative(root, parent)
  if (
    !rel ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../'))
  )
    throw new ApiError(
      'REPORT_SAVE_INTERNAL',
      '请选择应用运行数据目录之外的位置，避免覆盖已登记产物',
      400
    )
  const target = join(parent, basename(destination))
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new ApiError('REPORT_SAVE_UNSAFE', '目标不是普通文件，请另选位置', 409)
  const temporary = join(parent, '.pi-audit-export-' + randomUUID() + '.tmp')
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    if ((await realpath(dirname(destination))) !== parent)
      throw new ApiError('REPORT_SAVE_UNSAFE', '保存目录发生变化，请重新选择', 409)
    await rename(temporary, target)
    return target
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
