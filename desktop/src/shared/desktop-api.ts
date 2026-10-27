import type { ModelCatalog, ModelSelectionInput } from './model-settings'
import type {
  MetadataOverview,
  ProjectInput,
  ProjectRecord,
  ModelInput,
  ModelSaveResult
} from './metadata-contracts'
import type { ModelPingData, PiRuntimeInfo } from './pi-contracts'
import type { ApiResult } from './service-protocol'
import type { DatabaseInfo, StorageOverview } from './storage-contracts'

export interface AppInfo {
  name: string
  version: string
  electron: string
  node: string
}

export type ServiceState = 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped'

export interface ServiceStatus {
  status: ServiceState
  message: string
  code?: string
  requestId?: string
  pi?: PiRuntimeInfo
  database?: DatabaseInfo
}

export interface DesktopApi {
  reports: (
    action: 'generate' | 'list',
    input: unknown
  ) => Promise<ApiResult<import('./report-contracts').ReportData>>
  openReport: (
    input: unknown
  ) => Promise<ApiResult<import('./report-contracts').ReportScope & { reportId: string }>>
  startAnalysisStream: (
    input: import('./sse-contracts').AnalyzeRequest
  ) => Promise<ApiResult<import('./sse-contracts').StreamHandle>>
  stopAnalysisStream: (connectionId: string) => Promise<void>
  onAnalysisStream: (
    callback: (notice: import('./sse-contracts').StreamNotice) => void
  ) => () => void
  audit: (
    action: import('./scan-contracts').AuditAction,
    input: unknown
  ) => Promise<ApiResult<import('./scan-contracts').AuditData>>
  chooseSourceDirectory: () => Promise<string | null>
  getSourceTools: () => Promise<ApiResult<import('./source-contracts').SourceTools>>
  listSources: () => Promise<ApiResult<import('./source-contracts').SourceCatalog>>
  importLocalSource: (
    input: unknown
  ) => Promise<ApiResult<import('./source-contracts').SourceProject>>
  importGithubSource: (
    input: unknown
  ) => Promise<ApiResult<import('./source-contracts').SourceProject>>
  openSourceProject: (
    projectId: string
  ) => Promise<ApiResult<import('./source-contracts').SourceOpened>>
  getModelCatalog: () => Promise<ApiResult<ModelCatalog>>
  selectModel: (input: ModelSelectionInput) => Promise<ApiResult<ModelCatalog>>
  getMetadata: () => Promise<ApiResult<MetadataOverview>>
  saveProject: (input: ProjectInput) => Promise<ApiResult<ProjectRecord>>
  saveModelConfig: (input: ModelInput) => Promise<ApiResult<ModelSaveResult>>
  getStorageOverview: () => Promise<ApiResult<StorageOverview>>
  getAppInfo: () => Promise<AppInfo>
  getServiceStatus: () => Promise<ServiceStatus>
  checkServiceHealth: () => Promise<ServiceStatus>
  testModel: (modelConfigId: string) => Promise<ApiResult<ModelPingData>>
  onServiceStatus: (callback: (status: ServiceStatus) => void) => () => void
}
