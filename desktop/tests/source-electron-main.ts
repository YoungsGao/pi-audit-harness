import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ServiceManager } from '../src/main/service-manager'
import type { ApiResult } from '../src/shared/service-protocol'
import type { SourceCatalog } from '../src/shared/source-contracts'
const root = mkdtempSync(join(tmpdir(), 'pi-source-electron-'))
app.setPath('userData', join(root, 'profile'))
let window: BrowserWindow | undefined
const service = new ServiceManager(
  (s) => {
    window?.webContents.send('service:status-changed', s)
  },
  () => join(root, 'runtime')
)
const js = async <T>(s: string): Promise<T> => window!.webContents.executeJavaScript(s)
async function until(check: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 15000
  while (!(await check())) {
    if (Date.now() > end) throw Error('source DOM timeout')
    await new Promise((r) => setTimeout(r, 60))
  }
}
void app.whenReady().then(async () => {
  try {
    ipcMain.handle('app:get-info', () => ({
      name: 'Source fixture',
      version: '1',
      node: process.versions.node,
      electron: process.versions.electron
    }))
    ipcMain.handle('service:get-status', () => service.getStatus())
    ipcMain.handle('service:check-health', () => service.checkHealth())
    ipcMain.handle('storage:get-overview', () => service.getStorageOverview())
    ipcMain.handle('metadata:get', () => service.metadata('list'))
    ipcMain.handle('sources:tools', () => service.source('tools'))
    ipcMain.handle('sources:list', () => service.source('list'))
    ipcMain.handle('sources:local', (_e, v: unknown) => service.source('local', v))
    ipcMain.handle('sources:open', (_e, id: unknown) => service.source('open', { projectId: id }))
    const path = join(root, 'Java project')
    mkdirSync(path)
    writeFileSync(join(path, 'Demo.java'), 'class Demo{}')
    ipcMain.handle('sources:choose-directory', () => path)
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
    await until(() =>
      js(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='导入本地源码')`)
    )
    await js(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='选择源码文件夹').click()`
    )
    await until(() => js(`document.querySelector('input[aria-label="本地源码目录"]').value!==''`))
    await js(
      `(()=>{const e=document.querySelector('input[aria-label="源码项目名称"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Source Electron fixture');e.dispatchEvent(new Event('input',{bubbles:true}))})()`
    )
    await js(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='导入本地源码').click()`
    )
    await until(() =>
      js(
        `document.querySelector('[data-testid="source-status"]').textContent.includes('源码登记成功')`
      )
    )
    const list = await js<ApiResult<SourceCatalog>>('window.audit.listSources()')
    assert.equal(list.ok, true)
    if (!list.ok) throw Error()
    const id = list.data.projects[0].projectId
    assert.equal(list.data.total, 1)
    await js(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify('打开源码项目 ' + id)}).click()`
    )
    await until(() => js(`document.querySelector('aside[aria-label="已打开源码项目"]')!==null`))
    const pid = (service as unknown as { child: { pid: number } }).child.pid
    await service.stop()
    await until(async () => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    })
    await service.start()
    const again = await service.source<SourceCatalog>('list')
    assert.equal(again.ok, true)
    if (again.ok) assert.equal(again.data.projects[0].projectId, id)
    assert.notEqual((service as unknown as { child: { pid: number } }).child.pid, pid)
    const second = (service as unknown as { child: { pid: number } }).child.pid
    await service.stop()
    await until(async () => {
      try {
        process.kill(second, 0)
        return false
      } catch {
        return true
      }
    })
    console.info(
      'PASS SOURCE: real React folder choice/import/open + preload IPC authenticated HTTP + utilityProcess SQLite + different-PID restart; no model calls.'
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
