import { spawn, execFile } from 'node:child_process'
import { ApiError } from '../../shared/api-error.ts'
export interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
  allowedExitCodes?: readonly number[]
}
// 参数数组交给 spawn，永远不启用 shell；输出仅供内部解析，不回显供应商/本地命令原文。
export function command(
  executable: string,
  args: string[],
  options: CommandOptions = {}
): Promise<string> {
  if (options.signal?.aborted)
    return Promise.reject(new ApiError('SOURCE_CANCELLED', '源码操作已取消', 499))
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = '',
      bytes = 0,
      failure: ApiError | undefined
    const stop = (error: ApiError): void => {
      if (failure) return
      failure = error
      // Windows 的 Git 可能派生 remote-https；只终止本次创建且尚未关闭的进程树。
      if (process.platform === 'win32' && child.pid && child.exitCode === null) {
        execFile(
          'taskkill.exe',
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true },
          () => {
            if (child.exitCode === null) child.kill()
          }
        )
      } else child.kill('SIGKILL')
    }
    const abort = (): void => stop(new ApiError('SOURCE_CANCELLED', '源码操作已取消', 499))
    const timer = setTimeout(
      () =>
        stop(
          new ApiError('SOURCE_COMMAND_TIMEOUT', '工具执行超时，请检查网络或工具环境', 504, true)
        ),
      options.timeoutMs ?? 4000
    )
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) stop(new ApiError('SOURCE_OUTPUT_LIMIT', '工具输出超过限制', 413))
      else output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) stop(new ApiError('SOURCE_OUTPUT_LIMIT', '工具输出超过限制', 413))
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      failure ??= new ApiError(
        error.code === 'ENOENT' ? 'TOOL_MISSING' : 'SOURCE_COMMAND_FAILED',
        '工具不可用或执行失败',
        503
      )
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (!(options.allowedExitCodes ?? [0]).includes(code ?? -1))
        reject(
          new ApiError(
            'SOURCE_COMMAND_FAILED',
            '工具执行失败；请检查仓库是否公开、网络和目录权限',
            502,
            true
          )
        )
      else resolve(output.trim())
    })
  })
}
