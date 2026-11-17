import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServerConfig } from '../../shared/mcp-settings.ts'
import { ApiError } from '../../shared/api-error.ts'
import { mcpHash, MCP_TOOLS } from './contracts.ts'

export function readMcpServers(root: string): McpServerConfig[] {
  const file = join(root, 'mcp', 'servers.json')
  if (!existsSync(file))
    return [
      {
        id: 'codegraph',
        name: 'CodeGraph 补证',
        kind: 'codegraph',
        transport: 'builtin',
        enabled: true,
        command: '',
        args: [],
        url: '',
        tools: null,
        semgrepPath: '',
        revision: 1
      },
      {
        id: 'static',
        name: '静态扫描',
        kind: 'static',
        transport: 'builtin',
        enabled: true,
        command: '',
        args: [],
        url: '',
        tools: null,
        semgrepPath: process.env.PI_AUDIT_SEMGREP_PATH ?? '',
        revision: 1
      }
    ]
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (data.version !== 1 || !Array.isArray(data.servers)) throw Error('version')
    return data.servers
  } catch {
    throw new ApiError('MCP_CONFIG_CORRUPT', 'MCP配置文件损坏，请检查或恢复已保存配置', 409)
  }
}
export function selectedMcpServers(
  root: string
): Partial<Record<'codegraph' | 'static', McpServerConfig>> {
  const result: Partial<Record<'codegraph' | 'static', McpServerConfig>> = {}
  for (const server of readMcpServers(root))
    if (server.enabled && server.kind !== 'custom') result[server.kind] = server
  return result
}
export function mcpSettingsHash(root: string): string {
  const selected = selectedMcpServers(root)
  return mcpHash(
    ['codegraph', 'static'].map((kind) => {
      const s = selected[kind as 'codegraph' | 'static']
      return s
        ? {
            id: s.id,
            kind: s.kind,
            revision: s.revision,
            tools: s.tools,
            semgrepPath: s.semgrepPath
          }
        : null
    })
  )
}
export function enabledMcpTools(root: string): (typeof MCP_TOOLS)[number][] {
  const selected = selectedMcpServers(root)
  return MCP_TOOLS.filter((name) => {
    const server = selected[name === 'audit_static_scan' ? 'static' : 'codegraph']
    return !!server && (server.tools === null || server.tools.includes(name))
  })
}
