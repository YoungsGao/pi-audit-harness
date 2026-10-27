import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { DesktopApi, ServiceStatus } from '../shared/desktop-api'

const audit: DesktopApi = {
  reports: (action, input) => ipcRenderer.invoke('reports:action', action, input),
  openReport: (input) => ipcRenderer.invoke('reports:open', input),
  startAnalysisStream: (input) => ipcRenderer.invoke('analysis:start-stream', input),
  stopAnalysisStream: (id) => ipcRenderer.invoke('analysis:stop-stream', id),
  onAnalysisStream: (callback) => {
    const handler = (
      _event: IpcRendererEvent,
      notice: import('../shared/sse-contracts').StreamNotice
    ): void => callback(notice)
    ipcRenderer.on('analysis:stream', handler)
    return () => ipcRenderer.removeListener('analysis:stream', handler)
  },
  audit: (action, input) => ipcRenderer.invoke('audit:action', action, input),
  chooseSourceDirectory: () => ipcRenderer.invoke('sources:choose-directory'),
  getSourceTools: () => ipcRenderer.invoke('sources:tools'),
  listSources: () => ipcRenderer.invoke('sources:list'),
  importLocalSource: (input) => ipcRenderer.invoke('sources:local', input),
  importGithubSource: (input) => ipcRenderer.invoke('sources:github', input),
  openSourceProject: (projectId) => ipcRenderer.invoke('sources:open', projectId),
  getModelCatalog: () => ipcRenderer.invoke('models:get-catalog'),
  selectModel: (input) => ipcRenderer.invoke('models:select', input),
  getMetadata: () => ipcRenderer.invoke('metadata:get'),
  saveProject: (input) => ipcRenderer.invoke('metadata:save-project', input),
  saveModelConfig: (input) => ipcRenderer.invoke('metadata:save-model', input),
  getStorageOverview: () => ipcRenderer.invoke('storage:get-overview'),
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
