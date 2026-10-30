import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { helpLinks } from '../shared/help-links'
import { templateActions } from '../shared/template-contracts'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { ServiceManager } from './service-manager'
import type { AppInfo } from '../shared/desktop-api'

let mainWindow: BrowserWindow | null = null
let quitting = false
let quitAllowed = false

const service = new ServiceManager(
  (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('service:status-changed', status)
    }
  },
  () => join(app.getPath('userData'), 'runtime')
)

function assertClient(event: IpcMainInvokeEvent): void {
  if (
    event.sender !== mainWindow?.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('不允许的客户端通信来源')
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    title: 'pi-audit-harness',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow = window
  window.on('closed', () => {
    mainWindow = null
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  const loading =
    !app.isPackaged && rendererUrl
      ? window.loadURL(rendererUrl)
      : window.loadFile(join(__dirname, '../renderer/index.html'))

  void loading.catch((error: Error) => {
    console.error('页面加载失败：', error)
    dialog.showErrorBox('页面加载失败', error.message)
    app.quit()
  })
}

void app.whenReady().then(() => {
  console.info('客户端主进程 PID=', process.pid)
  app.setAppUserModelId('com.pi-audit-harness.desktop')
  ipcMain.handle('app:get-info', (event): AppInfo => {
    assertClient(event)
    return {
      name: 'pi-audit-harness',
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node
    }
  })
  ipcMain.handle('help:open', (event, id: unknown) => {
    assertClient(event)
    if (typeof id !== 'string' || !Object.hasOwn(helpLinks, id)) throw new Error('不支持的帮助链接')
    return shell.openExternal(helpLinks[id as keyof typeof helpLinks])
  })
  ipcMain.handle('service:get-status', (event) => {
    assertClient(event)
    return service.getStatus()
  })
  ipcMain.handle('service:check-health', (event) => {
    assertClient(event)
    return service.checkHealth()
  })
  ipcMain.handle('model:test', (event, modelConfigId: unknown) => {
    assertClient(event)
    return service.testModel(typeof modelConfigId === 'string' ? modelConfigId : '')
  })
  ipcMain.handle(
    'reports:action',
    (event, action: import('../shared/report-contracts').ReportAction, input: unknown) => {
      assertClient(event)
      if (!['generate', 'list', 'preview', 'export'].includes(action))
        throw new Error('不允许的报告操作')
      return service.report(action, input)
    }
  )
  ipcMain.handle('reports:save', (event, input: unknown) => {
    assertClient(event)
    return service.saveReport(input)
  })
  ipcMain.handle('reports:open', (event, input: unknown) => {
    assertClient(event)
    return service.openReport(input)
  })
  ipcMain.handle(
    'reviews:action',
    (event, action: import('../shared/review-contracts').ReviewAction, input: unknown) => {
      assertClient(event)
      if (!['get', 'save', 'source'].includes(action)) throw new Error('不允许的复核操作')
      return service.review(action, input)
    }
  )
  ipcMain.handle('storage:get-overview', (event) => {
    assertClient(event)
    return service.getStorageOverview()
  })
  ipcMain.handle('metadata:get', (event) => {
    assertClient(event)
    return service.metadata('list')
  })
  ipcMain.handle('metadata:save-project', (event, input: unknown) => {
    assertClient(event)
    return service.metadata('project', input)
  })
  ipcMain.handle('metadata:save-model', (event, input: unknown) => {
    assertClient(event)
    return service.metadata('model', input)
  })
  ipcMain.handle('models:get-catalog', (event) => {
    assertClient(event)
    return service.modelSettings()
  })
  ipcMain.handle('models:select', (event, input: unknown) => {
    assertClient(event)
    return service.modelSettings(input, true)
  })

  ipcMain.handle('sources:tools', (event) => {
    assertClient(event)
    return service.source('tools')
  })
  ipcMain.handle(
    'templates:action',
    (event, action: import('../shared/template-contracts').TemplateAction, input: unknown) => {
      assertClient(event)
      if (action === 'import' || !templateActions.includes(action))
        throw new Error('不允许的模板操作')
      return service.templates(action, input)
    }
  )
  ipcMain.handle('templates:import-document', async (event, kind: unknown) => {
    assertClient(event)
    if (kind !== 'file' && kind !== 'directory') throw new Error('不支持的导入方式')
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: kind === 'file' ? '选择 Markdown / SKILL.md 文档' : '选择含 SKILL.md 的目录',
      properties: kind === 'file' ? ['openFile'] : ['openDirectory'],
      ...(kind === 'file' ? { filters: [{ name: 'Markdown 文档', extensions: ['md'] }] } : {})
    })
    if (result.canceled || !result.filePaths[0]) return null
    return service.templates('import', { path: result.filePaths[0], kind })
  })
  ipcMain.handle(
    'audit:action',
    (event, action: import('../shared/scan-contracts').AuditAction, input: unknown) => {
      assertClient(event)
      return service.audit(action, input)
    }
  )
  ipcMain.handle('sources:list', (event) => {
    assertClient(event)
    return service.source('list')
  })
  ipcMain.handle(
    'analysis:start-stream',
    (event, input: import('../shared/sse-contracts').AnalyzeRequest) => {
      assertClient(event)
      return service.startAnalysisStream(input, (notice) => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('analysis:stream', notice)
      })
    }
  )
  ipcMain.handle('analysis:stop-stream', (event, id: unknown) => {
    assertClient(event)
    if (typeof id === 'string') service.stopAnalysisStream(id)
  })
  ipcMain.handle('sources:local', (event, value: unknown) => {
    assertClient(event)
    return service.source('local', value)
  })
  ipcMain.handle('sources:github', (event, value: unknown) => {
    assertClient(event)
    return service.source('github', value)
  })
  ipcMain.handle('sources:open', (event, projectId: unknown) => {
    assertClient(event)
    return service.source('open', { projectId })
  })
  ipcMain.handle('sources:choose-directory', async (event) => {
    assertClient(event)
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择 Java 源码目录',
      properties: ['openDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  createWindow()
  void service.start().catch((error: unknown) => {
    console.error('本地服务启动失败：', error instanceof Error ? error.message : '未知错误')
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', (event) => {
  if (quitAllowed) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  void service
    .stop()
    .catch((error: unknown) => {
      console.error('服务关闭失败：', error instanceof Error ? error.message : '未知错误')
    })
    .finally(() => {
      quitAllowed = true
      app.quit()
    })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
