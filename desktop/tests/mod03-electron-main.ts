import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron'
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServiceManager } from '../src/main/service-manager'
import type { ApiResult } from '../src/shared/service-protocol'
import type { ModelCatalog } from '../src/shared/model-settings'
import { createMod03Fixture } from './mod03-fixture.mjs'
import cleanupPath from './db02-cleanup-worker.ts?modulePath'
const root = mkdtempSync(join(tmpdir(), 'pi-mod03-electron-'))
app.setPath('userData', join(root, 'profile'))
let window: BrowserWindow | undefined,
  logs = ''
const service = new ServiceManager(
  (status) => {
    if (window && !window.isDestroyed()) window.webContents.send('service:status-changed', status)
  },
  () => join(root, 'runtime')
)
const js = async <T>(code: string): Promise<T> => window!.webContents.executeJavaScript(code)
async function until(test: () => Promise<boolean>, message: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await test())) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((r) => setTimeout(r, 50))
  }
}
async function body(): Promise<string> {
  return js('document.body.textContent')
}
async function click(label: string, nav = false): Promise<void> {
  await js(
    `Array.from(document.querySelectorAll(${JSON.stringify(nav ? 'nav button' : 'button')})).find(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled).click()`
  )
}
async function idle(): Promise<void> {
  await until(
    () =>
      js(
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='刷新模型配置'&&!b.disabled)`
      ),
    'model page idle timeout'
  )
}
async function catalog(): Promise<ModelCatalog> {
  const result = await js<ApiResult<ModelCatalog>>('window.audit.getModelCatalog()')
  if (!result.ok) throw new Error(result.error.code)
  return result.data
}
async function select(id: string): Promise<void> {
  const state = await catalog()
  const selected = await js<ApiResult<ModelCatalog>>(
    `window.audit.selectModel(${JSON.stringify({ configId: id, expectedRevision: state.selection.revision })})`
  )
  assert.equal(selected.ok, true)
  await click('刷新模型配置')
  await idle()
}
async function cleanup(): Promise<void> {
  const child = utilityProcess.fork(cleanupPath)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('fake credential cleanup timeout'))
    }, 30000)
    child.once('spawn', () => child.postMessage({ root: join(root, 'runtime') }))
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error('fake credential cleanup failed'))
    })
  })
}
void app.whenReady().then(async () => {
  const fixtures = [] as Awaited<ReturnType<typeof createMod03Fixture>>[]
  try {
    ipcMain.handle('app:get-info', () => ({
      name: 'MOD03 fixture',
      version: '1',
      node: process.versions.node,
      electron: process.versions.electron
    }))
    ipcMain.handle('service:get-status', () => service.getStatus())
    ipcMain.handle('service:check-health', () => service.checkHealth())
    ipcMain.handle('storage:get-overview', () => service.getStorageOverview())
    ipcMain.handle('metadata:get', () => service.metadata('list'))
    ipcMain.handle('metadata:save-project', (_e, v: unknown) => service.metadata('project', v))
    ipcMain.handle('metadata:save-model', (_e, v: unknown) => service.metadata('model', v))
    ipcMain.handle('models:get-catalog', () => service.modelSettings())
    ipcMain.handle('models:select', (_e, v: unknown) => service.modelSettings(v, true))
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
    const child = (service as unknown as { child: Electron.UtilityProcess }).child,
      pid = child.pid!
    child.stdout?.on('data', (c) => {
      logs += c.toString()
    })
    child.stderr?.on('data', (c) => {
      logs += c.toString()
    })
    mkdirSync(join(root, 'source'))
    writeFileSync(join(root, 'source', 'Secret.java'), 'MOD03_ELECTRON_SOURCE_NEVER_SEND')
    const project = await js<ApiResult<unknown>>(
      `window.audit.saveProject(${JSON.stringify({ projectName: 'MOD03 源码隔离样例', path: join(root, 'source'), sourceType: 'local' })})`
    )
    assert.equal(project.ok, true)
    await click('模型配置', true)
    await idle()
    assert.equal(
      await js(
        `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='测试当前模型').disabled`
      ),
      true
    )
    const scenarios = [
      ['success', ''],
      ['auth', 'MODEL_AUTH_FAILED'],
      ['model', 'MODEL_OR_ENDPOINT_NOT_FOUND'],
      ['quota', 'MODEL_RATE_LIMIT'],
      ['empty', 'EMPTY_REPLY'],
      ['network', 'MODEL_NETWORK_FAILED'],
      ['timeout', 'MODEL_TIMEOUT']
    ] as const
    for (const [mode, code] of scenarios) {
      const fixture = await createMod03Fixture({ mode, delayMs: mode === 'success' ? 350 : 0 })
      fixtures.push(fixture)
      const saved = await js<ApiResult<{ model: { configId: string } }>>(
        `window.audit.saveModelConfig(${JSON.stringify({ name: 'MOD03 ' + mode, baseUrl: fixture.baseUrl, modelId: 'explicit-fixture-model', apiKey: 'fixture-mod03-OS-key' })})`
      )
      if (!saved.ok) throw new Error(saved.error.code)
      const id = saved.data.model.configId
      await select(id)
      assert.equal(fixture.requests.length, 0)
      if (mode === 'success') {
        // 同一事件循环连续点击，两次处理函数也只能让后端收到一条请求。
        await js(
          `(()=>{const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='测试当前模型');button.click();button.click()})()`
        )
        await until(async () => (await body()).includes('测试中：'), 'pending status missing')
        await click('项目管理', true)
        await click('模型配置', true)
        await until(
          async () => (await body()).includes('测试成功：'),
          'success reply missing',
          20000
        )
        await idle()
        assert.equal(fixture.requests.length, 1)
        assert.ok((await body()).includes('MOD-03 本机模型已收到 ping'))
        assert.equal(
          await js(`document.querySelectorAll('section[aria-label="模型连接测试"] script').length`),
          0
        )
        assert.ok(
          await js(
            `document.querySelector('pre[aria-label="模型回复"]').textContent.includes('<script>fixture</script>')`
          )
        )
        assert.ok((await body()).includes(' ms'))
        assert.ok((await body()).includes('请求编号：'))
        await click('测试当前模型')
        await until(async () => fixture.requests.length === 2, 'manual retry request missing')
        await until(async () => (await body()).includes('测试成功：'), 'manual retry reply missing')
      } else {
        assert.ok((await body()).includes('此前配置版本的结果'))
        await click('测试当前模型')
        await until(
          async () => (await body()).includes('测试失败：' + code),
          'expected UI failure ' + code,
          mode === 'timeout' ? 23000 : 10000
        )
        await idle()
        assert.equal(fixture.requests.length, 1)
        assert.ok((await body()).includes('未判定连通成功'))
        assert.equal((await body()).includes('fixture-private-error-do-not-echo'), false)
      }
      for (const req of fixture.requests) {
        assert.equal(req.path, '/v1/chat/completions')
        assert.equal(req.body.model, 'explicit-fixture-model')
        assert.equal(req.body.tools?.length ?? 0, 0)
        assert.equal(JSON.stringify(req.body).includes('MOD03_ELECTRON_SOURCE_NEVER_SEND'), false)
        assert.deepEqual(
          req.body.messages.filter((x: { role: string }) => x.role === 'user'),
          [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
        )
      }
    }
    assert.equal(logs.includes('fixture-mod03-OS-key'), false)
    assert.equal(await js('localStorage.length'), 0)
    await service.stop()
    assert.throws(() => process.kill(pid, 0))
    for (const file of ['audit.sqlite3', 'audit.sqlite3-wal', 'audit.sqlite3-shm']) {
      const path = join(root, 'runtime/storage', file)
      if (existsSync(path))
        assert.equal(readFileSync(path).includes(Buffer.from('fixture-mod03-OS-key')), false)
    }
    await cleanup()
    window.destroy()
    for (const fixture of fixtures) await fixture.close()
    console.info(
      'PASS MOD-03: real React button + same-tick dedupe/navigation + actual Pi SDK + OS fake keys + exact single ping/no source/no tools + non-pong success/latency + auth/model/quota/empty/network/15s timeout + manual retry + safe text and errors + PID/key cleanup.'
    )
    app.exit(0)
  } catch (error) {
    console.error(error)
    await service.stop().catch(() => {})
    await cleanup().catch(() => {})
    window?.destroy()
    for (const fixture of fixtures) await fixture.close()
    app.exit(1)
  }
})
