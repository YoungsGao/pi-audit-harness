import { ApiError } from '../../shared/api-error.ts'
import type { ModelCatalog, ModelSelectionInput } from '../../shared/model-settings'
import type { ModelRecord } from '../../shared/metadata-contracts'
import type { LocalDatabase, Row } from './database'
function summary(row: Row): ModelRecord {
  return {
    configId: String(row.id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    modelId: String(row.model_id),
    revision: Number(row.revision),
    credentialState: row.secret_ref ? 'referenced' : 'missing'
  }
}
export class ModelSettingsRepository {
  private readonly db: LocalDatabase
  constructor(db: LocalDatabase) {
    this.db = db
  }
  catalog(): ModelCatalog {
    const selection = this.db.get('SELECT config_id,revision FROM model_selection WHERE slot=1')
    if (!selection)
      throw new ApiError('MODEL_SELECTION_INVALID', '模型选择状态缺失，请保留数据库排查')
    const id = selection.config_id === null ? null : String(selection.config_id)
    const row = id ? this.db.get('SELECT * FROM model_configs WHERE id=?', id) : undefined
    if (id && !row)
      throw new ApiError('MODEL_SELECTION_INVALID', '已选择的配置不存在，请保留数据库排查')
    return {
      models: this.db
        .all('SELECT * FROM model_configs ORDER BY updated_at DESC,id LIMIT 100')
        .map(summary),
      total: Number(this.db.get('SELECT count(*) AS n FROM model_configs')?.n),
      selection: {
        configId: id,
        revision: Number(selection.revision),
        model: row ? summary(row) : null
      }
    }
  }
  select(input: ModelSelectionInput): ModelCatalog {
    this.db.transaction((tx) => {
      const state = tx.get('SELECT revision FROM model_selection WHERE slot=1')
      if (!state || state.revision !== input.expectedRevision)
        throw new ApiError('MODEL_SELECTION_CONFLICT', '模型选择已改变，请刷新后重新选择', 409)
      if (input.configId && !tx.get('SELECT id FROM model_configs WHERE id=?', input.configId))
        throw new ApiError('MODEL_CONFIG_NOT_FOUND', '待选择的模型配置不存在', 404)
      tx.run(
        'UPDATE model_selection SET config_id=?,revision=revision+1 WHERE slot=1',
        input.configId
      )
    })
    return this.catalog()
  }
}
export function parseSelection(value: unknown): ModelSelectionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError('INVALID_MODEL_SELECTION', '模型选择参数无效', 400)
  const row = value as Record<string, unknown>
  if (
    Object.keys(row).length !== 2 ||
    !('configId' in row) ||
    !('expectedRevision' in row) ||
    !(
      row.configId === null ||
      (typeof row.configId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(row.configId))
    ) ||
    !Number.isSafeInteger(row.expectedRevision) ||
    Number(row.expectedRevision) < 0
  )
    throw new ApiError('INVALID_MODEL_SELECTION', '模型选择参数无效', 400)
  return { configId: row.configId as string | null, expectedRevision: Number(row.expectedRevision) }
}
