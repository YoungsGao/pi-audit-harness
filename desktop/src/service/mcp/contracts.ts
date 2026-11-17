import { createHash } from 'node:crypto'
import { ApiError } from '../../shared/api-error.ts'
import { isSnapshotPath } from '../../shared/snapshot-path.ts'

export const MCP_PROFILE = 'audit-mcp/1;codegraph/1;static/1'
export const MCP_TOOLS = ['audit_find_related', 'audit_read_related', 'audit_static_scan'] as const
export type McpToolName = (typeof MCP_TOOLS)[number]
export type SourceRange = { filePath: string; startLine: number; endLine: number; text: string }
export type McpArgs = {
  stepIndex: number
  direction?: 'definition' | 'incoming' | 'outgoing'
  targetId?: string
}
export interface McpOutput {
  contractVersion: 1
  tool: McpToolName
  profile: string
  server: string
  snapshotId: string
  sourceStamp: string
  stepIndex: number
  status: 'ok' | 'partial' | 'unavailable' | 'failed'
  truncated: boolean
  gaps: string[]
  items: Record<string, unknown>[]
  ranges: SourceRange[]
  citations: { id: string; filePath: string; startLine: number; endLine: number; text: string }[]
  engine: string
  rulesDigest: string | null
}
export interface McpReceipt {
  key: string
  name: McpToolName
  args: McpArgs
  output: McpOutput
}
export const mcpHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function mcpArgs(name: string, value: unknown, steps: number): McpArgs {
  const row = value as McpArgs
  const keys =
    name === 'audit_find_related'
      ? ['stepIndex', 'direction']
      : name === 'audit_read_related'
        ? ['stepIndex', 'targetId']
        : ['stepIndex']
  if (
    !MCP_TOOLS.includes(name as McpToolName) ||
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((k) => !keys.includes(k)) ||
    !Number.isInteger(row.stepIndex) ||
    row.stepIndex < 0 ||
    row.stepIndex >= steps ||
    (name === 'audit_find_related' &&
      !['definition', 'incoming', 'outgoing'].includes(row.direction!)) ||
    (name === 'audit_read_related' &&
      (typeof row.targetId !== 'string' || !/^rel-[a-f0-9]{32}$/.test(row.targetId)))
  )
    throw new ApiError('AGENT_TOOL_SCOPE', 'MCP工具或参数超出当前路径范围', 400)
  return name === 'audit_find_related'
    ? { stepIndex: row.stepIndex, direction: row.direction }
    : name === 'audit_read_related'
      ? { stepIndex: row.stepIndex, targetId: row.targetId }
      : { stepIndex: row.stepIndex }
}
export function checkMcpOutput(value: unknown): asserts value is McpOutput {
  const r = value as McpOutput
  if (
    !r ||
    r.contractVersion !== 1 ||
    r.profile !== MCP_PROFILE ||
    !MCP_TOOLS.includes(r.tool) ||
    !Number.isInteger(r.stepIndex) ||
    r.stepIndex < 0 ||
    r.stepIndex >= 16 ||
    !['ok', 'partial', 'unavailable', 'failed'].includes(r.status) ||
    typeof r.truncated !== 'boolean' ||
    !Array.isArray(r.gaps) ||
    r.gaps.length > 24 ||
    r.gaps.some((g) => typeof g !== 'string' || g.length > 160) ||
    !Array.isArray(r.items) ||
    r.items.length > 12 ||
    r.items.some((i) => !i || typeof i !== 'object' || Array.isArray(i)) ||
    !Array.isArray(r.ranges) ||
    r.ranges.length > 1 ||
    r.ranges.some(
      (range) =>
        !range ||
        !isSnapshotPath(range.filePath) ||
        !Number.isInteger(range.startLine) ||
        !Number.isInteger(range.endLine) ||
        range.startLine < 1 ||
        range.endLine < range.startLine ||
        range.endLine - range.startLine >= 80 ||
        typeof range.text !== 'string' ||
        Buffer.byteLength(range.text) > 12000
    ) ||
    (r.tool !== 'audit_read_related' && r.ranges.length !== 0) ||
    !Array.isArray(r.citations) ||
    r.citations.length > 80 ||
    r.citations.some(
      (c) =>
        !c ||
        typeof c.id !== 'string' ||
        !c.id.startsWith('ev-') ||
        !isSnapshotPath(c.filePath) ||
        !Number.isInteger(c.startLine) ||
        c.startLine < 1 ||
        c.endLine !== c.startLine ||
        typeof c.text !== 'string' ||
        c.text.length > 1000
    ) ||
    (r.rulesDigest !== null &&
      (typeof r.rulesDigest !== 'string' || !/^[a-f0-9]{64}$/.test(r.rulesDigest))) ||
    ['snapshotId', 'sourceStamp', 'server', 'engine'].some(
      (k) => typeof (r as unknown as Record<string, unknown>)[k] !== 'string'
    ) ||
    Buffer.byteLength(JSON.stringify(r)) > 32768
  )
    throw new ApiError('MCP_INVALID_OUTPUT', 'MCP返回结构或大小无效', 502)
}
export const mcpDefinitions = MCP_TOOLS.map((name) => ({
  name,
  description:
    name === 'audit_find_related'
      ? '在当前步骤的一层CodeGraph调用关系中查找方法，返回候选定位编号；不是传播证明。'
      : name === 'audit_read_related'
        ? '读取本步骤已经返回的关联定位编号对应的固定快照原文和证据卡。'
        : '对本步骤涉及的固定Java文件运行本地静态规则；命中不代表漏洞，未命中不代表安全。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      stepIndex: { type: 'integer', minimum: 0, maximum: 15 },
      ...(name === 'audit_find_related'
        ? { direction: { type: 'string', enum: ['definition', 'incoming', 'outgoing'] } }
        : {}),
      ...(name === 'audit_read_related'
        ? { targetId: { type: 'string', pattern: '^rel-[a-f0-9]{32}$' } }
        : {})
    },
    required:
      name === 'audit_find_related'
        ? ['stepIndex', 'direction']
        : name === 'audit_read_related'
          ? ['stepIndex', 'targetId']
          : ['stepIndex'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      contractVersion: { const: 1 },
      profile: { const: MCP_PROFILE },
      tool: { const: name },
      server: { type: 'string' },
      snapshotId: { type: 'string' },
      sourceStamp: { type: 'string' },
      stepIndex: { type: 'integer' },
      status: { enum: ['ok', 'partial', 'unavailable', 'failed'] },
      truncated: { type: 'boolean' },
      gaps: { type: 'array', items: { type: 'string' } },
      items: { type: 'array', items: { type: 'object' } },
      ranges: {
        type: 'array',
        maxItems: 1,
        items: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            startLine: { type: 'integer', minimum: 1 },
            endLine: { type: 'integer', minimum: 1 },
            text: { type: 'string', maxLength: 12000 }
          },
          required: ['filePath', 'startLine', 'endLine', 'text'],
          additionalProperties: false
        }
      },
      citations: {
        type: 'array',
        maxItems: 80,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            filePath: { type: 'string' },
            startLine: { type: 'integer', minimum: 1 },
            endLine: { type: 'integer', minimum: 1 },
            text: { type: 'string', maxLength: 1000 }
          },
          required: ['id', 'filePath', 'startLine', 'endLine', 'text'],
          additionalProperties: false
        }
      },
      engine: { type: 'string' },
      rulesDigest: { type: ['string', 'null'] }
    },
    required: [
      'contractVersion',
      'profile',
      'tool',
      'server',
      'snapshotId',
      'sourceStamp',
      'stepIndex',
      'status',
      'truncated',
      'gaps',
      'items',
      'ranges',
      'citations',
      'engine',
      'rulesDigest'
    ],
    additionalProperties: false
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
}))
