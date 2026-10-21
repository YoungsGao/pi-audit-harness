import { isAbsolute } from 'node:path'
import { startHttpServer } from './http-server'
import type { RunningHttpServer } from './http-server'
import type { ServiceToParent } from '../shared/service-protocol'
import { PiRuntime } from './pi-runtime'
import { PiOperations } from './pi-adapter'
import { unconfiguredModelPorts } from './model-config-resolver'

const parent = process.parentPort
if (!parent) throw new Error('请通过 Electron 启动正式服务入口')
let server: RunningHttpServer | undefined
let startingServer: Promise<RunningHttpServer> | undefined
let runtime: PiRuntime | undefined
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
  runtime = new PiRuntime(message.dataRoot)
  const currentRuntime = runtime
  const operations = new PiOperations(currentRuntime, unconfiguredModelPorts)
  startingServer = startHttpServer(message.token, {
    getRuntime: () => currentRuntime.getStatus(),
    testModel: (id, context, signal) => operations.ping(id, context, 15000, signal)
  })
  void startingServer
    .then(async (running) => {
      server = running
      if (closing) {
        await running.close()
        return
      }
      notify({ type: 'listening', port: running.port })
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
