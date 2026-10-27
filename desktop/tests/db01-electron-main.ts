import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron'
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ServiceManager } from '../src/main/service-manager'
import workerPath from './db01-seed-worker.ts?modulePath'

const root = resolve('.db01-test-data', randomUUID())
app.setPath('userData', join(root, 'electron-profile'))
let window: BrowserWindow | undefined
const service = new ServiceManager(
  (status) => {
    if (window && !window.isDestroyed()) window.webContents.send('service:status-changed', status)
  },
  () => join(root, 'runtime')
)
const bad = new ServiceManager(
  () => {},
  () => join(root, 'bad-runtime')
)
function pid(): number {
  return (service as unknown as { child: { pid: number } }).child.pid
}
async function seed(): Promise<void> {
  const child = utilityProcess.fork(workerPath)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('seed timed out'))
    }, 10000)
    child.once('spawn', () => child.postMessage({ root: join(root, 'runtime') }))
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error('seed failed'))
    })
  })
}
void app.whenReady().then(async () => {
  try {
    ipcMain.handle('app:get-info', () => ({
      name: 'DB-01 fixture',
      version: '1',
      node: process.versions.node,
      electron: process.versions.electron
    }))
    ipcMain.handle('service:get-status', () => service.getStatus())
    ipcMain.handle('service:check-health', () => service.checkHealth())
    ipcMain.handle('storage:get-overview', () => service.getStorageOverview())
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
    assert.equal(service.getStatus().database?.schemaVersion, 8)
    assert.deepEqual(
      ((await service.getStorageOverview()) as { data: { counts: unknown } }).data.counts,
      { projects: 0, runs: 0, results: 0, reports: 0 }
    )
    const firstPid = pid()
    await service.stop()
    assert.throws(() => process.kill(firstPid, 0))
    // 测试专用服务进程写入后退出，正式服务再次启动才读取。生产代码没有造数入口。
    await seed()
    await service.start()
    const secondPid = pid()
    const before = await window.webContents.executeJavaScript('window.audit.getStorageOverview()')
    assert.equal(before.ok, true)
    assert.equal(before.data.results[0].id, 'fixture-path-one')
    assert.equal(before.data.projects[0].name, 'SQLite 教学测试项目')
    await service.stop()
    assert.throws(() => process.kill(secondPid, 0))
    await service.start()
    const thirdPid = pid()
    assert.notEqual(secondPid, thirdPid)
    const after = await window.webContents.executeJavaScript('window.audit.getStorageOverview()')
    assert.deepEqual(after.data, before.data)
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent === '读取本地存储').click()`
    )
    const deadline = Date.now() + 5000
    while (
      !(await window.webContents.executeJavaScript('document.body.textContent')).includes(
        '受控测试结果'
      )
    ) {
      if (Date.now() > deadline) throw new Error('React storage card did not render saved result')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(await window.webContents.executeJavaScript('typeof window.require'), 'undefined')
    assert.equal(
      await window.webContents.executeJavaScript('typeof window.audit.querySql'),
      'undefined'
    )
    await service.stop()
    assert.throws(() => process.kill(thirdPid, 0))
    mkdirSync(join(root, 'bad-runtime/storage/audit.sqlite3'), { recursive: true })
    await assert.rejects(bad.start())
    assert.equal(bad.getStatus().code, 'DB_OPEN_FAILED')
    assert.equal((bad as unknown as { child?: unknown }).child, undefined)
    console.info(
      'PASS DB-01: real utilityProcess SQLite / empty init / fixture persistence / different-PID restart / HTTP IPC preload React / failed init / child cleanup. No paid model calls.'
    )
    console.info('TEST DATA=', root)
    window.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error)
    await Promise.allSettled([service.stop(), bad.stop()])
    window?.destroy()
    app.exit(1)
  }
})
