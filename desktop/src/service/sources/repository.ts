import { randomUUID } from 'node:crypto'
import type { SourceCatalog, SourceProject } from '../../shared/source-contracts'
import type { LocalDatabase, Row } from '../storage/database'
import type { SourceScan } from './scan'
import { SnapshotRepository } from '../storage/snapshot-repository.ts'
const select = `SELECT p.*,s.source_stamp,s.file_count,s.total_bytes,s.registered_at FROM projects p JOIN source_imports s ON s.project_id=p.id`
function project(row: Row): SourceProject {
  return {
    projectId: String(row.id),
    projectName: String(row.name),
    path: String(row.path),
    sourceType: row.source_type as 'local' | 'git',
    gitUrl: row.git_url === null ? null : String(row.git_url),
    commit: row.git_commit === null ? null : String(row.git_commit),
    dirty: row.git_dirty === null ? null : row.git_dirty === 1,
    sourceStamp: String(row.source_stamp),
    fileCount: Number(row.file_count),
    totalBytes: Number(row.total_bytes),
    registeredAt: String(row.registered_at)
  }
}
export class SourceRepository {
  readonly snapshots: SnapshotRepository
  private db: LocalDatabase
  constructor(db: LocalDatabase) {
    this.db = db
    this.snapshots = new SnapshotRepository(db)
  }
  catalog(): SourceCatalog {
    return {
      projects: this.db.all(select + ' ORDER BY s.registered_at DESC,p.id LIMIT 100').map(project),
      total: Number(this.db.get('SELECT count(*) AS n FROM source_imports')?.n)
    }
  }
  get(id: string): SourceProject | undefined {
    const row = this.db.get(select + ' WHERE p.id=?', id)
    return row ? project(row) : undefined
  }
  find(key: string): SourceProject | undefined {
    const row = this.db.get(
      select + ' WHERE s.source_key=? ORDER BY s.registered_at DESC LIMIT 1',
      key
    )
    return row ? project(row) : undefined
  }
  save(
    name: string,
    key: string,
    scan: SourceScan,
    git?: { url: string; commit: string; dirty: boolean }
  ): SourceProject {
    const id = randomUUID(),
      now = new Date().toISOString()
    this.db.transaction((tx) => {
      tx.run(
        `INSERT INTO projects (id,name,path,source_type,created_at,updated_at,git_url,git_commit,git_dirty,revision) VALUES (?,?,?,?,?,?,?,?,?,1)`,
        id,
        name,
        scan.path,
        git ? 'git' : 'local',
        now,
        now,
        git?.url ?? null,
        git?.commit ?? null,
        git ? Number(git.dirty) : null
      )
      tx.run(
        'INSERT INTO source_imports VALUES (?,?,?,?,?,?)',
        id,
        key,
        scan.stamp,
        scan.fileCount,
        scan.totalBytes,
        now
      )
    })
    return this.get(id)!
  }
}
