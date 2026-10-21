import type { PiRuntimeInfo } from './pi-contracts'

export interface RequestContext {
  requestId: string
  projectId?: string
  runId?: string
}

export interface HealthData {
  service: 'pi-audit-local'
  stage: 'http-ready'
  pi: 'not-integrated' | PiRuntimeInfo['state']
  runtime?: PiRuntimeInfo
}

export type ApiResult<T> = RequestContext &
  (
    | { ok: true; data: T }
    | {
        ok: false
        error: {
          code: string
          message: string
          retryable: boolean
        }
      }
  )

export type ParentToService =
  { type: 'init'; token: string; dataRoot: string } | { type: 'heartbeat' } | { type: 'shutdown' }

export type ServiceToParent =
  | { type: 'listening'; port: number }
  | { type: 'startup-error'; code: string; message: string }
  | { type: 'runtime-status'; runtime: PiRuntimeInfo }
