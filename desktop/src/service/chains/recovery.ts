import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  copyFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { ApiError } from '../../shared/api-error.ts'
import type {
  ControlState,
  RecoveryMode,
  RecoveryReceipt,
  RunRecoveryView
} from '../../shared/run-contracts.ts'
import type { ModelConfig } from '../../shared/pi-contracts.ts'
import type { LocalDatabase, Row } from '../storage/database.ts'
import { SnapshotRepository } from '../storage/snapshot-repository.ts'
import { TemplateRepository } from '../storage/template-repository.ts'
import { builtinRules } from '../rules/builtin.ts'
import type { ReviewInput } from './path-analysis.ts'
import type { LoopLimits } from './agent-loop.ts'
import { loadPiSdk } from '../pi-sdk.ts'

export const recoveryProtocol = 'audit-recovery/1;tool/1;validator/1;pi/1.2.0'
export const digest = (v: unknown): string =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex')
type Scope = { projectId: string; runId: string }
type Evidence = ReviewInput['evidence'][number]
export interface LoopCheckpoint {
  version: 1
  readSteps: number[]
  fingerprints: string[]
  noProgress: number
  evidenceBytes: number
  next: string
  action: 'continue' | 'finish'
  result: unknown
}
interface CheckedCheckpoint {
  row: Row
  host: LoopCheckpoint
  file: string
}
const now = (): string => new Date().toISOString()
const same = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const stopped = (state: unknown): boolean =>
  ['stop_requested', 'waiting_external', 'stopped', 'interrupted'].includes(String(state))

