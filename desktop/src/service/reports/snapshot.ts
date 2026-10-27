import type { LocalDatabase } from '../storage/database.ts'
import { CallChainRepository } from '../storage/call-chain-repository.ts'
import { ApiError } from '../../shared/api-error.ts'
import type { PathDetail } from '../../shared/scan-contracts'
import type { ReportStatistics } from '../../shared/report-contracts'
import { publicAnalysisValue } from '../../shared/path-detail-view.ts'

export interface ReportSnapshot {
  project: {
    projectId: string
    name: string
    sourceType: string
    gitUrl: string | null
    commit: string | null
  }
  run: {
    runId: string
    sourceStamp: string
    rulesVersion: string
    status: string
    stage: string
    createdAt: string
  }
  generatedAt: string
  scan: { state: string; truncated: boolean; warnings: unknown[] }
  stageReport: boolean
  statistics: ReportStatistics
  paths: PathDetail[]
}
export function savedReportSnapshot(
  db: LocalDatabase,
  projectId: string,
  runId: string
): ReportSnapshot {
  return db.transaction(() => {
    const project = db.get(
      'SELECT id,name,source_type,git_url,git_commit FROM projects WHERE id=?',
      projectId
    )
    const run = db.get('SELECT * FROM audit_runs WHERE id=? AND project_id=?', runId, projectId)
    if (!project || !run) throw new ApiError('REPORT_SCOPE_NOT_FOUND', '报告项目或任务不存在', 404)
    const ids = db.all(
      'SELECT path_id FROM call_paths WHERE project_id=? AND run_id=? ORDER BY created_at,path_id',
      projectId,
      runId
    )
    if (ids.length > 1000)
      throw new ApiError('REPORT_LIMIT', '单份报告最多 1000 条路径，请缩小任务范围', 413)
    const repo = new CallChainRepository(db)
    const paths = ids.map(
      (row) =>
        repo.detail({ projectId, runId, pathId: String(row.path_id) }) as unknown as PathDetail
    )
    const statistics: ReportStatistics = {
      ...repo.scans.statistics(projectId, runId),
      dangerous: Number(
        db.get(
          'SELECT count(DISTINCT path_id) AS n FROM call_paths WHERE project_id=? AND run_id=? AND dangerous=1',
          projectId,
          runId
        )!.n
      ),
      riskPoints: Number(
        db.get(
          'SELECT count(*) AS n FROM (SELECT sink_edge_id,rule_id FROM call_paths WHERE project_id=? AND run_id=? AND dangerous=1 AND sink_edge_id IS NOT NULL AND rule_id IS NOT NULL GROUP BY sink_edge_id,rule_id)',
          projectId,
          runId
        )!.n
      )
    }
    const scanRow = db.get(
      'SELECT state,truncated,warnings_json FROM scan_runs WHERE project_id=? AND run_id=?',
      projectId,
      runId
    )
    const warnings = scanRow ? JSON.parse(String(scanRow.warnings_json)) : []
    const scan = {
      state: scanRow ? String(scanRow.state) : '未保存',
      truncated: !scanRow || scanRow.truncated === 1,
      warnings: Array.isArray(warnings) ? warnings : []
    }
    const stageReport =
      run.status !== 'completed' ||
      statistics.pending > 0 ||
      statistics.analyzing > 0 ||
      statistics.failed > 0 ||
      statistics.unknown > 0 ||
      paths.some((path) => path.truncated) ||
      scan.truncated ||
      !['ready', 'empty'].includes(scan.state)
    const snapshot: ReportSnapshot = {
      project: {
        projectId,
        name: String(project.name),
        sourceType: String(project.source_type),
        gitUrl: project.git_url === null ? null : String(project.git_url),
        commit: project.git_commit === null ? null : String(project.git_commit)
      },
      run: {
        runId,
        sourceStamp: String(run.source_stamp),
        rulesVersion: String(run.rules_version),
        status: String(run.status),
        stage: String(run.stage),
        createdAt: String(run.created_at)
      },
      generatedAt: new Date().toISOString(),
      stageReport,
      scan,
      statistics,
      paths
    }
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 15 * 1024 * 1024)
      throw new ApiError('REPORT_LIMIT', '报告数据超过 15MiB，未静默截断', 413)
    return publicAnalysisValue(snapshot) as ReportSnapshot
  })
}
