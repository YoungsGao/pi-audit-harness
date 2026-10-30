import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron'
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ServiceManager } from '../src/main/service-manager'
import type { SourceProject } from '../src/shared/source-contracts'
import type { ModelSaveResult } from '../src/shared/metadata-contracts'
import type { PathDetail, PreparedScan } from '../src/shared/scan-contracts'
import type { HumanReview } from '../src/shared/review-contracts'
import type { ReportCatalog } from '../src/shared/report-contracts'
import { createScanModelFixture } from './scan-model-fixture.mjs'
import cleanupPath from './db02-cleanup-worker.ts?modulePath'
const root = resolve('.review-test-data', randomUUID())
app.setPath('userData', join(root, 'profile'))
let window: BrowserWindow | undefined,
  model: Awaited<ReturnType<typeof createScanModelFixture>> | undefined
let cancelSave = true
const copied: string[] = [],
  opened: string[] = []
const service = new ServiceManager(
  () => {},
  () => join(root, 'runtime'),
  async (file) => {
    const preview = new BrowserWindow({
      show: false,
      width: 1100,
      height: 1000,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    })
    try {
      await preview.loadFile(file)
      assert.equal(
        await preview.webContents.executeJavaScript(
          'document.querySelectorAll("script,img,iframe").length'
        ),
        0
      )
      assert.ok(
        await preview.webContents.executeJavaScript(
          'document.body.textContent.includes("人工判为误报")'
        )
      )
      writeFileSync(
        join(root, 'report-html.png'),
        (await preview.webContents.capturePage()).toPNG()
      )
      opened.push(file)
      return ''
    } finally {
      preview.destroy()
    }
  },
  async (file) => {
    if (cancelSave) return null
    const destination = join(root, 'copies', file.reportId + '.' + file.format)
    copied.push(destination)
    return destination
  }
)
const js = async <T>(source: string): Promise<T> => {
  try {
    return await window!.webContents.executeJavaScript(source)
  } catch (error) {
    throw new Error('Renderer script failed at ' + source.slice(0, 100) + ': ' + String(error), {
      cause: error
    })
  }
}
async function until(check: () => Promise<boolean>, label = 'DOM'): Promise<void> {
  const end = Date.now() + 25000
  while (!(await check())) {
    if (Date.now() > end) throw Error(label + ' timeout')
    await new Promise((r) => setTimeout(r, 65))
  }
}
async function click(label: string, nav = false): Promise<void> {
  await js(
    `Array.from(document.querySelectorAll(${JSON.stringify(nav ? 'nav button' : 'button')})).find(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled).click()`
  )
}
async function fill(label: string, value: string): Promise<void> {
  await js(
    `(()=>{const e=document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]');const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`
  )
}
async function capture(name: string, selector?: string): Promise<void> {
  if (selector)
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start'})`)
  await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  await new Promise((r) => setTimeout(r, 120))
  writeFileSync(
    join(root, name + '.png'),
    (
      await window!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    ).toPNG()
  )
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
      else reject(Error('credential cleanup failed'))
    })
  })
}
void app.whenReady().then(async () => {
  try {
    mkdirSync(join(root, 'source'), { recursive: true })
    mkdirSync(join(root, 'copies'))
    for (const file of readdirSync(resolve('tests/fixtures/scan-java'))) {
      let source = readFileSync(resolve('tests/fixtures/scan-java', file), 'utf8')
      if (file === 'UserRepository.java')
        source = source.replace(
          'statement.executeQuery',
          'if (!input.matches("[a-zA-Z0-9_]+")) throw new IllegalArgumentException();\n        statement.executeQuery'
        )
      writeFileSync(join(root, 'source', file), source)
    }
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
    ipcMain.handle(
      'audit:action',
      (_event, action: import('../src/shared/scan-contracts').AuditAction, input: unknown) =>
        service.audit(action, input)
    )
    ipcMain.handle(
      'templates:action',
      (_event, action: import('../src/shared/template-contracts').TemplateAction, input: unknown) =>
        service.templates(action, input)
    )
    ipcMain.handle(
      'reviews:action',
      (event, action: import('../src/shared/review-contracts').ReviewAction, input: unknown) => {
        assert.equal(event.sender, window!.webContents)
        assert.equal(event.senderFrame, window!.webContents.mainFrame)
        assert.ok(['get', 'save', 'source'].includes(action))
        return service.review(action, input)
      }
    )
    ipcMain.handle(
      'reports:action',
      (_event, action: import('../src/shared/report-contracts').ReportAction, input: unknown) => {
        assert.ok(['generate', 'list', 'preview', 'export'].includes(action))
        return service.report(action, input)
      }
    )
    ipcMain.handle('reports:save', (_event, input: unknown) => service.saveReport(input))
    ipcMain.handle('reports:open', (_event, input: unknown) => service.openReport(input))
    await service.start()
    model = await createScanModelFixture('safe')
    const configured = await service.metadata<ModelSaveResult>('model', {
      name: '界面与复核本机模型',
      baseUrl: model.baseUrl,
      modelId: 'fixture-review-ui',
      apiKey: 'fixture-review-not-real'
    })
    assert.equal(configured.ok, true)
    await service.modelSettings(
      { configId: configured.data.model.configId, expectedRevision: 0 },
      true
    )
    const imported = await service.source<SourceProject>('local', {
      projectName: '路径图与独立复核样例',
      path: join(root, 'source')
    })
    assert.equal(imported.ok, true)
    const prepared = await service.audit('prepare', { projectId: imported.data.projectId })
    assert.equal(prepared.ok, true)
    const run = prepared.data as PreparedScan,
      scope = { projectId: run.projectId, runId: run.runId },
      pathId = run.pathIds[0]
    const transmission = { ...scope, modelConfigId: configured.data.model.configId }
    const disclosure = await service.audit('disclosure', transmission)
    assert.equal(disclosure.ok, true)
    const permission = await service.audit('authorize', {
      ...transmission,
      scopeKey: (disclosure.data as { scopeKey: string }).scopeKey
    })
    assert.equal(permission.ok, true)
    assert.equal((await service.audit('analyze', { ...transmission, pathId })).ok, true)
    await until(async () => {
      const result = await service.audit('detail', { ...scope, pathId })
      return result.ok && (result.data as PathDetail).status !== 'analyzing'
    }, 'analysis')
    const machine = await service.audit('detail', { ...scope, pathId })
    assert.equal(machine.ok, true)
    assert.equal((machine.data as PathDetail).verdict, 'safe')
    const requests = model.requests.length
    window = new BrowserWindow({
      show: false,
      width: 1450,
      height: 1100,
      minWidth: 320,
      minHeight: 400,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    })
    await window.loadFile(join(__dirname, '../renderer/index.html'))
    await until(() => js('document.querySelectorAll("nav button").length===5'), 'navigation ready')
    await click('模型配置', true)
    await until(() => js('!!document.querySelector(".model-config-layout")'))
    assert.equal(
      await js('getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()'),
      '#475ecb'
    )
    assert.equal(
      await js('getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim()'),
      '#eff2f7'
    )
    assert.equal(await js('document.querySelector(".brand").textContent'), 'pi-audit-harness')
    const layout = await js<{ left: number; right: number; editor: number; width: number }>(
      '(()=>{const a=document.querySelector(".model-selection-pane").getBoundingClientRect(),b=document.querySelector(".model-editor-pane").getBoundingClientRect();return {left:a.x,right:b.x,editor:b.width,width:document.querySelector(".model-config-layout").getBoundingClientRect().width}})()'
    )
    assert.ok(layout.right > layout.left + 100)
    assert.ok(layout.editor > layout.width * 0.45)
    assert.equal(
      await js('getComputedStyle(document.querySelector("select")).paddingRight'),
      '42px'
    )
    await capture('models-wide')
    const primary = await js<{ x: number; y: number }>(
      '(()=>{const r=document.querySelector(".model-editor-pane .button-primary").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()'
    )
    window.webContents.sendInputEvent({ type: 'mouseMove', ...primary })
    await until(() =>
      js('document.querySelector(".model-editor-pane .button-primary").matches(":hover")')
    )
    assert.equal(
      await js(
        'getComputedStyle(document.querySelector(".model-editor-pane .button-primary")).color'
      ),
      'rgb(255, 255, 255)'
    )
    for (const width of [920, 480]) {
      window.setSize(width, 900)
      await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      assert.ok(
        await js('document.documentElement.scrollWidth<=innerWidth+1'),
        'model overflow ' + width
      )
      await capture('models-' + width, '.models-page')
    }
    window.setSize(1450, 1100)
    await click('项目管理', true)
    await click('重新检测 Git 与 rg')
    await until(() => js('!!document.querySelector(".source-tools")'))
    assert.equal(
      await js('getComputedStyle(document.querySelector(".source-tools")).display'),
      'grid'
    )
    await capture('source-tools', '.source-tools')
    await js(
      `localStorage.setItem('audit.detail.selection.v1',JSON.stringify(${JSON.stringify({ ...scope, pathId, tab: 'path' })}))`
    )
    await click('审计分析', true)
    await until(
      () =>
        js(
          '!!document.querySelector("[data-testid=graph-source]") && !!document.querySelector("[data-testid=path-defense]")'
        ),
      'graph source/defense'
    )
    assert.equal(await js('document.querySelectorAll("[data-testid=path-node]").length'), 4)
    assert.equal(await js('document.querySelectorAll("[data-testid=path-relation]").length'), 3)
    assert.equal(await js('document.querySelectorAll("[data-testid=path-branch]").length'), 1)
    await js('document.querySelector("[data-testid=path-node]").focus()')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
    assert.equal(await js('document.activeElement.getAttribute("data-testid")'), 'path-relation')
    await js('document.activeElement.click()')
    await until(() =>
      js('document.querySelector("[data-testid=path-inspector]").textContent.includes("参数映射")')
    )
    await click('被调用方源码')
    await until(() =>
      js('document.querySelector(".source-location")?.textContent.includes("SearchService.java")')
    )
    await js('document.querySelector("[data-testid=path-defense]").click()')
    await until(() =>
      js('document.querySelector(".source-location")?.textContent.includes("UserRepository.java")')
    )
    assert.ok(
      await js(
        'document.querySelector("[data-testid=graph-source]").textContent.includes("input.matches")'
      )
    )
    await capture('path-graph', '[data-testid=interactive-path]')
    for (const width of [920, 480]) {
      window.setSize(width, 900)
      await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      assert.ok(
        await js('document.documentElement.scrollWidth<=innerWidth+1'),
        'graph overflow ' + width
      )
      await capture('graph-' + width, '[data-testid=interactive-path]')
    }
    window.setSize(1450, 1100)
    await js('document.querySelector("[data-testid=path-branch]").click()')
    await until(
      () =>
        js(
          `!!document.querySelector('[data-testid=path-branch]') && document.querySelector('[data-testid=detail-path-id]')?.textContent!==${JSON.stringify(pathId)}`
        ),
      'branch switch'
    )
    await js('document.querySelector("[data-testid=path-branch]").click()')
    await until(() =>
      js(
        `document.querySelector('[data-testid=detail-path-id]')?.textContent===${JSON.stringify(pathId)}`
      )
    )
    await until(() =>
      js('document.querySelector("[data-testid=save-human-review]")?.matches(":disabled")===false')
    )
    await fill('人工复核状态', 'false_positive')
    await fill(
      '人工复核备注',
      '<img src="https://example.invalid" onerror="window.reviewInjected=1"> 人工备注 V1 api_key="private-review-marker"'
    )
    await js('document.querySelector("[data-testid=save-human-review]").click()')
    await until(() =>
      js(
        'document.querySelector("[data-testid=human-review-message]").textContent.includes("已保存")'
      )
    )
    assert.equal(
      await js('document.querySelectorAll(".human-review img,.human-review script").length'),
      0
    )
    assert.equal(await js('window.reviewInjected===undefined'), true)
    const saved = await service.review('get', { ...scope, pathId })
    assert.equal(saved.ok, true)
    assert.equal((saved.data as HumanReview).revision, 1)
    assert.ok(!(saved.data as HumanReview).note.includes('private-review-marker'))
    const afterMachine = await service.audit('detail', { ...scope, pathId })
    assert.equal(afterMachine.ok, true)
    assert.deepEqual(afterMachine.data, machine.data)
    await capture('human-review', '[data-testid=human-review]')
    await click('审计报告', true)
    await until(() =>
      js(
        '!!document.querySelector("[data-testid=report-preview]").textContent.includes("任务共 2")'
      )
    )
    await fill('导出人工状态', 'false_positive')
    await until(() =>
      js(
        'document.querySelector("[data-testid=report-preview]").textContent.includes("当前范围 1 / 任务共 2")'
      )
    )
    await js('document.querySelector("[data-testid=export-json]").click()')
    await until(
      () =>
        js(
          'document.querySelector("[data-testid=report-message]").textContent.includes("另存已取消")'
        ),
      'cancel save'
    )
    assert.equal(copied.length, 0)
    assert.equal(readdirSync(join(root, 'copies')).length, 0)
    const catalog = await service.report('list', scope)
    assert.equal(catalog.ok, true)
    const json = (catalog.data as ReportCatalog).reports.find((row) => row.format === 'json')!
    const jsonRaw = readFileSync(json.filePath, 'utf8'),
      document = JSON.parse(jsonRaw)
    assert.equal(document.paths.length, 1)
    assert.equal(document.paths[0].verdict, 'safe')
    assert.equal(document.humanReviews[0].status, 'false_positive')
    assert.ok(!jsonRaw.includes('<img'))
    assert.ok(!jsonRaw.includes('private-review-marker'))
    assert.ok(!jsonRaw.includes('fixture-review-not-real'))
    cancelSave = false
    await click('另存 JSON')
    await until(() =>
      js('document.querySelector("[data-testid=report-message]").textContent.includes("已另存")')
    )
    assert.equal(readFileSync(copied[0], 'utf8'), jsonRaw)
    await js('document.querySelector("[data-testid=generate-report]").click()')
    await until(() => js('!!document.querySelector("[data-testid=open-report]")'))
    await click('打开已登记 HTML')
    await until(async () => opened.length === 1, 'HTML opened')
    assert.equal(opened.length, 1)
    await capture('reports-filtered', '.reports-page')
    for (const [width, height] of [
      [1450, 1100],
      [920, 900],
      [480, 900]
    ]) {
      window.setSize(width, height)
      await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      assert.ok(
        await js('document.documentElement.scrollWidth<=innerWidth+1'),
        'body overflow ' + width
      )
      assert.ok(
        await js(
          'document.querySelector(".reports-page").getBoundingClientRect().right<=innerWidth+1'
        ),
        'report overflow ' + width
      )
      await capture('reports-' + width, '.reports-page')
    }
    window.setSize(1450, 1100)
    const beforePid = (service as unknown as { child: { pid: number } }).child.pid
    await service.stop()
    await service.start()
    assert.notEqual((service as unknown as { child: { pid: number } }).child.pid, beforePid)
    const reopened = await service.review('get', { ...scope, pathId })
    assert.equal(reopened.ok, true)
    assert.deepEqual(reopened.data, saved.data)
    const reloaded = new Promise<void>((resolve) =>
      window!.webContents.once('did-finish-load', () => resolve())
    )
    window.webContents.reload()
    await reloaded
    await until(
      () => js('document.querySelectorAll("nav button").length===5'),
      'navigation after reload'
    )
    await click('模型配置', true)
    await until(() => js('!!document.querySelector(".model-config-layout")'))
    await click('审计分析', true)
    await until(
      () =>
        js('document.querySelector("[aria-label=人工复核备注]")?.value.includes("人工备注 V1")'),
      'review restored'
    )
    assert.equal(model.requests.length, requests)
    writeFileSync(
      join(root, 'verification.json'),
      JSON.stringify(
        {
          scope,
          pathId,
          source: 'actual Electron React and utility process',
          machine: 'safe',
          human: 'false_positive',
          revision: 1,
          jsonReportId: json.reportId,
          viewports: [1450, 920, 480],
          copied: copied.length,
          opened: opened.length,
          modelRequests: requests,
          theme: { accent: '#475ecb', canvas: '#eff2f7' }
        },
        null,
        2
      )
    )
    console.info(
      'PASS UI-02/UI-04/REP-01/REP-03: graph node/edge/defense/source, native keyboard, scoped branch, separate review, preview/filter, JSON/HTML, cancel/copy/open, responsive theme, different-PID persistence.'
    )
    console.info('REVIEW_ARTIFACTS=', root)
    await service.stop()
    await cleanup()
    await model.close()
    window.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error)
    if (window) await capture('failure').catch(() => {})
    await service.stop().catch(() => {})
    await cleanup().catch(() => {})
    await model?.close().catch(() => {})
    window?.destroy()
    app.exit(1)
  }
})
