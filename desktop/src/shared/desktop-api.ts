import type { ModelPingData, PiRuntimeInfo } from './pi-contracts'
import type { ApiResult } from './service-protocol'

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
}

export interface DesktopApi {
  getAppInfo: () => Promise<AppInfo>
  getServiceStatus: () => Promise<ServiceStatus>
  checkServiceHealth: () => Promise<ServiceStatus>
  testModel: (modelConfigId: string) => Promise<ApiResult<ModelPingData>>
  onServiceStatus: (callback: (status: ServiceStatus) => void) => () => void
}
