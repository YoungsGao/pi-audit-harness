import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { DesktopApi, ServiceStatus } from '../shared/desktop-api'

const audit: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  getServiceStatus: () => ipcRenderer.invoke('service:get-status'),
  checkServiceHealth: () => ipcRenderer.invoke('service:check-health'),
  testModel: (modelConfigId) => ipcRenderer.invoke('model:test', modelConfigId),
  onServiceStatus: (callback) => {
    const listener = (_event: IpcRendererEvent, status: ServiceStatus): void => callback(status)
    ipcRenderer.on('service:status-changed', listener)
    return () => ipcRenderer.removeListener('service:status-changed', listener)
  }
}

contextBridge.exposeInMainWorld('audit', audit)