// No model calls here. The database decides scope and committed work; the SDK owns message semantics.
export class RunRecoveryStore {
  readonly db: LocalDatabase
  readonly root: string
  constructor(db: LocalDatabase) {
    this.db = db
    this.root = join(dirname(dirname(db.filePath)), 'recovery')
  }
  control(scope: Scope): { state: ControlState; revision: number } {
    if (
      !this.db.get(
        'SELECT id FROM audit_runs WHERE id=? AND project_id=?',
        scope.runId,
        scope.projectId
      )
    )
      throw new ApiError('RUN_NOT_FOUND', '任务不属于当前项目', 404)
    const r = this.db.get(
      'SELECT * FROM run_controls WHERE run_id=? AND project_id=?',
      scope.runId,
      scope.projectId
    )
    return { state: r ? (r.state as ControlState) : 'idle', revision: Number(r?.revision ?? 0) }
  }
  setState(scope: Scope, state: ControlState): void {
    this.control(scope)
    this.db.run(
      'INSERT INTO run_controls(run_id,project_id,state,revision,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(run_id) DO UPDATE SET state=excluded.state,revision=run_controls.revision+1,updated_at=excluded.updated_at',
      scope.runId,
      scope.projectId,
      state,
      now()
    )
  }
  assertStart(scope: Scope): void {
    if (stopped(this.control(scope).state))
      throw new ApiError('RUN_RESUME_REQUIRED', '任务已停止或中断，请先核对恢复清单再继续', 409)
  }
  binding(scope: Scope, pathId: string, modelId: string): Record<string, unknown> {
    const run = this.db.get(
      'SELECT * FROM audit_runs WHERE id=? AND project_id=?',
      scope.runId,
      scope.projectId
    )
    const path = this.db.get(
      'SELECT path_hash,source_ref,rule_id,truncated,truncation_reason FROM call_paths WHERE path_id=? AND run_id=? AND project_id=?',
      pathId,
      scope.runId,
      scope.projectId
    )
    const model = this.db.get(
      'SELECT id,revision,base_url,model_id,api FROM model_configs WHERE id=?',
      modelId
    )
    if (!run || !path || !model)
      throw new ApiError('RUN_MATERIAL_MISSING', '恢复所需路径或模型配置缺失', 409)
    const frozenModel = this.db.get(
      'SELECT model_json FROM run_controls WHERE run_id=?',
      scope.runId
    )?.model_json
    if (
      frozenModel &&
      frozenModel !== 'null' &&
      digest(JSON.parse(String(frozenModel))) !== digest(model)
    )
      throw new ApiError(
        'RUN_BINDING_CHANGED',
        '模型配置与本任务首次执行时不一致，请创建新任务',
        409
      )
    if (run.rules_version !== builtinRules.version)
      throw new ApiError('RUN_RULES_CHANGED', '原任务规则版本不可用，请创建新任务', 409)
    const snapshot = new SnapshotRepository(this.db).info(scope.projectId, scope.runId)
    // Validate bytes, including files not read by the interrupted path. No current working-tree reads.
    for (const file of snapshot.files)
      new SnapshotRepository(this.db).read(scope.projectId, scope.runId, file.filePath)
    return {
      ...scope,
      pathId,
      path,
      edges: this.db.all(
        'SELECT s.step_index,e.* FROM path_steps s JOIN call_edges e ON e.uid=s.edge_uid WHERE s.path_id=? ORDER BY s.step_index',
        pathId
      ),
      snapshotId: snapshot.snapshotId,
      sourceStamp: snapshot.sourceStamp,
      manifestHash: digest(snapshot.files),
      reviewHash: new TemplateRepository(this.db).run(scope.projectId, scope.runId).contextHash,
      rulesHash: digest(builtinRules),
      model,
      protocol: recoveryProtocol
    }
  }
  begin(
    scope: Scope,
    pathId: string,
    modelId: string,
    attempt: number,
    resume: boolean
  ): RecoveryExecution {
    const binding = this.binding(scope, pathId, modelId),
      hash = digest(binding)
    const prior = this.db.get('SELECT * FROM path_recovery WHERE path_id=?', pathId)
    if (resume && (!prior || prior.state === 'completed' || prior.binding_hash !== hash))
      throw new ApiError('RUN_BINDING_CHANGED', '原快照、审查材料或模型配置与中断时不一致', 409)
    const epoch = Number(prior?.epoch ?? 0) + 1,
      journey = resume ? String(prior!.journey_id) : randomUUID()
    this.db.run(
      `INSERT INTO path_recovery(path_id,run_id,project_id,journey_id,epoch,attempt,binding_json,binding_hash,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'running',?) ON CONFLICT(path_id) DO UPDATE SET journey_id=excluded.journey_id,epoch=excluded.epoch,attempt=excluded.attempt,binding_json=excluded.binding_json,binding_hash=excluded.binding_hash,state='running',requests=?,tools=?,rounds=?,limits_json=?,receipt_json=?,pi_session_id=NULL,session_file=NULL,updated_at=excluded.updated_at`,
      pathId,
      scope.runId,
      scope.projectId,
      journey,
      epoch,
      attempt,
      JSON.stringify(binding),
      hash,
      now(),
      resume ? Number(prior!.requests) : 0,
      resume ? Number(prior!.tools) : 0,
      resume ? Number(prior!.rounds) : 0,
      resume ? String(prior!.limits_json) : 'null',
      resume ? String(prior!.receipt_json) : 'null'
    )
    this.setState(scope, 'running')
    this.db.run(
      "UPDATE run_controls SET model_json=? WHERE run_id=? AND model_json='null'",
      JSON.stringify(binding.model),
      scope.runId
    )
    return new RecoveryExecution(this, scope, pathId, journey, epoch, attempt, hash, resume)
  }
  requestStop(scope: Scope, active: boolean): void {
    const control = this.control(scope)
    if (['completed', 'stopped', 'stop_requested', 'waiting_external'].includes(control.state))
      return
    this.db.transaction((tx) => {
      this.setState(scope, active ? 'stop_requested' : 'stopped')
      tx.run(
        "UPDATE audit_runs SET status='cancelled',stage=?,error_code='RUN_USER_STOP',updated_at=?,finished_at=? WHERE id=?",
        'interrupted',
        now(),
        active ? null : now(),
        scope.runId
      )
    })
  }
  settle(scope: Scope): void {
    const state = this.control(scope).state
    if (['stop_requested', 'waiting_external'].includes(state)) {
      this.setState(scope, 'stopped')
      this.db.run(
        "UPDATE audit_runs SET status='cancelled',stage='interrupted',error_code='RUN_USER_STOP',finished_at=?,updated_at=? WHERE id=?",
        now(),
        now(),
        scope.runId
      )
    } else if (state === 'running') {
      const run = this.db.get('SELECT status FROM audit_runs WHERE id=?', scope.runId)!
      this.setState(scope, run.status === 'completed' ? 'completed' : 'idle')
    }
  }
  recover(): void {
    this.db.transaction((tx) => {
      for (const r of tx.all(
        "SELECT * FROM run_controls WHERE state IN ('running','stop_requested','waiting_external')"
      )) {
        const state = r.state === 'running' ? 'interrupted' : 'stopped'
        this.setState({ projectId: String(r.project_id), runId: String(r.run_id) }, state)
        tx.run(
          'UPDATE audit_runs SET status=?,stage=?,error_code=?,finished_at=?,updated_at=? WHERE id=?',
          state === 'stopped' ? 'cancelled' : 'failed',
          'interrupted',
          state === 'stopped' ? 'RUN_USER_STOP' : 'ANALYSIS_INTERRUPTED',
          now(),
          now(),
          r.run_id
        )
      }
      tx.run(
        "UPDATE path_recovery SET state='interrupted',updated_at=? WHERE state='running'",
        now()
      )
      tx.run(
        "UPDATE recovery_requests SET state='uncertain',finished_at=? WHERE state='started'",
        now()
      )
    })
  }
  row(pathId: string): Row {
    const r = this.db.get('SELECT * FROM path_recovery WHERE path_id=?', pathId)
    if (!r) throw new ApiError('RUN_RECOVERY_MISSING', '路径没有可恢复执行记录', 409)
    return r
  }
  directory(): string {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const stat = lstatSync(this.root)
    const expected = join(realpathSync(dirname(this.root)), 'recovery')
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(realpathSync(this.root), expected))
      throw new ApiError('RUN_UNSAFE_FILE', '恢复目录不是应用持有的普通目录', 409)
    return this.root
  }
  artifact(name: string): string {
    if (!/^[A-Za-z0-9_-]+\.jsonl$/.test(name))
      throw new ApiError('RUN_UNSAFE_FILE', '会话文件标识无效', 409)
    const file = join(this.directory(), name),
      stat = lstatSync(file)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !same(realpathSync(file), file) ||
      stat.size > 4 * 1024 * 1024
    )
      throw new ApiError('RUN_UNSAFE_FILE', '恢复产物类型或大小无效', 409)
    return file
  }
  evidence(path: Row, stepIndex: number): Evidence | null {
    const r = this.db.get(
      'SELECT * FROM recovery_tools WHERE journey_id=? AND step_index=? AND path_id=? AND binding_hash=?',
      path.journey_id,
      stepIndex,
      path.path_id,
      path.binding_hash
    )
    if (!r) return null
    const evidence = JSON.parse(String(r.evidence_json)) as Evidence
    if (digest(evidence) !== r.sha256)
      throw new ApiError('RUN_EVIDENCE_CORRUPT', '取证回执摘要不一致', 409)
    const edge = this.db.get(
      'SELECT e.file_path,e.called_function_file_path FROM path_steps s JOIN call_edges e ON e.uid=s.edge_uid WHERE s.path_id=? AND s.step_index=?',
      path.path_id,
      stepIndex
    )
    if (!edge) throw new ApiError('RUN_EVIDENCE_CORRUPT', '取证回执步骤越界', 409)
    const ranges = evidence.ranges ?? [evidence]
    if (!ranges.length || ranges.length > 2)
      throw new ApiError('RUN_EVIDENCE_CORRUPT', '取证范围无效', 409)
    for (const range of ranges) {
      if (
        ![edge.file_path, edge.called_function_file_path].includes(range.filePath) ||
        !Number.isInteger(range.startLine) ||
        !Number.isInteger(range.endLine) ||
        range.startLine < 1 ||
        range.endLine < range.startLine ||
        range.endLine - range.startLine >= 80
      )
        throw new ApiError('RUN_EVIDENCE_CORRUPT', '取证范围不属于路径', 409)
      const raw = new SnapshotRepository(this.db)
        .read(String(path.project_id), String(path.run_id), range.filePath)
        .split('\n')
        .slice(range.startLine - 1, range.endLine)
        .join('\n')
      const text = raw.replaceAll('\r\n', '\n')
      if (![raw, text, raw.slice(0, 12000), text.slice(0, 12000)].includes(range.text))
        throw new ApiError('RUN_EVIDENCE_CORRUPT', '取证回执与原快照不一致', 409)
    }
    if (
      evidence.ranges &&
      evidence.text !==
        ranges.map((r) => `${r.filePath}:${r.startLine}-${r.endLine}\n${r.text}`).join('\n')
    )
      throw new ApiError('RUN_EVIDENCE_CORRUPT', '取证组合文本不一致', 409)
    return evidence
  }
  checkpoint(path: Row): CheckedCheckpoint | null {
    for (const row of this.db.all(
      'SELECT * FROM recovery_checkpoints WHERE path_id=? AND journey_id=? AND binding_hash=? ORDER BY rowid DESC LIMIT 20',
      path.path_id,
      path.journey_id,
      path.binding_hash
    )) {
      try {
        const file = this.artifact(String(row.file_name)),
          bytes = readFileSync(file)
        if (
          bytes.length !== row.size ||
          createHash('sha256').update(bytes).digest('hex') !== row.sha256
        )
          continue
        const entries = bytes
          .toString('utf8')
          .trimEnd()
          .split('\n')
          .map((s) => JSON.parse(s))
        const header = entries.shift(),
          leaf = entries.at(-1)
        const host = JSON.parse(String(row.host_json)) as LoopCheckpoint
        if (
          header?.type !== 'session' ||
          header.id !== row.pi_session_id ||
          leaf?.id !== row.leaf_id ||
          leaf?.customType !== 'audit-checkpoint' ||
          leaf.data.bindingHash !== path.binding_hash ||
          digest(leaf.data.host) !== digest(host) ||
          host.version !== 1 ||
          !Array.isArray(host.readSteps) ||
          host.readSteps.length > 16 ||
          !['continue', 'finish'].includes(host.action) ||
          !Array.isArray(host.fingerprints) ||
          !Number.isInteger(host.noProgress) ||
          host.noProgress < 0 ||
          !Number.isInteger(host.evidenceBytes) ||
          host.evidenceBytes < 0 ||
          typeof host.next !== 'string' ||
          host.next.length > 2000
        )
          continue
        const seen = new Set<string>(),
          calls = new Map<string, number>()
        const attachedSteps = new Set<number>()
        for (const entry of entries) {
          if (
            typeof entry.id !== 'string' ||
            seen.has(entry.id) ||
            (entry.parentId !== null && !seen.has(entry.parentId))
          )
            throw Error('broken branch')
          seen.add(entry.id)
          if (entry.type === 'message' && entry.message.role === 'user') {
            const text =
              typeof entry.message.content === 'string'
                ? entry.message.content
                : entry.message.content.map((c: { text?: string }) => c.text ?? '').join('')
            let context: Record<string, unknown> | undefined
            try {
              context = JSON.parse(text.slice(text.indexOf('\n') + 1))
            } catch {
              /* Ordinary continuation prompts have no embedded initial context. */
            }
            if (
              context?.projectId === path.project_id &&
              context.runId === path.run_id &&
              context.pathId === path.path_id
            ) {
              const initial = context.recovery as
                { verifiedEvidence?: ({ stepIndex: number } & Evidence)[] } | undefined
              if (initial?.verifiedEvidence)
                for (const { stepIndex, ...evidence } of initial.verifiedEvidence) {
                  const stored = this.evidence(path, stepIndex)
                  if (!stored || digest(stored) !== digest(evidence))
                    throw Error('rebuilt evidence differs')
                  attachedSteps.add(stepIndex)
                }
            }
          }
          if (entry.type === 'message' && entry.message.role === 'assistant') {
            if (['aborted', 'error'].includes(entry.message.stopReason))
              throw Error('incomplete assistant')
            for (const item of entry.message.content)
              if (item.type === 'toolCall') {
                if (
                  item.name !== 'audit_read_step' ||
                  Object.keys(item.arguments).length !== 1 ||
                  !Number.isInteger(item.arguments.stepIndex)
                )
                  throw Error('unexpected tool')
                calls.set(item.id, item.arguments.stepIndex)
              }
          }
          if (entry.type === 'message' && entry.message.role === 'toolResult') {
            const index = calls.get(entry.message.toolCallId)
            if (
              index === undefined ||
              entry.message.isError ||
              entry.message.toolName !== 'audit_read_step'
            )
              throw Error('unmatched tool result')
            calls.delete(entry.message.toolCallId)
            const { stepIndex, ...payload } = JSON.parse(
              entry.message.content
                .map((c: { type: string; text?: string }) => (c.type === 'text' ? c.text : ''))
                .join('')
            )
            const evidence = this.evidence(path, index)
            if (stepIndex !== index || !evidence || digest(payload) !== digest(evidence))
              throw Error('tool payload differs from receipt')
            attachedSteps.add(index)
          }
        }
        if (
          calls.size ||
          new Set(host.readSteps).size !== host.readSteps.length ||
          host.readSteps.some((index) => !attachedSteps.has(index))
        )
          continue
        const evidence = host.readSteps.map((index) => this.evidence(path, index))
        if (
          evidence.some((e) => !e) ||
          digest([...new Set(evidence.map(digest))].sort()) !==
            digest([...host.fingerprints].sort()) ||
          [...new Map(evidence.map((e) => [digest(e), e])).values()].reduce(
            (n, e) => n + Buffer.byteLength(e!.text),
            0
          ) !== host.evidenceBytes
        )
          continue
        return { row, host, file }
      } catch {
        /* A damaged latest checkpoint can fall back to an older validated boundary. */
      }
    }
    return null
  }
  view(scope: Scope): RunRecoveryView {
    const control = this.control(scope)
    const paths = this.db.all(
      `SELECT p.path_id,p.status,r.state AS recovery_state,a.phase AS attempt_phase FROM call_paths p LEFT JOIN path_recovery r ON r.path_id=p.path_id LEFT JOIN path_attempts a ON a.path_id=p.path_id WHERE p.project_id=? AND p.run_id=? ORDER BY p.created_at,p.path_id`,
      scope.projectId,
      scope.runId
    )
    const candidates = paths.filter((p) => p.recovery_state && p.recovery_state !== 'completed')
    const candidate =
        candidates[0] ??
        (['stopped', 'interrupted', 'idle'].includes(control.state) &&
        this.db.get(
          "SELECT run_id FROM run_controls WHERE run_id=? AND model_json!='null'",
          scope.runId
        )
          ? paths.find((p) => p.status === 'pending')
          : undefined),
      active = candidates.find((p) => p.recovery_state === 'running')
    const path = candidate?.recovery_state ? this.row(String(candidate.path_id)) : null
    const reasons: string[] = [],
      readSteps: number[] = []
    let mode: RecoveryMode = 'none',
      checkpoint: CheckedCheckpoint | null = null
    if (path) {
      try {
        const binding = JSON.parse(String(path.binding_json))
        if (
          digest(this.binding(scope, String(path.path_id), String(binding.model.id))) !==
          path.binding_hash
        )
          throw new ApiError(
            'RUN_BINDING_CHANGED',
            '原快照、审查材料或模型配置发生变化，不能按原条件继续',
            409
          )
        const receipts = this.db.all(
          'SELECT step_index FROM recovery_tools WHERE journey_id=? ORDER BY step_index',
          path.journey_id
        )
        for (const r of receipts) {
          this.evidence(path, Number(r.step_index))
          readSteps.push(Number(r.step_index))
        }
        checkpoint = this.checkpoint(path)
        mode = checkpoint ? 'native' : readSteps.length ? 'rebuild' : 'restart'
        if (checkpoint) readSteps.splice(0, readSteps.length, ...checkpoint.host.readSteps)
        reasons.push(
          checkpoint
            ? '会话、取证回执与原任务材料已核对，可从安全轮次继续'
            : readSteps.length
              ? '没有可用的完整会话检查点；将用核验后的证据重建上下文'
              : '尚无安全检查点，将重跑当前未提交路径'
        )
        if (
          !checkpoint &&
          this.db.get(
            'SELECT checkpoint_id FROM recovery_checkpoints WHERE path_id=? AND journey_id=? LIMIT 1',
            path.path_id,
            path.journey_id
          )
        )
          reasons.push(
            '已有会话检查点未通过完整性或证据一致性校验；将明确回退，不直接加载损坏的会话'
          )
        const limits = JSON.parse(String(path.limits_json))
        if (
          limits &&
          (Number(path.requests) >= limits.maxRequests ||
            Number(path.rounds) >= limits.maxRounds ||
            Number(path.tools) >= limits.maxToolCalls) &&
          checkpoint?.host.action !== 'finish'
        )
          throw new ApiError(
            'RUN_BUDGET_EXHAUSTED',
            '此路径累计执行预算已耗尽；恢复不会重置预算，可显式重新审阅以开始新调查',
            409
          )
      } catch (error) {
        mode = 'blocked'
        reasons.push(error instanceof ApiError ? error.message : '恢复材料校验失败，请保留数据排查')
      }
      reasons.push('已发送但未确认完成的模型请求可能产生用量；继续可能需要重新请求')
    } else if (candidate) {
      const modelId = this.db.get(
        'SELECT model_config_id FROM audit_runs WHERE id=?',
        scope.runId
      )?.model_config_id
      if (modelId) {
        try {
          this.binding(scope, String(candidate.path_id), String(modelId))
          mode = 'restart'
          reasons.push('从已提交路径边界继续；已提交结果不重复调查，下一条尚未开始的路径正常执行')
        } catch (error) {
          mode = 'blocked'
          reasons.push(error instanceof ApiError ? error.message : '原任务材料不可用')
        }
      } else {
        mode = 'blocked'
        reasons.push('任务尚未绑定原分析模型，请先按正常流程配置并开始分析')
      }
    }
    const steps = candidate
      ? this.db
          .all(
            'SELECT step_index FROM path_steps WHERE path_id=? ORDER BY step_index',
            candidate.path_id
          )
          .map((r) => Number(r.step_index))
      : []
    const uncertainRequests = path
      ? Number(
          this.db.get(
            "SELECT count(*) AS n FROM recovery_requests WHERE journey_id=? AND state IN ('started','uncertain')",
            path.journey_id
          )!.n
        )
      : 0
    const receipt = path ? (JSON.parse(String(path.receipt_json)) as RecoveryReceipt | null) : null
    const lastRow = this.db.get(
      "SELECT * FROM path_recovery WHERE run_id=? AND receipt_json!='null' ORDER BY updated_at DESC LIMIT 1",
      scope.runId
    )
    const view = {
      ...scope,
      revision: control.revision,
      state: control.state,
      activePathId: active ? String(active.path_id) : null,
      candidatePathId: candidate ? String(candidate.path_id) : null,
      modelConfigId: path
        ? String(JSON.parse(String(path.binding_json)).model.id)
        : candidate
          ? ((this.db.get('SELECT model_config_id FROM audit_runs WHERE id=?', scope.runId)
              ?.model_config_id as string | null) ?? null)
          : null,
      committedPaths: paths.filter(
        (p) =>
          p.recovery_state === 'completed' ||
          (!p.recovery_state &&
            (p.attempt_phase === 'completed' ||
              ['completed', 'invalid'].includes(String(p.status))))
      ).length,
      pendingPaths: paths.filter((p) => p.status === 'pending').length,
      interruptedPaths: candidates.length,
      mode,
      checkpointId: checkpoint ? String(checkpoint.row.checkpoint_id) : null,
      readSteps,
      remainingSteps: steps.filter((i) => !readSteps.includes(i)),
      requestsUsed: Number(path?.requests ?? 0),
      toolsUsed: Number(path?.tools ?? 0),
      roundsUsed: Number(path?.rounds ?? 0),
      uncertainRequests,
      canResume:
        !!candidate &&
        !['blocked', 'none'].includes(mode) &&
        !['running', 'stop_requested', 'waiting_external'].includes(control.state),
      reasons,
      lastRecovery:
        receipt ??
        (lastRow ? (JSON.parse(String(lastRow.receipt_json)) as RecoveryReceipt | null) : null)
    }
    return { ...view, recoveryKey: digest(view) }
  }
}

