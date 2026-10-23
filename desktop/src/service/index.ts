import { SourceService } from './sources/service'
import { SourceRepository } from './sources/repository'
import { CodeQueryService } from './query/service'
import { CallChainService } from './chains/service'
import { CallChainRepository } from './storage/call-chain-repository'
import { PathAnalysisService } from './chains/path-analysis'
import { builtinRules } from './rules/builtin'
import { MODEL_TEST_TIMEOUT_MS } from '../shared/model-test'
import { isAbsolute } from 'node:path'
import { ApiError } from '../shared/api-error.ts'
import { openStorage } from './storage/schema'
import type { LocalDatabase } from './storage/database'
import { AuditRepository } from './storage/repository'
import { startHttpServer } from './http-server'
import type { RunningHttpServer } from './http-server'
import type { ServiceToParent } from '../shared/service-protocol'
import { PiRuntime } from './pi-runtime'
import { PiOperations } from './pi-adapter'
import { ModelSettingsRepository } from './storage/model-settings-repository'
import { MetadataRepository } from './storage/metadata-repository'
import { MetadataService } from './storage/metadata-service'
import { WindowsCredentialStore } from './storage/credential-store'

const parent = process.parentPort
if (!parent) throw new Error('请通过 Electron 启动正式服务入口')
let server: RunningHttpServer | undefined
let startingServer: Promise<RunningHttpServer> | undefined
let runtime: PiRuntime | undefined
let database: LocalDatabase | undefined
let metadata: MetadataService | undefined
let sources: SourceService | undefined
let queries: CodeQueryService | undefined
let chains: CallChainService | undefined
let initialized = false
let closing = false
let lastHeartbeat = Date.now()

function notify(message: ServiceToParent): void {
  parent.postMessage(message)
}

function shutdown(exitCode = 0): void {
  if (closing) return
  closing = true
  clearInterval(watchdog)
  void (async () => {
    const running = server ?? (await startingServer?.catch(() => undefined))
    const results = await Promise.allSettled([runtime?.close(), running?.close()])
    // 先停止接收请求并等待 HTTP/Pi 清理，再关闭本服务唯一的数据库连接。
    await sources?.close()
    await chains?.close()
    await queries?.close()
    await metadata?.close()
    database?.close()
    process.exit(results.some((item) => item.status === 'rejected') ? 1 : exitCode)
  })().catch(() => process.exit(1))
}

const watchdog = setInterval(() => {
  if (Date.now() - lastHeartbeat > 8000) shutdown(1)
}, 2000)

parent.on('message', (event: { data: unknown }) => {
  const message = event.data
  if (!message || typeof message !== 'object' || !('type' in message)) return
  if (message.type === 'shutdown') {
    shutdown()
    return
  }
  if (message.type === 'heartbeat') {
    lastHeartbeat = Date.now()
    return
  }
  if (message.type !== 'init' || closing) return
  if (
    initialized ||
    !('token' in message) ||
    typeof message.token !== 'string' ||
    message.token.length < 32 ||
    !('dataRoot' in message) ||
    typeof message.dataRoot !== 'string' ||
    !isAbsolute(message.dataRoot)
  ) {
    notify({ type: 'startup-error', code: 'INVALID_INIT', message: '服务初始化消息无效或重复' })
    shutdown(1)
    return
  }
  initialized = true
  lastHeartbeat = Date.now()
  let repository: AuditRepository
  let chainRepository: CallChainRepository
  try {
    // DB 必须先准备好；建表失败时不能宣称本地服务已就绪。
    database = openStorage(message.dataRoot)
    repository = new AuditRepository(database)
    sources = new SourceService(database, message.dataRoot)
    queries = new CodeQueryService(new SourceRepository(database))
    chainRepository = new CallChainRepository(database)
    chainRepository.scans.recover()
    chains = new CallChainService(chainRepository, queries)
    metadata = new MetadataService(
      new MetadataRepository(database),
      new WindowsCredentialStore(),
      new ModelSettingsRepository(database)
    )
  } catch (error) {
    notify({
      type: 'startup-error',
      code: error instanceof ApiError ? error.code : 'DB_INITIALIZE_FAILED',
      message: error instanceof ApiError ? error.message : '数据库初始化失败'
    })
    shutdown(1)
    return
  }
  runtime = new PiRuntime(message.dataRoot)
  const currentRuntime = runtime
  const currentMetadata = metadata!
  const operations = new PiOperations(currentRuntime, currentMetadata.modelPorts())
  chains!.analysis = new PathAnalysisService(chainRepository!, queries!, (input, signal) =>
    operations.reviewPath(input, signal)
  )
  startingServer = startHttpServer(message.token, {
    getRules: () => builtinRules,
    codeQuery: (action, value, signal) => queries!.action(action, value, signal),
    chainAction: (action, value, signal) => chains!.action(action, value, signal),
    getSourceTools: (signal) => sources!.tools(signal),
    getSources: () => sources!.list(),
    sourceAction: (action, value, signal) => sources!.action(action, value, signal),
    getRuntime: () => currentRuntime.getStatus(),
    getDatabase: () => repository.getInfo(),
    getStorageOverview: () => repository.overview(),
    getMetadata: () => currentMetadata.overview(),
    getModelCatalog: () => currentMetadata.catalog(),
    selectModel: (input, signal) => currentMetadata.selectModel(input, signal),
    saveProject: (input, signal) => currentMetadata.saveProject(input, signal),
    saveModel: (input, signal) => currentMetadata.saveModel(input, signal),
    testModel: (id, context, signal) => operations.ping(id, context, MODEL_TEST_TIMEOUT_MS, signal)
  })
  void startingServer
    .then(async (running) => {
      server = running
      if (closing) {
        await running.close()
        return
      }
      notify({ type: 'listening', port: running.port })
      void currentMetadata.recover().catch(() => {})
      const preparing = currentRuntime.initialize()
      notify({ type: 'runtime-status', runtime: currentRuntime.getStatus() })
      try {
        await preparing
      } catch {
        /* 脱敏错误已写入运行时状态。 */
      }
      if (!closing) notify({ type: 'runtime-status', runtime: currentRuntime.getStatus() })
    })
    .catch(() => {
      if (!closing) {
        notify({
          type: 'startup-error',
          code: 'SERVICE_LISTEN_FAILED',
          message: '本地服务监听失败'
        })
        shutdown(1)
      }
    })
})
