export const mcpActions = [
  'list',
  'save',
  'delete',
  'import',
  'start',
  'stop',
  'test',
  'tools',
  'configureTools',
  'call',
  'runtime',
  'configureRuntime',
  'restartRuntime'
] as const
export type McpAction = (typeof mcpActions)[number]
export interface McpServerConfig {
  id: string
  name: string
  kind: 'codegraph' | 'static' | 'custom'
  transport: 'builtin' | 'stdio' | 'http'
  enabled: boolean
  command: string
  args: string[]
  url: string
  tools: string[] | null
  semgrepPath: string
  revision: number
  state?: 'ready' | 'connected' | 'disabled' | 'configured'
}
export interface McpRuntimeInfo {
  state: 'stopped' | 'starting' | 'ready' | 'failed'
  pythonPath: string
  sourceRoot: string
  pid: number | null
  port: number | null
  message: string
}
export interface McpCatalog {
  servers: McpServerConfig[]
  total: number
  pid: number
  port: number
}
export interface McpToolsInfo {
  id: string
  tools: {
    name: string
    description?: string
    inputSchema: Record<string, unknown>
    outputSchema?: Record<string, unknown>
    annotations?: Record<string, unknown>
  }[]
  advertisedTools?: string[]
  protocol: string
  connected: boolean
  pid: number
  scannerConfigured: boolean | null
}
export type McpData = McpCatalog | McpRuntimeInfo | McpToolsInfo | { id: string; result: unknown }
export function isMcpData(value: unknown): value is McpData {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if ('servers' in v)
    return (
      Array.isArray(v.servers) &&
      v.servers.length <= 30 &&
      v.servers.every(
        (s) =>
          s &&
          typeof s.id === 'string' &&
          typeof s.name === 'string' &&
          ['codegraph', 'static', 'custom'].includes(s.kind) &&
          typeof s.enabled === 'boolean' &&
          Number.isInteger(s.revision)
      )
    )
  if ('pythonPath' in v)
    return (
      typeof v.pythonPath === 'string' &&
      typeof v.sourceRoot === 'string' &&
      typeof v.message === 'string' &&
      ['stopped', 'starting', 'ready', 'failed'].includes(String(v.state))
    )
  if ('tools' in v)
    return (
      typeof v.id === 'string' &&
      Array.isArray(v.tools) &&
      v.tools.every(
        (t) => t && typeof t.name === 'string' && t.inputSchema && typeof t.inputSchema === 'object'
      )
    )
  return typeof v.id === 'string' && 'result' in v
}
