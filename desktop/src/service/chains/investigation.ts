import type { EventInput } from '../../shared/agent-contracts.ts'
import type { InvestigationSnapshot, InvestigationStep } from '../../shared/investigation.ts'
import type { ReviewInput } from './path-analysis.ts'

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
export class InvestigationTracker {
  readonly state: InvestigationSnapshot
  private readonly pendingTargets = new Map<string, number>()
  private readonly completed = new Set<string>()
  private readonly targets = new Set<string>()
  private validation = ''
  private readonly input: ReviewInput
  constructor(input: ReviewInput, tools: string[]) {
    this.input = input
    this.state = {
      version: 1,
      phase: 'collecting',
      activeTool: null,
      nextAction: '',
      tools,
      calls: 0,
      requests: 0,
      repairs: 0,
      evidenceBytes: 0,
      meter: { total: 0, responses: 0 },
      steps: input.path.steps.map((s) => ({
        stepIndex: s.stepIndex,
        read: 'pending',
        related: 0,
        relatedRead: 0,
        graph: 'pending',
        scan: 'pending',
        findings: 0,
        cards: 0
      })),
      gaps: []
    }
  }
  accept(event: EventInput): boolean {
    const p = object(event.payload),
      args = object(p.input),
      output = object(p.output)
    const step = this.state.steps[Number(args.stepIndex)]
    let changed = true
    if (event.type === 'tool' && event.status === 'started') {
      this.state.activeTool = event.toolName ?? null
      this.state.calls++
    } else if (event.type === 'tool' && event.status === 'completed' && step) {
      this.state.activeTool = null
      const key = event.toolName + JSON.stringify(args)
      if (this.completed.has(key)) return true
      this.completed.add(key)
      if (event.toolName === 'audit_read_step') {
        step.read = output.complete === false ? 'partial' : 'complete'
        step.cards = Array.isArray(output.citations) ? output.citations.length : 0
        this.state.evidenceBytes += Buffer.byteLength(String(output.text ?? ''))
      } else if (event.toolName === 'audit_find_related') {
        step.graph = output.status as InvestigationStep['graph']
        for (const item of Array.isArray(output.items) ? output.items : []) {
          const id = String(object(item).targetId)
          if (!this.targets.has(id)) {
            this.targets.add(id)
            this.pendingTargets.set(id, step.stepIndex)
            step.related++
          }
        }
      } else if (event.toolName === 'audit_read_related') {
        if (
          Array.isArray(output.ranges) &&
          output.ranges.length &&
          this.pendingTargets.delete(String(args.targetId))
        )
          step.relatedRead++
        step.cards += Array.isArray(output.citations) ? output.citations.length : 0
        for (const range of Array.isArray(output.ranges) ? output.ranges : [])
          this.state.evidenceBytes += Buffer.byteLength(String(object(range).text ?? ''))
      } else if (event.toolName === 'audit_static_scan') {
        step.scan = output.status as InvestigationStep['scan']
        step.findings = Array.isArray(output.items) ? output.items.length : 0
      }
    } else if (event.status === 'model_usage') {
      const meter = object(p.meter)
      if (typeof meter.total === 'number' && meter.total > 0) {
        this.state.meter.total += meter.total
        this.state.meter.responses++
      }
    } else if (event.status === 'request_started') this.state.requests++
    else if (event.status === 'validation_retry' || event.status === 'validation_failed') {
      const issue = object(p.validation)
      this.validation =
        `${String(issue.field ?? '')}：${String(issue.message ?? '结论尚未通过校验')}`.slice(0, 240)
      this.state.repairs += event.status === 'validation_retry' ? 1 : 0
      this.state.phase = 'repairing'
    } else if (event.status === 'investigation_verified') {
      this.state.phase = 'verified'
      this.validation = ''
    } else changed = false
    return changed
  }
  snapshot(): InvestigationSnapshot {
    const gaps: InvestigationSnapshot['gaps'] = []
    for (const step of this.state.steps) {
      if (step.read !== 'complete')
        gaps.push({
          stepIndex: step.stepIndex,
          code: 'SOURCE_READ',
          message: step.read === 'pending' ? '尚未读取本步骤原文' : '本步骤源码读取不完整'
        })
      else if (step.graph === 'unavailable' || step.graph === 'failed' || step.graph === 'partial')
        gaps.push({
          stepIndex: step.stepIndex,
          code: 'GRAPH_GAP',
          message: '关联图查询未提供完整覆盖，请核对工具返回的缺口'
        })
      else if (step.related > step.relatedRead)
        gaps.push({
          stepIndex: step.stepIndex,
          code: 'RELATED_REVIEW',
          message: '有关联候选尚未补读；候选定位不等于传播证明'
        })
      else if (step.scan === 'unavailable' || step.scan === 'failed' || step.scan === 'partial')
        gaps.push({
          stepIndex: step.stepIndex,
          code: 'STATIC_GAP',
          message: '静态扫描能力或覆盖不完整，不能据此判安全'
        })
    }
    if (this.input.path.truncated)
      gaps.push({
        stepIndex: null,
        code: 'PATH_COVERAGE',
        message: `调用路径覆盖受限：${this.input.path.truncationReason}`
      })
    if (this.validation)
      gaps.push({ stepIndex: null, code: 'RESULT_VALIDATION', message: this.validation })
    if (this.state.phase === 'verified')
      this.state.nextAction = '本次提交已通过原文与传播协议校验；这不等同于动态漏洞验证。'
    else if (this.validation)
      this.state.nextAction = '依据具体校验反馈修正公开结论；不得改写源码引用或猜测安全。'
    else if (this.state.activeTool) this.state.nextAction = '正在执行工具；以实际回执更新材料状态。'
    else if (gaps.some((g) => g.code === 'SOURCE_READ'))
      this.state.nextAction = '先读取尚未完成的步骤原文，再核查传播与防护。'
    else if (this.pendingTargets.size)
      this.state.nextAction = this.state.tools.includes('audit_read_related')
        ? '可补读本步骤已返回的关联候选，核查辅助逻辑是否相关。'
        : '关联读取未启用，保留材料缺口。'
    else
      this.state.nextAction =
        '原文已读取；核查参数映射、赋值、返回、字段与防护，证据不足时保留未知。'
    if (this.state.phase === 'collecting' && this.state.steps.every((s) => s.read !== 'pending'))
      this.state.phase = 'verifying'
    return {
      ...this.state,
      steps: this.state.steps.map((s) => ({ ...s })),
      gaps: gaps.slice(0, 20)
    }
  }
}
