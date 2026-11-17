import type { CodeQueryService } from '../query/service.ts'
import type { ReviewInput } from '../chains/path-analysis.ts'
import type { QueryItem } from '../../shared/query-contracts.ts'
import { ApiError } from '../../shared/api-error.ts'
import { evidenceCards } from '../chains/evidence-citations.ts'
import { MCP_PROFILE, mcpArgs, mcpHash, checkMcpOutput } from './contracts.ts'
import type { McpArgs, McpOutput, McpReceipt, McpToolName } from './contracts.ts'
import { STATIC_RULES_DIGEST } from './static-scanner.ts'

import { AuditMcpGateway } from './gateway.ts'

export class AuditMcpBackend {
  private readonly receipts = new Map<string, McpReceipt>()
  readonly query: CodeQueryService
  readonly input: Pick<ReviewInput, 'projectId' | 'runId' | 'pathId' | 'path'>
  private readonly targets = new Map<string, { stepIndex: number; item: QueryItem }>()
  readonly snapshot: ReturnType<CodeQueryService['snapshots']['info']>
  constructor(
    query: CodeQueryService,
    input: Pick<ReviewInput, 'projectId' | 'runId' | 'pathId' | 'path'>
  ) {
    this.query = query
    this.input = input
    this.snapshot = query.snapshots.info(input.projectId, input.runId)
  }
  restore(receipt: McpReceipt): void {
    const args = mcpArgs(receipt.name, receipt.args, this.input.path.steps.length)
    checkMcpOutput(receipt.output)
    if (
      receipt.key !== mcpHash([receipt.name, args]) ||
      receipt.output.tool !== receipt.name ||
      receipt.output.snapshotId !== this.snapshot.snapshotId ||
      receipt.output.sourceStamp !== this.snapshot.sourceStamp ||
      receipt.output.stepIndex !== args.stepIndex
    )
      throw new ApiError('RUN_MCP_CORRUPT', 'MCP回执与任务身份不一致', 409)
    if (receipt.name === 'audit_find_related')
      for (const row of receipt.output.items) {
        const item = row.item as QueryItem
        const id = this.targetId(args, item)
        if (
          row.targetId !== id ||
          !this.snapshot.files.some((f) => f.filePath === item?.location?.filePath)
        )
          throw new ApiError('RUN_MCP_CORRUPT', 'MCP定位编号或快照文件无效', 409)
        this.targets.set(id, { stepIndex: args.stepIndex, item })
      }
    if (receipt.name === 'audit_static_scan' && receipt.output.rulesDigest !== STATIC_RULES_DIGEST)
      throw new ApiError('RUN_MCP_VERSION_CHANGED', '静态规则版本与原回执不同', 409)
    if (receipt.name === 'audit_read_related') {
      const target = this.targets.get(args.targetId!)
      const location = target?.item.symbol?.location ?? target?.item.location
      if (
        !target ||
        target.stepIndex !== args.stepIndex ||
        receipt.output.ranges.some(
          (r) =>
            r.filePath !== location?.filePath ||
            r.startLine !== location.start.line ||
            r.endLine > location.end.line
        )
      )
        throw new ApiError('RUN_MCP_CORRUPT', '补证范围不是本步骤已授权关联定位', 409)
    }
    for (const range of receipt.output.ranges) {
      const raw = this.query.snapshots
        .read(this.input.projectId, this.input.runId, range.filePath)
        .split('\n')
        .slice(range.startLine - 1, range.endLine)
        .join('\n')
      if (
        !Number.isInteger(range.startLine) ||
        range.startLine < 1 ||
        range.endLine - range.startLine >= 80 ||
        range.endLine < range.startLine ||
        raw !== range.text
      )
        throw new ApiError('RUN_MCP_CORRUPT', 'MCP补证原文不匹配固定快照', 409)
    }
    if (
      mcpHash(receipt.output.citations) !==
      mcpHash(
        receipt.output.ranges.length
          ? evidenceCards(
              { ...receipt.output.ranges[0], ranges: receipt.output.ranges },
              args.stepIndex,
              this.input
            )
          : []
      )
    )
      throw new ApiError('RUN_MCP_CORRUPT', 'MCP证据编号不匹配', 409)
    this.receipts.set(receipt.key, receipt)
  }
  private targetId(args: McpArgs, item: QueryItem): string {
    return (
      'rel-' +
      mcpHash([
        MCP_PROFILE,
        this.input.projectId,
        this.input.runId,
        this.input.pathId,
        this.snapshot.snapshotId,
        args,
        item
      ]).slice(0, 32)
    )
  }
  async context(signal: AbortSignal, withGraph = true): Promise<Record<string, unknown>> {
    const files = this.snapshot.files.map((f) => ({
      filePath: f.filePath,
      source: this.query.snapshots.read(this.input.projectId, this.input.runId, f.filePath)
    }))
    let graph: import('../query/graph-contracts.ts').McpGraphProjection = {
      engine: 'basic',
      gaps: ['CODEGRAPH_NOT_AVAILABLE'],
      methods: [],
      calls: []
    }
    if (withGraph)
      try {
        graph = await this.query.unified.mcpProjection(
          this.input.projectId,
          this.input.runId,
          signal
        )
      } catch (error) {
        if (signal.aborted || !(error instanceof ApiError) || !error.code.startsWith('QUERY_'))
          throw error
        graph.gaps.push(error.code)
      }
    return {
      projectId: this.input.projectId,
      runId: this.input.runId,
      pathId: this.input.pathId,
      snapshotId: this.snapshot.snapshotId,
      sourceStamp: this.snapshot.sourceStamp,
      steps: this.input.path.steps.map((s) => ({ stepIndex: s.stepIndex, edge: s.edge })),
      files,
      graph,
      receipts: [...this.receipts.values()]
    }
  }
  async call(name: McpToolName, value: unknown, signal: AbortSignal): Promise<McpOutput> {
    const gateway = new AuditMcpGateway(this, signal)
    try {
      return await gateway.call(name, value)
    } finally {
      await gateway.close()
    }
  }
}
