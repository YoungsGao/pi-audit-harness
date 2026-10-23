import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ServiceManager } from '../src/main/service-manager'
import type { AuditAction, ScanStatistics } from '../src/shared/scan-contracts'
import type { SourceProject } from '../src/shared/source-contracts'
import type { ApiResult } from '../src/shared/service-protocol'
import type { ModelSaveResult } from '../src/shared/metadata-contracts'
import { createScanModelFixture } from './scan-model-fixture.mjs'
import cleanupPath from './db02-cleanup-worker.ts?modulePath'
const root = resolve('.scan-test-data', randomUUID())
app.setPath('userData', join(root, 'profile'))
const service = new ServiceManager(
  () => {},
  () => join(root, 'runtime')
)
let window: BrowserWindow | undefined
let fixture: Awaited<ReturnType<typeof createScanModelFixture>> | undefined
async function cleanup(): Promise<void> {
  const child = utilityProcess.fork(cleanupPath)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('fake key cleanup timeout'))
    }, 30000)
    child.once('spawn', () => child.postMessage({ root: join(root, 'runtime') }))
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error('fake key cleanup failed'))
    })
  })
}
const js = async <T>(text: string): Promise<T> => window!.webContents.executeJavaScript(text)
async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('scan DOM timeout')
    await new Promise((r) => setTimeout(r, 70))
  }
}
void app.whenReady().then(async () => {
  try {
    ipcMain.handle('app:get-info', () => ({
      name: 'Scan integration',
      version: '1',
      node: process.versions.node,
      electron: process.versions.electron
    }))
    ipcMain.handle('service:get-status', () => service.getStatus())
    ipcMain.handle('service:check-health', () => service.checkHealth())
    ipcMain.handle('storage:get-overview', () => service.getStorageOverview())
    ipcMain.handle('metadata:get', () => service.metadata('list'))
    ipcMain.handle('sources:list', () => service.source('list'))
    ipcMain.handle('models:get-catalog', () => service.modelSettings())
    ipcMain.handle('audit:action', (_e, action: AuditAction, input: unknown) =>
      service.audit(action, input)
    )
    await service.start()
    fixture = await createScanModelFixture()
    const saved = await service.metadata<ModelSaveResult>('model', {
      name: '本机路径审阅测试',
      baseUrl: fixture.baseUrl,
      modelId: 'scan-review-fixture',
      apiKey: 'fixture-scan-not-a-real-key'
    })
    assert.equal(saved.ok, true)
    const selected = await service.modelSettings(
      { configId: saved.data.model.configId, expectedRevision: 0 },
      true
    )
    assert.equal(selected.ok, true)
    const imported = await service.source<SourceProject>('local', {
      projectName: '用户查询审计样例',
      path: resolve('tests/fixtures/scan-java')
    })
    assert.equal(imported.ok, true)
    window = new BrowserWindow({
      show: false,
      width: 1450,
      height: 1250,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    })
    await window.loadFile(join(__dirname, '../renderer/index.html'))
    await js(
      "Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='审计分析').click()"
    )
    await until(() =>
      js('document.querySelector(\'select[aria-label="审计项目"]\')?.options.length>1')
    )
    await js(
      `(()=>{const select=document.querySelector('select[aria-label="审计项目"]');select.value=${JSON.stringify(imported.data.projectId)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`
    )
    await js(
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='预处理并生成调用链').click()"
    )
    await until(() =>
      js(
        "document.querySelector('[data-testid=\"audit-statistics\"]')?.textContent.includes('候选路径2')"
      )
    )
    await until(() =>
      js(
        "document.querySelector('[aria-label=\"调用链简要详情\"]')?.textContent.includes('UserRepository')"
      )
    )
    const catalog = (await service.audit('runs', {
      projectId: imported.data.projectId
    })) as ApiResult<{ runs: { runId: string }[] }>
    assert.equal(catalog.ok, true)
    const runId = catalog.data.runs[0].runId
    const stats = (await service.audit('statistics', {
      projectId: imported.data.projectId,
      runId
    })) as ApiResult<ScanStatistics>
    assert.equal(stats.ok, true)
    if (stats.ok) {
      assert.equal(stats.data.paths, 2)
      assert.equal(stats.data.sinks, 1)
      assert.equal(stats.data.edges, 4)
    }
    const detailText = await js<string>(
      'document.querySelector(\'[aria-label="调用链简要详情"]\').textContent'
    )
    assert.ok(detailText.includes('SearchService'))
    assert.equal(await js('typeof window.require'), 'undefined')
    assert.equal(fixture.requests.length, 0)
    await until(() =>
      js('document.querySelector(\'[data-testid="start-path-analysis"]\')?.disabled===false')
    )
    await js(
      '(()=>{const b=document.querySelector(\'[data-testid="start-path-analysis"]\');b.click();b.click()})()'
    )
    await until(() =>
      js(
        "document.querySelector('[data-testid=\"audit-statistics\"]')?.textContent.includes('分析中1')"
      )
    )
    await until(() =>
      js("document.querySelector('.audit-summary')?.textContent.includes('本机受控模型')")
    )
    assert.equal(fixture.requests.length, 1)
    assert.equal(await js("document.querySelector('.audit-summary script')===null"), true)
    const afterAnalysis = (await service.audit('statistics', {
      projectId: imported.data.projectId,
      runId
    })) as ApiResult<ScanStatistics>
    assert.equal(afterAnalysis.ok, true)
    assert.equal(afterAnalysis.data.unresolved, 1)
    assert.equal(afterAnalysis.data.pending, 1)
    mkdirSync(root, { recursive: true })
    const screenshot = join(root, 'audit-workbench.png')
    await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    await new Promise((r) => setTimeout(r, 250))
    writeFileSync(
      screenshot,
      (
        await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      ).toPNG()
    )
    const firstPid = (service as unknown as { child: { pid: number } }).child.pid
    await service.stop()
    await service.start()
    assert.notEqual((service as unknown as { child: { pid: number } }).child.pid, firstPid)
    const again = await service.audit('statistics', { projectId: imported.data.projectId, runId })
    assert.deepEqual(again.ok && again.data, afterAnalysis.data)
    console.info(
      'PASS SCAN/UI: real Java parsing -> utilityProcess SQLite -> main DTO -> preload -> React -> actual Pi SDK/local fixture -> per-path result and stats -> different-PID persistence. Double click sent one local-only request; text escaped.'
    )
    console.info('SCREENSHOT=', screenshot)
    console.info('DATABASE=', join(root, 'runtime/storage/audit.sqlite3'))
    await service.stop()
    await cleanup()
    await fixture.close()
    window.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error)
    await service.stop().catch(() => {})
    await cleanup().catch(() => {})
    await fixture?.close()
    window?.destroy()
    app.exit(1)
  }
})
