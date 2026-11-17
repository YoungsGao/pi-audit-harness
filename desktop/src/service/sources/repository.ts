import { randomUUID } from 'node:crypto'
import type { SourceCatalog, SourceProject } from '../../shared/source-contracts'
import type { LocalDatabase, Row } from '../storage/database'
import type { SourceScan } from './scan'
import { SnapshotRepository } from '../storage/snapshot-repository.ts'
import { GraphRepository } from '../storage/graph-repository.ts'
import { dirname } from 'node:path'
const select = `SELECT p.id,p.name,p.path,p.source_type,p.git_url,p.git_commit,p.git_dirty,
  p.source_stamp,p.file_count,p.total_bytes,p.registered_at FROM projects p WHERE p.source_key IS NOT NULL`
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
  readonly graphs: GraphRepository
  readonly dataRoot: string
  private db: LocalDatabase
  constructor(db: LocalDatabase) {
    this.db = db
    this.snapshots = new SnapshotRepository(db)
    this.graphs = new GraphRepository(db)
    this.dataRoot = dirname(dirname(db.filePath))
  }
  catalog(): SourceCatalog {
    return {
      projects: this.db.all(select + ' ORDER BY p.registered_at DESC,p.id LIMIT 100').map(project),
      total: Number(
        this.db.get('SELECT count(*) AS n FROM projects WHERE source_key IS NOT NULL')?.n
      )
    }
  }
  get(id: string): SourceProject | undefined {
    const row = this.db.get(select + ' AND p.id=?', id)
    return row ? project(row) : undefined
  }
  find(key: string): SourceProject | undefined {
    const row = this.db.get(
      select + ' AND p.source_key=? ORDER BY p.registered_at DESC LIMIT 1',
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
    this.db.run(
      `INSERT INTO projects (id,name,path,source_type,created_at,updated_at,git_url,git_commit,git_dirty,revision,
        source_key,source_stamp,file_count,total_bytes,registered_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`,
      id,
      name,
      scan.path,
      git ? 'git' : 'local',
      now,
      now,
      git?.url ?? null,
      git?.commit ?? null,
      git ? Number(git.dirty) : null,
      key,
      scan.stamp,
      scan.fileCount,
      scan.totalBytes,
      now
    )
    return this.get(id)!
  }
}
