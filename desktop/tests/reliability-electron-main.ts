import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ServiceManager } from '../src/main/service-manager'
import type { SourceProject } from '../src/shared/source-contracts'
import type { ModelSaveResult } from '../src/shared/metadata-contracts'
import type { PreparedScan, PathDetail } from '../src/shared/scan-contracts'
import { createAgentModelFixture } from './agent-model-fixture.mjs'
import cleanupPath from './db02-cleanup-worker.ts?modulePath'
const root = resolve('.reliability-test-data', randomUUID())
app.setPath('userData', join(root, 'profile'))
const service = new ServiceManager(
  () => {},
  () => join(root, 'runtime')
)
let window: BrowserWindow | undefined,
  model: Awaited<ReturnType<typeof createAgentModelFixture>> | undefined
let submissions = 0,
  persistent = false
const js = <T>(text: string): Promise<T> => window!.webContents.executeJavaScript(text)
async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const end = Date.now() + 30000
  while (!(await check())) {
    if (Date.now() > end) throw Error(label + ' timeout')
    await new Promise((r) => setTimeout(r, 60))
  }
}
async function cleanup(): Promise<void> {
  const child = utilityProcess.fork(cleanupPath)
  await new Promise<void>((r, j) => {
    const timer = setTimeout(() => {
      child.kill()
      j(Error('cleanup timeout'))
    }, 20000)
    child.once('spawn', () => child.postMessage({ root: join(root, 'runtime') }))
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) r()
      else j(Error('cleanup failed'))
    })
  })
}
void app.whenReady().then(async () => {
  try {
    mkdirSync(root, { recursive: true })
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
    ipcMain.handle('audit:action', (e, a, input) => {
      assert.equal(e.sender, window!.webContents)
      return service.audit(a, input)
    })
    ipcMain.handle('reviews:action', (_e, a, input) => service.review(a, input))
    ipcMain.handle('templates:action', (_e, a, input) => service.templates(a, input))
    ipcMain.handle('reports:action', (_e, a, input) => service.report(a, input))
    await service.start()
    model = await createAgentModelFixture({
      mode: 'finish',
      transformDecision: (value, { tools }) => {
        const d = value as {
          action: string
          result: { steps: { stepIndex: number; quotes: string[] }[] }
        }
        if (d.action !== 'finish') return d
        submissions++
        for (const s of d.result.steps)
          s.quotes = [
            persistent || submissions === 1
              ? 'ev-invented'
              : tools.find((t) => t.stepIndex === s.stepIndex)!.citations![0].id
          ]
        return d
      }
    })
    const saved = await service.metadata<ModelSaveResult>('model', {
      name: 'QA reliability local fixture',
      baseUrl: model.baseUrl,
      modelId: 'fixture',
      apiKey: 'local-fixture-key'
    })
    assert.ok(saved.ok)
    await service.modelSettings({ configId: saved.data.model.configId, expectedRevision: 0 }, true)
    const project = await service.source<SourceProject>('local', {
      projectName: 'QA reliability',
      path: resolve('tests/fixtures/scan-java')
    })
    assert.ok(project.ok)
    window = new BrowserWindow({
      show: false,
      width: 1450,
      height: 1100,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    await window.loadFile(join(__dirname, '../renderer/index.html'))
    await until(() => js('document.querySelectorAll("nav button").length===5'), 'navigation')
    const scenarios: Record<string, unknown>[] = []
    for (const fail of [false, true]) {
      submissions = 0
      persistent = fail
      const prepared = await service.audit('prepare', { projectId: project.data.projectId })
      assert.ok(prepared.ok)
      const run = prepared.data as PreparedScan,
        scope = { projectId: run.projectId, runId: run.runId },
        pathId = run.pathIds[0],
        transmission = { ...scope, modelConfigId: saved.data.model.configId }
      const disclosure = await service.audit('disclosure', transmission)
      assert.ok(disclosure.ok)
      const allowed = await service.audit('authorize', {
        ...transmission,
        scopeKey: (disclosure.data as { scopeKey: string }).scopeKey
      })
      assert.ok(allowed.ok)
      const start = await service.audit('analyze', { ...transmission, pathId })
      assert.ok(start.ok)
      await until(async () => {
        const d = await service.audit('detail', { ...scope, pathId })
        return d.ok && (d.data as PathDetail).status !== 'analyzing'
      }, 'terminal path')
      const detail = await service.audit('detail', { ...scope, pathId })
      assert.ok(detail.ok)
      assert.equal((detail.data as PathDetail).status, fail ? 'failed' : 'unresolved')
      assert.equal(submissions, 2)
      await js(
        'Array.from(document.querySelectorAll("nav button")).find(b=>b.textContent==="模型配置").click()'
      )
      await until(
        () =>
          js(
            'document.querySelector("h1")?.textContent==="模型配置" && !document.querySelector("[data-testid=validation-feedback]")'
          ),
        'model navigation settled'
      )
      await js(
        `localStorage.setItem('audit.detail.selection.v1',JSON.stringify(${JSON.stringify({ ...scope, pathId, tab: 'process' })}));Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='审计分析').click()`
      )
      const history = await service.audit('history', { ...scope, pathId })
      assert.ok(history.ok)
      const selected = (history.data as { selectedSessionId: string }).selectedSessionId
      await until(
        () =>
          js(
            `document.body.textContent.includes(${JSON.stringify(pathId)}) && document.querySelector('select[aria-label="分析历史会话"]')?.value===${JSON.stringify(selected)}`
          ),
        'current path history'
      )
      await until(
        () => js('!!document.querySelector("[data-testid=validation-feedback]")'),
        'validation feedback'
      )
      assert.ok(
        await js(
          'document.querySelector("[data-testid=validation-feedback]").textContent.includes("steps[0].quotes[0]")'
        )
      )
      assert.equal(
        await js('!!document.querySelector("[data-testid=analysis-timeline] [role=alert]")'),
        fail
      )
      if (!fail)
        assert.ok(
          await js(
            'document.querySelector("[data-testid=analysis-timeline]").textContent.includes("原文与传播校验通过")'
          )
        )
      await js(
        'document.querySelector("[data-testid=validation-feedback]").scrollIntoView({block:"center"})'
      )
      await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      writeFileSync(
        join(root, fail ? 'validation-failed.png' : 'validation-repaired.png'),
        (await window.webContents.capturePage()).toPNG()
      )
      scenarios.push({
        failed: fail,
        ...scope,
        pathId,
        submissions,
        verdict: (detail.data as PathDetail).verdict,
        status: (detail.data as PathDetail).status
      })
    }
    assert.equal(await js('typeof require'), 'undefined')
    writeFileSync(
      join(root, 'verification.json'),
      JSON.stringify(
        { ok: true, scenarios, requests: model.requests.length, paidRequests: 0 },
        null,
        2
      )
    )
    await service.stop()
    await cleanup()
    await model.close()
    window.destroy()
    console.log(
      'PASS reliability Electron: real Pi repair, scoped evidence, persisted field diagnostics, renderer history, bounded failure, credential cleanup'
    )
    console.log('RELIABILITY_ARTIFACTS=' + root)
    app.exit(0)
  } catch (error) {
    console.error(error)
    if (window)
      writeFileSync(join(root, 'failure.png'), (await window.webContents.capturePage()).toPNG())
    await service.stop().catch(() => {})
    await cleanup().catch(() => {})
    await model?.close().catch(() => {})
    window?.destroy()
    app.exit(1)
  }
})
