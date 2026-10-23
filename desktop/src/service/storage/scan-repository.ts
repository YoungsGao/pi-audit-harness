import { ApiError } from '../../shared/api-error.ts'
import type { ScanRun, ScanSummary, ScanStatistics, Verdict } from '../../shared/scan-contracts'
import type { LocalDatabase, SqlSession } from './database.ts'

export interface ReviewResult {
  verdict: Verdict | 'invalid'
  summary: string
  steps: { stepIndex: number; dangerous: number | null; reason: string; quotes: string[] }[]
}
export class ScanRepository {
  private readonly db: LocalDatabase
  constructor(db: LocalDatabase) {
    this.db = db
  }
  begin(projectId: string, runId: string, sourceStamp: string, rulesVersion: string): void {
    const now = new Date().toISOString()
    this.db.transaction((tx) => {
      tx.run(
        "INSERT INTO audit_runs (id,project_id,status,source_stamp,rules_version,created_at,updated_at) VALUES (?,?,'queued',?,?,?,?)",
        runId,
        projectId,
        sourceStamp,
        rulesVersion,
        now,
        now
      )
      tx.run(
        "INSERT INTO scan_runs (run_id,project_id,state,started_at) VALUES (?,?,'scanning',?)",
        runId,
        projectId,
        now
      )
    })
  }
  finish(tx: SqlSession, runId: string, summary: ScanSummary): void {
    tx.run(
      'UPDATE scan_runs SET state=?,candidate_count=?,unresolved_calls=?,truncated=?,warnings_json=?,finished_at=? WHERE run_id=?',
      summary.state,
      summary.candidateCount,
      summary.unresolvedCalls,
      Number(summary.truncated),
      JSON.stringify(summary.warnings),
      new Date().toISOString(),
      runId
    )
  }
  fail(runId: string, code: string): void {
    this.db.transaction((tx) => {
      tx.run(
        "UPDATE scan_runs SET state='failed',error_code=?,finished_at=? WHERE run_id=?",
        code,
        new Date().toISOString(),
        runId
      )
      tx.run(
        "UPDATE audit_runs SET status='failed',updated_at=? WHERE id=?",
        new Date().toISOString(),
        runId
      )
    })
  }
  runs(projectId: string): { projectId: string; runs: ScanRun[] } {
    return {
      projectId,
      runs: this.db
        .all(
          `SELECT a.*,s.state,s.candidate_count,s.unresolved_calls,s.truncated,s.warnings_json,s.error_code
      FROM audit_runs a LEFT JOIN scan_runs s ON s.run_id=a.id WHERE a.project_id=? ORDER BY a.created_at DESC,a.id DESC LIMIT 50`,
          projectId
        )
        .map((row) => ({
          projectId,
          runId: String(row.id),
          sourceStamp: String(row.source_stamp),
          rulesVersion: String(row.rules_version),
          state: (row.state ?? 'partial') as ScanRun['state'],
          candidateCount: Number(row.candidate_count ?? 0),
          unresolvedCalls: Number(row.unresolved_calls ?? 0),
          truncated: row.truncated === 1,
          warnings: row.warnings_json
            ? JSON.parse(String(row.warnings_json))
            : [{ code: 'LEGACY_RUN', filePath: null, message: '旧任务没有预处理覆盖记录。' }],
          errorCode:
            row.error_code === null || row.error_code === undefined ? null : String(row.error_code),
          createdAt: String(row.created_at),
          analysisStatus: String(row.status),
          modelConfigId: row.model_config_id === null ? null : String(row.model_config_id)
        }))
    }
  }
  statistics(projectId: string, runId: string): ScanStatistics {
    if (!this.db.get('SELECT id FROM audit_runs WHERE id=? AND project_id=?', runId, projectId))
      throw new ApiError('CHAIN_NOT_FOUND', '调用链任务不存在', 404)
    const row = this.db.get(
      `SELECT count(*) AS paths,count(DISTINCT sink_edge_id) AS sinks,
      COALESCE(sum(verdict='dangerous'),0) AS dangerous,COALESCE(sum(verdict='safe'),0) AS safe,COALESCE(sum(verdict='unknown'),0) AS unknown,
      COALESCE(sum(status='pending'),0) AS pending,COALESCE(sum(status='analyzing'),0) AS analyzing,COALESCE(sum(status='completed'),0) AS completed,
      COALESCE(sum(status='failed'),0) AS failed,COALESCE(sum(status='unresolved'),0) AS unresolved,COALESCE(sum(status='invalid'),0) AS invalid
      FROM call_paths WHERE project_id=? AND run_id=?`,
      projectId,
      runId
    )!
    return {
      ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])),
      edges: Number(
        this.db.get(
          'SELECT count(*) AS n FROM call_edges WHERE project_id=? AND run_id=?',
          projectId,
          runId
        )?.n
      )
    } as ScanStatistics
  }
  claim(projectId: string, runId: string, pathId: string, modelId: string): number {
    return this.db.transaction((tx) => {
      const path = tx.get(
        'SELECT status FROM call_paths WHERE project_id=? AND run_id=? AND path_id=?',
        projectId,
        runId,
        pathId
      )
      if (!path) throw new ApiError('CHAIN_NOT_FOUND', '调用路径不存在', 404)
      if (!['pending', 'failed', 'unresolved'].includes(String(path.status)))
        throw new ApiError('ANALYSIS_CONFLICT', '路径已领取或已结束，请刷新状态', 409)
      if (!tx.get('SELECT id FROM model_configs WHERE id=?', modelId))
        throw new ApiError('MODEL_CONFIG_NOT_FOUND', '请选择已保存的模型配置', 404)
      const run = tx.get('SELECT model_config_id FROM audit_runs WHERE id=?', runId)!
      if (run.model_config_id && run.model_config_id !== modelId)
        throw new ApiError(
          'ANALYSIS_MODEL_CONFLICT',
          '任务已绑定其他模型，请新建任务或使用原模型',
          409
        )
      const attempt =
        Number(tx.get('SELECT attempt FROM path_attempts WHERE path_id=?', pathId)?.attempt ?? 0) +
        1
      const now = new Date().toISOString()
      tx.run(
        "INSERT INTO path_attempts (path_id,run_id,project_id,attempt,model_config_id,phase,started_at) VALUES (?,?,?,?,?,'analyzing',?) ON CONFLICT(path_id) DO UPDATE SET attempt=excluded.attempt,model_config_id=excluded.model_config_id,phase='analyzing',started_at=excluded.started_at,finished_at=NULL,error_code=NULL",
        pathId,
        runId,
        projectId,
        attempt,
        modelId,
        now
      )
      tx.run(
        "UPDATE call_paths SET status='analyzing',verdict='unknown',dangerous=NULL,result_summary='',updated_at=? WHERE path_id=?",
        now,
        pathId
      )
      tx.run(
        "UPDATE path_steps SET dangerous=NULL,taint_in_json='[]',taint_out_json='[]',evidence_json='[]',defense_summary='' WHERE path_id=?",
        pathId
      )
      tx.run(
        "UPDATE audit_runs SET status='running',model_config_id=?,updated_at=? WHERE id=?",
        modelId,
        now,
        runId
      )
      return attempt
    })
  }
  complete(
    pathId: string,
    attempt: number,
    result: ReviewResult,
    evidence: { filePath: string; startLine: number; endLine: number; text: string }[],
    uncertain: boolean
  ): void {
    this.db.transaction((tx) => {
      const current = tx.get(
        "SELECT run_id FROM path_attempts WHERE path_id=? AND attempt=? AND phase='analyzing'",
        pathId,
        attempt
      )
      if (!current) throw new ApiError('ANALYSIS_STALE', '旧分析尝试不能覆盖当前路径', 409)
      const verdict =
        result.verdict === 'invalid' || (uncertain && result.verdict === 'safe')
          ? 'unknown'
          : result.verdict
      const now = new Date().toISOString()
      tx.run(
        'UPDATE call_paths SET status=?,verdict=?,dangerous=?,result_summary=?,updated_at=? WHERE path_id=?',
        result.verdict === 'invalid'
          ? 'invalid'
          : verdict === 'unknown'
            ? 'unresolved'
            : 'completed',
        verdict,
        verdict === 'unknown' ? null : Number(verdict === 'dangerous'),
        result.summary + (uncertain ? '\n路径存在未覆盖部分，保留覆盖限制。' : ''),
        now,
        pathId
      )
      for (const step of result.steps)
        tx.run(
          'UPDATE path_steps SET dangerous=?,evidence_json=?,defense_summary=? WHERE path_id=? AND step_index=?',
          result.verdict === 'invalid' ? null : step.dangerous,
          JSON.stringify(
            step.quotes.map((quote) => ({
              filePath: evidence[step.stepIndex].filePath,
              startLine: evidence[step.stepIndex].startLine,
              endLine: evidence[step.stepIndex].endLine,
              quote
            }))
          ),
          step.dangerous === 0 ? step.reason : '',
          pathId,
          step.stepIndex
        )
      tx.run(
        "UPDATE path_attempts SET phase='completed',finished_at=? WHERE path_id=? AND attempt=?",
        now,
        pathId,
        attempt
      )
      this.refreshRun(tx, String(current.run_id))
    })
  }
  analysisFailed(pathId: string, attempt: number, code: string): void {
    this.db.transaction((tx) => {
      const current = tx.get(
        "SELECT run_id FROM path_attempts WHERE path_id=? AND attempt=? AND phase='analyzing'",
        pathId,
        attempt
      )
      if (!current) return
      tx.run(
        "UPDATE path_attempts SET phase='failed',error_code=?,finished_at=? WHERE path_id=? AND attempt=?",
        code,
        new Date().toISOString(),
        pathId,
        attempt
      )
      tx.run(
        "UPDATE call_paths SET status='failed',verdict='unknown',dangerous=NULL,result_summary=?,updated_at=? WHERE path_id=?",
        '分析未完成：' + code,
        new Date().toISOString(),
        pathId
      )
      this.refreshRun(tx, String(current.run_id))
    })
  }
  private refreshRun(tx: SqlSession, runId: string): void {
    const row = tx.get(
      "SELECT sum(status='analyzing') AS active,sum(status='pending') AS pending,sum(status='failed') AS failed FROM call_paths WHERE run_id=?",
      runId
    )!
    tx.run(
      'UPDATE audit_runs SET status=?,updated_at=? WHERE id=?',
      row.active ? 'running' : row.pending ? 'queued' : row.failed ? 'failed' : 'completed',
      new Date().toISOString(),
      runId
    )
  }
  recover(): void {
    this.db.transaction((tx) => {
      tx.run(
        "UPDATE audit_runs SET status='failed' WHERE id IN (SELECT run_id FROM scan_runs WHERE state='scanning')"
      )
      tx.run(
        "UPDATE scan_runs SET state='failed',error_code='SCAN_INTERRUPTED',finished_at=? WHERE state='scanning'",
        new Date().toISOString()
      )
      const attempts = tx.all("SELECT path_id,run_id FROM path_attempts WHERE phase='analyzing'")
      for (const row of attempts)
        tx.run(
          "UPDATE call_paths SET status='unresolved',verdict='unknown',dangerous=NULL,result_summary='上次分析随服务中断，请明确重试。',updated_at=? WHERE path_id=?",
          new Date().toISOString(),
          row.path_id
        )
      tx.run(
        "UPDATE path_attempts SET phase='failed',error_code='ANALYSIS_INTERRUPTED',finished_at=? WHERE phase='analyzing'",
        new Date().toISOString()
      )
      for (const row of attempts) this.refreshRun(tx, String(row.run_id))
    })
  }
}
