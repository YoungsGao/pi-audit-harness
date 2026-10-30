import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { LocalDatabase } from '../storage/database.ts'
import { ReportRepository } from '../storage/report-repository.ts'
import type { ReportCommit } from '../storage/report-repository.ts'
import { retryWrite } from '../storage/retry-write.ts'
import { ApiError } from '../../shared/api-error.ts'
import { reportInput } from '../../shared/report-contracts.ts'
import type { ReportAction, ReportData, ReportFile } from '../../shared/report-contracts'
import { PiRuntime } from '../pi-runtime.ts'
import { savedReportSnapshot, reportPreview, renderReportJson } from './snapshot.ts'
import { executeSavedReport } from './pi-report.ts'
import { publishReport, reportFilePath, verifyReportFile } from './files.ts'

export class ReportService {
  private readonly db: LocalDatabase
  private readonly dataRoot: string
  private readonly runtime: PiRuntime
  private readonly repo: ReportRepository
  private readonly closing = new AbortController()
  private active?: Promise<ReportData>
  private persistenceFault = false
  constructor(db: LocalDatabase, dataRoot: string) {
    this.db = db
    this.dataRoot = dataRoot
    this.runtime = new PiRuntime(join(dataRoot, 'report-command'))
    this.repo = new ReportRepository(db)
  }
  async action(action: ReportAction, value: unknown, signal?: AbortSignal): Promise<ReportData> {
    let scope: ReturnType<typeof reportInput>
    try {
      scope = reportInput(action, value)
    } catch {
      throw new ApiError('REPORT_INVALID_INPUT', '报告标识、格式或筛选条件无效', 400)
    }
    if (this.persistenceFault)
      throw new ApiError(
        'REPORT_PERSISTENCE_FAILED',
        '报告状态写库未确认，请检查磁盘并重启服务恢复',
        503
      )
    if (action === 'list') return this.repo.list(scope.projectId, scope.runId)
    if (action === 'preview')
      return reportPreview(savedReportSnapshot(this.db, scope.projectId, scope.runId, scope.filter))
    if (action === 'file') {
      const row = this.repo.get(scope, scope.reportId!)
      if (row.status !== 'ready' || !row.sha256)
        throw new ApiError('REPORT_NOT_READY', '报告尚未成功生成，或旧记录没有可验证产物', 409)
      const file: ReportFile = {
        format: row.format,
        projectId: scope.projectId,
        runId: scope.runId,
        reportId: row.reportId,
        filePath: row.filePath,
        sha256: row.sha256
      }
      await verifyReportFile(this.dataRoot, file)
      return file
    }
    if (this.closing.signal.aborted) throw new ApiError('REPORT_STOPPED', '报告服务正在停止', 503)
    if (this.active)
      throw new ApiError('REPORT_BUSY', '已有报告正在生成，请等待并刷新列表', 409, true)
    const task = this.generate(
      scope,
      AbortSignal.any([this.closing.signal, ...(signal ? [signal] : [])])
    )
    this.active = task
    try {
      return await task
    } finally {
      this.active = undefined
    }
  }
  private async generate(
    scope: ReturnType<typeof reportInput>,
    signal: AbortSignal
  ): Promise<ReportData> {
    // The pending row and filename are created by the service; no client-supplied path or HTML.
    const id = randomUUID()
    const format = scope.format ?? 'html'
    const filter = scope.filter
    this.repo.begin(
      scope.projectId,
      scope.runId,
      reportFilePath(this.dataRoot, id, format),
      id,
      format,
      filter
    )
    let commit: ReportCommit | undefined
    try {
      const frozen = savedReportSnapshot(this.db, scope.projectId, scope.runId, filter)
      if (scope.expectedSnapshotKey && frozen.snapshotKey !== scope.expectedSnapshotKey)
        throw new ApiError(
          'REPORT_SNAPSHOT_CHANGED',
          '保存结果或人工复核已变化，请刷新预览后重新生成',
          409
        )
      const publish = async (snapshot: typeof frozen, content: string): Promise<void> => {
        const sha256 = await publishReport(this.dataRoot, id, content, format)
        if (signal.aborted) throw new ApiError('REPORT_CANCELLED', '报告生成已取消', 499)
        await verifyReportFile(this.dataRoot, {
          projectId: scope.projectId,
          runId: scope.runId,
          format,
          reportId: id,
          filePath: reportFilePath(this.dataRoot, id, format),
          sha256
        })
        commit = {
          statistics: snapshot.statistics,
          stageReport: snapshot.stageReport,
          sha256,
          generatedAt: snapshot.generatedAt,
          snapshotKey: snapshot.snapshotKey,
          stageReasons: snapshot.stageReasons,
          reviewCounts: snapshot.reviewCounts,
          totalPaths: snapshot.allStatistics.paths
        }
      }
      if (format === 'json') await publish(frozen, renderReportJson(frozen, id))
      else await executeSavedReport(this.runtime, scope, () => frozen, publish, signal)
      if (!commit || signal.aborted)
        throw new ApiError('REPORT_CANCELLED', '报告生成未完成或已取消', 499)
      await retryWrite(() => this.repo.commit(id, commit!))
    } catch (error) {
      try {
        await retryWrite(() =>
          this.repo.fail(id, error instanceof ApiError ? error.code : 'REPORT_GENERATION_FAILED')
        )
      } catch {
        this.persistenceFault = true
        throw new ApiError(
          'REPORT_PERSISTENCE_FAILED',
          `报告状态写库未确认。projectId=${scope.projectId} runId=${scope.runId} reportId=${id}`,
          503
        )
      }
    }
    return this.repo.get(scope, id)
  }
  async close(): Promise<void> {
    this.closing.abort()
    await this.active?.catch(() => {})
    await this.runtime.close()
  }
}
