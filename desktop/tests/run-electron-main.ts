import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron'
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { ServiceManager } from '../src/main/service-manager'
import type { SourceProject } from '../src/shared/source-contracts'
import type { ModelSaveResult } from '../src/shared/metadata-contracts'
import type { AuditAction, PathDetail, PreparedScan } from '../src/shared/scan-contracts'
import type { RunRecoveryView } from '../src/shared/run-contracts'
import type { ReportRecord, ReportPreview } from '../src/shared/report-contracts'
import { createAgentModelFixture } from './agent-model-fixture.mjs'
import cleanupPath from './db02-cleanup-worker.ts?modulePath'
const root = resolve('.run-test-data', randomUUID())
app.setPath('userData', join(root, 'profile'))
const service = new ServiceManager(
  () => {},
  () => join(root, 'runtime')
)
let window: BrowserWindow | undefined,
  model: Awaited<ReturnType<typeof createAgentModelFixture>> | undefined,
  db: DatabaseSync | undefined
let release = (): void => {}
const js = <T>(code: string): Promise<T> => window!.webContents.executeJavaScript(code)
async function until(check: () => Promise<boolean>, label = 'DOM'): Promise<void> {
  const end = Date.now() + 30000
  while (!(await check())) {
    if (Date.now() > end) throw Error(label + ' timeout')
    await new Promise((r) => setTimeout(r, 60))
  }
}
async function capture(name: string, selector = '[data-testid=run-control-panel]'): Promise<void> {
  await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start'})`)
  await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  writeFileSync(join(root, name + '.png'), (await window!.webContents.capturePage()).toPNG())
}
async function cleanup(): Promise<void> {
  const child = utilityProcess.fork(cleanupPath)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(Error('cleanup timeout'))
    }, 20000)
    child.once('spawn', () => child.postMessage({ root: join(root, 'runtime') }))
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(Error('credential cleanup'))
    })
  })
}
void app.whenReady().then(async () => {
  try {
    mkdirSync(join(root, 'source'), { recursive: true })
    for (const file of readdirSync(resolve('tests/fixtures/scan-java')))
      writeFileSync(
        join(root, 'source', file),
        readFileSync(resolve('tests/fixtures/scan-java', file), 'utf8').replace(/\r?\n/g, '\r\n')
      )
    ipcMain.handle('app:get-info', () => ({
      name: 'pi-audit-harness',
      version: '1',
      node: process.versions.node,
      electron: process.versions.electron
    }))
    ipcMain.handle('service:get-status', () => service.getStatus())
    ipcMain.handle('service:check-health', () => service.checkHealth())
    ipcMain.handle('storage:get-overview', () => service.getStorageOverview())
    ipcMain.handle('metadata:get', () => service.metadata('list'))
    ipcMain.handle('models:get-catalog', () => service.modelSettings())
    ipcMain.handle('sources:list', () => service.source('list'))
    ipcMain.handle('sources:tools', () => service.source('tools'))
    ipcMain.handle('audit:action', (event, action: AuditAction, input: unknown) => {
      assert.equal(event.sender, window!.webContents)
      assert.equal(event.senderFrame, window!.webContents.mainFrame)
      return service.audit(action, input)
    })
    ipcMain.handle(
      'templates:action',
      (_e, action: import('../src/shared/template-contracts').TemplateAction, input: unknown) =>
        service.templates(action, input)
    )
    ipcMain.handle(
      'reviews:action',
      (_e, action: import('../src/shared/review-contracts').ReviewAction, input: unknown) =>
        service.review(action, input)
    )
    ipcMain.handle(
      'reports:action',
      (_e, action: import('../src/shared/report-contracts').ReportAction, input: unknown) =>
        service.report(action, input)
    )
    await service.start()
    const gate = new Promise<void>((r) => {
      release = r
    })
    model = await createAgentModelFixture({
      mode: 'continue',
      delayMs: 60,
      beforeReply: async (body) => {
        if (body.messages.filter((m) => m.role === 'user').length >= 2) await gate
      }
    })
    const saved = await service.metadata<ModelSaveResult>('model', {
      name: '停止与恢复本机夹具',
      baseUrl: model.baseUrl,
      modelId: 'fixture',
      apiKey: 'local-fixture-key'
    })
    assert.equal(saved.ok, true)
    await service.modelSettings({ configId: saved.data.model.configId, expectedRevision: 0 }, true)
    const imported = await service.source<SourceProject>('local', {
      projectName: '可验证恢复样例',
      path: join(root, 'source')
    })
    assert.equal(imported.ok, true)
    const prepared = await service.audit('prepare', { projectId: imported.data.projectId })
    assert.equal(prepared.ok, true)
    const run = prepared.data as PreparedScan,
      scope = { projectId: run.projectId, runId: run.runId },
      pathId = run.pathIds[0],
      transmission = { ...scope, modelConfigId: saved.data.model.configId }
    const disclosure = await service.audit('disclosure', transmission)
    assert.equal(disclosure.ok, true)
    assert.equal(
      (
        await service.audit('authorize', {
          ...transmission,
          scopeKey: (disclosure.data as { scopeKey: string }).scopeKey
        })
      ).ok,
      true
    )
    window = new BrowserWindow({
      show: false,
      width: 1450,
      height: 1100,
      minWidth: 320,
      minHeight: 400,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    await window.loadFile(join(__dirname, '../renderer/index.html'))
    await until(() => js('document.querySelectorAll("nav button").length===5'))
    await js(
      `localStorage.setItem('audit.detail.selection.v1',JSON.stringify(${JSON.stringify({ ...scope, pathId, tab: 'path' })}));Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='审计分析').click()`
    )
    await until(() => js('!!document.querySelector("[data-testid=run-control-panel]")'))
    db = new DatabaseSync(join(root, 'runtime/storage/audit.sqlite3'), { readOnly: true })
    assert.equal((await service.audit('analyze', { ...transmission, pathId })).ok, true)
    await until(
      async () =>
        Number(db!.prepare('SELECT count(*) AS n FROM recovery_checkpoints').get()!.n) > 0,
      'safe checkpoint'
    )
    await until(async () => model!.requests.length >= 5, 'inflight next round')
    await until(() => js('document.querySelector("[data-testid=stop-run]").disabled===false'))
    await capture('run-running')
    await js('document.querySelector("[data-testid=stop-run]").click()')
    await until(() =>
      js(
        'document.querySelector("[data-testid=run-control-message]")?.textContent.includes("停止请求已受理")'
      )
    )
    await until(() =>
      js('document.querySelector("[data-testid=run-control-state]")?.textContent==="已停止"')
    )
    const plan = await service.audit('recovery', scope)
    assert.equal(plan.ok, true)
    assert.equal((plan.data as RunRecoveryView).mode, 'native')
    assert.equal((plan.data as RunRecoveryView).readSteps.length, 3)
    assert.equal((plan.data as RunRecoveryView).uncertainRequests, 1)
    assert.ok(
      await js(
        'document.querySelector("[data-testid=recovery-manifest]").textContent.includes("原任务")'
      )
    )
    await capture('run-stopped')
    const requests = model.requests.length,
      beforePid = (service as unknown as { child: { pid: number } }).child.pid
    await service.stop()
    await service.start()
    const afterPid = (service as unknown as { child: { pid: number } }).child.pid
    assert.notEqual(beforePid, afterPid)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(model.requests.length, requests)
    const loaded = new Promise<void>((r) => window!.webContents.once('did-finish-load', () => r()))
    window.webContents.reload()
    await loaded
    await until(() => js('document.querySelectorAll("nav button").length===5'))
    await js(
      'Array.from(document.querySelectorAll("nav button")).find(b=>b.textContent==="审计分析").click()'
    )
    await until(() => js('document.querySelector("[data-testid=resume-run]")?.disabled===false'))
    for (const file of readdirSync(join(root, 'source')))
      writeFileSync(join(root, 'source', file), 'class ChangedSource {}')
    release()
    await js('document.querySelector("[data-testid=resume-run]").click()')
    await until(async () => {
      const result = await service.audit('recovery', scope)
      return result.ok && (result.data as RunRecoveryView).committedPaths === 2
    }, 'resumed paths')
    await until(() =>
      js('document.querySelector("[data-testid=last-recovery]")?.textContent.includes("检查点")')
    )
    await until(
      () => js('document.querySelector("[data-testid=run-control-state]")?.textContent==="已完成"'),
      'completed control view'
    )
    const detail = await service.audit('detail', { ...scope, pathId })
    assert.equal(detail.ok, true)
    assert.ok((detail.data as PathDetail).steps.every((s) => s.evidence.length > 0))
    assert.equal(
      db.prepare('SELECT attempt FROM path_attempts WHERE path_id=?').get(pathId)!.attempt,
      2
    )
    assert.equal(
      (model.requests[requests] as { messages: { role: string }[] }).messages.filter(
        (m) => m.role === 'tool'
      ).length,
      3
    )
    await capture('run-restored')
    for (const width of [1450, 920, 480]) {
      window.setSize(width, 1000)
      await capture('run-' + width)
      assert.ok(await js('document.documentElement.scrollWidth<=innerWidth+1'))
    }
    window.setSize(1450, 1100)
    const filter = { verdict: 'all', pathStatus: 'all', reviewStatus: 'all' }
    const preview = await service.report('preview', { ...scope, filter })
    assert.equal(preview.ok, true)
    const exported = await service.report('export', {
      ...scope,
      filter,
      format: 'json',
      expectedSnapshotKey: (preview.data as ReportPreview).snapshotKey
    })
    assert.equal(exported.ok, true)
    const report = exported.data as ReportRecord
    assert.equal(report.status, 'ready')
    const reportText = readFileSync(report.filePath, 'utf8'),
      document = JSON.parse(reportText)
    assert.equal(document.recovery.uncertainRequests, 1)
    assert.equal(
      document.recovery.paths.find((p: { pathId: string }) => p.pathId === pathId).lastRecovery
        .mode,
      'native'
    )
    assert.ok(!reportText.includes('local-fixture-key'))
    writeFileSync(
      join(root, 'verification.json'),
      JSON.stringify(
        {
          beforePid,
          afterPid,
          requestsBeforeResume: requests,
          totalRequests: model.requests.length,
          recovery: document.recovery,
          source: 'actual Electron React utilityProcess Pi SDK and CRLF snapshot'
        },
        null,
        2
      )
    )
    console.info(
      'PASS RUN-01/RUN-02: actual stop acceptance/wait/stopped, native context and host evidence, original CRLF snapshot after disk changes, no auto model call after different-PID restart, explicit resume, independent SSE history, stage JSON and 1450/920/480 layout.'
    )
    console.info('RUN_ARTIFACTS=', root)
    db.close()
    db = undefined
    await service.stop()
    await cleanup()
    await model.close()
    window.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error)
    release()
    if (window) await capture('failure', 'main').catch(() => {})
    db?.close()
    await service.stop().catch(() => {})
    await cleanup().catch(() => {})
    await model?.close().catch(() => {})
    window?.destroy()
    app.exit(1)
  }
})