export class RecoveryExecution {
  readonly store: RunRecoveryStore
  readonly scope: Scope
  readonly pathId: string
  readonly journeyId: string
  readonly epoch: number
  readonly attempt: number
  readonly bindingHash: string
  readonly resuming: boolean
  private requestId: string | null = null
  constructor(
    store: RunRecoveryStore,
    scope: Scope,
    pathId: string,
    journeyId: string,
    epoch: number,
    attempt: number,
    bindingHash: string,
    resuming: boolean
  ) {
    this.store = store
    this.scope = scope
    this.pathId = pathId
    this.journeyId = journeyId
    this.epoch = epoch
    this.attempt = attempt
    this.bindingHash = bindingHash
    this.resuming = resuming
  }
  assertLive(): Row {
    const row = this.store.row(this.pathId)
    if (
      row.epoch !== this.epoch ||
      row.attempt !== this.attempt ||
      row.state !== 'running' ||
      stopped(this.store.control(this.scope).state)
    )
      throw new ApiError('RUN_USER_STOP', '执行已停止或被新的恢复替代', 409)
    return row
  }
  configure(model: Readonly<ModelConfig>, limits: LoopLimits): void {
    const row = this.assertLive(),
      binding = JSON.parse(String(row.binding_json)),
      frozen = binding.model
    if (
      frozen.id !== model.id ||
      frozen.revision !== model.revision ||
      frozen.base_url !== model.baseUrl ||
      frozen.model_id !== model.modelId ||
      frozen.api !== model.api
    )
      throw new ApiError('RUN_BINDING_CHANGED', '实际模型超出原任务恢复配置', 409)
    if (
      row.limits_json !== 'null' &&
      digest(JSON.parse(String(row.limits_json))) !== digest(limits)
    )
      throw new ApiError('RUN_BUDGET_CHANGED', '原执行预算配置已变化，不能静默继续', 409)
    this.store.db.run(
      'UPDATE path_recovery SET limits_json=? WHERE path_id=? AND epoch=?',
      JSON.stringify(limits),
      this.pathId,
      this.epoch
    )
  }
  counts(): { requests: number; tools: number; rounds: number } {
    const r = this.assertLive()
    return { requests: Number(r.requests), tools: Number(r.tools), rounds: Number(r.rounds) }
  }
  spend(kind: 'requests' | 'tools' | 'rounds', max: number): void {
    const r = this.assertLive()
    if (Number(r[kind]) >= max)
      throw new ApiError(
        kind === 'requests'
          ? 'AGENT_REQUEST_LIMIT'
          : kind === 'tools'
            ? 'AGENT_TOOL_LIMIT'
            : 'AGENT_ROUND_LIMIT',
        '累计执行预算达到上限',
        409
      )
    this.store.db.run(
      `UPDATE path_recovery SET ${kind}=${kind}+1,updated_at=? WHERE path_id=? AND epoch=?`,
      now(),
      this.pathId,
      this.epoch
    )
  }
  request(max: number): void {
    this.spend('requests', max)
    this.requestId = randomUUID()
    this.store.db.run(
      "INSERT INTO recovery_requests VALUES(?,?,?,?,?,?,'started',NULL,?,NULL)",
      this.requestId,
      this.journeyId,
      this.pathId,
      this.scope.runId,
      this.scope.projectId,
      this.epoch,
      now()
    )
  }
  received(usage: unknown): void {
    this.assertLive()
    if (this.requestId)
      this.store.db.run(
        "UPDATE recovery_requests SET state='received',usage_json=?,finished_at=? WHERE request_id=? AND epoch=?",
        JSON.stringify(usage ?? null),
        now(),
        this.requestId,
        this.epoch
      )
    this.requestId = null
  }
  async read(index: number, work: () => Promise<Evidence>): Promise<Evidence> {
    const row = this.assertLive(),
      cached = this.store.evidence(row, index)
    if (cached) return cached
    const evidence = await work()
    this.assertLive()
    this.store.db.run(
      'INSERT INTO recovery_tools VALUES(?,?,?,?,?,?,?,?,?,?)',
      this.journeyId,
      index,
      this.pathId,
      this.scope.runId,
      this.scope.projectId,
      this.bindingHash,
      JSON.stringify(evidence),
      digest(evidence),
      this.epoch,
      now()
    )
    return evidence
  }
  async open(): Promise<{
    manager: SessionManager
    host: LoopCheckpoint | null
    reused: Map<number, Evidence>
    receipt: RecoveryReceipt | null
  }> {
    const sdk = await loadPiSdk(),
      row = this.assertLive(),
      checkpoint = this.resuming ? this.store.checkpoint(row) : null
    const reused = new Map<number, Evidence>()
    if (this.resuming)
      for (const r of this.store.db.all(
        'SELECT step_index FROM recovery_tools WHERE journey_id=? ORDER BY step_index',
        this.journeyId
      )) {
        const index = Number(r.step_index),
          evidence = this.store.evidence(row, index)
        if (evidence) reused.set(index, evidence)
      }
    const filename = `active-${this.journeyId}-${this.epoch}.jsonl`,
      file = join(this.store.directory(), filename)
    // Open an owned copy: the immutable checkpoint must never receive SDK appends.
    let manager: SessionManager
    if (checkpoint) {
      copyFileSync(checkpoint.file, file, 1)
      manager = sdk.SessionManager.open(file, this.store.root)
    } else manager = sdk.SessionManager.inMemory(this.store.root)
    this.assertLive()
    const receipt: RecoveryReceipt | null = this.resuming
      ? {
          mode: checkpoint ? 'native' : reused.size ? 'rebuild' : 'restart',
          checkpointId: checkpoint ? String(checkpoint.row.checkpoint_id) : null,
          reusedSteps: [...(checkpoint ? checkpoint.host.readSteps : reused.keys())],
          reason: checkpoint
            ? '会话与宿主状态在同一安全轮次恢复'
            : '使用原快照核验的证据重建；未完成模型工作可能重做',
          createdAt: now()
        }
      : (JSON.parse(String(row.receipt_json)) as RecoveryReceipt | null)
    this.store.db.run(
      'UPDATE path_recovery SET pi_session_id=?,session_file=?,receipt_json=?,updated_at=? WHERE path_id=? AND epoch=?',
      manager.getSessionId(),
      checkpoint ? filename : null,
      JSON.stringify(receipt),
      now(),
      this.pathId,
      this.epoch
    )
    return { manager, host: checkpoint?.host ?? null, reused, receipt }
  }
  save(manager: SessionManager, host: LoopCheckpoint, secret: string): void {
    this.assertLive()
    manager.appendCustomEntry('audit-checkpoint', { bindingHash: this.bindingHash, host })
    const id = randomUUID(),
      filename = id + '.jsonl',
      file = join(this.store.directory(), filename),
      temp = file + '.tmp'
    let text =
      [manager.getHeader(), ...manager.getBranch()].map((e) => JSON.stringify(e)).join('\n') + '\n'
    if (secret) text = text.replaceAll(secret, '[REDACTED]')
    if (Buffer.byteLength(text) > 4 * 1024 * 1024)
      throw new ApiError('RUN_CONTEXT_LIMIT', '安全会话超过4MiB，停止并保留已有检查点', 413)
    writeFileSync(temp, text, { flag: 'wx', mode: 0o600 })
    const fd = openSync(temp, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
    this.assertLive()
    this.store.db.run(
      'INSERT INTO recovery_checkpoints VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      this.pathId,
      this.scope.runId,
      this.scope.projectId,
      this.journeyId,
      this.epoch,
      this.attempt,
      this.bindingHash,
      manager.getSessionId(),
      manager.getLeafId()!,
      filename,
      createHash('sha256').update(text).digest('hex'),
      Buffer.byteLength(text),
      JSON.stringify(host),
      now()
    )
  }
}
