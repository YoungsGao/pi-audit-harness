import type { CreateAgentSessionResult } from '@earendil-works/pi-coding-agent'
import { ApiError } from '../shared/api-error.ts'
import type { RequestContext } from '../shared/service-protocol'
import type {
  AuditPreview,
  AuditWorkItem,
  ModelIdentity,
  ModelPorts,
  ReportPreview
} from '../shared/pi-contracts.ts'
import { resolveModelConfig } from './model-config-resolver.ts'
import { createManagedSession } from './pi-session-factory.ts'
import { createPiResources } from './pi-resources.ts'
import { PiRuntime, throwIfCancelled, waitWithSignal } from './pi-runtime.ts'
import { PiResultCollector } from './pi-result-collector.ts'
import { createAuditExtension } from './pi/extensions/audit.ts'
import { createReportExtension } from './pi/extensions/report.ts'
import { normalizePiFailure } from './pi-errors.ts'

type Session = CreateAgentSessionResult['session']

function assertTaskIds(context: RequestContext, work: { projectId: string; runId: string }): void {
  if (
    !/^[A-Za-z0-9_-]{1,80}$/.test(work.runId) ||
    !work.projectId ||
    context.projectId !== work.projectId ||
    context.runId !== work.runId
  ) {
    throw new ApiError('INVALID_TASK_CONTEXT', '请求标识与本次项目或任务不一致', 400)
  }
}

async function promptSafely(session: Session, text: string, signal: AbortSignal): Promise<void> {
  throwIfCancelled(signal)
  const abort = (): void => {
    void session.abort().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  let assistantFailed = false
  let assistantError = ''
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      assistantFailed = ['error', 'aborted'].includes(event.message.stopReason)
      assistantError = event.message.errorMessage ?? ''
    }
  })
  try {
    throwIfCancelled(signal)
    await waitWithSignal(session.prompt(text), signal)
    throwIfCancelled(signal)
    if (assistantFailed) throw normalizePiFailure(assistantError)
  } finally {
    signal.removeEventListener('abort', abort)
    unsubscribe()
  }
}

export class PiOperations {
  private runtime: PiRuntime
  private ports: ModelPorts

  constructor(runtime: PiRuntime, ports: ModelPorts) {
    this.runtime = runtime
    this.ports = ports
  }

  private async useSession<T>(
    configId: string,
    context: RequestContext,
    mode: 'ping' | 'audit' | 'report',
    taskInput: AuditWorkItem | AuditPreview | undefined,
    execute: (session: Session, collector: PiResultCollector, signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    outerSignal?: AbortSignal
  ): Promise<T & RequestContext & { model: ModelIdentity }> {
    return this.runtime.run(
      async (signal) => {
        let session: Session | undefined
        try {
          const selected = await resolveModelConfig(configId, this.ports, signal)
          const collector = new PiResultCollector()
          const extensions =
            mode === 'audit'
              ? [
                  {
                    name: 'audit@0.1.0',
                    factory: createAuditExtension(taskInput as AuditWorkItem, collector)
                  }
                ]
              : mode === 'report'
                ? [
                    {
                      name: 'report@0.1.0',
                      factory: createReportExtension(taskInput as AuditPreview, collector)
                    }
                  ]
                : []
          const resources = await waitWithSignal(
            createPiResources(this.runtime.workDir, this.runtime.agentDir, extensions),
            signal
          )
          session = await createManagedSession(
            this.runtime,
            selected,
            resources,
            mode === 'audit' ? ['audit_read_evidence'] : [],
            signal,
            () => collector.fail()
          )
          const data = await execute(session, collector, signal)
          collector.assertHealthy()
          return {
            ...data,
            ...context,
            model: {
              configId: selected.config.id,
              revision: selected.config.revision,
              modelId: selected.config.modelId
            }
          }
        } catch (error) {
          throw normalizePiFailure(error)
        } finally {
          session?.dispose()
        }
      },
      timeoutMs,
      outerSignal
    )
  }

  ping(
    configId: string,
    context: RequestContext,
    timeoutMs = 15000,
    signal?: AbortSignal
  ): Promise<RequestContext & { reply: string; latencyMs: number; model: ModelIdentity }> {
    const start = performance.now()
    return this.useSession(
      configId,
      context,
      'ping',
      undefined,
      async (session, _collector, current) => {
        if (session.getActiveToolNames().length !== 0)
          throw new ApiError('INVALID_TOOL_SET', '模型测试不应启用工具')
        await promptSafely(session, 'ping', current)
        const reply = session.getLastAssistantText()?.trim()
        if (!reply) throw new ApiError('EMPTY_REPLY', '模型没有返回有效文本', 502)
        return { reply, latencyMs: Math.round(performance.now() - start) }
      },
      timeoutMs,
      signal
    )
  }

  auditPreview(
    configId: string,
    context: RequestContext,
    work: AuditWorkItem,
    timeoutMs = 15000
  ): Promise<RequestContext & AuditPreview & { model: ModelIdentity }> {
    assertTaskIds(context, work)
    return this.useSession(
      configId,
      context,
      'audit',
      work,
      async (session, collector, signal) => {
        await promptSafely(
          session,
          '请先调用 audit_read_evidence，随后仅根据实际读取的源码用中文说明其行为和未解决问题。这是运行时样例，不要求给出正式漏洞结论。',
          signal
        )
        collector.assertHealthy()
        const summary = session.getLastAssistantText()?.trim()
        if (!summary || collector.evidence.length === 0)
          throw new ApiError('EVIDENCE_MISSING', '审计样例未取得实际工具证据', 502)
        return {
          scope: 'runtime-preview' as const,
          projectId: work.projectId,
          runId: work.runId,
          summary,
          evidence: [...collector.evidence]
        }
      },
      timeoutMs
    )
  }

  reportPreview(
    configId: string,
    context: RequestContext,
    input: AuditPreview,
    timeoutMs = 15000
  ): Promise<RequestContext & ReportPreview & { model: ModelIdentity }> {
    assertTaskIds(context, input)
    return this.useSession(
      configId,
      context,
      'report',
      input,
      async (session, collector, signal) => {
        await promptSafely(session, '/report ' + input.runId, signal)
        collector.assertHealthy()
        if (!collector.report)
          throw new ApiError('REPORT_OUTPUT_MISSING', '报告扩展没有返回产物', 502)
        return collector.report
      },
      timeoutMs
    )
  }
}
