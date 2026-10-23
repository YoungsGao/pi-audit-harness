import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ServiceManager } from '../src/main/service-manager'
import { writeFile } from 'node:fs/promises'
import { createEnv02Fixture } from './env02-fixture.mjs'
import workerPath from './env02-operations-worker.ts?modulePath'

const dataRoot = resolve('.env02-test-data', randomUUID())
let window: BrowserWindow | undefined
const service = new ServiceManager(
  (status) => {
    if (window && !window.isDestroyed()) window.webContents.send('service:status-changed', status)
  },
  () => dataRoot
)

async function verifyWorkerExtensions(): Promise<void> {
  const fixture = await createEnv02Fixture()
  try {
    const worker = utilityProcess.fork(workerPath)
    let html = ''
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.kill()
        reject(new Error('扩展探针超时'))
      }, 20000)
      worker.once('spawn', () =>
        worker.postMessage({
          root: join(fixture.directory, 'worker'),
          projectRoot: fixture.projectRoot,
          config: fixture.config
        })
      )
      worker.on('message', (message) => {
        if (message?.ok && typeof message.html === 'string') html = message.html
      })
      worker.once('exit', (code) => {
        clearTimeout(timer)
        if (code === 0 && html) resolve()
        else reject(new Error('Electron 服务进程扩展验证失败'))
      })
    })
    assert.equal(fixture.requests.length, 3)
    const output = join(fixture.directory, 'preview.html')
    await writeFile(output, html, 'utf8')
    console.info('本机测试服务生成的运行时预览报告：', output)
  } finally {
    await fixture.close()
  }
}

void app.whenReady().then(async () => {
  try {
    ipcMain.handle('app:get-info', () => ({
      name: 'ENV-02 test',
      version: '1',
      node: process.versions.node,
      electron: process.versions.electron
    }))
    ipcMain.handle('service:get-status', () => service.getStatus())
    ipcMain.handle('service:check-health', () => service.checkHealth())
    ipcMain.handle('model:test', (_event, id: string) => service.testModel(id))
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    await window.loadFile(join(__dirname, '../renderer/index.html'))
    await service.start()
    const deadline = Date.now() + 20000
    while (service.getStatus().pi?.state === 'initializing' || !service.getStatus().pi) {
      if (Date.now() > deadline) throw new Error('等待 Pi 就绪超时')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(service.getStatus().pi?.state, 'ready')
    const status = await window.webContents.executeJavaScript('window.audit.checkServiceHealth()')
    assert.equal(status.pi.sdkVersion, '1.2.0')
    const result = await window.webContents.executeJavaScript("window.audit.testModel('missing')")
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'MODEL_CONFIG_NOT_FOUND')
    assert.equal(typeof result.requestId, 'string')
    assert.equal(service.getStatus().status, 'ready')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(
      (await window.webContents.executeJavaScript('document.body.textContent')).includes(
        'Pi 状态：ready'
      )
    )
    // 仅读取本测试创建的服务 PID，停止后用操作系统确认它已结束。
    const ownedPid = (service as unknown as { child: { pid: number } }).child.pid
    await service.stop()
    assert.throws(() => process.kill(ownedPid, 0))
    await verifyWorkerExtensions()
    console.info(
      'PASS: Electron 实际服务、Pi 初始化、preload/IPC、React 状态、错误编号、退出清理，以及服务进程内的实际审计工具和 /report 扩展。未调用真实供应商。'
    )
    window.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error)
    await service.stop().catch(() => {})
    window?.destroy()
    app.exit(1)
  }
})
