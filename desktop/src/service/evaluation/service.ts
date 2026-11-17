import { randomUUID, createHash } from 'node:crypto'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  renameSync
} from 'node:fs'
import { join } from 'node:path'
import type { ModelPorts, ModelConfig } from '../../shared/pi-contracts.ts'
import type {
  EvaluationAction,
  EvaluationJob,
  EvaluationRow,
  EvaluationGroup
} from '../../shared/evaluation.ts'
import { ApiError } from '../../shared/api-error.ts'
import { evaluationCases, evaluationCorpusVersion } from './corpus.ts'
import { engineeringModel } from './engineering-model.ts'
import { resolveModelConfig } from '../model-config-resolver.ts'
import { openStorage } from '../storage/schema.ts'
import { SourceRepository } from '../sources/repository.ts'
import { importLocal } from '../sources/local.ts'
import { CodeQueryService } from '../query/service.ts'
import { CallChainRepository } from '../storage/call-chain-repository.ts'
import { CallChainService } from '../chains/service.ts'
import { PathAnalysisService } from '../chains/path-analysis.ts'
import type { ReviewInput } from '../chains/path-analysis.ts'
import { runAgentLoop, defaultLoopLimits } from '../chains/agent-loop.ts'
import { PiRuntime } from '../pi-runtime.ts'
import { builtinRules } from '../rules/builtin.ts'
import { selectedMcpServers } from '../mcp/settings.ts'
import type { EventInput } from '../../shared/agent-contracts.ts'
import { redactText } from '../../shared/redaction.ts'
import type { PathDetail } from '../../shared/scan-contracts.ts'
import { AUDIT_PROMPT_VERSION } from '../chains/policy.ts'
import { STATIC_RULES_DIGEST } from '../mcp/static-scanner.ts'

