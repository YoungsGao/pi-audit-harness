import { app, BrowserWindow, dialog, ipcMain } from 'electron'
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
    title: 'Pi Audit Harness',
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
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node
    }
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
