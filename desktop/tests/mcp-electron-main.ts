import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ServiceManager } from '../src/main/service-manager'
import type { McpCatalog, McpToolsInfo, McpRuntimeInfo } from '../src/shared/mcp-settings'
const root = resolve('.mcp-test-data', randomUUID())
app.setPath('userData', join(root, 'profile'))
const service = new ServiceManager(
  () => {},
  () => join(root, 'runtime')
)
let window: BrowserWindow | undefined
const js = <T>(code: string): Promise<T> => window!.webContents.executeJavaScript(code)
async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const end = Date.now() + 30000
  while (!(await check())) {
    if (Date.now() > end) throw Error(label + ' timeout')
    await new Promise((r) => setTimeout(r, 60))
  }
}
async function click(text: string): Promise<void> {
  assert.ok(
    await js<boolean>(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`
    ),
    text
  )
}
async function fill(label: string, value: string): Promise<void> {
  await js(
    `(()=>{const el=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`
  )
}
async function settled(): Promise<void> {
  await until(
    () => js('!document.querySelector("button[type=submit]")?.disabled'),
    'form available'
  )
}
void app.whenReady().then(async () => {
  try {
    mkdirSync(root, { recursive: true })
    ipcMain.handle('app:get-info', () => ({
      name: 'pi-audit',
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
    ipcMain.handle('mcp:action', (_event, action, input) => service.mcp(action, input))
    ipcMain.handle('mcp:import', () =>
      service.mcp('import', {
        mcpServers: { 文件导入样例: { command: 'python', args: ['-m', 'example'] } }
      })
    )
    await service.start()
    window = new BrowserWindow({
      show: false,
      width: 1460,
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
    await until(() => js('document.querySelectorAll("nav button").length===7'), 'navigation')
    await click('扩展服务')
    await until(
      () =>
        js(
          'document.querySelector("[data-testid=mcp-runtime-state]")?.textContent==="Python 已就绪"'
        ),
      'Python ready'
    )
    await settled()
    assert.equal(await js('document.querySelectorAll(".mcp-server").length'), 2)
    const initialRuntime = await service.mcp('runtime', {})
    assert.ok(initialRuntime.ok)
    await fill('Python解释器', join(root, 'missing-python.exe'))
    await click('保存运行环境')
    await until(
      () =>
        js(
          'document.querySelector("[data-testid=mcp-runtime-state]").textContent==="Python 启动失败"'
        ),
      'failed runtime status'
    )
    await settled()
    assert.ok(
      await js(
        'document.querySelector("[data-testid=mcp-error]").textContent.includes("MCP_PYTHON_MISSING")'
      )
    )
    await fill('Python解释器', (initialRuntime.data as McpRuntimeInfo).pythonPath)
    await click('保存运行环境')
    await until(
      () =>
        js(
          'document.querySelector("[data-testid=mcp-runtime-state]").textContent==="Python 已就绪"'
        ),
      'fixed runtime status'
    )
    await settled()
    await js('document.querySelector("[data-testid=mcp-server-static]").click()')
    await fill('MCP服务名称', '静态扫描界面已编辑')
    await click('保存配置')
    await until(
      () =>
        js(
          'document.querySelector("[data-testid=mcp-message]").textContent.includes("配置已保存")'
        ),
      'save'
    )
    await settled()
    await click('测试连接 / 查看工具')
    await until(() => js('document.querySelectorAll(".mcp-tool").length===1'), 'tool list')
    await settled()
    await js('document.querySelector(".mcp-tool input").click()')
    await click('保存工具选择')
    await until(
      () =>
        js(
          'document.querySelector("[data-testid=mcp-message]").textContent.includes("工具选择已保存")'
        ),
      'disable tool'
    )
    await settled()
    const disabled = await service.mcp('test', { id: 'static' })
    assert.ok(disabled.ok)
    assert.deepEqual((disabled.data as McpToolsInfo).advertisedTools, [])
    await click('测试连接 / 查看工具')
    await until(
      () => js('document.querySelectorAll(".mcp-tool").length===1'),
      'rediscover disabled tool'
    )
    await settled()
    assert.equal(await js('document.querySelector(".mcp-tool input").checked'), false)
    await js('document.querySelector(".mcp-tool input").click()')
    await click('保存工具选择')
    await until(
      () =>
        js(
          'document.querySelector("[data-testid=mcp-message]").textContent.includes("工具选择已保存")'
        ),
      'enable tool'
    )
    await settled()
    await click('停用')
    await until(
      () => js('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="启动")'),
      'stop'
    )
    await settled()
    await click('启动')
    await settled()
    await click('导入 MCP')
    await fill(
      'MCP导入JSON',
      JSON.stringify({
        mcpServers: { 粘贴导入样例: { command: 'python', args: ['-m', 'example'] } }
      })
    )
    await click('导入文本')
    await until(() => js('document.querySelectorAll(".mcp-server").length===3'), 'import paste')
    await settled()
    const list = await service.mcp('list', {})
    assert.ok(list.ok)
    const imported = (list.data as McpCatalog).servers.find((s) => s.name === '粘贴导入样例')!
    assert.equal(imported.enabled, false)
    await js(`document.querySelector('[data-testid="mcp-server-${imported.id}"]').click()`)
    await click('删除配置')
    await until(() => js('document.querySelectorAll(".mcp-server").length===2'), 'delete')
    await settled()
    await click('导入 MCP')
    await click('选择 JSON 文件')
    await until(() => js('document.querySelectorAll(".mcp-server").length===3'), 'file import')
    await settled()
    await js('document.querySelector("[data-testid=mcp-server-static]").click()')
    await click('测试连接 / 查看工具')
    await until(() => js('document.querySelectorAll(".mcp-tool").length===1'), 'final tools')
    await settled()
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await new Promise((r) => setTimeout(r, 200))
    writeFileSync(join(root, 'mcp-settings.png'), (await window.webContents.capturePage()).toPNG())
    await js('document.querySelector(".mcp-layout").scrollIntoView({block:"start"})')
    await new Promise((r) => setTimeout(r, 200))
    writeFileSync(join(root, 'mcp-tools.png'), (await window.webContents.capturePage()).toPNG())
    await js('document.getElementById("workspace-main").scrollTo(0,0);window.scrollTo(0,0)')
    window.setSize(600, 1000)
    await new Promise((r) => setTimeout(r, 150))
    const layout = await js<{ width: number; viewport: number }>(
      '({width:document.documentElement.scrollWidth,viewport:innerWidth})'
    )
    assert.ok(layout.width <= layout.viewport + 2, JSON.stringify(layout))
    writeFileSync(
      join(root, 'mcp-settings-mobile.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    await service.stop()
    await service.start()
    const reopened = await service.mcp('list', {})
    assert.ok(reopened.ok)
    assert.equal(
      (reopened.data as McpCatalog).servers.find((s) => s.id === 'static')!.name,
      '静态扫描界面已编辑'
    )
    writeFileSync(
      join(root, 'verification.json'),
      JSON.stringify(
        {
          ok: true,
          realPython: true,
          tools: 3,
          crud: true,
          importText: true,
          importFileBridge: true,
          disabledToolsCanBeReenabled: true,
          restartPersists: true,
          layout
        },
        null,
        2
      )
    )
    await service.stop()
    window.destroy()
    console.log(
      'PASS MCP Electron: Python HTTP, real discovery, CRUD, import, tool disable/enable, restart and responsive layout'
    )
    console.log('MCP_ARTIFACTS=' + root)
    app.exit(0)
  } catch (e) {
    console.error(e)
    if (window)
      writeFileSync(join(root, 'failure.png'), (await window.webContents.capturePage()).toPNG())
    await service.stop().catch(() => {})
    window?.destroy()
    app.exit(1)
  }
})
