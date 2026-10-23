import { randomUUID } from 'node:crypto'
import { ApiError } from '../../shared/api-error.ts'
import type { ModelConfig } from '../../shared/pi-contracts'
import type {
  MetadataOverview,
  ModelInput,
  ModelRecord,
  ProjectInput,
  ProjectRecord
} from '../../shared/metadata-contracts'
import type { LocalDatabase, Row } from './database.ts'
import type { ProjectSource } from './project-source'

function conflict(): never {
  throw new ApiError('METADATA_REVISION_CONFLICT', '记录已改变，请刷新后再保存', 409)
}
function project(row: Row): ProjectRecord {
  return {
    projectId: String(row.id),
    projectName: String(row.name),
    path: String(row.path),
    sourceType: row.source_type as 'local' | 'git',
    gitUrl: row.git_url === null ? null : String(row.git_url),
    commit: row.git_commit === null ? null : String(row.git_commit),
    dirty: row.git_dirty === null ? null : row.git_dirty === 1,
    revision: Number(row.revision),
    needsMetadata:
      row.source_type === 'git' && (!row.git_url || !row.git_commit || row.git_dirty === null)
  }
}
function model(row: Row): ModelRecord {
  return {
    configId: String(row.id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    modelId: String(row.model_id),
    revision: Number(row.revision),
    credentialState: row.secret_ref ? 'referenced' : 'missing'
  }
}
export class MetadataRepository {
  private readonly db: LocalDatabase
  constructor(db: LocalDatabase) {
    this.db = db
  }
  overview(): MetadataOverview {
    return {
      projects: this.db
        .all('SELECT * FROM projects ORDER BY updated_at DESC,id LIMIT 100')
        .map(project),
      models: this.db
        .all('SELECT * FROM model_configs ORDER BY updated_at DESC,id LIMIT 100')
        .map(model),
      totals: {
        projects: Number(this.db.get('SELECT count(*) AS n FROM projects')?.n),
        models: Number(this.db.get('SELECT count(*) AS n FROM model_configs')?.n)
      }
    }
  }
  saveProject(input: ProjectInput, source: ProjectSource): ProjectRecord {
    const id = input.projectId ?? randomUUID(),
      now = new Date().toISOString()
    return this.db.transaction((tx) => {
      // 已导入源码带有来源键和登记指纹；旧元数据表单不能绕过导入流程改写路径/来源。
      if (
        input.projectId &&
        tx.get("SELECT name FROM sqlite_schema WHERE name='source_imports'") &&
        tx.get('SELECT project_id FROM source_imports WHERE project_id=?', input.projectId)
      )
        throw new ApiError(
          'SOURCE_PROJECT_LOCKED',
          '该项目已登记源码，请使用源码导入与打开流程；本阶段不支持修改已登记来源',
          409
        )
      const old = tx.get('SELECT * FROM projects WHERE id=?', id)
      if (input.projectId && (!old || old.revision !== input.expectedRevision)) conflict()
      if (!input.projectId && old) conflict()
      if (old)
        tx.run(
          `UPDATE projects SET name=?,path=?,source_type=?,git_url=?,git_commit=?,git_dirty=?,
        revision=revision+1,updated_at=? WHERE id=?`,
          input.projectName,
          source.path,
          input.sourceType,
          input.gitUrl ?? null,
          source.commit,
          source.dirty === null ? null : Number(source.dirty),
          now,
          id
        )
      else
        tx.run(
          `INSERT INTO projects (id,name,path,source_type,created_at,updated_at,git_url,git_commit,git_dirty,revision)
        VALUES (?,?,?,?,?,?,?,?,?,1)`,
          id,
          input.projectName,
          source.path,
          input.sourceType,
          now,
          now,
          input.gitUrl ?? null,
          source.commit,
          source.dirty === null ? null : Number(source.dirty)
        )
      return project(tx.get('SELECT * FROM projects WHERE id=?', id)!)
    })
  }
  getModel(id: string): ModelConfig | undefined {
    const row = this.db.get('SELECT * FROM model_configs WHERE id=?', id)
    return row
      ? {
          id: String(row.id),
          name: String(row.name),
          baseUrl: String(row.base_url),
          modelId: String(row.model_id),
          revision: Number(row.revision),
          api: 'openai-completions',
          secretRef: row.secret_ref ? String(row.secret_ref) : ''
        }
      : undefined
  }
  // 仅供内部配置服务调用。secretRef 由服务生成，不接受 HTTP 客户端指定。
  commitModel(
    input: ModelInput,
    id: string,
    secretRef: string | null,
    newRef?: string
  ): ModelRecord {
    return this.db.transaction((tx) => {
      const old = tx.get('SELECT * FROM model_configs WHERE id=?', id),
        now = new Date().toISOString()
      if (input.configId && (!old || old.revision !== input.expectedRevision)) conflict()
      if (!input.configId && old) conflict()
      if (old)
        tx.run(
          `UPDATE model_configs SET name=?,base_url=?,model_id=?,secret_ref=?,revision=revision+1,updated_at=? WHERE id=?`,
          input.name,
          input.baseUrl,
          input.modelId,
          secretRef,
          now,
          id
        )
      else
        tx.run(
          `INSERT INTO model_configs (id,name,base_url,model_id,secret_ref,revision,api,created_at,updated_at)
        VALUES (?,?,?,?,?,1,'openai-completions',?,?)`,
          id,
          input.name,
          input.baseUrl,
          input.modelId,
          secretRef,
          now,
          now
        )
      if (newRef) tx.run('DELETE FROM credential_cleanup WHERE secret_ref=?', newRef)
      if (old?.secret_ref && old.secret_ref !== secretRef)
        tx.run('INSERT OR IGNORE INTO credential_cleanup VALUES (?,?)', old.secret_ref, now)
      return model(tx.get('SELECT * FROM model_configs WHERE id=?', id)!)
    })
  }
  prepareCredential(reference: string): void {
    this.db.run('INSERT INTO credential_cleanup VALUES (?,?)', reference, new Date().toISOString())
  }
  cleanupCandidates(): string[] {
    return this.db
      .all('SELECT secret_ref FROM credential_cleanup ORDER BY created_at LIMIT 100')
      .map((r) => String(r.secret_ref))
  }
  isReferenced(reference: string): boolean {
    return !!this.db.get('SELECT id FROM model_configs WHERE secret_ref=?', reference)
  }
  finishCleanup(reference: string): void {
    this.db.run('DELETE FROM credential_cleanup WHERE secret_ref=?', reference)
  }
}
