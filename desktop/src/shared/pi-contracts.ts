export interface PiRuntimeInfo {
  state: 'not-initialized' | 'initializing' | 'ready' | 'failed' | 'stopped'
  sdkVersion: string
  message: string
  code?: string
}

export interface ModelConfig {
  id: string
  revision: number
  name: string
  baseUrl: string
  modelId: string
  api: 'openai-completions'
  secretRef: string
}

export interface ModelPorts {
  getConfig: (id: string) => Promise<ModelConfig | undefined>
  readSecret: (reference: string) => Promise<string | undefined>
}

export interface ModelIdentity {
  configId: string
  revision: number
  modelId: string
}

export interface ModelPingData {
  reply: string
  latencyMs: number
  model: ModelIdentity
}

export function isPiRuntimeInfo(value: unknown): value is PiRuntimeInfo {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.state === 'string' &&
    ['not-initialized', 'initializing', 'ready', 'failed', 'stopped'].includes(item.state) &&
    typeof item.sdkVersion === 'string' &&
    typeof item.message === 'string' &&
    (item.code === undefined || typeof item.code === 'string')
  )
}

export interface AuditWorkItem {
  projectId: string
  runId: string
  projectRoot: string
  file: string
  startLine: number
  endLine: number
}

export interface SourceEvidence {
  file: string
  startLine: number
  endLine: number
  content: string
  sha256: string
}

export interface AuditPreview {
  scope: 'runtime-preview'
  projectId: string
  runId: string
  summary: string
  evidence: SourceEvidence[]
}

export interface ReportPreview {
  projectId: string
  runId: string
  html: string
}
