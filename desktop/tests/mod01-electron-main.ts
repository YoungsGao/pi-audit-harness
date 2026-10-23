import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServiceManager } from '../src/main/service-manager'
import type { ModelCatalog } from '../src/shared/model-settings'
import type { ApiResult } from '../src/shared/service-protocol'
import { createMod01Fixture } from './mod01-fixture.mjs'
import cleanupPath from './db02-cleanup-worker.ts?modulePath'
const root = mkdtempSync(join(tmpdir(), 'pi-mod01-electron-'))
app.setPath('userData', join(root, 'profile'))
let window: BrowserWindow | undefined
let logs = ''
const service = new ServiceManager(
  (status) => {
    if (window && !window.isDestroyed()) window.webContents.send('service:status-changed', status)
  },
  () => join(root, 'runtime')
)
const evalJs = async <T>(source: string): Promise<T> =>
  window!.webContents.executeJavaScript(source)
async function until(
  predicate: () => Promise<boolean>,
  message: string,
  ms = 20000
): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
async function text(): Promise<string> {
  return evalJs('document.body.textContent')
}
async function click(label: string, nav = false): Promise<void> {
  await evalJs(
    `Array.from(document.querySelectorAll(${JSON.stringify(nav ? 'nav button' : 'button')})).find(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled).click()`
  )
}
async function fill(label: string, value: string, select = false): Promise<void> {
  await evalJs(`(()=>{const input=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');
 Object.getOwnPropertyDescriptor(${select ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype,'value').set.call(input,${JSON.stringify(value)});
 input.dispatchEvent(new Event(${JSON.stringify(select ? 'change' : 'input')},{bubbles:true}));})()`)
}
async function state(): Promise<ModelCatalog> {
  const result = await evalJs<ApiResult<ModelCatalog>>('window.audit.getModelCatalog()')
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('catalog failed')
  return result.data
}
async function idle(): Promise<void> {
  await until(
    () =>
      evalJs(
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='刷新模型配置'&&!b.disabled)`
      ),
    'model page busy'
  )
}
async function submit(): Promise<void> {
  await evalJs(`document.querySelector('input[aria-label="配置名称"]').form.requestSubmit()`)
}
function watchLogs(): number {
  const child = (service as unknown as { child: Electron.UtilityProcess }).child
  child.stdout?.on('data', (chunk) => {
    logs += chunk.toString()
  })
  child.stderr?.on('data', (chunk) => {
    logs += chunk.toString()
  })
  return child.pid!
}
async function cleanup(): Promise<void> {
  const child = utilityProcess.fork(cleanupPath)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('owned credential cleanup timeout'))
    }, 25000)
    child.once('spawn', () => child.postMessage({ root: join(root, 'runtime') }))
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error('owned credential cleanup failed'))
    })
  })
}
void app.whenReady().then(async () => {
  const keyA = 'fixture-mod01-key-a',
    keyB = 'fixture-mod01-key-b'
  const a = await createMod01Fixture({ modelId: 'model-a-explicit', key: keyA }),
    b = await createMod01Fixture({ modelId: 'model-b-explicit', key: keyB })
  try {
    ipcMain.handle('app:get-info', () => ({
      name: 'MOD01 fixture',
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
    const firstPid = watchLogs()
    await click('模型配置', true)
    await idle()
    assert.equal((await state()).selection.configId, null)
    await submit()
    await until(async () => (await text()).includes('请先修正表单'), 'inline validation missing')
    assert.equal((await state()).total, 0)
    for (const [name, url, id, key] of [
      ['配置 A', a.baseUrl, 'model-a-explicit', keyA],
      ['配置 B', b.baseUrl, 'model-b-explicit', keyB]
    ]) {
      if (name === '配置 B') await click('新建配置')
      await fill('配置名称', name)
      await fill('Base URL', url)
      await fill('模型 ID', id)
      await fill('API Key', key)
      await submit()
      await idle()
      await until(async () => (await text()).includes('模型配置已保存'), 'model save missing')
      assert.equal(await evalJs(`document.querySelector('input[aria-label="API Key"]').value`), '')
      assert.equal(
        await evalJs(`document.querySelector('input[aria-label="API Key"]').type`),
        'password'
      )
    }
    const initial = await state(),
      idA = initial.models.find((x) => x.name === '配置 A')!.configId,
      idB = initial.models.find((x) => x.name === '配置 B')!.configId
    assert.equal(initial.selection.configId, null)
    assert.equal(a.requests.length + b.requests.length, 0)
    await fill('当前模型配置', idA, true)
    await click('应用选择')
    await idle()
    assert.equal((await state()).selection.configId, idA)
    // 编辑 B 时，A 的当前选择保持不变；保存不等于切换选择。
    await evalJs(
      `Array.from(document.querySelectorAll('.models-page li')).find(li=>li.textContent.includes(${JSON.stringify(idB)})).querySelector('button').click()`
    )
    await fill('配置名称', '配置 B 已改名')
    await submit()
    await idle()
    assert.equal((await state()).selection.configId, idA)
    assert.equal((await state()).models.find((x) => x.configId === idB)?.revision, 2)
    await fill('配置名称', '未保存的修改')
    await click('新建配置')
    assert.ok((await text()).includes('有未保存的修改'))
    await click('继续编辑')
    assert.equal(
      await evalJs(`document.querySelector('input[aria-label="配置名称"]').value`),
      '未保存的修改'
    )
    await click('新建配置')
    await click('放弃修改并切换')
    assert.equal(await evalJs(`document.querySelector('input[aria-label="配置名称"]').value`), '')
    await fill('当前模型配置', idB, true)
    await click('应用选择')
    await idle()
    const selected = await state()
    assert.equal(selected.selection.configId, idB)
    assert.equal(a.requests.length + b.requests.length, 0)
    await until(async () => service.getStatus().pi?.state === 'ready', 'Pi ready timeout')
    const ping = await evalJs<ApiResult<{ model: { configId: string; modelId: string } }>>(
      `window.audit.testModel(${JSON.stringify(selected.selection.configId)})`
    )
    assert.equal(ping.ok, true)
    if (ping.ok) {
      assert.equal(ping.data.model.configId, idB)
      assert.equal(ping.data.model.modelId, 'model-b-explicit')
    }
    assert.equal(a.requests.length, 0)
    assert.equal(b.requests.length, 1)
    assert.equal(b.requests[0].authorization, 'Bearer ' + keyB)
    assert.equal(b.requests[0].path, '/v1/chat/completions')
    assert.deepEqual(b.requests[0].body.messages.at(-1).content, [{ type: 'text', text: 'ping' }])
    // 清空选择后不会回退到 A；再明确选择 B，验证持久化重启。
    await fill('当前模型配置', '', true)
    await click('应用选择')
    await idle()
    assert.equal((await state()).selection.configId, null)
    await fill('当前模型配置', idB, true)
    await click('应用选择')
    await idle()
    const before = await state()
    await service.stop()
    assert.throws(() => process.kill(firstPid, 0))
    await service.start()
    const secondPid = watchLogs()
    assert.notEqual(firstPid, secondPid)
    await click('刷新模型配置')
    await idle()
    assert.deepEqual(await state(), before)
    const stale = await evalJs<ApiResult<ModelCatalog>>(
      `window.audit.selectModel(${JSON.stringify({ configId: idA, expectedRevision: 0 })})`
    )
    assert.equal(stale.ok, false)
    if (!stale.ok) assert.equal(stale.error.code, 'MODEL_SELECTION_CONFLICT')
    assert.equal((await state()).selection.configId, idB)
    const missingInput = await evalJs<ApiResult<ModelCatalog>>(
      'window.audit.selectModel(undefined)'
    )
    assert.equal(missingInput.ok, false)
    // 同一配置被另一个调用者更新，旧编辑表单提交必须报冲突而不是覆盖。
    await evalJs(
      `Array.from(document.querySelectorAll('.models-page li')).find(li=>li.textContent.includes(${JSON.stringify(idB)})).querySelector('button').click()`
    )
    const update = await evalJs<ApiResult<unknown>>(
      `window.audit.saveModelConfig(${JSON.stringify({ configId: idB, expectedRevision: 2, name: 'B 外部更新', baseUrl: b.baseUrl, modelId: 'model-b-explicit' })})`
    )
    assert.equal(update.ok, true)
    await fill('配置名称', 'B 旧草稿')
    await fill('API Key', 'fixture-uncommitted-stale-key')
    await submit()
    await idle()
    assert.ok((await text()).includes('METADATA_REVISION_CONFLICT'))
    assert.equal((await state()).selection.model?.name, 'B 外部更新')
    assert.equal(await evalJs(`document.querySelector('input[aria-label="API Key"]').value`), '')
    await click('刷新模型配置')
    await idle()
    await click('编辑配置')
    if ((await text()).includes('有未保存的修改')) await click('放弃修改并切换')
    await fill('Base URL', 'https://changed.example.invalid/v1')
    await submit()
    await idle()
    assert.ok((await text()).includes('MODEL_KEY_REENTRY_REQUIRED'))
    assert.equal((await state()).selection.model?.baseUrl, b.baseUrl)
    assert.equal(a.requests.length + b.requests.length, 1)
    assert.equal((await text()).includes(keyA) || (await text()).includes(keyB), false)
    assert.equal(await evalJs('localStorage.length'), 0)
    await service.stop()
    assert.throws(() => process.kill(secondPid, 0))
    for (const file of ['audit.sqlite3', 'audit.sqlite3-wal', 'audit.sqlite3-shm']) {
      const path = join(root, 'runtime/storage', file)
      if (existsSync(path)) {
        const bytes = readFileSync(path)
        assert.equal(bytes.includes(Buffer.from(keyA)), false)
        assert.equal(bytes.includes(Buffer.from(keyB)), false)
      }
    }
    assert.equal(
      logs.includes(keyA) || logs.includes(keyB) || logs.includes('fixture-uncommitted-stale-key'),
      false
    )
    await cleanup()
    window.destroy()
    await a.close()
    await b.close()
    console.info(
      'PASS MOD-01: actual React create/edit/validate/mask/unsaved/choose/clear/conflicts + real OS fake credentials + restart selection + exact Pi endpoint/model/key + no save/discovery calls + no plaintext DB/DTO/ordinary service logs + owned cleanup.'
    )
    app.exit(0)
  } catch (error) {
    console.error(error)
    await service.stop().catch(() => {})
    await cleanup().catch(() => {})
    window?.destroy()
    await a.close()
    await b.close()
    app.exit(1)
  }
})