const groups: EvaluationGroup[] = ['steps', 'codegraph', 'full']
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
export class EvaluationService {
  private starting = false
  private closing = false
  private active?: { job: EvaluationJob; abort: AbortController; task: Promise<void> }
  private readonly folder: string
  private readonly dataRoot: string
  private readonly ports: ModelPorts
  constructor(dataRoot: string, ports: ModelPorts) {
    this.dataRoot = dataRoot
    this.ports = ports
    this.folder = join(dataRoot, 'evaluations')
    mkdirSync(this.folder, { recursive: true })
    for (const id of readdirSync(this.folder)) {
      if (!/^[a-f0-9-]{36}$/.test(id) || !existsSync(join(this.folder, id, 'result.json'))) continue
      const job = this.load(id)
      if (job.state === 'running') {
        job.state = 'interrupted'
        job.errorCode = 'EVAL_INTERRUPTED'
        job.finishedAt = new Date().toISOString()
        job.uncertainUsage += job.reserved
        job.reserved = 0
        this.save(job)
      }
    }
  }
  private save(job: EvaluationJob): void {
    const file = join(this.folder, job.id, 'result.json')
    mkdirSync(join(this.folder, job.id), { recursive: true })
    writeFileSync(file + '.tmp', JSON.stringify(job, null, 2), 'utf8')
    renameSync(file + '.tmp', file)
  }
  private load(id: string): EvaluationJob {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new ApiError('EVAL_INVALID_INPUT', '评测编号无效', 400)
    const file = join(this.folder, id, 'result.json')
    if (!existsSync(file)) throw new ApiError('EVAL_NOT_FOUND', '评测不存在', 404)
    return JSON.parse(readFileSync(file, 'utf8'))
  }
  async action(action: EvaluationAction, value: unknown): Promise<unknown> {
    const v = value as Record<string, unknown>
    if (!v || typeof v !== 'object' || Array.isArray(v))
      throw new ApiError('EVAL_INVALID_INPUT', '评测参数须为对象', 400)
    if (action === 'catalog')
      return {
        cases: evaluationCases.map(({ id, title, category, expected }) => ({
          id,
          title,
          category,
          expected
        })),
        corpusVersion: evaluationCorpusVersion
      }
    if (action === 'list')
      return {
        jobs: readdirSync(this.folder)
          .filter(
            (id) => /^[a-f0-9-]{36}$/.test(id) && existsSync(join(this.folder, id, 'result.json'))
          )
          .map((id) => this.load(id))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 20)
          .map((job) => ({ ...job, rows: [] }))
      }
    if (action === 'detail') return this.load(String(v.id))
    if (action === 'stop') {
      const active = this.active
      if (active && active.job.id === v.id) {
        active.abort.abort(new ApiError('EVAL_USER_STOP', '用户停止评测', 409))
        await active.task
      }
      return this.load(String(v.id))
    }
    if (action !== 'start') throw new ApiError('EVAL_INVALID_ACTION', '不支持的评测操作', 404)
    if (this.active || this.starting) throw new ApiError('EVAL_BUSY', '已有对照评测正在运行', 409)
    if (this.closing) throw new ApiError('EVAL_CLOSED', '评测中心正在关闭', 503)
    if (
      !['engineering', 'live'].includes(String(v.mode)) ||
      !Array.isArray(v.caseIds) ||
      !v.caseIds.length ||
      v.caseIds.length > 9 ||
      new Set(v.caseIds).size !== v.caseIds.length ||
      v.caseIds.some((id) => !evaluationCases.some((c) => c.id === id)) ||
      !Number.isInteger(v.trials) ||
      Number(v.trials) < 1 ||
      Number(v.trials) > 3
    )
      throw new ApiError('EVAL_INVALID_INPUT', '选择1—9个场景，每组重复1—3次', 400)
    const live = v.mode === 'live'
    if (
      live &&
      (v.allowPaid !== true ||
        !Number.isInteger(v.tokenBudget) ||
        Number(v.tokenBudget) < 1000 ||
        Number(v.tokenBudget) > 500000)
    )
      throw new ApiError(
        'EVAL_CONSENT_REQUIRED',
        '真实模型需确认发送固定样例及1000—500000 Tokens预算',
        400
      )
    this.starting = true
    try {
      const selected = live
        ? await resolveModelConfig(
            String(v.modelConfigId),
            this.ports,
            new AbortController().signal
          )
        : null
      if (this.closing) throw new ApiError('EVAL_CLOSED', '评测中心正在关闭', 503)
      if (selected && selected.config.revision !== v.modelRevision)
        throw new ApiError('EVAL_MODEL_CHANGED', '模型配置已变化，请刷新后确认', 409)
      const job: EvaluationJob = {
        id: randomUUID(),
        mode: live ? 'live' : 'engineering',
        state: 'running',
        createdAt: new Date().toISOString(),
        finishedAt: null,
        corpusVersion: evaluationCorpusVersion,
        rulesVersion: builtinRules.version,
        promptVersion: AUDIT_PROMPT_VERSION,
        staticRulesDigest: STATIC_RULES_DIGEST,
        limits: { ...defaultLoopLimits },
        model: selected
          ? {
              id: selected.config.id,
              modelId: selected.config.modelId,
              revision: selected.config.revision,
              baseUrl: selected.config.baseUrl
            }
          : null,
        caseIds: v.caseIds as string[],
        trials: Number(v.trials),
        tokenBudget: live ? Number(v.tokenBudget) : 0,
        reportedUsage: 0,
        uncertainUsage: 0,
        reserved: 0,
        current: '',
        errorCode: null,
        rows: []
      }
      this.save(job)
      const abort = new AbortController()
      const task = this.execute(job, abort.signal, selected?.config).finally(() => {
        this.active = undefined
      })
      this.active = { job, abort, task }
      return structuredClone(job)
    } finally {
      this.starting = false
    }
  }
  private async execute(
    job: EvaluationJob,
    signal: AbortSignal,
    model?: Readonly<ModelConfig>
  ): Promise<void> {
    let oracle: Awaited<ReturnType<typeof engineeringModel>> | undefined
    try {
      if (job.mode === 'engineering') oracle = await engineeringModel()
      for (let trial = 1; trial <= job.trials; trial++)
        for (const caseId of job.caseIds)
          for (const group of groups) {
            if (signal.aborted) throw new ApiError('EVAL_USER_STOP', '用户停止评测', 409)
            job.current = `${caseId} / ${group} / ${trial}`
            this.save(job)
            const config = model ?? {
              id: 'engineering',
              name: '本地工程替身',
              modelId: 'engineering-fixture',
              revision: 1,
              baseUrl: oracle!.baseUrl,
              api: 'openai-completions',
              secretRef: 'engineering-only'
            }
            const ports = oracle
              ? { getConfig: async () => config, readSecret: async () => 'engineering-local-only' }
              : this.ports
            if (!oracle) {
              const current = await resolveModelConfig(config.id, ports, signal)
              if (
                current.config.revision !== config.revision ||
                current.config.baseUrl !== config.baseUrl ||
                current.config.modelId !== config.modelId
              )
                throw new ApiError('EVAL_MODEL_CHANGED', '模型配置已变化，停止评测', 409)
            }
            job.rows.push(await this.runRow(job, caseId, group, trial, config, ports, signal))
            this.save(job)
            if (job.errorCode === 'EVAL_TOKEN_BUDGET')
              throw new ApiError('EVAL_TOKEN_BUDGET', '评测预算不足以发送下一请求', 409)
          }
      job.state = signal.aborted ? 'stopped' : 'completed'
      if (signal.aborted) job.errorCode = 'EVAL_USER_STOP'
    } catch (error) {
      job.errorCode = error instanceof ApiError ? error.code : 'EVAL_FAILED'
      job.state = signal.aborted || job.errorCode === 'EVAL_TOKEN_BUDGET' ? 'stopped' : 'failed'
    } finally {
      if (job.reserved) {
        job.uncertainUsage += job.reserved
        job.reserved = 0
      }
      await oracle?.close()
      job.current = ''
      job.finishedAt = new Date().toISOString()
      this.save(job)
    }
  }
  private async runRow(
    job: EvaluationJob,
    caseId: string,
    group: EvaluationGroup,
    trial: number,
    config: Readonly<ModelConfig>,
    ports: ModelPorts,
    signal: AbortSignal
  ): Promise<EvaluationRow> {
    const item = evaluationCases.find((c) => c.id === caseId)!,
      started = performance.now()
    const row: EvaluationRow = {
      caseId,
      group,
      trial,
      sourceDigest: createHash('sha256').update(JSON.stringify(item.files)).digest('hex'),
      expected: item.expected,
      verdict: null,
      status: 'failed',
      durationMs: 0,
      requests: 0,
      tools: 0,
      repairs: 0,
      reportedUsage: 0,
      uncertainUsage: 0,
      evidenceValid: false,
      errorCode: null,
      scanStatus: null,
      gaps: [],
      trace: []
    }
    // Keep disposable graph/WAL paths below Windows MAX_PATH; identities stay in result.json.
    const root = join(
        this.folder,
        job.id,
        `r${evaluationCases.indexOf(item)}-${group[0]}-${trial}`
      ),
      dataRoot = join(root, 'runtime'),
      source = join(root, 'source')
    mkdirSync(source, { recursive: true })
    for (const [name, text] of Object.entries(item.files))
      writeFileSync(join(source, name), text, 'utf8')
    const scanner = selectedMcpServers(this.dataRoot).static?.semgrepPath ?? ''
    mkdirSync(join(dataRoot, 'mcp'), { recursive: true })
    writeFileSync(
      join(dataRoot, 'mcp', 'servers.json'),
      JSON.stringify({
        version: 1,
        servers: [
          {
            id: 'codegraph',
            name: 'CodeGraph',
            kind: 'codegraph',
            transport: 'builtin',
            enabled: group !== 'steps',
            tools: null,
            revision: 1,
            command: '',
            args: [],
            url: '',
            semgrepPath: ''
          },
          {
            id: 'static',
            name: 'Static',
            kind: 'static',
            transport: 'builtin',
            enabled: group === 'full',
            tools: null,
            semgrepPath: scanner,
            revision: 1,
            command: '',
            args: [],
            url: ''
          }
        ]
      })
    )
    const db = openStorage(dataRoot),
      sources = new SourceRepository(db),
      query = new CodeQueryService(sources, { dataRoot }),
      repo = new CallChainRepository(db),
      chains = new CallChainService(repo, query),
      runtime = new PiRuntime(join(root, 'pi'))
    const settleUnknown = (): void => {
      if (job.reserved) {
        row.uncertainUsage += job.reserved
        job.uncertainUsage += job.reserved
        job.reserved = 0
        this.save(job)
      }
    }
    try {
      db.run(
        'INSERT INTO model_configs(id,name,base_url,model_id,secret_ref,revision,api) VALUES(?,?,?,?,?,?,?)',
        config.id,
        config.name,
        config.baseUrl,
        config.modelId,
        config.secretRef,
        config.revision,
        config.api
      )
      const project = await importLocal(sources, { projectName: '固定对照样例', path: source })
      const prepared = (await chains.action('prepare', { projectId: project.projectId })) as {
        runId: string
        pathIds: string[]
      }
      if (!prepared.pathIds.length) {
        row.status = 'no-candidate'
        return row
      }
      const scope = {
        projectId: project.projectId,
        runId: prepared.runId,
        modelConfigId: config.id
      }
      const disclosure = (await chains.action('disclosure', scope)) as { scopeKey: string }
      await chains.action('authorize', { ...scope, scopeKey: disclosure.scopeKey })
      chains.analysis = new PathAnalysisService(
        repo,
        query,
        (input, localSignal) => {
          const review: ReviewInput = {
            ...input,
            authorizeModel: (selected) => {
              if (
                selected.id !== config.id ||
                selected.revision !== config.revision ||
                selected.baseUrl !== config.baseUrl ||
                selected.modelId !== config.modelId
              )
                throw new ApiError('EVAL_MODEL_CHANGED', '超出已确认评测模型', 409)
              return input.authorizeModel!(selected)
            },
            beforeModelRequest: ({ inputBytes, maxOutputTokens }) => {
              settleUnknown()
              if (job.mode === 'live') {
                const reserve = inputBytes + maxOutputTokens + 8192
                if (job.reportedUsage + job.uncertainUsage + reserve > job.tokenBudget) {
                  job.errorCode = 'EVAL_TOKEN_BUDGET'
                  this.save(job)
                  throw new ApiError('EVAL_TOKEN_BUDGET', '预算不足，未发送请求', 409)
                }
                job.reserved = reserve
                this.save(job)
              }
              row.requests++
            },
            recordEvent: (event: EventInput) => {
              const p = event.payload as Record<string, unknown> | undefined
              if (event.type === 'tool' && event.status === 'started') row.tools++
              if (event.status === 'validation_retry') row.repairs++
              if (event.status === 'model_usage' && job.mode === 'live') {
                const meter = p?.meter as { total?: number }
                if (typeof meter.total === 'number' && meter.total > 0) {
                  row.reportedUsage += meter.total
                  job.reportedUsage += meter.total
                  job.reserved = 0
                  this.save(job)
                } else settleUnknown()
              }
              if (event.toolName === 'audit_static_scan' && event.status === 'completed')
                row.scanStatus = String((p?.output as Record<string, unknown>)?.status)
              if (event.type === 'tool' && event.status === 'completed') {
                const output = p?.output as { gaps?: string[] } | undefined
                if (Array.isArray(output?.gaps))
                  row.gaps.push(...output.gaps.filter((g) => !row.gaps.includes(g)))
              }
              if (row.trace.length < 100 && event.status !== 'investigation_state')
                row.trace.push({
                  status: event.status,
                  tool: event.toolName ?? null,
                  summary: event.summary ? redactText(event.summary).slice(0, 500) : null
                })
              input.recordEvent?.(event)
            }
          }
          return runAgentLoop(
            runtime,
            ports,
            review,
            AbortSignal.any([signal, localSignal]),
            defaultLoopLimits
          ).finally(() => {
            // Keep new MCP receipts visible to the production commit-time validation too.
            input.mcpReceipts = review.mcpReceipts
          })
        },
        true
      )
      const pathId = prepared.pathIds[0]
      row.pathCount = prepared.pathIds.length
      row.pathHash = String(repo.detail({ ...scope, pathId }).pathHash)
      if (row.pathCount > 1) row.gaps.push('MULTIPLE_CANDIDATES_FIRST_PATH_ONLY')
      await chains.action('analyze', { ...scope, pathId })
      while (repo.scans.statistics(scope.projectId, scope.runId).analyzing) await sleep(20)
      const result = repo.detail({ ...scope, pathId }) as unknown as PathDetail
      row.status = ['completed', 'unresolved'].includes(result.status) ? 'completed' : 'failed'
      row.verdict = row.status === 'completed' ? result.verdict : null
      row.evidenceValid = row.status === 'completed'
      row.gaps.push(
        ...[
          result.truncationReason,
          ...result.steps
            .filter((s) => s.edge.resolutionStatus === 'unresolved')
            .map(() => 'UNRESOLVED_CALL')
        ].filter(Boolean)
      )
      if (row.status === 'failed') {
        const last = db.get(
          "SELECT body_json FROM audit_events WHERE chain_id=? AND type='result' ORDER BY seq DESC LIMIT 1",
          pathId
        )
        const body = last ? JSON.parse(String(last.body_json)) : {}
        row.errorCode = job.errorCode ?? body.details?.payload?.errorCode ?? 'EVAL_ANALYSIS_FAILED'
        row.trace.push({ status: 'failed', tool: null, summary: row.errorCode })
      }
    } catch (error) {
      row.errorCode = error instanceof ApiError ? error.code : 'EVAL_ROW_FAILED'
    } finally {
      settleUnknown()
      await chains.close()
      await runtime.close()
      await query.close()
      db.close()
      row.durationMs = Math.round(performance.now() - started)
    }
    return row
  }
  async close(): Promise<void> {
    this.closing = true
    if (this.active) {
      this.active.abort.abort()
      await this.active.task
    }
  }
}
