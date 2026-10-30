import { createHash, randomUUID } from 'node:crypto'
import { ApiError } from '../../shared/api-error.ts'
import { disclosureCategories } from '../../shared/input-enhancements.ts'
import type { DisclosureScope } from '../../shared/input-enhancements'
import type { ModelConfig } from '../../shared/pi-contracts'
import type { LocalDatabase } from './database'
import { SnapshotRepository } from './snapshot-repository.ts'
import { TemplateRepository } from './template-repository.ts'

export class DisclosureRepository {
  private readonly db: LocalDatabase
  constructor(db: LocalDatabase) {
    this.db = db
  }

  preview(projectId: string, runId: string, configId: string): DisclosureScope {
    const snapshot = new SnapshotRepository(this.db).info(projectId, runId)
    const model = this.db.get(
      'SELECT id,revision,base_url,model_id FROM model_configs WHERE id=?',
      configId
    )
    if (!model) throw new ApiError('MODEL_CONFIG_NOT_FOUND', '请选择已保存的模型配置', 404)
    const scope = {
      projectId,
      snapshotId: snapshot.snapshotId,
      reviewContextHash: new TemplateRepository(this.db).run(projectId, runId).contextHash,
      configId,
      revision: Number(model.revision),
      baseUrl: String(model.base_url),
      modelId: String(model.model_id),
      fileCount: snapshot.files.length,
      totalBytes: snapshot.files.reduce((n, f) => n + f.size, 0),
      categories: [...disclosureCategories]
    }
    const scopeKey = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
    return {
      ...scope,
      runId,
      scopeKey,
      authorized: !!this.db.get(
        'SELECT scope_key FROM disclosure_grants WHERE scope_key=?',
        scopeKey
      )
    }
  }
  confirm(
    projectId: string,
    runId: string,
    configId: string,
    expectedScopeKey: string
  ): DisclosureScope {
    const scope = this.preview(projectId, runId, configId)
    if (scope.scopeKey !== expectedScopeKey)
      throw new ApiError(
        'DISCLOSURE_SCOPE_CHANGED',
        '发送范围或模型配置已变化，请重新查看并确认',
        409
      )
    if (!scope.authorized)
      this.db.run(
        'INSERT INTO disclosure_grants VALUES (?,?,?,?,?)',
        scope.scopeKey,
        projectId,
        scope.snapshotId,
        JSON.stringify(scope),
        new Date().toISOString()
      )
    return { ...scope, authorized: true }
  }
  require(projectId: string, runId: string, configId: string): DisclosureScope {
    const scope = this.preview(projectId, runId, configId)
    if (!scope.authorized)
      throw new ApiError(
        'SOURCE_DISCLOSURE_REQUIRED',
        '请先查看并确认此项目快照向目标服务及模型发送的内容范围',
        409
      )
    return scope
  }
  beforeSend(
    scope: DisclosureScope,
    pathId: string,
    attempt: number,
    model: Readonly<ModelConfig>
  ): string {
    if (
      model.id !== scope.configId ||
      model.revision !== scope.revision ||
      model.baseUrl !== scope.baseUrl ||
      model.modelId !== scope.modelId ||
      !this.db.get('SELECT scope_key FROM disclosure_grants WHERE scope_key=?', scope.scopeKey)
    )
      throw new ApiError(
        'DISCLOSURE_SCOPE_CHANGED',
        '实际调用配置超出已确认范围，停止发送并重新确认',
        409
      )
    const id = randomUUID()
    this.db.run(
      `INSERT INTO source_transmissions
      (transmission_id,project_id,run_id,path_id,attempt,scope_key,config_id,revision,base_url,model_id,started_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      scope.projectId,
      scope.runId,
      pathId,
      attempt,
      scope.scopeKey,
      model.id,
      model.revision,
      model.baseUrl,
      model.modelId,
      new Date().toISOString()
    )
    return id
  }
  observed(id: string, modelId: string): void {
    if (modelId.length > 0 && modelId.length <= 200)
      this.db.run(
        'UPDATE source_transmissions SET observed_model_id=? WHERE transmission_id=?',
        modelId,
        id
      )
  }
}
