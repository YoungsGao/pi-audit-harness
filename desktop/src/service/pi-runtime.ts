import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { ApiError } from '../shared/api-error.ts'
import type { PiRuntimeInfo } from '../shared/pi-contracts.ts'
import { EXPECTED_PI_VERSION, loadPiSdk } from './pi-sdk.ts'
import { createPiResources } from './pi-resources.ts'

export function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof ApiError
    ? signal.reason
    : new ApiError('CANCELLED', '操作已取消', 409)
}

export function waitWithSignal<T>(
  work: Promise<T>,
  signal: AbortSignal,
  onLateResult?: (value: T) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cancel = (): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', cancel)
      try {
        throwIfCancelled(signal)
      } catch (error) {
        reject(error)
      }
    }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    work.then(
      (value) => {
        if (settled) {
          onLateResult?.(value)
          return
        }
        settled = true
        signal.removeEventListener('abort', cancel)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', cancel)
        reject(error)
      }
    )
  })
}

export class PiRuntime {
  readonly root: string
  readonly agentDir: string
  readonly workDir: string
  private info: PiRuntimeInfo = {
    state: 'not-initialized',
    sdkVersion: EXPECTED_PI_VERSION,
    message: 'Pi 尚未初始化'
  }
  private initialization?: Promise<void>
  private stopping = false
  private active?: { controller: AbortController; done: Promise<unknown> }

  constructor(root: string) {
    if (!isAbsolute(root)) throw new ApiError('INVALID_INIT', '应用数据目录必须是绝对路径', 400)
    this.root = root
    this.agentDir = join(root, 'pi-agent')
    this.workDir = join(root, 'pi-work')
  }

  getStatus(): PiRuntimeInfo {
    return { ...this.info }
  }

  initialize(): Promise<void> {
    if (this.stopping) return Promise.reject(new ApiError('SERVICE_STOPPING', '服务正在关闭', 409))
    if (this.initialization) return this.initialization
    this.info = { ...this.info, state: 'initializing', message: '正在准备 Pi 运行环境' }
    this.initialization = (async () => {
      await mkdir(this.agentDir, { recursive: true })
      await mkdir(this.workDir, { recursive: true })
      await loadPiSdk()
      await createPiResources(this.workDir, this.agentDir)
      if (this.stopping) throw new ApiError('SERVICE_STOPPING', '服务正在关闭', 409)
      this.info = { ...this.info, state: 'ready', message: 'Pi 运行环境就绪；尚未验证模型连接' }
    })().catch((error: unknown) => {
      const failure =
        error instanceof ApiError ? error : new ApiError('PI_INIT_FAILED', 'Pi 初始化失败', 503)
      if (!this.stopping) {
        this.info = { ...this.info, state: 'failed', code: failure.code, message: failure.message }
      }
      throw failure
    })
    return this.initialization
  }

  async run<T>(
    task: (signal: AbortSignal) => Promise<T>,
    timeoutMs = 15000,
    outerSignal?: AbortSignal
  ): Promise<T> {
    if (this.stopping) throw new ApiError('SERVICE_STOPPING', '服务正在关闭', 409)
    if (this.active) throw new ApiError('PI_BUSY', '已有 Pi 调用正在执行', 409)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
      throw new ApiError('INVALID_REQUEST', '超时必须在 100～120000 毫秒之间', 400)
    }
    throwIfCancelled(outerSignal)
    const controller = new AbortController()
    const cancel = (): void => controller.abort(new ApiError('CANCELLED', '操作已取消', 409))
    outerSignal?.addEventListener('abort', cancel, { once: true })
    if (outerSignal?.aborted) cancel()
    const timer = setTimeout(
      () => controller.abort(new ApiError('MODEL_TIMEOUT', 'Pi 操作超时', 504, true)),
      timeoutMs
    )
    const work = (async () => {
      await waitWithSignal(this.initialize(), controller.signal)
      throwIfCancelled(controller.signal)
      return task(controller.signal)
    })()
    const done = work.finally(() => {
      clearTimeout(timer)
      outerSignal?.removeEventListener('abort', cancel)
      if (this.active?.controller === controller) this.active = undefined
    })
    this.active = { controller, done }
    return waitWithSignal(done, controller.signal)
  }

  async close(): Promise<void> {
    this.stopping = true
    this.active?.controller.abort(new ApiError('CANCELLED', '客户端正在退出', 409))
    await Promise.allSettled([this.initialization, this.active?.done])
    this.info = { ...this.info, state: 'stopped', message: 'Pi 运行环境已关闭' }
  }
}
