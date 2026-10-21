import { utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import { randomBytes } from 'node:crypto'
import servicePath from '../service/index.ts?modulePath'
import { checkLocalHealth, postModelTest } from './service-client'
import { ApiError } from '../shared/api-error.ts'
import { isPiRuntimeInfo } from '../shared/pi-contracts.ts'
import { randomUUID } from 'node:crypto'
import type { ApiResult } from '../shared/service-protocol'
import type { ModelPingData } from '../shared/pi-contracts'
import type { ServiceStatus } from '../shared/desktop-api'
import type { ParentToService } from '../shared/service-protocol'

async function waitForExit(exited: Promise<number>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export class ServiceManager {
  private status: ServiceStatus = { status: 'stopped', message: '本地服务尚未启动' }
  private child?: UtilityProcess
  private connection?: { port: number; token: string }
  private heartbeat?: ReturnType<typeof setInterval>
  private exited?: Promise<number>
  private rejectStartup?: (error: Error) => void
  private startTask?: Promise<void>
  private stopTask?: Promise<void>
  private cleanupTask?: Promise<void>
  private runtimeRevision = 0

  constructor(
    private readonly onChange: (status: ServiceStatus) => void,
    private readonly getDataRoot: () => string
  ) {}

  getStatus(): ServiceStatus {
    return { ...this.status }
  }

  private update(status: ServiceStatus): void {
    this.status = status
    this.onChange(this.getStatus())
  }

  start(): Promise<void> {
    if (this.startTask) return this.startTask
    if (this.child) return Promise.resolve()
    this.startTask = this.launch().finally(() => {
      this.startTask = undefined
    })
    return this.startTask
  }

  private async launch(): Promise<void> {
    this.update({ status: 'starting', message: '正在启动并检查本地服务…' })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const token = randomBytes(32).toString('hex')
      const child = utilityProcess.fork(servicePath, [], {
        serviceName: 'Pi Audit Local Service',
        stdio: 'pipe'
      })
      this.child = child

      const listening = new Promise<number>((resolve, reject) => {
        this.rejectStartup = reject
        child.on('message', (message: unknown) => {
          if (this.child !== child) return
          if (!message || typeof message !== 'object' || !('type' in message)) return
          if (
            message.type === 'runtime-status' &&
            'runtime' in message &&
            isPiRuntimeInfo(message.runtime)
          ) {
            this.runtimeRevision += 1
            if (['starting', 'ready'].includes(this.status.status))
              this.update({ ...this.status, pi: message.runtime })
            return
          }
          if (
            message.type === 'listening' &&
            'port' in message &&
            Number.isInteger(message.port) &&
            Number(message.port) > 0 &&
            Number(message.port) <= 65535
          ) {
            resolve(Number(message.port))
          } else if (message.type === 'startup-error') {
            reject(
              new ApiError(
                'code' in message && typeof message.code === 'string'
                  ? message.code
                  : 'SERVICE_START_FAILED',
                'message' in message && typeof message.message === 'string'
                  ? message.message
                  : '本地服务启动失败'
              )
            )
          }
        })
      })

      this.exited = new Promise<number>((resolve) => {
        child.once('exit', (code) => {
          clearInterval(this.heartbeat)
          this.connection = undefined
          if (this.child === child) this.child = undefined
          this.rejectStartup?.(new Error(`本地服务退出，退出码 ${code}`))
          if (!['stopping', 'stopped', 'failed'].includes(this.status.status)) {
            this.update({
              status: 'failed',
              code: 'SERVICE_EXITED',
              message: `本地服务意外退出，退出码 ${code}`
            })
          }
          resolve(code)
        })
      })

      child.once('spawn', () => {
        console.info('本地服务进程 PID=', child.pid)
        const dataRoot = this.getDataRoot()
        console.info('应用运行数据目录=', dataRoot)
        const init: ParentToService = { type: 'init', token, dataRoot }
        child.postMessage(init)
        this.heartbeat = setInterval(() => {
          const message: ParentToService = { type: 'heartbeat' }
          child.postMessage(message)
        }, 2000)
      })

      const boot = listening.then(async (port) => {
        if (this.child !== child || this.status.status !== 'starting')
          throw new Error('服务启动已取消')
        this.connection = { port, token }
        const revision = this.runtimeRevision
        const health = await checkLocalHealth(port, token)
        if (health.runtime && this.runtimeRevision === revision)
          this.update({ ...this.status, pi: health.runtime })
      })
      await Promise.race([
        boot,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('本地服务启动超过 10 秒')), 10000)
        })
      ])
      if (this.child !== child || this.status.status !== 'starting')
        throw new Error('服务启动已取消')
      this.update({
        status: 'ready',
        message: '本地 HTTP 服务就绪；Pi 状态单独显示',
        pi: this.status.pi
      })
      console.info(
        `本地服务已就绪，PID=${child.pid}，地址=http://127.0.0.1:${this.connection?.port}`
      )
    } catch (error) {
      if (!['stopping', 'stopped'].includes(this.status.status)) {
        this.update({
          status: 'failed',
          code: error instanceof ApiError ? error.code : 'SERVICE_START_FAILED',
          requestId: error instanceof ApiError ? error.requestId : undefined,
          message: error instanceof Error ? error.message : '本地服务启动失败'
        })
      }
      await this.cleanup()
      throw error
    } finally {
      clearTimeout(timer)
      this.rejectStartup = undefined
    }
  }

  async checkHealth(): Promise<ServiceStatus> {
    const connection = this.connection
    if (!connection || this.status.status !== 'ready') return this.getStatus()
    const revision = this.runtimeRevision
    try {
      const health = await checkLocalHealth(connection.port, connection.token)
      if (this.connection === connection && health.runtime && this.runtimeRevision === revision)
        this.update({ ...this.status, pi: health.runtime })
    } catch (error) {
      if (this.connection === connection && this.status.status === 'ready') {
        this.update({
          status: 'failed',
          code: error instanceof ApiError ? error.code : 'HEALTH_CHECK_FAILED',
          requestId: error instanceof ApiError ? error.requestId : undefined,
          message: error instanceof Error ? error.message : '健康检查失败'
        })
      }
    }
    return this.getStatus()
  }

  async testModel(configId: string): Promise<ApiResult<ModelPingData>> {
    const connection = this.connection
    if (!connection || this.status.status !== 'ready') {
      return {
        ok: false,
        requestId: randomUUID(),
        error: { code: 'SERVICE_NOT_READY', message: '本地服务尚未就绪', retryable: true }
      }
    }
    return postModelTest(connection.port, connection.token, configId)
  }

  private cleanup(): Promise<void> {
    if (this.cleanupTask) return this.cleanupTask
    const child = this.child
    const exited = this.exited
    if (!child || !exited) return Promise.resolve()

    clearInterval(this.heartbeat)
    this.cleanupTask = (async () => {
      const shutdown: ParentToService = { type: 'shutdown' }
      child.postMessage(shutdown)
      if (!(await waitForExit(exited, 3000))) {
        child.kill()
        if (!(await waitForExit(exited, 1000))) throw new Error('本地服务未在期限内退出')
      }
    })().finally(() => {
      this.cleanupTask = undefined
    })
    return this.cleanupTask
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask
    this.update({ status: 'stopping', message: '正在关闭本地服务…' })
    this.rejectStartup?.(new Error('客户端正在退出'))
    this.stopTask = this.cleanup()
      .then(() => {
        this.update({ status: 'stopped', message: '本地服务已停止' })
      })
      .finally(() => {
        this.stopTask = undefined
      })
    return this.stopTask
  }
}
