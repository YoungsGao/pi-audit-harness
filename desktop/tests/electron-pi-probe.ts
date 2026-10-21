import { app, utilityProcess } from 'electron'
import workerPath from './pi-probe-worker.ts?modulePath'

void app.whenReady().then(() => {
  const child = utilityProcess.fork(workerPath)
  let passed = false
  const timer = setTimeout(() => {
    child.kill()
    app.exit(2)
  }, 20000)
  child.on('message', (message) => {
    passed = message?.ok === true && message?.stage === 'session-created'
    console.info(
      passed ? 'PASS: Electron 服务进程已加载 Pi、创建并释放真实会话；未调用模型。' : message
    )
  })
  child.once('exit', (code) => {
    clearTimeout(timer)
    app.exit(passed && code === 0 ? 0 : 1)
  })
})
