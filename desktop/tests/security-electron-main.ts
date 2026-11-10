import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { ServiceManager } from '../src/main/service-manager'
import { assertDesktopClient, secureWindow } from '../src/main/window-security'
import type { SourceProject } from '../src/shared/source-contracts'
import type { PreparedScan } from '../src/shared/scan-contracts'
import type { ReportCatalog } from '../src/shared/report-contracts'
const root = resolve('.security-test-data', randomUUID())
app.setPath('userData', join(root, 'profile'))
const service = new ServiceManager(
  () => {},
  () => join(root, 'runtime')
)
let window: BrowserWindow | undefined,
  foreign: BrowserWindow | undefined,
  preview: BrowserWindow | undefined
const js = <T>(code: string): Promise<T> => window!.webContents.executeJavaScript(code)
async function until(check: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 15000
  while (!(await check())) {
    if (Date.now() > end) throw Error('security UI timeout')
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}
void app.whenReady().then(async () => {
  let hits = 0
  const probe = createServer((_req, res) => {
    hits++
    res.end('unexpected')
  })
  try {
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as import('node:net').AddressInfo).port
    const attack = `<script>window.SEC_INJECTED=1</script><img src="http://127.0.0.1:${port}/probe" onerror="window.SEC_INJECTED=1"><iframe src="http://127.0.0.1:${port}/frame"></iframe><a href="javascript:window.SEC_INJECTED=1">SEC payload</a>`
    mkdirSync(join(root, 'source'), { recursive: true })
    writeFileSync(
      join(root, 'source', 'Demo.java'),
      'class Demo { @GetMapping("/q") void query(String q) { /* ' +
        attack +
        ' */ stmt.executeQuery(q); } }'
    )
    const guard = (event: Electron.IpcMainInvokeEvent): void =>
      assertDesktopClient(event, window ?? null)
    ipcMain.handle('app:get-info', (event) => {
      guard(event)
      return {
        name: 'security-test',
        version: '1',
        node: process.versions.node,
        electron: process.versions.electron
      }
    })
    ipcMain.handle('service:get-status', (event) => {
      guard(event)
      return service.getStatus()
    })
    ipcMain.handle('service:check-health', (event) => {
      guard(event)
      return service.checkHealth()
    })
    ipcMain.handle('metadata:get', (event) => {
      guard(event)
      return service.metadata('list')
    })
    ipcMain.handle('models:get-catalog', (event) => {
      guard(event)
      return service.modelSettings()
    })
    ipcMain.handle('sources:list', (event) => {
      guard(event)
      return service.source('list')
    })
    ipcMain.handle('storage:get-overview', (event) => {
      guard(event)
      return service.getStorageOverview()
    })
    ipcMain.handle('audit:action', (event, action, input) => {
      guard(event)
      return service.audit(action, input)
    })
    ipcMain.handle('reviews:action', (event, action, input) => {
      guard(event)
      return service.review(action, input)
    })
    ipcMain.handle('templates:action', (event, action, input) => {
      guard(event)
      return service.templates(action, input)
    })
    await service.start()
    const imported = await service.source<SourceProject>('local', {
      projectName: 'SEC <script>window.SEC_INJECTED=1</script>',
      path: join(root, 'source')
    })
    assert.ok(imported.ok, JSON.stringify(imported))
    const prepared = await service.audit('prepare', { projectId: imported.data.projectId })
    assert.ok(prepared.ok)
    const run = prepared.data as PreparedScan
    const scope = { projectId: run.projectId, runId: run.runId, pathId: run.pathIds[0] }
    const original = await service.review('get', scope)
    assert.ok(original.ok)
    const review = original.data as import('../src/shared/review-contracts').HumanReview
    const saved = await service.review('save', {
      ...scope,
      expectedRevision: 0,
      baselineVersion: review.current.version,
      status: 'needs_more_info',
      note: attack + ' api_key="sec-private-marker"'
    })
    assert.ok(saved.ok)
    window = new BrowserWindow({
      show: false,
      width: 1300,
      height: 1000,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    secureWindow(window)
    await window.loadFile(join(__dirname, '../renderer/index.html'))
    const prefs = (
      window.webContents as typeof window.webContents & {
        getLastWebPreferences(): Electron.WebPreferences
      }
    ).getLastWebPreferences()
    assert.equal(prefs.contextIsolation, true)
    assert.equal(prefs.nodeIntegration, false)
    assert.equal(prefs.sandbox, true)
    assert.equal(await js('typeof require'), 'undefined')
    assert.equal(await js('typeof window.audit'), 'object')
    assert.equal(await js('typeof window.audit.invoke'), 'undefined')
    await until(() => js('document.querySelectorAll("nav button").length===5'))
    await js(
      `localStorage.setItem('audit.detail.selection.v1',JSON.stringify(${JSON.stringify({ ...scope, tab: 'path' })})); Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='审计分析').click()`
    )
    await until(() =>
      js(
        '!!document.querySelector("[data-testid=graph-source]") && !!document.querySelector("[aria-label=人工复核备注]")'
      )
    )
    assert.ok(
      await js(
        'document.querySelector("[data-testid=graph-source]").textContent.includes("<script>")'
      )
    )
    assert.ok(
      await js('document.querySelector("[aria-label=人工复核备注]").value.includes("<img")')
    )
    assert.equal(
      await js('document.querySelectorAll("#root img,#root iframe,#root script").length'),
      0
    )
    assert.equal(await js('window.SEC_INJECTED'), undefined)
    assert.equal(await js('document.body.textContent.includes("sec-private-marker")'), false)
    await js(
      'document.querySelector("[data-testid=graph-source]").scrollIntoView({block:"center"}); new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'
    )
    writeFileSync(
      join(root, 'source-review-escaped.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    const metadata = await service.metadata('list')
    assert.ok(metadata.ok)
    assert.equal(JSON.stringify(metadata).includes('secretRef'), false)
    const generated = await service.report('generate', {
      projectId: scope.projectId,
      runId: scope.runId
    })
    assert.ok(generated.ok)
    const catalog = await service.report('list', { projectId: scope.projectId, runId: scope.runId })
    assert.ok(catalog.ok)
    const file = (catalog.data as ReportCatalog).reports[0]
    assert.equal(file.status, 'ready', file.errorCode ?? 'report not ready')
    assert.equal(readFileSync(file.filePath, 'utf8').includes('sec-private-marker'), false)
    preview = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    secureWindow(preview)
    await preview.loadFile(file.filePath)
    assert.equal(
      await preview.webContents.executeJavaScript(
        'document.querySelectorAll("script,img,iframe,a").length'
      ),
      0
    )
    assert.ok(
      await preview.webContents.executeJavaScript('document.body.textContent.includes("<script>")')
    )
    assert.equal(await preview.webContents.executeJavaScript('window.SEC_INJECTED'), undefined)
    await preview.webContents.executeJavaScript(
      'Array.from(document.querySelectorAll("pre")).find(e=>e.textContent.includes("<script>")).scrollIntoView({block:"center"}); new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'
    )
    writeFileSync(
      join(root, 'report-escaped.png'),
      (await preview.webContents.capturePage()).toPNG()
    )
    const count = BrowserWindow.getAllWindows().length
    await js(`window.open('http://127.0.0.1:${port}/popup')`)
    assert.equal(BrowserWindow.getAllWindows().length, count)
    await js(`location.href='http://127.0.0.1:${port}/navigation'`)
    assert.ok(window.webContents.getURL().startsWith('file:'))
    foreign = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    await foreign.loadFile(join(__dirname, '../renderer/index.html'))
    assert.equal(
      await foreign.webContents.executeJavaScript(
        'window.audit.getAppInfo().then(()=>false,()=>true)'
      ),
      true
    )
    assert.equal(hits, 0)
    writeFileSync(
      join(root, 'verification.json'),
      JSON.stringify(
        {
          scope,
          checks: [
            'context isolation',
            'no Node in renderer',
            'fixed IPC bridge',
            'foreign IPC denied',
            'navigation/popup denied',
            'source/review/HTML escaped',
            'no external requests'
          ],
          probeRequests: hits
        },
        null,
        2
      )
    )
    console.info(
      'PASS SEC-03: actual Electron/React/utilityProcess, source/review/report escaping, fixed IPC, foreign sender, navigation/popup and zero probe requests.'
    )
    console.info('SECURITY_ARTIFACTS=', root)
    await service.stop()
    foreign.destroy()
    preview.destroy()
    window.destroy()
    probe.close()
    app.exit(0)
  } catch (error) {
    console.error(error)
    if (window)
      writeFileSync(join(root, 'failure.png'), (await window.webContents.capturePage()).toPNG())
    await service.stop().catch(() => {})
    foreign?.destroy()
    preview?.destroy()
    window?.destroy()
    probe.close()
    app.exit(1)
  }
})
