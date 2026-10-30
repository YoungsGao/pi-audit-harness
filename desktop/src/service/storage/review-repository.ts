import { createHash } from 'node:crypto'
import type { LocalDatabase } from './database.ts'
import type {
  HumanReview,
  MachineReviewBasis,
  PathScope,
  ReviewSave
} from '../../shared/review-contracts.ts'
import { reviewInput } from '../../shared/review-contracts.ts'
import { publicAnalysisText } from '../../shared/path-detail-view.ts'
import { ApiError } from '../../shared/api-error.ts'
export class ReviewRepository {
  private readonly db: LocalDatabase
  constructor(db: LocalDatabase) {
    this.db = db
  }
  get(scope: PathScope): HumanReview {
    const path = this.db.get(
      'SELECT status,verdict,dangerous,result_summary,updated_at,path_hash FROM call_paths WHERE project_id=? AND run_id=? AND path_id=?',
      scope.projectId,
      scope.runId,
      scope.pathId
    )
    if (!path) throw new ApiError('REVIEW_SCOPE_NOT_FOUND', '未找到当前项目和任务的路径', 404)
    const attempt = this.db.get(
      'SELECT attempt,phase FROM path_attempts WHERE project_id=? AND run_id=? AND path_id=?',
      scope.projectId,
      scope.runId,
      scope.pathId
    )
    const current: MachineReviewBasis = {
      version: createHash('sha256')
        .update(JSON.stringify({ path, attempt: attempt ?? null }))
        .digest('hex'),
      status: String(path.status),
      verdict: String(path.verdict),
      updatedAt: String(path.updated_at),
      attempt: Number(attempt?.attempt ?? 0)
    }
    const row = this.db.get(
      'SELECT * FROM path_review_versions WHERE project_id=? AND run_id=? AND path_id=? ORDER BY revision DESC LIMIT 1',
      scope.projectId,
      scope.runId,
      scope.pathId
    )
    const baseline = row ? (JSON.parse(String(row.baseline_json)) as MachineReviewBasis) : null
    return {
      ...scope,
      revision: Number(row?.revision ?? 0),
      status: row ? (row.status as HumanReview['status']) : 'unreviewed',
      note: row ? publicAnalysisText(String(row.note)) : '',
      savedAt: row ? String(row.saved_at) : null,
      baseline,
      current,
      stale: !!baseline && baseline.version !== current.version
    }
  }
  save(input: ReviewSave): HumanReview {
    reviewInput('save', input)
    return this.db.transaction((tx) => {
      const before = this.get({
        projectId: input.projectId,
        runId: input.runId,
        pathId: input.pathId
      })
      if (before.revision !== input.expectedRevision)
        throw new ApiError('REVIEW_CONFLICT', '复核记录已更新，请刷新后核对再保存', 409)
      if (before.current.version !== input.baselineVersion)
        throw new ApiError(
          'REVIEW_MACHINE_CHANGED',
          '机器结果已更新，请刷新复核基线后重新核对',
          409
        )
      tx.run(
        'INSERT INTO path_review_versions VALUES(?,?,?,?,?,?,?,?)',
        input.projectId,
        input.runId,
        input.pathId,
        before.revision + 1,
        input.status,
        publicAnalysisText(input.note.trim()),
        JSON.stringify(before.current),
        new Date().toISOString()
      )
      return this.get({ projectId: input.projectId, runId: input.runId, pathId: input.pathId })
    })
  }
}
