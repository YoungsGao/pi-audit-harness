import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron'
import { join } from 'node:path'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ServiceManager } from '../src/main/service-manager'
import { createEnv02Fixture } from './env02-fixture.mjs'
import cleanupPath from './db02-cleanup-worker.ts?modulePath'
const root = mkdtempSync(join(tmpdir(), 'pi-db02-electron-'))
app.setPath('userData', join(root, 'profile'))
let window: BrowserWindow | undefined
const service = new ServiceManager(
  (status) => {
    if (window && !window.isDestroyed()) window.webContents.send('service:status-changed', status)
  },
  () => join(root, 'runtime')
)
async function cleanup(): Promise<void> {
  const child = utilityProcess.fork(cleanupPath)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('credential cleanup timeout'))
    }, 20000)
    child.once('spawn', () => child.postMessage({ root: join(root, 'runtime') }))
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error('credential cleanup failed'))
    })
  })
}
void app.whenReady().then(async () => {
  const fixture = await createEnv02Fixture()
  try {
    ipcMain.handle('app:get-info', () => ({
      name: 'DB02 fixture',
      version: '1',
      node: process.versions.node,
      electron: process.versions.electron
    }))
    ipcMain.handle('service:get-status', () => service.getStatus())
    ipcMain.handle('service:check-health', () => service.checkHealth())
    ipcMain.handle('storage:get-overview', () => service.getStorageOverview())
    ipcMain.handle('metadata:get', () => service.metadata('list'))
    ipcMain.handle('metadata:save-project', (_e, input: unknown) =>
      service.metadata('project', input)
    )
    ipcMain.handle('metadata:save-model', (_e, input: unknown) => service.metadata('model', input))
    ipcMain.handle('models:get-catalog', () => service.modelSettings())
    ipcMain.handle('models:select', (_e, input: unknown) => service.modelSettings(input, true))
    ipcMain.handle('model:test', (_e, id: string) => service.testModel(id))
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
    const project = await window.webContents.executeJavaScript(
      `window.audit.saveProject(${JSON.stringify({ projectName: 'Electron教学项目', path: fixture.projectRoot, sourceType: 'local' })})`
    )
    assert.equal(project.ok, true)
    const model = await window.webContents.executeJavaScript(
      `window.audit.saveModelConfig(${JSON.stringify({ name: 'Electron教学配置', baseUrl: fixture.config.baseUrl, modelId: fixture.config.modelId, apiKey: 'fixture-key-not-a-real-secret' })})`
    )
    assert.equal(model.ok, true)
    assert.equal(fixture.requests.length, 0) // 保存、读取不会发送模型请求。
    const deadline = Date.now() + 20000
    while (service.getStatus().pi?.state !== 'ready') {
      if (Date.now() > deadline) throw new Error('Pi ready timeout')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const ping = await service.testModel(model.data.model.configId)
    assert.equal(ping.ok, true)
    assert.equal(fixture.requests.length, 1) // 明确测试才经真实 Pi SDK 调用本机 fixture。
    const before = await window.webContents.executeJavaScript('window.audit.getMetadata()')
    assert.equal(JSON.stringify(before).includes('fixture-key-not-a-real-secret'), false)
    const pid = (service as unknown as { child: { pid: number } }).child.pid
    await service.stop()
    assert.throws(() => process.kill(pid, 0))
    assert.equal(
      readFileSync(join(root, 'runtime/storage/audit.sqlite3')).includes(
        Buffer.from('fixture-key-not-a-real-secret')
      ),
      false
    )
    await service.start()
    const after = await window.webContents.executeJavaScript('window.audit.getMetadata()')
    assert.deepEqual(after.data, before.data)
    const restarted = Date.now() + 20000
    while (service.getStatus().pi?.state !== 'ready') {
      if (Date.now() > restarted) throw new Error('restarted Pi ready timeout')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal((await service.testModel(model.data.model.configId)).ok, true)
    assert.equal(fixture.requests.length, 2)
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='模型配置').click()`
    )
    const rendered = Date.now() + 5000
    while (
      !(await window.webContents.executeJavaScript('document.body.textContent')).includes(
        '已关联系统凭据'
      )
    ) {
      if (Date.now() > rendered) throw new Error('metadata UI timeout')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='项目管理').click()`
    )
    // 实际 DOM 提交项目表单，覆盖 React 受控输入与 onSubmit。
    await window.webContents.executeJavaScript(`(()=>{
    const input=document.querySelector('input[aria-label="项目名称"]');
    const path=document.querySelector('input[aria-label="本地绝对路径"]');
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(input,'React表单项目');input.dispatchEvent(new Event('input',{bubbles:true}));
    set.call(path,${JSON.stringify(fixture.projectRoot)});path.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
    await window.webContents.executeJavaScript(
      `document.querySelector('input[aria-label="项目名称"]').form.requestSubmit()`
    )
    const submitted = Date.now() + 5000
    while (
      !(await window.webContents.executeJavaScript('document.body.textContent')).includes(
        '项目已保存'
      )
    ) {
      if (Date.now() > submitted) throw new Error('React save timeout')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='模型配置').click()`
    )
    const ready = Date.now() + 5000
    while (
      !(await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='编辑配置'&&!b.disabled)`
      ))
    ) {
      if (Date.now() > ready) throw new Error('model page ready timeout')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='编辑配置').click()`
    )
    await window.webContents.executeJavaScript(`(()=>{
      const input=document.querySelector('input[aria-label="API Key"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'fixture-rotated-in-React');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`)
    await window.webContents.executeJavaScript(
      `document.querySelector('input[aria-label="API Key"]').form.requestSubmit()`
    )
    const modelSaved = Date.now() + 15000
    while (
      !(await window.webContents.executeJavaScript('document.body.textContent')).includes(
        '模型配置已保存'
      )
    ) {
      if (Date.now() > modelSaved) throw new Error('React model save timeout')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const edited = await window.webContents.executeJavaScript('window.audit.getMetadata()')
    assert.equal(edited.data.models[0].configId, model.data.model.configId)
    assert.equal(edited.data.models[0].revision, 2)
    assert.equal(fixture.requests.length, 2)
    assert.equal(
      await window.webContents.executeJavaScript(
        `document.querySelector('input[aria-label="API Key"]').type`
      ),
      'password'
    )
    assert.equal(
      await window.webContents.executeJavaScript(
        `document.querySelector('input[aria-label="API Key"]').value`
      ),
      ''
    )
    await service.stop()
    await cleanup()
    console.info(
      'PASS DB-02: real Credential Manager + utilityProcess save/read/restart + authenticated HTTP/IPC/preload + React form + persisted ID into Pi local fixture + key not in DB/DTO; own fake credential removed.'
    )
    window.destroy()
    await fixture.close()
    app.exit(0)
  } catch (error) {
    console.error(error)
    await service.stop().catch(() => {})
    await cleanup().catch(() => {})
    window?.destroy()
    await fixture.close()
    app.exit(1)
  }
})
