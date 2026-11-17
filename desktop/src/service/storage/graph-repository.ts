import { createHash } from 'node:crypto'
import type { LocalDatabase } from './database.ts'
import type { GraphBinding } from '../query/graph-contracts.ts'
import { ApiError } from '../../shared/api-error.ts'
export const graphHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class GraphRepository {
  private readonly db: LocalDatabase
  constructor(db: LocalDatabase) {
    this.db = db
  }
  get(projectId: string, runId: string): GraphBinding | null {
    const row = this.db.get(
      'SELECT graph_json AS binding_json,graph_hash AS binding_hash FROM audit_runs WHERE project_id=? AND id=?',
      projectId,
      runId
    )
    if (!row?.binding_json) return null
    const binding = JSON.parse(String(row.binding_json)) as GraphBinding
    if (graphHash(binding) !== row.binding_hash)
      throw new ApiError('RUN_GRAPH_CORRUPT', '固定图身份损坏', 409)
    return binding
  }
  save(projectId: string, runId: string, binding: GraphBinding): void {
    const previous = this.get(projectId, runId)
    if (previous) {
      if (graphHash(previous) !== graphHash(binding))
        throw new ApiError('RUN_GRAPH_CHANGED', '不能更换任务固定图', 409)
      return
    }
    this.db.run(
      'UPDATE audit_runs SET graph_json=?,graph_hash=?,graph_created_at=? WHERE id=? AND project_id=?',
      JSON.stringify(binding),
      graphHash(binding),
      new Date().toISOString(),
      runId,
      projectId
    )
  }
}
