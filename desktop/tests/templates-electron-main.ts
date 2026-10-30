import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ServiceManager } from '../src/main/service-manager'
import type { SourceProject } from '../src/shared/source-contracts'
import type {
  TemplateAction,
  TemplateRecord,
  TemplateCatalog,
  ProjectReview,
  RunReviewConfig
} from '../src/shared/template-contracts'
import type { ModelSaveResult } from '../src/shared/metadata-contracts'
import type { ReportRecord } from '../src/shared/report-contracts'
import { createScanModelFixture } from './scan-model-fixture.mjs'
import cleanupPath from './db02-cleanup-worker.ts?modulePath'
const root = resolve('.templates-test-data', randomUUID())
app.setPath('userData', join(root, 'profile'))
const service = new ServiceManager(
  () => {},
  () => join(root, 'runtime')
)
let window: BrowserWindow | undefined,
  fixture: Awaited<ReturnType<typeof createScanModelFixture>> | undefined
const js = async <T>(source: string): Promise<T> => window!.webContents.executeJavaScript(source)
async function until(check: () => Promise<boolean>, label = 'template DOM'): Promise<void> {
  const deadline = Date.now() + 25000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(label + ' timeout')
    await new Promise((r) => setTimeout(r, 65))
  }
}
async function click(label: string, nav = false): Promise<void> {
  await js(
    `Array.from(document.querySelectorAll(${JSON.stringify(nav ? 'nav button' : 'button')})).find(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled).click()`
  )
}
async function fill(label: string, value: string, select = false): Promise<void> {
  await js(
    `(()=>{const e=document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]');const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:${select ? 'HTMLSelectElement.prototype' : 'HTMLInputElement.prototype'};Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('${select ? 'change' : 'input'}',{bubbles:true}));})()`
  )
}
async function capture(name: string): Promise<void> {
  await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  await window!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
  await new Promise((r) => setTimeout(r, 200))
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
      reject(new Error('owned credential cleanup timeout'))
    }, 25000)
    child.once('spawn', () => child.postMessage({ root: join(root, 'runtime') }))
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error('cleanup failed'))
    })
  })
}
void app.whenReady().then(async () => {
  try {
    mkdirSync(root, { recursive: true })
    const markdownFile = join(root, 'audit.md'),
      skill = join(root, 'skill'),
      marker = join(root, 'executed.txt')
    mkdirSync(join(skill, 'scripts'), { recursive: true })
    writeFileSync(
      markdownFile,
      '# 导入 Markdown 标题\n\n导入的简介段落。\n\n## 检查参数来源\n- 读取源码确认'
    )
    writeFileSync(
      join(skill, 'SKILL.md'),
      '---\nname: skill-audit-fixture\ndescription: 导入 Skill 只作为文档\n---\n# SKILL-MARKER\n\n不要执行 scripts/install.ps1。\n\n<script>alert("fixture")</script>\n\n[链接](https://example.invalid)'
    )
    writeFileSync(
      join(skill, 'scripts/install.ps1'),
      `Set-Content -LiteralPath '${marker}' -Value executed`
    )
    ipcMain.handle('app:get-info', () => ({
      name: 'templates fixture',
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
      (_e, action: import('../src/shared/scan-contracts').AuditAction, input: unknown) =>
        service.audit(action, input)
    )
    ipcMain.handle(
      'reviews:action',
      (_e, action: import('../src/shared/review-contracts').ReviewAction, input: unknown) =>
        service.review(action, input)
    )
    ipcMain.handle('templates:action', (_e, action: TemplateAction, input: unknown) => {
      assert.notEqual(action, 'import')
      return service.templates(action, input)
    })
    ipcMain.handle('templates:import-document', (_e, kind: 'file' | 'directory') =>
      service.templates('import', { kind, path: kind === 'file' ? markdownFile : skill })
    )
    ipcMain.handle(
      'analysis:start-stream',
      (_e, input: import('../src/shared/sse-contracts').AnalyzeRequest) =>
        service.startAnalysisStream(input, (notice) =>
          window?.webContents.send('analysis:stream', notice)
        )
    )
    ipcMain.handle('analysis:stop-stream', (_e, id: string) => service.stopAnalysisStream(id))
    await service.start()
    fixture = await createScanModelFixture()
    const model = await service.metadata<ModelSaveResult>('model', {
      name: 'templates local fixture',
      baseUrl: fixture.baseUrl,
      modelId: 'scan-review-fixture',
      apiKey: 'fixture-template-not-real'
    })
    assert.equal(model.ok, true)
    await service.modelSettings({ configId: model.data.model.configId, expectedRevision: 0 }, true)
    const imported = await service.source<SourceProject>('local', {
      projectName: '模板与业务要求样例',
      path: resolve('tests/fixtures/scan-java')
    })
    assert.equal(imported.ok, true)
    const projectId = imported.data.projectId
    window = new BrowserWindow({
      show: false,
      width: 1450,
      height: 1100,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    })
    await window.loadFile(join(__dirname, '../renderer/index.html'))
    await click('审计模板', true)
    await until(() => js('document.querySelector("[data-testid=save-template]")?.disabled===false'))
    await click('保存模板')
    assert.ok(await js('document.body.textContent.includes("请填写模板名称")'))
    await fill('模板名称', '业务模板 V1')
    await fill('模板简介', '关注 Repository 业务封装')
    await fill(
      '模板正文',
      '# TEMPLATE-MARKER-V1\n\n- 核对来源\n\n<img src="https://example.invalid/tracker">\n\n```sh\necho never-executed\n```'
    )
    assert.equal(
      await js(
        'document.querySelector("[data-testid=markdown-preview]").querySelectorAll("script,img,a,iframe").length'
      ),
      0
    )
    assert.ok(
      await js(
        'document.querySelector("[data-testid=markdown-preview]").textContent.includes("TEMPLATE-MARKER-V1")'
      )
    )
    await click('保存模板')
    await until(() =>
      js('document.querySelector("[data-testid=template-status]")?.textContent.includes("版本 1")')
    )
    await fill('模板名称', '业务模板 V2')
    await fill('模板正文', '# TEMPLATE-MARKER-V2\n\n核对封装与真实来源，必须读取源码。')
    await click('保存模板')
    await until(() =>
      js('document.querySelector("[data-testid=template-status]")?.textContent.includes("版本 2")')
    )
    const list = await service.templates('list', {})
    assert.equal(list.ok, true)
    const chosen = (list.data as TemplateCatalog).templates.find((t) => t.name === '业务模板 V2')!
    await click('导入 Markdown / SKILL.md')
    await until(() =>
      js('document.querySelector("[aria-label=模板名称]")?.value==="导入 Markdown 标题"')
    )
    assert.ok(
      await js('document.querySelector("[aria-label=模板简介]").value.includes("简介段落")')
    )
    await click('保存模板')
    await until(() =>
      js(
        'document.querySelector("[data-testid=template-status]")?.textContent.includes("模板已保存：导入 Markdown 标题")'
      )
    )
    await click('导入 Skill 目录')
    await until(() =>
      js('document.querySelector("[aria-label=模板名称]")?.value==="skill-audit-fixture"')
    )
    assert.equal(
      await js(
        'document.querySelector("[data-testid=markdown-preview]").querySelectorAll("script,img,a").length'
      ),
      0
    )
    await click('保存模板')
    await until(() =>
      js(
        'document.querySelector("[data-testid=template-status]")?.textContent.includes("模板已保存：skill-audit-fixture")'
      )
    )
    assert.equal(existsSync(marker), false)
    assert.equal(fixture.requests.length, 0)
    for (const [width, height] of [
      [1450, 1100],
      [920, 760],
      [480, 850]
    ]) {
      window.setContentSize(width, height)
      await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      assert.ok(await js('document.documentElement.scrollWidth<=window.innerWidth+1'))
    }
    window.setContentSize(1450, 1100)
    await capture('templates-editor')
    await click('审计分析', true)
    await until(() => js('document.querySelector("[aria-label=审计项目]")?.options.length>1'))
    await fill('审计项目', projectId, true)
    await until(() =>
      js(
        '!!document.querySelector("[aria-label=重点审查要求]") && !document.querySelector("[data-testid=review-config-editor] fieldset").disabled'
      )
    )
    await fill('业务封装', 'Repository 是业务封装')
    await fill('输入来源', 'HTTP q 参数')
    await fill('防护约定', '核对参数化与白名单覆盖')
    await fill('重点审查要求', 'PROJECT-FOCUS-V1')
    assert.equal(
      await js(
        'Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="预处理并生成调用链").disabled'
      ),
      true
    )
    await js('document.querySelector("[data-testid=save-project-review]").click()')
    await until(() =>
      js(
        'document.querySelector("[data-testid=review-config-editor]").textContent.includes("项目补充要求已保存")'
      )
    )
    await js('document.querySelector(\'[aria-label="选择模板 业务模板 V2"]\').click()')
    await js('document.querySelector(\'[aria-label="选择模板 skill-audit-fixture"]\').click()')
    await click('预处理并生成调用链')
    await until(() =>
      js(
        'document.querySelector("[data-testid=run-review-config]")?.textContent.includes("业务模板 V2")'
      )
    )
    const runId = await js<string>('document.querySelector("[aria-label=审计任务]").value')
    const before = await service.templates('run', { projectId, runId })
    assert.equal(before.ok, true)
    const edited = await service.templates('save', {
      templateId: chosen.templateId,
      expectedRevision: 2,
      name: '业务模板 V3',
      language: 'java',
      category: 'custom',
      description: chosen.description,
      markdown: 'TEMPLATE-MARKER-V3',
      origin: 'manual',
      sourceName: null
    })
    assert.equal(edited.ok, true)
    const notes = await service.templates('project', { projectId })
    assert.equal(notes.ok, true)
    const { revision: reviewRevision, updatedAt, ...fields } = notes.data as ProjectReview
    assert.ok(updatedAt)
    await service.templates('saveProject', {
      ...fields,
      expectedRevision: reviewRevision,
      focus: 'PROJECT-FOCUS-V2'
    })
    await js('document.querySelector("[data-testid=detail-tab-process]").click()')
    await until(() => js('!!document.querySelector("[data-testid=confirm-source-disclosure]")'))
    assert.equal(fixture.requests.length, 0)
    await js('document.querySelector("[data-testid=confirm-source-disclosure]").click()')
    await until(() =>
      js('document.querySelector("[data-testid=start-path-analysis]")?.disabled===false')
    )
    await js('document.querySelector("[data-testid=start-path-analysis]").click()')
    await until(() =>
      js(
        'document.querySelector("[data-testid=analysis-result]")?.textContent.includes("completed / completed")'
      )
    )
    const sent = JSON.stringify(fixture.requests)
    for (const word of ['TEMPLATE-MARKER-V2', 'PROJECT-FOCUS-V1', 'SKILL-MARKER'])
      assert.ok(sent.includes(word), word)
    for (const word of ['TEMPLATE-MARKER-V3', 'PROJECT-FOCUS-V2'])
      assert.ok(!sent.includes(word), word)
    assert.equal(existsSync(marker), false)
    const report = await service.report('generate', { projectId, runId })
    assert.equal(report.ok, true)
    const html = readFileSync((report.data as ReportRecord).filePath!, 'utf8')
    assert.ok(html.includes('TEMPLATE-MARKER-V2'))
    assert.ok(html.includes('未经验证'))
    assert.ok(!html.includes('TEMPLATE-MARKER-V3'))
    await capture('templates-review')
    const pid = (service as unknown as { child: { pid: number } }).child.pid
    await service.stop()
    await service.start()
    assert.notEqual((service as unknown as { child: { pid: number } }).child.pid, pid)
    const after = await service.templates('run', { projectId, runId })
    assert.equal(after.ok, true)
    assert.deepEqual(after.data, before.data)
    assert.equal(
      (after.data as RunReviewConfig).templates.find((t) => t.templateId === chosen.templateId)
        ?.revision,
      2
    )
    assert.equal((await service.templates('list', {})).ok, true)
    assert.equal((edited.data as TemplateRecord).revision, 3)
    console.info(
      'PASS TPL-02/TPL-03/TPL-04: real React editor/preview, metadata imports, inert Skill scripts, project requirements, version-pinned task context, actual Pi/SSE/report, 3 viewport sizes, different-PID persistence.'
    )
    console.info('TEMPLATE_ARTIFACTS=', root)
    await service.stop()
    await cleanup()
    await fixture.close()
    window.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error)
    await service.stop().catch(() => {})
    await cleanup().catch(() => {})
    await fixture?.close().catch(() => {})
    window?.destroy()
    app.exit(1)
  }
})
