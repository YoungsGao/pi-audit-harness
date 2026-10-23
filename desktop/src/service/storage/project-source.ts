import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ApiError } from '../../shared/api-error.ts'
import type { ProjectInput } from '../../shared/metadata-contracts'
const execute = promisify(execFile)
export interface ProjectSource {
  path: string
  commit: string | null
  dirty: boolean | null
}

export async function inspectProject(input: ProjectInput): Promise<ProjectSource> {
  if (!isAbsolute(input.path))
    throw new ApiError('INVALID_PROJECT_PATH', '源码目录必须为绝对路径', 400)
  let path: string
  try {
    path = await realpath(input.path)
    if (!(await stat(path)).isDirectory()) throw new Error()
  } catch {
    throw new ApiError('PROJECT_PATH_UNAVAILABLE', '源码目录不存在或无法访问', 400)
  }
  if (input.sourceType === 'local') return { path, commit: null, dirty: null }
  try {
    // 参数数组传递，不启动 shell；不执行 clone、fetch、pull 或用户提供的命令。
    const git = async (args: string[]): Promise<string> =>
      (
        await execute('git', ['-C', path, ...args], {
          windowsHide: true,
          timeout: 3000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
        })
      ).stdout.trim()
    const top = await realpath(await git(['rev-parse', '--show-toplevel']))
    if (top.toLowerCase() !== path.toLowerCase()) throw new Error('not repository root')
    const commit = await git(['rev-parse', '--verify', 'HEAD'])
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('invalid commit')
    const dirty = !!(await git(['status', '--porcelain=v1', '--untracked-files=normal']))
    return { path, commit, dirty }
  } catch {
    throw new ApiError(
      'GIT_METADATA_UNAVAILABLE',
      '无法读取 Git 仓库根目录、HEAD 或工作区状态，请确认 Git 已安装且至少有一次提交',
      400
    )
  }
}
