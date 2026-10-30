import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { LocalDatabase } from './database.ts'
import { ScanRepository } from './scan-repository.ts'
import { appendEvent, redact } from './analysis-events.ts'
import { ApiError } from '../../shared/api-error.ts'
import type {
  ReportCatalog,
  ReportRecord,
  ReportScope,
  ReportStatistics,
  ReportFormat,
  ReportFilter,
  ReviewCounts
} from '../../shared/report-contracts'
import { isReportStatistics, defaultReportFilter } from '../../shared/report-contracts.ts'

export interface ReportCommit {
  snapshotKey?: string
  stageReasons?: string[]
  reviewCounts?: ReviewCounts
  totalPaths?: number
  statistics: ReportStatistics
  stageReport: boolean
  sha256: string
  generatedAt: string
}

// Internal report ledger; renderer cannot choose arbitrary paths or replace report snapshots.
export class ReportRepository {
  private readonly db: LocalDatabase
  constructor(db: LocalDatabase) {
    this.db = db
  }
  begin(
    projectId: string,
    runId: string,
    filePath: string,
    id = randomUUID(),
    format: ReportFormat = 'html',
    filter: ReportFilter = defaultReportFilter
  ): string {
    if (!isAbsolute(filePath))
      throw new ApiError('REPORT_INVALID_PATH', '报告路径必须为绝对路径', 400)
    const now = new Date().toISOString()
    this.db.transaction((tx) => {
      const stats = new ScanRepository(this.db).statistics(projectId, runId)
      tx.run(
        `INSERT INTO reports (id,run_id,project_id,file_path,status,summary,created_at,summary_json,format,filter_json)
        VALUES (?,?,?,?,'pending','等待报告生成',?,?,?,?)`,
        id,
        runId,
        projectId,
        filePath,
        now,
        JSON.stringify(stats),
        format,
        JSON.stringify(filter)
      )
      appendEvent(tx, projectId, runId, null, {
        type: 'process',
        status: 'report_pending',
        summary: '报告记录已创建',
        payload: { reportId: id, statistics: stats }
      })
    })
    return id
  }
  async finish(id: string, errorCode?: string): Promise<void> {
    const row = this.db.get("SELECT * FROM reports WHERE id=? AND status='pending'", id)
    if (!row) throw new ApiError('REPORT_CONFLICT', '报告记录不存在或已结束', 409)
    if (!errorCode) {
      try {
        if (!(await stat(String(row.file_path))).isFile()) throw new Error()
      } catch {
        throw new ApiError('REPORT_FILE_MISSING', '报告文件尚未生成', 409)
      }
    }
    this.settle(id, errorCode)
  }
  commit(id: string, snapshot: ReportCommit): void {
    this.settle(id, undefined, snapshot)
  }
  fail(id: string, code: string): void {
    this.settle(id, code)
  }
  private settle(id: string, errorCode?: string, snapshot?: ReportCommit): void {
    const row = this.db.get("SELECT * FROM reports WHERE id=? AND status='pending'", id)
    if (!row) throw new ApiError('REPORT_CONFLICT', '报告记录不存在或已结束', 409)
    this.db.transaction((tx) => {
      if (!tx.get("SELECT id FROM reports WHERE id=? AND status='pending'", id))
        throw new ApiError('REPORT_CONFLICT', '报告记录已结束', 409)
      const stats =
        snapshot?.statistics ??
        new ScanRepository(this.db).statistics(String(row.project_id), String(row.run_id))
      tx.run(
        'UPDATE reports SET status=?,summary=?,summary_json=?,generated_at=?,error_message=? WHERE id=?',
        errorCode ? 'failed' : 'ready',
        errorCode ? '报告生成失败' : '报告已生成',
        JSON.stringify(snapshot ?? stats),
        errorCode ? null : (snapshot?.generatedAt ?? new Date().toISOString()),
        errorCode ? redact(errorCode).slice(0, 200) : null,
        id
      )
      appendEvent(tx, String(row.project_id), String(row.run_id), null, {
        type: 'result',
        status: errorCode ? 'report_failed' : 'report_ready',
        summary: errorCode ? '报告生成失败' : '报告已生成',
        payload: { reportId: id, statistics: snapshot?.statistics ?? stats }
      })
    })
  }
  get(scope: ReportScope, id: string): ReportRecord {
    const row = this.db.get(
      'SELECT * FROM reports WHERE project_id=? AND run_id=? AND id=?',
      scope.projectId,
      scope.runId,
      id
    )
    if (!row) throw new ApiError('REPORT_NOT_FOUND', '报告不属于当前项目与任务', 404)
    const parsed = JSON.parse(String(row.summary_json)) as Record<string, unknown>
    const statistics = {
      ...((parsed.statistics ?? parsed) as object),
      riskPoints: (parsed.statistics as Record<string, unknown> | undefined)?.riskPoints ?? null
    }
    return {
      format: row.format as ReportFormat,
      filter: JSON.parse(String(row.filter_json)),
      snapshotKey: typeof parsed.snapshotKey === 'string' ? parsed.snapshotKey : null,
      stageReasons: Array.isArray(parsed.stageReasons) ? (parsed.stageReasons as string[]) : [],
      reviewCounts: (parsed.reviewCounts as ReviewCounts) ?? null,
      totalPaths: typeof parsed.totalPaths === 'number' ? parsed.totalPaths : null,
      projectId: scope.projectId,
      runId: scope.runId,
      reportId: id,
      filePath: String(row.file_path),
      status: row.status as ReportRecord['status'],
      createdAt: String(row.created_at),
      generatedAt: row.generated_at === null ? null : String(row.generated_at),
      errorCode: row.error_message === null ? null : String(row.error_message),
      stageReport: typeof parsed.stageReport === 'boolean' ? parsed.stageReport : null,
      sha256: typeof parsed.sha256 === 'string' ? parsed.sha256 : null,
      statistics: isReportStatistics(statistics) ? statistics : null
    }
  }
  list(projectId: string, runId: string): ReportCatalog {
    new ScanRepository(this.db).state(projectId, runId)
    return {
      projectId,
      runId,
      reports: this.db
        .all(
          'SELECT id FROM reports WHERE project_id=? AND run_id=? ORDER BY created_at DESC,id DESC LIMIT 100',
          projectId,
          runId
        )
        .map((r) => this.get({ projectId, runId }, String(r.id)))
    }
  }
  recover(): void {
    this.db.transaction((tx) => {
      for (const r of tx.all("SELECT id,project_id,run_id FROM reports WHERE status='pending'")) {
        tx.run(
          "UPDATE reports SET status='failed',error_message='REPORT_INTERRUPTED' WHERE id=?",
          r.id
        )
        appendEvent(tx, String(r.project_id), String(r.run_id), null, {
          type: 'result',
          status: 'report_failed',
          summary: '报告生成随服务中断',
          payload: { reportId: r.id, errorCode: 'REPORT_INTERRUPTED' }
        })
      }
    })
  }
}
