import { sourceRequest } from './source-client'
import { connectAnalyze } from './analyze-stream-client'
import type { AnalyzeRequest, StreamHandle, StreamNotice } from '../shared/sse-contracts'
import { auditRequest } from './audit-client'
import { templateRequest } from './template-client'
import type { AuditAction, AuditData } from '../shared/scan-contracts'
import type { SourceAction } from './source-client'
import { utilityProcess } from 'electron'
import { modelSettingsRequest } from './model-settings-client'
import type { ModelCatalog } from '../shared/model-settings'
import { metadataRequest } from './metadata-client'
import type { MetadataOverview, ProjectRecord, ModelSaveResult } from '../shared/metadata-contracts'
import { readStorageOverview } from './storage-client'
import type { StorageOverview } from '../shared/storage-contracts'
import type { UtilityProcess } from 'electron'
import { randomBytes } from 'node:crypto'
import servicePath from '../service/index.ts?modulePath'
import { checkLocalHealth, postModelTest } from './service-client'
import { ApiError } from '../shared/api-error.ts'
import { isPiRuntimeInfo } from '../shared/pi-contracts.ts'
import { randomUUID } from 'node:crypto'
import { shell, dialog } from 'electron'
import { saveReportCopy } from './report-export'
import { reportRequest } from './report-client'
import { reviewRequest } from './review-client'
import type { ReportAction, ReportData, ReportScope } from '../shared/report-contracts'
import { verifyReportFile } from '../service/reports/files'
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
  private readonly streams = new Map<string, AbortController>()
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
    private readonly getDataRoot: () => string,
    private readonly reportOpener: (path: string) => Promise<string> = (path) =>
      shell.openPath(path),
    private readonly reportDestination: (
      file: import('../shared/report-contracts').ReportFile
    ) => Promise<string | null> = async (file) => {
      const selected = await dialog.showSaveDialog({
        title: '另存审计结果',
        defaultPath: `pi-audit-harness-${file.reportId}.${file.format}`,
        filters: [
          {
            name: file.format === 'json' ? 'JSON 审计结果' : 'HTML 审计报告',
            extensions: [file.format]
          }
        ],
        properties: ['showOverwriteConfirmation']
      })
      return selected.canceled ? null : (selected.filePath ?? null)
    }
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
        this.update({
          ...this.status,
          database: health.database,
          pi: health.runtime && this.runtimeRevision === revision ? health.runtime : this.status.pi
        })
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
        pi: this.status.pi,
        database: this.status.database
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
      if (this.connection === connection)
        this.update({
          ...this.status,
          database: health.database,
          pi: health.runtime && this.runtimeRevision === revision ? health.runtime : this.status.pi
        })
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

  async templates(
    action: import('../shared/template-contracts').TemplateAction,
    input: unknown
  ): Promise<ApiResult<import('../shared/template-contracts').TemplateData>> {
    const connection = this.connection
    if (!connection || this.status.status !== 'ready')
      return {
        ok: false,
        requestId: randomUUID(),
        error: { code: 'SERVICE_NOT_READY', message: '本地服务尚未就绪', retryable: true }
      }
    return templateRequest(connection.port, connection.token, action, input)
  }
  async audit(action: AuditAction, input: unknown): Promise<ApiResult<AuditData>> {
    const connection = this.connection
    if (!connection || this.status.status !== 'ready')
      return {
        ok: false,
        requestId: randomUUID(),
        error: { code: 'SERVICE_NOT_READY', message: '本地服务尚未就绪', retryable: true }
      }
    return auditRequest(connection.port, connection.token, action, input)
  }
  async report(action: ReportAction, input: unknown): Promise<ApiResult<ReportData>> {
    const connection = this.connection
    if (!connection || this.status.status !== 'ready')
      return {
        ok: false,
        requestId: randomUUID(),
        error: { code: 'SERVICE_NOT_READY', message: '本地服务尚未就绪', retryable: true }
      }
    return reportRequest(connection.port, connection.token, action, input)
  }
  async review(
    action: import('../shared/review-contracts').ReviewAction,
    input: unknown
  ): Promise<ApiResult<import('../shared/review-contracts').ReviewData>> {
    const connection = this.connection
    if (!connection || this.status.status !== 'ready')
      return {
        ok: false,
        requestId: randomUUID(),
        error: { code: 'SERVICE_NOT_READY', message: '本地服务尚未就绪', retryable: true }
      }
    return reviewRequest(connection.port, connection.token, action, input)
  }
  async openReport(input: unknown): Promise<ApiResult<ReportScope & { reportId: string }>> {
    const result = await this.report('file', input)
    if (!result.ok) return result
    if (!('sha256' in result.data) || !('reportId' in result.data) || !result.data.sha256)
      return {
        ok: false,
        requestId: result.requestId,
        error: { code: 'REPORT_UNSAFE_FILE', message: '报告文件信息无效', retryable: false }
      }
    try {
      const file = {
        format: result.data.format,
        projectId: result.data.projectId,
        runId: result.data.runId,
        reportId: result.data.reportId,
        filePath: result.data.filePath,
        sha256: result.data.sha256
      }
      if (file.format !== 'html')
        throw new ApiError('REPORT_FORMAT_UNSUPPORTED', 'JSON结果请使用另存文件操作', 400)
      await verifyReportFile(this.getDataRoot(), file)
      const error = await this.reportOpener(file.filePath)
      if (error)
        throw new ApiError('REPORT_OPEN_FAILED', '系统未能打开 HTML 报告，请检查默认浏览器', 502)
      return {
        ok: true,
        requestId: result.requestId,
        data: { projectId: file.projectId, runId: file.runId, reportId: file.reportId }
      }
    } catch (error) {
      return {
        ok: false,
        requestId: result.requestId,
        error: {
          code: error instanceof ApiError ? error.code : 'REPORT_OPEN_FAILED',
          message: error instanceof ApiError ? error.message : '无法打开已登记报告',
          retryable: false
        }
      }
    }
  }
  async saveReport(
    input: unknown
  ): Promise<ApiResult<import('../shared/report-contracts').ReportSaveResult>> {
    const result = await this.report('file', input)
    if (!result.ok) return result
    if (!('sha256' in result.data) || !('reportId' in result.data) || !result.data.sha256)
      return {
        ok: false,
        requestId: result.requestId,
        error: { code: 'REPORT_UNSAFE_FILE', message: '报告文件信息无效', retryable: false }
      }
    const file: import('../shared/report-contracts').ReportFile = {
      projectId: result.data.projectId,
      runId: result.data.runId,
      reportId: result.data.reportId,
      filePath: result.data.filePath,
      sha256: result.data.sha256,
      format: result.data.format
    }
    try {
      const destination = await this.reportDestination(file)
      const savedPath = destination
        ? await saveReportCopy(this.getDataRoot(), file, destination)
        : null
      return {
        ok: true,
        requestId: result.requestId,
        data: {
          projectId: file.projectId,
          runId: file.runId,
          reportId: file.reportId,
          cancelled: !destination,
          savedPath
        }
      }
    } catch (error) {
      return {
        ok: false,
        requestId: result.requestId,
        error: {
          code: error instanceof ApiError ? error.code : 'REPORT_SAVE_FAILED',
          message:
            error instanceof ApiError ? error.message : '文件另存未完成，请检查目录权限并重试',
          retryable: false
        }
      }
    }
  }
  async startAnalysisStream(
    input: AnalyzeRequest,
    notify: (notice: StreamNotice) => void
  ): Promise<ApiResult<StreamHandle>> {
    const connection = this.connection,
      requestId = randomUUID()
    if (!connection || this.status.status !== 'ready')
      return {
        ok: false,
        requestId,
        error: { code: 'SERVICE_NOT_READY', message: '本地服务尚未就绪', retryable: true }
      }
    if (this.streams.size >= 2)
      return {
        ok: false,
        requestId,
        error: { code: 'SSE_BUSY', message: '请先关闭已有事件连接', retryable: true }
      }
    const id = randomUUID(),
      controller = new AbortController()
    this.streams.set(id, controller)
    try {
      const stream = await connectAnalyze(
        connection.port,
        connection.token,
        input,
        (frame) => notify({ connectionId: id, frame }),
        controller.signal
      )
      void stream.done
        .then(
          () => {
            if (!controller.signal.aborted) notify({ connectionId: id, ended: true })
          },
          (error) => {
            if (!controller.signal.aborted)
              notify({
                connectionId: id,
                errorCode: error instanceof ApiError ? error.code : 'SSE_DISCONNECTED'
              })
          }
        )
        .finally(() => this.streams.delete(id))
      return { ok: true, requestId, data: { connectionId: id, sessionId: stream.sessionId } }
    } catch (error) {
      controller.abort()
      this.streams.delete(id)
      return {
        ok: false,
        requestId,
        error: {
          code: error instanceof ApiError ? error.code : 'SSE_CONNECT_FAILED',
          message: error instanceof ApiError ? error.message : '事件连接失败，请按会话游标重连',
          retryable: true
        }
      }
    }
  }
  stopAnalysisStream(id: string): void {
    this.streams.get(id)?.abort()
    this.streams.delete(id)
  }

  async source<T>(action: SourceAction, input?: unknown): Promise<ApiResult<T>> {
    const connection = this.connection
    if (!connection || this.status.status !== 'ready')
      return {
        ok: false,
        requestId: randomUUID(),
        error: { code: 'SERVICE_NOT_READY', message: '本地服务尚未就绪', retryable: true }
      }
    return sourceRequest<T>(connection.port, connection.token, action, input)
  }
  async modelSettings(
    input?: unknown,
    selecting = input !== undefined
  ): Promise<ApiResult<ModelCatalog>> {
    const connection = this.connection
    if (!connection || this.status.status !== 'ready')
      return {
        ok: false,
        requestId: randomUUID(),
        error: { code: 'SERVICE_NOT_READY', message: '本地服务尚未就绪', retryable: true }
      }
    return modelSettingsRequest(connection.port, connection.token, input, selecting)
  }

  async metadata<T extends MetadataOverview | ProjectRecord | ModelSaveResult>(
    action: 'list' | 'project' | 'model',
    input?: unknown
  ): Promise<ApiResult<T>> {
    const connection = this.connection
    if (!connection || this.status.status !== 'ready')
      return {
        ok: false,
        requestId: randomUUID(),
        error: { code: 'SERVICE_NOT_READY', message: '本地服务尚未就绪', retryable: true }
      }
    return metadataRequest<T>(connection.port, connection.token, action, input)
  }

  async getStorageOverview(): Promise<ApiResult<StorageOverview>> {
    const connection = this.connection
    if (!connection || this.status.status !== 'ready')
      return {
        ok: false,
        requestId: randomUUID(),
        error: {
          code: 'SERVICE_NOT_READY',
          message: '本地服务尚未就绪',
          retryable: true
        }
      }
    return readStorageOverview(connection.port, connection.token)
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
    for (const controller of this.streams.values()) controller.abort()
    this.streams.clear()
    if (this.cleanupTask) return this.cleanupTask
    const child = this.child
    const exited = this.exited
    if (!child || !exited) return Promise.resolve()

    clearInterval(this.heartbeat)
    this.cleanupTask = (async () => {
      const ownedPid = child.pid
      const shutdown: ParentToService = { type: 'shutdown' }
      child.postMessage(shutdown)
      if (!(await waitForExit(exited, 15000))) {
        child.kill()
        if (!(await waitForExit(exited, 1000))) throw new Error('本地服务未在期限内退出')
      }
      // utilityProcess 的 exit 事件与 Windows PID 完全消失之间可能有很短的间隔。
      // stop 返回前确认本次持有的 PID 已结束，避免重启/测试误判遗留进程。
      const deadline = Date.now() + 1000
      while (ownedPid) {
        try {
          process.kill(ownedPid, 0)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') break
          throw error
        }
        if (Date.now() >= deadline) throw new Error('本地服务 PID 未在期限内结束')
        await new Promise((resolve) => setTimeout(resolve, 20))
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
