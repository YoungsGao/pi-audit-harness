import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { basename, isAbsolute } from 'node:path'
import { ApiError } from '../../shared/api-error.ts'
import type {
  CallEdgeInput,
  CandidateGraph,
  GraphSaved
} from '../../shared/call-chain-contracts.ts'
import type { LocalDatabase, Row } from './database.ts'
import { ScanRepository } from './scan-repository.ts'
import type { ScanSummary } from '../../shared/scan-contracts'

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
// 身份绑定真实调用位置，不随“猜测的被调用函数”改变；同一位置不能静默覆盖。
export function callEdgeUid(runId: string, edge: CallEdgeInput): string {
  return 'edge-' + hash([runId, edge.filePath, edge.callLine, edge.callColumn])
}
function text(value: unknown, max = 1000): value is string {
  return (
    typeof value === 'string' &&
    !!value.trim() &&
    value.length <= max &&
    !Array.from(value).some((c) => c.charCodeAt(0) < 32)
  )
}
function filePath(value: unknown): value is string {
  return (
    text(value) &&
    !isAbsolute(value) &&
    !value.includes('\\') &&
    !value.split('/').some((p) => !p || p === '.' || p === '..' || p.includes(':'))
  )
}
function invalid(message: string): never {
  throw new ApiError('CHAIN_INVALID_INPUT', message, 400)
}
function edgeFrom(row: Row): CallEdgeInput & { uid: string } {
  return {
    uid: String(row.uid),
    filePath: String(row.file_path),
    callerKey: String(row.caller_key),
    calleeKey: String(row.callee_key),
    functionName: String(row.function_name),
    calledFunctionName: String(row.called_function_name),
    calledFilePath:
      row.called_function_file_path === null ? null : String(row.called_function_file_path),
    callLine: Number(row.call_line),
    callColumn: Number(row.call_column),
    isSink: row.is_sink === 1,
    ruleId: row.rule_id === null ? null : String(row.rule_id),
    resolutionStatus: row.resolution_status as CallEdgeInput['resolutionStatus'],
    arguments: JSON.parse(String(row.arguments_json))
  }
}
function pathFrom(row: Row): Record<string, unknown> {
  return {
    pathId: row.path_id,
    runId: row.run_id,
    projectId: row.project_id,
    pathHash: row.path_hash,
    sourceRef: row.source_ref,
    sinkEdgeUid: row.sink_edge_id,
    ruleId: row.rule_id,
    status: row.status,
    verdict: row.verdict,
    dangerous: row.dangerous,
    truncated: row.truncated === 1,
    truncationReason: row.truncation_reason,
    summary: row.result_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class CallChainRepository {
  readonly scans: ScanRepository
  private readonly db: LocalDatabase
  constructor(db: LocalDatabase) {
    this.db = db
    this.scans = new ScanRepository(db)
  }

  saveGraph(input: CandidateGraph, summary?: ScanSummary): GraphSaved {
    if (
      !text(input.projectId, 80) ||
      !text(input.runId, 80) ||
      !text(input.sourceStamp, 200) ||
      !text(input.rulesVersion, 100) ||
      !Array.isArray(input.edges) ||
      !Array.isArray(input.paths) ||
      input.edges.length > 1000 ||
      input.paths.length > 100
    )
      invalid('任务标识或调用链批次无效')
    const byUid = new Map<string, CallEdgeInput>()
    for (const edge of input.edges) {
      if (
        !edge ||
        !filePath(edge.filePath) ||
        !text(edge.callerKey) ||
        !text(edge.calleeKey) ||
        !text(edge.functionName) ||
        !text(edge.calledFunctionName) ||
        (edge.calledFilePath !== null && !filePath(edge.calledFilePath)) ||
        !Number.isInteger(edge.callLine) ||
        edge.callLine < 1 ||
        !Number.isInteger(edge.callColumn) ||
        edge.callColumn < 1 ||
        typeof edge.isSink !== 'boolean' ||
        !['candidate', 'confirmed', 'unresolved', 'invalid'].includes(edge.resolutionStatus) ||
        (edge.ruleId !== null && !text(edge.ruleId, 100)) ||
        (edge.isSink && !edge.ruleId) ||
        !Array.isArray(edge.arguments) ||
        JSON.stringify(edge.arguments).length > 16000
      )
        invalid('调用边字段或参数范围无效')
      const uid = callEdgeUid(input.runId, edge)
      if (byUid.has(uid)) invalid('同一调用位置在本批次重复')
      byUid.set(uid, edge)
    }
    let rows = input.edges.length + input.paths.length + 1
    const paths = input.paths.map((path) => {
      if (
        !path ||
        !Array.isArray(path.edgeUids) ||
        !path.edgeUids.length ||
        path.edgeUids.length > 32 ||
        typeof path.truncated !== 'boolean' ||
        ![
          '',
          'recursion',
          'depth-limit',
          'node-limit',
          'path-limit',
          'unresolved-caller',
          'candidate-limit'
        ].includes(path.truncationReason) ||
        path.truncated !== !!path.truncationReason ||
        (path.sourceRef !== null && !text(path.sourceRef)) ||
        (path.ruleId !== null && !text(path.ruleId, 100))
      )
        invalid('路径字段或展开预算无效')
      rows += path.edgeUids.length
      const steps = path.edgeUids.map((uid) => {
        const edge = byUid.get(uid)
        if (!edge) invalid('路径引用了本批次以外的调用边')
        return edge
      })
      if (steps.some((edge, i) => i > 0 && steps[i - 1].calleeKey !== edge.callerKey))
        invalid('路径步骤不连通')
      const sink = byUid.get(path.sinkEdgeUid)
      if (!sink?.isSink || path.edgeUids.at(-1) !== path.sinkEdgeUid || path.ruleId !== sink.ruleId)
        invalid('路径必须以对应 Sink 结束')
      const pathHash = hash([
        path.sourceRef,
        path.ruleId,
        path.edgeUids,
        path.truncated,
        path.truncationReason
      ])
      return { ...path, pathHash, pathId: 'path-' + hash([input.runId, pathHash]) }
    })
    if (rows > 5000) invalid('单次事务超过 5000 行')
    const now = new Date().toISOString()
    return this.db.transaction((tx) => {
      const registered = tx.get(
        'SELECT source_stamp FROM source_imports WHERE project_id=?',
        input.projectId
      )
      if (registered && registered.source_stamp !== input.sourceStamp)
        throw new ApiError('CHAIN_RUN_CONFLICT', '任务源码指纹与已登记源码不一致', 409)
      const existing = tx.get('SELECT * FROM audit_runs WHERE id=?', input.runId)
      if (
        existing &&
        (existing.project_id !== input.projectId ||
          existing.source_stamp !== input.sourceStamp ||
          existing.rules_version !== input.rulesVersion)
      )
        throw new ApiError('CHAIN_RUN_CONFLICT', '任务绑定的项目、源码或规则版本不一致', 409)
      if (existing && existing.status !== 'queued')
        throw new ApiError('CHAIN_RUN_CLOSED', '不能向已开始分析的任务追加候选', 409)
      if (!existing)
        tx.run(
          "INSERT INTO audit_runs (id,project_id,status,source_stamp,rules_version,model_config_id,created_at,updated_at) VALUES (?,?,'queued',?,?,NULL,?,?)",
          input.runId,
          input.projectId,
          input.sourceStamp,
          input.rulesVersion,
          now,
          now
        )
      for (const [uid, edge] of byUid) {
        const old = tx.get('SELECT * FROM call_edges WHERE uid=?', uid)
        if (old) {
          if (
            old.run_id !== input.runId ||
            old.project_id !== input.projectId ||
            !isDeepStrictEqual(edgeFrom(old), { uid, ...edge })
          )
            throw new ApiError(
              'CHAIN_EDGE_CONFLICT',
              '同一调用位置的内容冲突，不能覆盖已有证据',
              409
            )
          continue
        }
        tx.run(
          `INSERT INTO call_edges (uid,run_id,project_id,file_path,caller_key,callee_key,call_line,is_sink,rule_id,
          file_name,function_name,called_function_name,called_function_file_name,called_function_file_path,call_column,resolution_status,arguments_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          uid,
          input.runId,
          input.projectId,
          edge.filePath,
          edge.callerKey,
          edge.calleeKey,
          edge.callLine,
          Number(edge.isSink),
          edge.ruleId,
          basename(edge.filePath),
          edge.functionName,
          edge.calledFunctionName,
          edge.calledFilePath === null ? null : basename(edge.calledFilePath),
          edge.calledFilePath,
          edge.callColumn,
          edge.resolutionStatus,
          JSON.stringify(edge.arguments)
        )
      }
      for (const path of paths) {
        if (
          tx.get(
            'SELECT path_id FROM call_paths WHERE run_id=? AND path_hash=?',
            input.runId,
            path.pathHash
          )
        )
          continue
        tx.run(
          `INSERT INTO call_paths (path_id,run_id,project_id,path_hash,sink_edge_id,verdict,dangerous,result_summary,created_at,source_ref,rule_id,status,truncated,truncation_reason,updated_at)
          VALUES (?,?,?,?,?,'unknown',NULL,'',?,?,?,'pending',?,?,?)`,
          path.pathId,
          input.runId,
          input.projectId,
          path.pathHash,
          path.sinkEdgeUid,
          now,
          path.sourceRef,
          path.ruleId,
          Number(path.truncated),
          path.truncationReason,
          now
        )
        path.edgeUids.forEach((uid, stepIndex) =>
          tx.run(
            'INSERT INTO path_steps (path_id,step_index,edge_uid,run_id,project_id) VALUES (?,?,?,?,?)',
            path.pathId,
            stepIndex,
            uid,
            input.runId,
            input.projectId
          )
        )
      }
      if (summary) this.scans.finish(tx, input.runId, summary)
      return {
        projectId: input.projectId,
        runId: input.runId,
        pathIds: [...new Set(paths.map((p) => p.pathId))]
      }
    })
  }

  list(input: {
    projectId: string
    runId: string
    limit?: number
    offset?: number
  }): Record<string, unknown> {
    const limit = input.limit ?? 50,
      offset = input.offset ?? 0
    if (
      !text(input.projectId, 80) ||
      !text(input.runId, 80) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 1000000
    )
      invalid('路径列表范围无效')
    const run = this.db.get(
      'SELECT id,project_id,source_stamp,rules_version,status FROM audit_runs WHERE id=? AND project_id=?',
      input.runId,
      input.projectId
    )
    if (!run) throw new ApiError('CHAIN_NOT_FOUND', '未找到对应项目的调用链任务', 404)
    return {
      projectId: input.projectId,
      runId: input.runId,
      sourceStamp: run.source_stamp,
      rulesVersion: run.rules_version,
      total: Number(
        this.db.get(
          'SELECT count(*) AS n FROM call_paths WHERE run_id=? AND project_id=?',
          input.runId,
          input.projectId
        )?.n
      ),
      paths: this.db
        .all(
          'SELECT * FROM call_paths WHERE run_id=? AND project_id=? ORDER BY created_at,path_id LIMIT ? OFFSET ?',
          input.runId,
          input.projectId,
          limit,
          offset
        )
        .map(pathFrom)
    }
  }

  detail(input: { projectId: string; runId: string; pathId: string }): Record<string, unknown> {
    if (![input.projectId, input.runId, input.pathId].every((id) => text(id, 100)))
      invalid('路径标识无效')
    const path = this.db.get(
      'SELECT * FROM call_paths WHERE project_id=? AND run_id=? AND path_id=?',
      input.projectId,
      input.runId,
      input.pathId
    )
    if (!path) throw new ApiError('CHAIN_NOT_FOUND', '未找到对应项目与任务的调用路径', 404)
    const steps = this.db.all(
      `SELECT e.*,s.step_index,s.dangerous AS step_dangerous,s.taint_in_json,s.taint_out_json,s.evidence_json,s.defense_summary
      FROM path_steps s JOIN call_edges e ON e.uid=s.edge_uid AND e.run_id=s.run_id AND e.project_id=s.project_id
      WHERE s.project_id=? AND s.run_id=? AND s.path_id=? ORDER BY s.step_index`,
      input.projectId,
      input.runId,
      input.pathId
    )
    return {
      ...pathFrom(path),
      steps: steps.map((step) => ({
        stepIndex: Number(step.step_index),
        edge: edgeFrom(step),
        dangerous: step.step_dangerous,
        taintIn: JSON.parse(String(step.taint_in_json)),
        taintOut: JSON.parse(String(step.taint_out_json)),
        evidence: JSON.parse(String(step.evidence_json)),
        defenseSummary: step.defense_summary
      }))
    }
  }
}
