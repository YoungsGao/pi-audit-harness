import type { LocalDatabase } from '../storage/database.ts'
import { CallChainRepository } from '../storage/call-chain-repository.ts'
import { ApiError } from '../../shared/api-error.ts'
import type { PathDetail } from '../../shared/scan-contracts'
import type {
  ReportStatistics,
  ReportFilter,
  ReportPreview,
  ReviewCounts
} from '../../shared/report-contracts'
import { defaultReportFilter } from '../../shared/report-contracts.ts'
import type { HumanReview } from '../../shared/review-contracts.ts'
import { ReviewRepository } from '../storage/review-repository.ts'
import { createHash } from 'node:crypto'
import { publicAnalysisValue } from '../../shared/path-detail-view.ts'
import { SnapshotRepository } from '../storage/snapshot-repository.ts'

export interface ReportSnapshot {
  recovery: {
    controlState: string
    recordedRequests: number
    uncertainRequests: number
    paths: {
      pathId: string
      epoch: number
      state: string
      lastRecovery: import('../../shared/run-contracts').RecoveryReceipt | null
    }[]
  }
  filter: ReportFilter
  snapshotKey: string
  allStatistics: ReportStatistics
  humanReviews: HumanReview[]
  reviewCounts: ReviewCounts
  stageReasons: string[]
  reviewConfig: import('../../shared/template-contracts').RunReviewConfig
  sourceSnapshot: import('../../shared/input-enhancements').SnapshotInfo | null
  transmissions: {
    configId: string
    revision: number
    baseUrl: string
    modelId: string
    observedModelId: string | null
    pathId: string
    attempt: number
    startedAt: string
  }[]
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
    finishedAt: string | null
    errorCode: string | null
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
  runId: string,
  filter: ReportFilter = defaultReportFilter
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
    const allPaths = ids.map(
      (row) =>
        repo.detail({ projectId, runId, pathId: String(row.path_id) }) as unknown as PathDetail
    )
    const allStatistics: ReportStatistics = {
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
    const reviews = new ReviewRepository(db)
    const allReviews = allPaths.map((path) =>
      reviews.get({ projectId, runId, pathId: path.pathId })
    )
    const paths = allPaths.filter(
      (path) =>
        (filter.verdict === 'all' || path.verdict === filter.verdict) &&
        (filter.pathStatus === 'all' || path.status === filter.pathStatus) &&
        (filter.reviewStatus === 'all' ||
          allReviews.find((r) => r.pathId === path.pathId)!.status === filter.reviewStatus)
    )
    const humanReviews = allReviews.filter((review) =>
      paths.some((path) => path.pathId === review.pathId)
    )
    const statistics = selectedStatistics(paths)
    const reviewCounts: ReviewCounts = {
      unreviewed: 0,
      confirmed: 0,
      false_positive: 0,
      needs_more_info: 0,
      stale: 0
    }
    for (const review of humanReviews) {
      reviewCounts[review.status]++
      if (review.stale) reviewCounts.stale++
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
      allStatistics.pending > 0 ||
      allStatistics.analyzing > 0 ||
      allStatistics.failed > 0 ||
      allStatistics.unknown > 0 ||
      allPaths.some((path) => path.truncated) ||
      scan.truncated ||
      !['ready', 'empty'].includes(scan.state) ||
      Object.values(filter).some((value) => value !== 'all') ||
      reviewCounts.stale > 0
    const hasSnapshot = db.get(
      'SELECT snapshot_id FROM run_snapshots WHERE project_id=? AND run_id=?',
      projectId,
      runId
    )
    const snapshot: ReportSnapshot = {
      recovery: {
        controlState: String(
          db.get('SELECT state FROM run_controls WHERE run_id=?', runId)?.state ?? 'legacy'
        ),
        recordedRequests: db
          .all(
            'SELECT path_id FROM recovery_requests WHERE project_id=? AND run_id=?',
            projectId,
            runId
          )
          .filter((r) => paths.some((p) => p.pathId === r.path_id)).length,
        uncertainRequests: db
          .all(
            "SELECT path_id FROM recovery_requests WHERE project_id=? AND run_id=? AND state IN ('started','uncertain')",
            projectId,
            runId
          )
          .filter((r) => paths.some((p) => p.pathId === r.path_id)).length,
        paths: db
          .all(
            'SELECT path_id,epoch,state,receipt_json FROM path_recovery WHERE project_id=? AND run_id=?',
            projectId,
            runId
          )
          .filter((r) => paths.some((p) => p.pathId === r.path_id))
          .map((r) => ({
            pathId: String(r.path_id),
            epoch: Number(r.epoch),
            state: String(r.state),
            lastRecovery: JSON.parse(String(r.receipt_json))
          }))
      },
      filter: { ...filter },
      snapshotKey: '',
      allStatistics,
      humanReviews,
      reviewCounts,
      stageReasons: [
        ...(run.status !== 'completed'
          ? [`任务尚未完整结束：${String(run.status)} / ${String(run.stage)}`]
          : []),
        ...(run.error_code ? [`任务结束原因：${String(run.error_code)}`] : []),
        ...(allStatistics.pending ? [`待分析 ${allStatistics.pending} 条路径`] : []),
        ...(allStatistics.analyzing ? [`仍在分析 ${allStatistics.analyzing} 条路径`] : []),
        ...(allStatistics.failed ? [`分析失败 ${allStatistics.failed} 条路径`] : []),
        ...(allStatistics.unknown
          ? [`风险未知 ${allStatistics.unknown} 条路径（包含未分析、失败和证据不足）`]
          : []),
        ...(allPaths.some((path) => path.truncated) ? ['存在截断或未解析的路径边界'] : []),
        ...(scan.truncated || !['ready', 'empty'].includes(scan.state)
          ? [`预处理覆盖不完整：${scan.state}`]
          : []),
        ...(Object.values(filter).some((v) => v !== 'all')
          ? [`筛选导出 ${paths.length} / ${allPaths.length} 条路径，不能代替完整任务报告`]
          : []),
        ...(reviewCounts.stale
          ? [`所选路径有 ${reviewCounts.stale} 条人工复核的机器基线已更新`]
          : [])
      ],
      reviewConfig: repo.scans.templates.run(projectId, runId),
      sourceSnapshot: hasSnapshot ? new SnapshotRepository(db).info(projectId, runId) : null,
      transmissions: db
        .all(
          'SELECT * FROM source_transmissions WHERE project_id=? AND run_id=? ORDER BY started_at,transmission_id',
          projectId,
          runId
        )
        .filter((row) => paths.some((path) => path.pathId === row.path_id))
        .map((row) => ({
          configId: String(row.config_id),
          revision: Number(row.revision),
          baseUrl: String(row.base_url),
          modelId: String(row.model_id),
          observedModelId: row.observed_model_id === null ? null : String(row.observed_model_id),
          pathId: String(row.path_id),
          attempt: Number(row.attempt),
          startedAt: String(row.started_at)
        })),
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
        createdAt: String(run.created_at),
        finishedAt: run.finished_at === null ? null : String(run.finished_at),
        errorCode: run.error_code === null ? null : String(run.error_code)
      },
      generatedAt: new Date().toISOString(),
      stageReport,
      scan,
      statistics,
      paths
    }
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 15 * 1024 * 1024)
      throw new ApiError('REPORT_LIMIT', '报告数据超过 15MiB，未静默截断', 413)
    const clean = publicAnalysisValue(snapshot) as ReportSnapshot
    clean.snapshotKey = createHash('sha256')
      .update(JSON.stringify({ ...clean, generatedAt: '' }))
      .digest('hex')
    return clean
  })
}
function selectedStatistics(paths: PathDetail[]): ReportStatistics {
  const statistics: ReportStatistics = {
    paths: paths.length,
    sinks: 0,
    edges: 0,
    dangerous: 0,
    safe: 0,
    unknown: 0,
    pending: 0,
    analyzing: 0,
    completed: 0,
    failed: 0,
    unresolved: 0,
    invalid: 0,
    riskPoints: 0
  }
  for (const path of paths) {
    statistics[path.status]++
    statistics[path.verdict]++
  }
  statistics.sinks = new Set(paths.map((p) => p.sinkEdgeUid).filter(Boolean)).size
  statistics.edges = new Set(paths.flatMap((p) => p.steps.map((s) => s.edge.uid))).size
  statistics.riskPoints = new Set(
    paths
      .filter((p) => p.dangerous === 1 && p.sinkEdgeUid && p.ruleId)
      .map((p) => JSON.stringify([p.sinkEdgeUid, p.ruleId]))
  ).size
  return statistics
}
export function reportPreview(snapshot: ReportSnapshot): ReportPreview {
  const {
    filter,
    generatedAt,
    snapshotKey,
    statistics,
    allStatistics,
    reviewCounts,
    stageReport,
    stageReasons
  } = snapshot
  return {
    projectId: snapshot.project.projectId,
    runId: snapshot.run.runId,
    filter,
    generatedAt,
    snapshotKey,
    statistics,
    allStatistics,
    reviewCounts,
    stageReport,
    stageReasons
  }
}
export function renderReportJson(snapshot: ReportSnapshot, reportId: string): string {
  return (
    JSON.stringify(
      { schema: 'pi-audit-harness.report', version: 1, reportId, ...snapshot },
      null,
      2
    )
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029') + '\n'
  )
}
