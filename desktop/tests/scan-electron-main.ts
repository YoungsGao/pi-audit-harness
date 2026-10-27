import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ServiceManager } from '../src/main/service-manager'
import type {
  AuditAction,
  ScanStatistics,
  PathList,
  PathDetail
} from '../src/shared/scan-contracts'
import type { SourceProject } from '../src/shared/source-contracts'
import type { ApiResult } from '../src/shared/service-protocol'
import type { ModelSaveResult } from '../src/shared/metadata-contracts'
import type { ReportCatalog, ReportRecord } from '../src/shared/report-contracts'
import { createScanModelFixture } from './scan-model-fixture.mjs'
import cleanupPath from './db02-cleanup-worker.ts?modulePath'
const root = resolve('.scan-test-data', randomUUID())
const qa04 = process.env.PI_AUDIT_QA04 === '1'
const openedReports: string[] = []
let pingRequests = 0
const qaEvidence: Record<string, unknown> = {
  model: 'local HTTP fixture through real Pi SDK; no paid provider'
}
app.setPath('userData', join(root, 'profile'))
const service = new ServiceManager(
  () => {},
  () => join(root, 'runtime'),
  async (file) => {
    const preview = new BrowserWindow({
      show: false,
      width: 1100,
      height: 1400,
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
        await preview.webContents.executeJavaScript('document.querySelector("h1")?.textContent'),
        '阶段报告'
      )
      assert.equal(
        await preview.webContents.executeJavaScript('document.querySelectorAll("script").length'),
        0
      )
      await preview.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      await new Promise((resolve) => setTimeout(resolve, 150))
      writeFileSync(
        join(root, 'report-preview.png'),
        (
          await preview.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
        ).toPNG()
      )
      openedReports.push(file)
      return ''
    } finally {
      preview.destroy()
    }
  }
)
let window: BrowserWindow | undefined
let fixture: Awaited<ReturnType<typeof createScanModelFixture>> | undefined
let failingFixture: Awaited<ReturnType<typeof createScanModelFixture>> | undefined
const modelRequests = (): number => (fixture?.requests.length ?? 0) - pingRequests
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
async function selectDetailTab(name: string): Promise<void> {
  await js(`document.querySelector('[data-testid="detail-tab-${name}"]').click()`)
}
async function verifyWorkspaceLayout(): Promise<void> {
  const results: unknown[] = []
  for (const [width, height] of [
    [1450, 1000],
    [1024, 768],
    [480, 850],
    [1280, 420]
  ]) {
    window!.setContentSize(width, height)
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const measurements = await js<{
      sidebarTop: number
      afterSidebarTop: number
      navTop: number
      afterNavTop: number
      scrollTop: number
      documentScroll: number
      documentHeight: number
      viewportHeight: number
      contentWidth: number
      scrollWidth: number
      mainHeight: number
      sidebarScroll: number
    }>(`(() => {
      const main = document.querySelector('main');
      const sidebar = document.querySelector('.sidebar');
      const nav = document.querySelector('nav');
      main.scrollTop = 0;
      const sidebarTop = sidebar.getBoundingClientRect().top;
      const navTop = nav.getBoundingClientRect().top;
      main.scrollTop = main.scrollHeight;
      return { sidebarTop, afterSidebarTop: sidebar.getBoundingClientRect().top,
        navTop, afterNavTop: nav.getBoundingClientRect().top, scrollTop: main.scrollTop,
        documentScroll: document.scrollingElement.scrollTop,
        documentHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight,
        contentWidth: main.clientWidth, scrollWidth: main.scrollWidth,
        mainHeight: main.clientHeight, sidebarScroll: sidebar.scrollTop };
    })()`)
    assert.ok(measurements.scrollTop > 100, `main must actually scroll at ${width}x${height}`)
    assert.equal(measurements.sidebarTop, measurements.afterSidebarTop)
    assert.equal(measurements.navTop, measurements.afterNavTop)
    assert.equal(measurements.documentScroll, 0)
    assert.ok(measurements.documentHeight <= measurements.viewportHeight + 1)
    assert.ok(
      measurements.scrollWidth <= measurements.contentWidth + 1,
      `horizontal overflow at ${width}`
    )
    assert.equal(measurements.mainHeight, measurements.viewportHeight)
    await js('document.querySelector("main").scrollTop=0')
    await window!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    writeFileSync(
      join(root, `workspace-${width}.png`),
      (
        await window!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      ).toPNG()
    )
    results.push({ width, height, ...measurements })
  }
  window!.setContentSize(1450, 1250)
  await js('document.querySelector("main").scrollTop=0')
  writeFileSync(join(root, 'workspace-layout.json'), JSON.stringify(results, null, 2))
  console.info(
    'PASS layout: independent main scroll, stationary navigation, no page/horizontal overflow at desktop, tablet, narrow and short viewport sizes.'
  )
}
async function captureWorkspace(name: string): Promise<void> {
  for (const width of [1450, 480]) {
    window!.setContentSize(width, 1000)
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await js('document.querySelector("main").scrollTop=0')
    await js(
      'new Promise(resolve => requestAnimationFrame(() => { document.querySelector("main").scrollTop=0; requestAnimationFrame(resolve) }))'
    )
    assert.equal(
      await js(
        'document.querySelector("main").scrollWidth <= document.querySelector("main").clientWidth + 1'
      ),
      true,
      `${name} horizontal overflow at ${width}`
    )
    assert.equal(await js('document.querySelector("main").scrollTop'), 0)
    assert.equal(await js('document.querySelectorAll("nav button[title]").length'), 4)
    writeFileSync(
      join(root, `${name}-${width}.png`),
      (
        await window!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      ).toPNG()
    )
  }
  window!.setContentSize(1450, 1250)
}
void app.whenReady().then(async () => {
  try {
    ipcMain.handle('app:get-info', () => ({
      name: 'Scan integration',
      version: '1',
      node: process.versions.node,
      electron: process.versions.electron
    }))
    ipcMain.handle(
      'analysis:start-stream',
      (_e, input: import('../src/shared/sse-contracts').AnalyzeRequest) =>
        service.startAnalysisStream(input, (notice) =>
          window?.webContents.send('analysis:stream', notice)
        )
    )
    ipcMain.handle('analysis:stop-stream', (_e, id: string) => service.stopAnalysisStream(id))
    ipcMain.handle('service:get-status', () => service.getStatus())
    ipcMain.handle('service:check-health', () => service.checkHealth())
    ipcMain.handle('storage:get-overview', () => service.getStorageOverview())
    ipcMain.handle('metadata:get', () => service.metadata('list'))
    ipcMain.handle('sources:list', () => service.source('list'))
    ipcMain.handle('models:get-catalog', () => service.modelSettings())
    ipcMain.handle('model:test', (_e, id: string) => service.testModel(id))
    ipcMain.handle('reports:action', (_e, action: 'generate' | 'list', input: unknown) =>
      service.report(action, input)
    )
    ipcMain.handle('reports:open', (_e, input: unknown) => service.openReport(input))
    ipcMain.handle('sources:tools', () => service.source('tools'))
    ipcMain.handle('sources:github', (_e, input: unknown) => service.source('github', input))
    ipcMain.handle('sources:local', (_e, input: unknown) => service.source('local', input))
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
    let localProject = imported.data
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
    await until(() => js('!!document.querySelector(".sources-page")'))
    await verifyWorkspaceLayout()
    await js(
      'Array.from(document.querySelectorAll("nav button")).find(b=>b.textContent==="模型配置").click()'
    )
    await until(() => js('document.querySelector(".models-page select")?.options.length > 1'))
    await captureWorkspace('workspace-models')
    window.webContents.focus()
    await js('document.querySelector("nav button").focus()')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    await until(() => js('document.activeElement?.getAttribute("title")==="项目管理"'))
    const keyboardFocus = await js<{ visible: boolean; style: string; width: string }>(
      '({ visible: document.activeElement.matches(":focus-visible"), style: getComputedStyle(document.activeElement).outlineStyle, width: getComputedStyle(document.activeElement).outlineWidth })'
    )
    assert.ok(
      keyboardFocus.visible && keyboardFocus.style !== 'none',
      JSON.stringify(keyboardFocus)
    )
    await js('document.activeElement.click()')
    await until(() =>
      js(
        '!!document.querySelector(".sources-page") && document.querySelector("main").scrollTop===0'
      )
    )
    if (qa04) {
      await js(
        'Array.from(document.querySelectorAll("nav button")).find(b=>b.textContent==="模型配置").click()'
      )
      await until(() =>
        js(
          'Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="测试当前模型"&&!b.disabled)'
        )
      )
      await js(
        'Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="测试当前模型").click()'
      )
      await until(() =>
        js(
          'document.querySelector(\'[data-testid="model-test-status"]\')?.textContent.includes("测试成功")'
        )
      )
      assert.equal(fixture.requests.length, 1)
      const pingBody = fixture.requests[0] as {
        model: string
        messages: { role: string; content: unknown }[]
      }
      assert.equal(pingBody.model, saved.data.model.modelId)
      const pingContent = pingBody.messages.filter((item) => item.role === 'user').at(-1)?.content
      assert.equal(
        Array.isArray(pingContent)
          ? pingContent.map((part) => part.text ?? '').join('')
          : pingContent,
        'ping'
      )
      pingRequests = 1
      qaEvidence.ping = {
        requests: 1,
        modelId: pingBody.model,
        reply: await js('document.querySelector(\'[aria-label="模型回复"]\').textContent')
      }
      await js(
        'Array.from(document.querySelectorAll("nav button")).find(b=>b.textContent==="项目管理").click()'
      )
      for (const [label, value] of [
        ['源码项目名称', 'QA04 本地 Java/Spring 样例'],
        ['本地源码目录', resolve('tests/fixtures/scan-java')]
      ])
        await js(
          `(()=>{const field=document.querySelector('input[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}))})()`
        )
      await js(
        '(()=>{const field=document.querySelector(\'[aria-label="重复来源处理"]\');field.value="new";field.dispatchEvent(new Event("change",{bubbles:true}))})()'
      )
      await js(
        'Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="导入本地源码").click()'
      )
      await until(() =>
        js(
          'document.querySelector(\'[data-testid="source-status"]\')?.textContent.includes("源码登记成功")'
        )
      )
      const localSources =
        await service.source<import('../src/shared/source-contracts').SourceCatalog>('list')
      assert.equal(localSources.ok, true)
      localProject = localSources.data.projects.find(
        (project) => project.projectName === 'QA04 本地 Java/Spring 样例'
      )!
      assert.equal(localProject.fileCount, 3)
      qaEvidence.local = {
        projectId: localProject.projectId,
        path: localProject.path,
        javaFiles: localProject.fileCount,
        sourceStamp: localProject.sourceStamp,
        importedThroughRenderer: true
      }
      await js(
        'Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="重新检测 Git 与 rg").click()'
      )
      await until(() =>
        js(
          'Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="下载公开 GitHub 仓库"&&!b.disabled)'
        )
      )
      const publicUrl = 'https://github.com/spring-guides/gs-rest-service'
      await js(
        `(()=>{const field=document.querySelector('input[aria-label="公开 GitHub URL"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(publicUrl)});field.dispatchEvent(new Event('input',{bubbles:true}))})()`
      )
      await js(
        'Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="下载公开 GitHub 仓库").click()'
      )
      const cloneDeadline = Date.now() + 70000
      while (
        !(await js(
          'document.querySelector(\'[data-testid="source-status"]\')?.textContent.includes("仓库下载并登记成功")'
        ))
      ) {
        const failure = await js<string>(
          'document.querySelector(\'[data-testid="source-status"][role="alert"]\')?.textContent??""'
        )
        if (failure) throw new Error('QA04 public GitHub import failed: ' + failure)
        if (Date.now() > cloneDeadline) throw new Error('QA04 public GitHub import timed out')
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      const sources =
        await service.source<import('../src/shared/source-contracts').SourceCatalog>('list')
      assert.equal(sources.ok, true)
      const github = sources.data.projects.find((project) => project.sourceType === 'git')!
      assert.ok(github.fileCount > 0)
      assert.match(github.commit!, /^[a-f0-9]{40,64}$/)
      qaEvidence.publicGithub = {
        url: publicUrl,
        commit: github.commit,
        projectId: github.projectId,
        javaFiles: github.fileCount
      }
      const publicPrepared = await service.audit('prepare', { projectId: github.projectId })
      assert.equal(publicPrepared.ok, true)
      qaEvidence.publicPreprocessing = publicPrepared.ok ? publicPrepared.data : null
    }
    await js(
      "Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='审计分析').click()"
    )
    await until(() =>
      js('document.querySelector(\'select[aria-label="审计项目"]\')?.options.length>1')
    )
    await js(
      `(()=>{const select=document.querySelector('select[aria-label="审计项目"]');select.value=${JSON.stringify(localProject.projectId)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`
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
      projectId: localProject.projectId
    })) as ApiResult<{ runs: { runId: string }[] }>
    assert.equal(catalog.ok, true)
    const runId = catalog.data.runs[0].runId
    const stats = (await service.audit('statistics', {
      projectId: localProject.projectId,
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
    assert.equal(modelRequests(), 0)
    assert.deepEqual(
      await js('Array.from(document.querySelectorAll(\'[role="tab"]\')).map(t=>t.textContent)'),
      ['调用路径', '传播证据', '防护分析', '分析过程']
    )
    assert.equal(
      await js('document.querySelector(\'[data-testid="detail-outcome"]\').textContent'),
      '未分析'
    )
    const selectedBeforeTabs = await js<string>(
      'document.querySelector(\'[data-testid="detail-path-id"]\').textContent'
    )
    const pathSteps = await js<string[]>(
      'Array.from(document.querySelectorAll(".audit-steps > li > strong")).map(e=>e.textContent)'
    )
    assert.equal(pathSteps.length, 3)
    assert.ok(pathSteps[0].includes('Web.'))
    assert.ok(pathSteps[1].includes('SearchService.'))
    assert.ok(pathSteps[2].includes('UserRepository.'))
    await selectDetailTab('evidence')
    assert.equal(
      await js(
        'document.querySelector(\'[data-testid="detail-panel-evidence"]\').textContent.includes("没有可展示的已保存源码引用")'
      ),
      true
    )
    await selectDetailTab('defense')
    assert.equal(
      await js(
        'document.querySelector(\'[data-testid="detail-panel-defense"]\').textContent.includes("未记录")'
      ),
      true
    )
    await selectDetailTab('process')
    assert.equal(
      await js('document.querySelector(\'[data-testid="detail-path-id"]\').textContent'),
      selectedBeforeTabs
    )
    assert.equal(modelRequests(), 0)
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
      js(
        "document.querySelector('[data-testid=\"analysis-stream-events\"]')?.textContent.includes('queued')"
      )
    )
    const liveSession = await js<string>(
      'document.querySelector(\'[aria-label="分析历史会话"]\').value'
    )
    await selectDetailTab('evidence')
    assert.equal(await js('document.querySelector(".analysis-stream").getClientRects().length'), 0)
    await selectDetailTab('process')
    assert.equal(
      await js('document.querySelector(\'[aria-label="分析历史会话"]\').value'),
      liveSession
    )
    assert.equal(
      await js(
        'document.querySelector(\'[data-testid="analysis-connection"]\').textContent.includes("接收已落库事件")'
      ),
      true
    )
    await js(
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='断开事件连接').click()"
    )
    await until(() =>
      js("document.querySelector('.audit-summary')?.textContent.includes('本机受控模型')")
    )
    // Three actual read-step requests + final decision; duplicate click must not double them.
    assert.equal(modelRequests(), 4)
    await js(
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='按原游标重连').click()"
    )
    await until(() =>
      js(
        "document.querySelector('[data-testid=\"analysis-stream-events\"]')?.textContent.includes('completed / completed')"
      )
    )
    assert.equal(modelRequests(), 4)
    const events = await service.audit('events', { projectId: localProject.projectId, runId })
    assert.equal(events.ok, true)
    if (events.ok && 'events' in events.data) {
      assert.equal(events.data.events.filter((e) => e.type === 'result').length, 1)
      assert.equal(
        events.data.events.filter((e) => e.type === 'tool' && e.status === 'completed').length,
        3
      )
    }
    assert.equal(await js("document.querySelector('.audit-summary script')===null"), true)
    assert.equal(await js('document.body.textContent.includes("fixture-ui03-private")'), false)
    assert.equal(
      await js('document.querySelector(".audit-summary").textContent.includes("[REDACTED]")'),
      true
    )
    const afterAnalysis = (await service.audit('statistics', {
      projectId: localProject.projectId,
      runId
    })) as ApiResult<ScanStatistics>
    assert.equal(afterAnalysis.ok, true)
    assert.equal(afterAnalysis.data.unresolved, 1)
    assert.equal(afterAnalysis.data.pending, 1)
    assert.equal(
      await js(
        "document.querySelector('[data-testid=\"analysis-thinking\"]')?.textContent.includes('thoughts_execute')"
      ),
      true
    )
    assert.equal(
      await js(
        "document.querySelector('[data-testid=\"analysis-process\"]')?.textContent.includes('audit_read_step')"
      ),
      true
    )
    assert.equal(
      await js(
        "document.querySelector('[data-testid=\"analysis-result\"]')?.textContent.includes('SQLite 任务统计')"
      ),
      true
    )
    const firstPath = await js<string>(
      'document.querySelector(\'[aria-label="调用链简要详情"] > .audit-id\').textContent'
    )
    assert.equal(
      await js(
        'document.querySelector(\'[data-testid="detail-outcome"]\').textContent.includes("证据不足")'
      ),
      true
    )
    assert.equal(
      await js(
        '(()=>{const ids=[...document.querySelectorAll(\'[data-testid="analysis-timeline"] > li\')].map(e=>Number(e.dataset.eventId));return ids.length===10&&ids.every((id,i)=>id===i+1)})()'
      ),
      true
    )
    assert.equal(
      await js(
        'document.querySelector(\'[data-testid="analysis-timeline"]\').textContent.includes("toolCallId=")'
      ),
      true
    )
    await selectDetailTab('evidence')
    assert.equal(
      await js(
        'document.querySelector(\'[data-testid="detail-panel-evidence"]\').textContent.includes("取证范围 Web.java:")'
      ),
      true
    )
    assert.equal(
      await js(
        'document.querySelector(\'[data-testid="detail-panel-evidence"]\').textContent.includes("实参与形参映射")'
      ),
      true
    )
    const evidenceScreenshot = join(root, 'ui03-evidence.png')
    window.setContentSize(1100, 1800)
    await js(
      'document.querySelector(\'[aria-label="调用链简要详情"]\').scrollIntoView({block:"start"})'
    )
    await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    await new Promise((r) => setTimeout(r, 250))
    writeFileSync(
      evidenceScreenshot,
      (
        await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      ).toPNG()
    )
    await until(() =>
      js('JSON.parse(localStorage.getItem("audit.detail.selection.v1")).tab==="evidence"')
    )
    const loaded = new Promise<void>((resolve) =>
      window!.webContents.once('did-finish-load', () => resolve())
    )
    window.webContents.reload()
    await loaded
    await js(
      "Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='审计分析').click()"
    )
    await until(() =>
      js(
        `document.querySelector('[data-testid="detail-path-id"]')?.textContent===${JSON.stringify(firstPath)}`
      )
    )
    assert.equal(
      await js(
        'document.querySelector(\'[data-testid="detail-tab-evidence"]\').getAttribute("aria-selected")'
      ),
      'true'
    )
    await selectDetailTab('process')
    await until(() =>
      js(
        'document.querySelector(\'[data-testid="analysis-timeline"]\')?.textContent.includes("completed")'
      )
    )
    assert.equal(modelRequests(), 4)
    await js(
      `Array.from(document.querySelectorAll('button[aria-label^="查看调用链 "]')).find(b=>b.getAttribute('aria-label')!==${JSON.stringify('查看调用链 ' + firstPath)}).click()`
    )
    await until(() =>
      js(
        "document.querySelector('[data-testid=\"analysis-result\"]')?.textContent.includes('尚未收到当前会话最终结果')"
      )
    )
    assert.equal(
      await js(
        "document.querySelector('[data-testid=\"analysis-stream-events\"]')?.textContent.includes('thoughts_execute')"
      ),
      false
    )
    await js(
      `Array.from(document.querySelectorAll('button[aria-label^="查看调用链 "]')).find(b=>b.getAttribute('aria-label')===${JSON.stringify('查看调用链 ' + firstPath)}).click()`
    )
    await until(() =>
      js(
        "document.querySelector('[data-testid=\"analysis-result\"]')?.textContent.includes('completed / completed')"
      )
    )
    assert.equal(modelRequests(), 4)
    assert.equal(
      await js(
        "(()=>{const ids=[...document.querySelectorAll('[data-testid=\"analysis-stream-events\"] li > .audit-badge')].map(e=>e.textContent.split(' ')[0]);return ids.length===new Set(ids).size})()"
      ),
      true
    )
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
    window.setContentSize(1100, 1800)
    await js("document.querySelector('.analysis-stream').scrollIntoView({block:'start'})")
    await new Promise((r) => setTimeout(r, 250))
    const flowScreenshot = join(root, 'analysis-flow.png')
    writeFileSync(
      flowScreenshot,
      (
        await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      ).toPNG()
    )
    const firstPid = (service as unknown as { child: { pid: number } }).child.pid
    await service.stop()
    await until(() =>
      js(
        "document.querySelector('[data-testid=\"audit-read-error\"]')?.textContent.includes('当前数据库状态未确认')"
      )
    )
    assert.equal(
      await js('document.querySelector(\'[data-testid="start-path-analysis"]\')?.disabled'),
      true
    )
    await service.start()
    await until(() => js('document.querySelector(\'[data-testid="audit-read-error"]\')===null'))
    assert.notEqual((service as unknown as { child: { pid: number } }).child.pid, firstPid)
    const again = await service.audit('statistics', { projectId: localProject.projectId, runId })
    assert.deepEqual(again.ok && again.data, afterAnalysis.data)
    await until(() =>
      js('document.querySelector(\'[data-testid="start-pending-analysis"]\')?.disabled===false')
    )
    await js(
      '(()=>{const b=document.querySelector(\'[data-testid="start-pending-analysis"]\');b.click();b.click()})()'
    )
    await until(() =>
      js(
        "(()=>{const t=document.querySelector('[data-testid=\"audit-statistics\"]')?.textContent??'';return t.includes('待分析0')&&t.includes('分析中0')})()"
      )
    )
    const queueState = await service.audit('runState', {
      projectId: localProject.projectId,
      runId
    })
    assert.equal(queueState.ok, true)
    if (queueState.ok && 'statistics' in queueState.data) {
      assert.equal(queueState.data.statistics.unresolved, 2)
      assert.equal(queueState.data.stage, 'completed')
    }
    assert.equal(modelRequests(), 8)
    await captureWorkspace('workspace-analysis')
    await js(
      'Array.from(document.querySelectorAll("nav button")).find(b=>b.textContent==="审计报告").click()'
    )
    await until(() =>
      js(
        `document.querySelector('select[aria-label="报告任务"]')?.value===${JSON.stringify(runId)} && document.querySelector('[data-testid="generate-report"]')?.disabled===false`
      )
    )
    await js(
      '(()=>{const b=document.querySelector(\'[data-testid="generate-report"]\');b.click();b.click()})()'
    )
    await until(() =>
      js(
        'document.querySelector(\'[data-testid="report-list"]\')?.textContent.includes("阶段报告 · 已生成")'
      )
    )
    const reportCatalog = (await service.report('list', {
      projectId: localProject.projectId,
      runId
    })) as ApiResult<ReportCatalog>
    assert.equal(reportCatalog.ok, true)
    assert.equal(reportCatalog.data.reports.length, 1)
    const report = reportCatalog.data.reports[0] as ReportRecord
    assert.equal(report.statistics?.unresolved, 2)
    assert.equal(report.statistics?.riskPoints, 0)
    assert.equal(modelRequests(), 8)
    await captureWorkspace('workspace-reports')
    await js('document.querySelector(\'[data-testid="open-report"]\').click()')
    await until(async () => openedReports.length === 1)
    const reportScreenshot = join(root, 'report-list.png')
    await js('document.querySelector("main").scrollTop=0')
    await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    await new Promise((resolve) => setTimeout(resolve, 150))
    writeFileSync(
      reportScreenshot,
      (
        await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      ).toPNG()
    )
    const reportPid = (service as unknown as { child: { pid: number } }).child.pid
    await service.stop()
    await service.start()
    assert.notEqual((service as unknown as { child: { pid: number } }).child.pid, reportPid)
    const afterReportRestart = await service.report('list', {
      projectId: localProject.projectId,
      runId
    })
    assert.deepEqual(afterReportRestart, {
      ...reportCatalog,
      requestId: afterReportRestart.requestId
    })
    const reopened = await service.openReport({
      projectId: localProject.projectId,
      runId,
      reportId: report.reportId
    })
    assert.equal(reopened.ok, true)
    assert.equal(openedReports.length, 2)
    qaEvidence.report = {
      reportId: report.reportId,
      runId,
      filePath: report.filePath,
      statistics: report.statistics,
      stageReport: report.stageReport,
      differentPidRestart: true,
      htmlOpened: 2
    }
    await js(
      'Array.from(document.querySelectorAll("nav button")).find(b=>b.textContent==="审计分析").click()'
    )
    await until(() =>
      js(
        `document.querySelector('select[aria-label="审计任务"]')?.value===${JSON.stringify(runId)}`
      )
    )
    failingFixture = await createScanModelFixture('unavailable')
    const failedModel = await service.metadata<ModelSaveResult>('model', {
      name: '本机不可达模型实验',
      baseUrl: failingFixture.baseUrl,
      modelId: 'unavailable-fixture',
      apiKey: 'fixture-unavailable-not-real'
    })
    assert.equal(failedModel.ok, true)
    await js(
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='刷新项目与状态').click()"
    )
    await until(() =>
      js(
        `Array.from(document.querySelector('select[aria-label="路径分析模型"]')?.options??[]).some(o=>o.value===${JSON.stringify(failedModel.data.model.configId)})`
      )
    )
    await js(
      `(()=>{const s=document.querySelector('select[aria-label="路径分析模型"]');s.value=${JSON.stringify(failedModel.data.model.configId)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`
    )
    await js(
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='预处理并生成调用链').click()"
    )
    await until(() =>
      js(
        `document.querySelector('select[aria-label="审计任务"]')?.value!==${JSON.stringify(runId)} && document.querySelector('[data-testid="start-path-analysis"]')?.disabled===false`
      )
    )
    await js('document.querySelector(\'[data-testid="start-path-analysis"]\').click()')
    await until(() =>
      js(
        "document.querySelector('[data-testid=\"analysis-result\"]')?.textContent.includes('MODEL_SERVICE_FAILED')"
      )
    )
    await until(() =>
      js(
        "document.querySelector('[data-testid=\"analysis-result\"]')?.textContent.includes('最新路径状态failed')"
      )
    )
    assert.equal(failingFixture.requests.length, 1)
    await until(() =>
      js(
        "document.querySelector('select[aria-label=\"分析历史会话\"]')?.selectedOptions[0]?.textContent.includes('尝试 1')"
      )
    )
    assert.equal(
      await js(
        "document.querySelector('[data-testid=\"analysis-result\"]')?.textContent.includes('风险判断保持未知')"
      ),
      true
    )
    assert.equal(
      await js(
        "document.querySelector('[aria-label=\"三段式分析流\"]')?.textContent.includes('chainId=')"
      ),
      true
    )
    await js("document.querySelector('.analysis-stream').scrollIntoView({block:'start'})")
    await new Promise((r) => setTimeout(r, 250))
    const failureScreenshot = join(root, 'analysis-failure.png')
    // Hidden windows may return the previous compositor frame on the first capture.
    await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    await new Promise((r) => setTimeout(r, 250))
    writeFileSync(
      failureScreenshot,
      (
        await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      ).toPNG()
    )
    // A remembered path from another run must not be accepted as this run's selection.
    await until(() =>
      js(
        'JSON.parse(localStorage.getItem("audit.detail.selection.v1")).runId===document.querySelector(\'[aria-label="审计任务"]\').value'
      )
    )
    const finalRun = await js<string>('document.querySelector(\'[aria-label="审计任务"]\').value')
    await js(
      `(()=>{const saved=JSON.parse(localStorage.getItem('audit.detail.selection.v1'));saved.pathId=${JSON.stringify(firstPath)};localStorage.setItem('audit.detail.selection.v1',JSON.stringify(saved))})()`
    )
    const reloaded = new Promise<void>((resolve) =>
      window!.webContents.once('did-finish-load', () => resolve())
    )
    window.webContents.reload()
    await reloaded
    await js(
      "Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='审计分析').click()"
    )
    await until(() =>
      js(
        `document.querySelector('[data-testid="detail-path-id"]')?.textContent && document.querySelector('[aria-label="审计任务"]')?.value===${JSON.stringify(finalRun)}`
      )
    )
    assert.notEqual(
      await js('document.querySelector(\'[data-testid="detail-path-id"]\').textContent'),
      firstPath
    )
    assert.equal(modelRequests(), 8)
    assert.equal(failingFixture.requests.length, 1)
    console.info(
      'PASS SCAN/UI: real Java parsing -> utilityProcess SQLite -> main DTO -> preload -> React -> actual Pi SDK tool loop/local fixture -> committed events/results -> different-PID persistence -> pending queue. Double click started one loop; text escaped.'
    )
    console.info('SCREENSHOT=', screenshot)
    console.info('FLOW_SCREENSHOT=', flowScreenshot)
    console.info('FAILURE_SCREENSHOT=', failureScreenshot)
    console.info('EVIDENCE_SCREENSHOT=', evidenceScreenshot)
    console.info(
      'PASS UI-03: four persistent tabs, scoped selection after reload, saved evidence/checks, ordered live/replayed timeline, public-text redaction; no extra model calls on tab changes or reload.'
    )
    console.info('DATABASE=', join(root, 'runtime/storage/audit.sqlite3'))
    console.info('REPORT_SCREENSHOT=', reportScreenshot)
    console.info('REPORT_PREVIEW=', join(root, 'report-preview.png'))
    if (qa04) {
      await service.stop()
      const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
      const originalPath = process.env[pathKey]
      try {
        process.env[pathKey] = join(root, 'no-executables')
        await service.start()
      } finally {
        if (originalPath === undefined) delete process.env[pathKey]
        else process.env[pathKey] = originalPath
      }
      await js(
        'Array.from(document.querySelectorAll("nav button")).find(b=>b.textContent==="项目管理").click()'
      )
      await js(
        'Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="重新检测 Git 与 rg").click()'
      )
      await until(() =>
        js(
          'document.querySelector(\'[aria-label="源码导入"]\')?.textContent.includes("未检测到可用 Git")'
        )
      )
      const missingGit = await service.source('github', {
        gitUrl: 'https://github.com/spring-guides/qa04-missing-git'
      })
      assert.equal(missingGit.ok, false)
      if (!missingGit.ok) assert.equal(missingGit.error.code, 'GIT_REQUIRED')
      const localWithoutGit = await service.source<SourceProject>('local', {
        projectName: '缺 Git 时的本地输入',
        path: resolve('tests/fixtures/scan-java'),
        duplicate: 'new'
      })
      assert.equal(localWithoutGit.ok, true)
      qaEvidence.missingGit = {
        errorCode: !missingGit.ok ? missingGit.error.code : null,
        localImport: true,
        installationHintShown: true
      }
      const verifiedScope = { projectId: localProject.projectId, runId }
      const savedPaths = (await service.audit('list', verifiedScope)) as ApiResult<PathList>
      assert.equal(savedPaths.ok, true)
      const savedDetails = await Promise.all(
        savedPaths.data.paths.map(
          (path) =>
            service.audit('detail', { ...verifiedScope, pathId: path.pathId }) as Promise<
              ApiResult<PathDetail>
            >
        )
      )
      const verifiedDetails = savedDetails.map((detail) => {
        assert.equal(detail.ok, true)
        assert.equal(detail.data.status, 'unresolved')
        assert.equal(detail.data.verdict, 'unknown')
        assert.equal(detail.data.dangerous, null)
        return detail.data
      })
      const stepCount = verifiedDetails.reduce((sum, item) => sum + item.steps.length, 0)
      const uniqueEdges = new Set(
        verifiedDetails.flatMap((item) => item.steps.map((step) => step.edge.uid))
      ).size
      assert.equal(stepCount, 6)
      assert.equal(uniqueEdges, 4)
      const sessionHistory = (await service.audit('history', {
        ...verifiedScope,
        pathId: savedPaths.data.paths[0].pathId
      })) as ApiResult<import('../src/shared/sse-contracts').AnalysisHistory>
      assert.equal(sessionHistory.ok, true)
      const sseTypes = [
        ...new Set(sessionHistory.data.frames.map((frame) => frame.data.type))
      ].sort()
      assert.deepEqual(sseTypes, ['process', 'result', 'thinking'])
      qaEvidence.analysis = {
        projectId: localProject.projectId,
        runId,
        paths: 2,
        stepsPerPath: 3,
        pathSteps: stepCount,
        uniqueEdges,
        modelRequests: modelRequests(),
        sseTypes,
        verdict: 'unknown',
        dangerous: null,
        databaseStatistics: queueState.ok ? queueState.data : null
      }
      writeFileSync(join(root, 'qa04-result.json'), JSON.stringify(qaEvidence, null, 2))
      console.info(
        'PASS QA-04: configured model ping, actual public GitHub clone, local Java/Spring input, missing-Git installation hint/local fallback, SQLite queue, three SSE types, Pi /report, HTML open and different-PID persistence.'
      )
      console.info('QA04_EVIDENCE=', join(root, 'qa04-result.json'))
    }
    await service.stop()
    await cleanup()
    await fixture.close()
    await failingFixture.close()
    window.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error)
    await service.stop().catch(() => {})
    await cleanup().catch(() => {})
    await fixture?.close()
    await failingFixture?.close()
    window?.destroy()
    app.exit(1)
  }
})
