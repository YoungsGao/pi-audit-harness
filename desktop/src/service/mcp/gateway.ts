import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { randomUUID } from 'node:crypto'
import { selectedMcpServers, enabledMcpTools } from './settings.ts'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ApiError } from '../../shared/api-error.ts'
import type { AuditMcpBackend } from './backend.ts'
import { mcpDefinitions, checkMcpOutput, mcpArgs, mcpHash } from './contracts.ts'
import type { McpToolName, McpOutput } from './contracts.ts'
import { isDeepStrictEqual } from 'node:util'
import { STATIC_RULES_DIGEST } from './static-scanner.ts'

// Compatibility stdio facade used by the query lab; tool execution is delegated to Python.
export function createAuditMcpServer(
  backend: AuditMcpBackend,
  kind: 'codegraph' | 'static',
  signal: AbortSignal
): Server {
  const server = new Server(
    { name: 'audit-' + kind, version: '1.0.0' },
    { capabilities: { tools: {} } }
  )
  const tools = mcpDefinitions.filter(
    (d) => (d.name === 'audit_static_scan') === (kind === 'static')
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!tools.some((t) => t.name === request.params.name))
      throw new ApiError('AGENT_TOOL_SCOPE', 'MCP服务不提供此工具', 403)
    const result = await backend.call(
      request.params.name as McpToolName,
      request.params.arguments,
      AbortSignal.any([signal, extra.signal])
    )
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
  })
  return server
}
export class AuditMcpGateway {
  private readonly clients = new Map<string, Client>()
  private ready?: Promise<void>
  private registered = false
  private readonly contextId = randomUUID()
  private readonly selected: ReturnType<typeof selectedMcpServers>
  readonly toolNames: McpToolName[]
  readonly backend: AuditMcpBackend
  readonly signal: AbortSignal
  constructor(backend: AuditMcpBackend, signal: AbortSignal) {
    this.backend = backend
    this.signal = signal
    this.selected = selectedMcpServers(backend.query.mcp.root)
    this.toolNames = enabledMcpTools(backend.query.mcp.root)
  }
  private async connect(): Promise<void> {
    const manager = this.backend.query.mcp
    try {
      await manager.start()
      const context = await this.backend.context(
        this.signal,
        this.toolNames.some((name) => name !== 'audit_static_scan')
      )
      this.registered = true
      await manager.request(
        '/contexts/' + this.contextId,
        'POST',
        { ...context, servers: this.selected },
        this.signal
      )
      for (const kind of ['codegraph', 'static'] as const) {
        const server = this.selected[kind]
        const expected = mcpDefinitions.filter(
          (d) =>
            this.toolNames.includes(d.name) &&
            (d.name === 'audit_static_scan') === (kind === 'static')
        )
        if (!server || !expected.length) continue
        const endpoint = await manager.endpoint(kind, server.id, this.contextId)
        const client = new Client({ name: 'audit-host', version: '2.0.0' })
        this.clients.set(kind, client)
        await client.connect(
          new StreamableHTTPClientTransport(endpoint.url, {
            requestInit: { headers: endpoint.headers }
          }),
          { signal: this.signal }
        )
        const listed = await client.listTools({}, { signal: this.signal })
        const publicDefinition = (tool: (typeof listed.tools)[number]): unknown => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: tool.annotations
        })
        if (!isDeepStrictEqual(listed.tools.map(publicDefinition), expected.map(publicDefinition)))
          throw new ApiError('MCP_TOOL_SET_CHANGED', 'Python MCP工具清单与审计契约不一致', 409)
      }
    } catch (error) {
      await this.close()
      throw error
    }
  }
  async call(name: McpToolName, args: unknown): Promise<McpOutput> {
    mcpArgs(name, args, this.backend.input.path.steps.length)
    if (!this.toolNames.includes(name))
      throw new ApiError('MCP_TOOL_DISABLED', '此MCP工具已停用', 409)
    try {
      await (this.ready ??= this.connect())
      const result = await this.clients
        .get(name === 'audit_static_scan' ? 'static' : 'codegraph')!
        .callTool({ name, arguments: args as Record<string, unknown> }, undefined, {
          signal: this.signal,
          timeout: 25000
        })
      if (result.isError) {
        const message = JSON.stringify(result.content)
        throw new ApiError(
          message.includes('AGENT_TOOL_SCOPE')
            ? 'AGENT_TOOL_SCOPE'
            : message.includes('MCP_CONFIG_CHANGED')
              ? 'MCP_CONFIG_CHANGED'
              : 'MCP_TOOL_FAILED',
          'Python MCP工具调用被拒绝或失败',
          409
        )
      }
      checkMcpOutput(result.structuredContent)
      this.backend.restore({
        key: mcpHash([name, args]),
        name,
        args: mcpArgs(name, args, this.backend.input.path.steps.length),
        output: result.structuredContent
      })
      return result.structuredContent
    } catch (error) {
      if (error instanceof ApiError && /^MCP_(?:PYTHON|START)/.test(error.code))
        return {
          contractVersion: 1,
          tool: name,
          profile: 'audit-mcp/1;codegraph/1;static/1',
          server: name === 'audit_static_scan' ? 'audit-static/1' : 'audit-codegraph/1',
          snapshotId: this.backend.snapshot.snapshotId,
          sourceStamp: this.backend.snapshot.sourceStamp,
          stepIndex: (args as { stepIndex: number }).stepIndex,
          status: 'unavailable',
          truncated: false,
          gaps: [error.code],
          items: [],
          ranges: [],
          citations: [],
          engine: name === 'audit_static_scan' ? 'semgrep/1.185.0' : 'codegraph',
          rulesDigest: name === 'audit_static_scan' ? STATIC_RULES_DIGEST : null
        }
      throw error
    }
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((c) => c.close()))
    this.clients.clear()
    if (this.registered) {
      this.registered = false
      await this.backend.query.mcp.request('/contexts/' + this.contextId, 'DELETE').catch(() => {})
    }
  }
}
