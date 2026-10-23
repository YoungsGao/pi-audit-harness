import { randomUUID } from 'node:crypto'
import { ModelSettingsRepository, parseSelection } from './model-settings-repository.ts'
import type { ModelCatalog } from '../../shared/model-settings'
import { ApiError } from '../../shared/api-error.ts'
import type { ModelPorts } from '../../shared/pi-contracts'
import type {
  MetadataOverview,
  ModelSaveResult,
  ProjectRecord
} from '../../shared/metadata-contracts'
import { MetadataRepository } from './metadata-repository.ts'
import { parseModel, parseProject } from './metadata-validation.ts'
import { inspectProject } from './project-source.ts'
import type { CredentialStore } from './credential-store'

export class MetadataService {
  private readonly repository: MetadataRepository
  private readonly vault: CredentialStore
  private readonly settings?: ModelSettingsRepository
  private tail: Promise<unknown> = Promise.resolve()
  private closing = false
  private pending = 0
  constructor(
    repository: MetadataRepository,
    vault: CredentialStore,
    settings?: ModelSettingsRepository
  ) {
    this.settings = settings
    this.repository = repository
    this.vault = vault
  }
  private check(signal?: AbortSignal): void {
    if (this.closing || signal?.aborted)
      throw new ApiError('METADATA_CANCELLED', '元数据操作已停止', 503, true)
  }
  private enqueue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.check(signal)
    if (this.pending >= 16)
      return Promise.reject(
        new ApiError('METADATA_BUSY', '配置写入队列已满，请稍后重试', 429, true)
      )
    this.pending++
    const task = this.tail.then(() => {
      this.check(signal)
      return operation()
    })
    this.tail = task
      .catch(() => {})
      .finally(() => {
        this.pending--
      })
    return task
  }
  overview(): MetadataOverview {
    return this.repository.overview()
  }
  saveProject(value: unknown, signal?: AbortSignal): Promise<ProjectRecord> {
    const input = parseProject(value)
    return this.enqueue(async () => {
      const source = await inspectProject(input)
      this.check(signal)
      return this.repository.saveProject(input, source)
    }, signal)
  }
  saveModel(value: unknown, signal?: AbortSignal): Promise<ModelSaveResult> {
    const input = parseModel(value)
    return this.enqueue(async () => {
      const id = input.configId ?? randomUUID(),
        old = this.repository.getModel(id)
      if (input.configId && (!old || old.revision !== input.expectedRevision))
        throw new ApiError('METADATA_REVISION_CONFLICT', '记录已改变，请刷新后再保存', 409)
      if (old?.secretRef && old.baseUrl !== input.baseUrl && input.apiKey === undefined)
        throw new ApiError(
          'MODEL_KEY_REENTRY_REQUIRED',
          '修改服务地址时请重新填写该地址对应的 API Key',
          400
        )
      const newRef = input.apiKey === undefined ? undefined : 'PiAuditHarness/model/' + randomUUID()
      const reference = newRef ?? (old?.secretRef || null)
      // 先持久化“如果没有被正式引用就应清理”的意图，弥补 SQLite 与系统凭据库不能共用事务。
      if (newRef) this.repository.prepareCredential(newRef)
      try {
        if (newRef) await this.vault.write(newRef, input.apiKey!)
        this.check(signal)
        const model = this.repository.commitModel(input, id, reference, newRef)
        // 提交后旧引用进入清理账本；失败不伪装成“配置保存失败”，保留下次重试。
        await this.cleanupOne()
        return { model, cleanupPending: this.repository.cleanupCandidates().length > 0 }
      } catch (error) {
        // 若外部写入失败或 DB 回滚，账本仍存在。尽力清理，保留原始业务错误。
        await this.cleanupOne()
        throw error
      }
    }, signal)
  }
  private async cleanupOne(): Promise<void> {
    const reference = this.repository.cleanupCandidates()[0]
    if (!reference) return
    if (this.repository.isReferenced(reference)) {
      this.repository.finishCleanup(reference)
      return // 绝不删除正在使用的凭据。
    }
    try {
      await this.vault.delete(reference)
      this.repository.finishCleanup(reference)
    } catch {
      /* 脱敏：账本保留引用，下一次保存或 recover 重试；不记录 Key。 */
    }
  }
  catalog(): ModelCatalog {
    if (!this.settings) throw new ApiError('MODEL_SETTINGS_NOT_READY', '模型选择尚未接入', 503)
    return this.settings.catalog()
  }
  selectModel(value: unknown, signal?: AbortSignal): Promise<ModelCatalog> {
    const input = parseSelection(value)
    return this.enqueue(async () => {
      if (!this.settings) throw new ApiError('MODEL_SETTINGS_NOT_READY', '模型选择尚未接入', 503)
      return this.settings.select(input)
    }, signal)
  }
  recover(): Promise<void> {
    return this.enqueue(() => this.cleanupOne())
  }
  modelPorts(): ModelPorts {
    return {
      resolveSnapshot: (id, signal) =>
        this.enqueue(async () => {
          const config = this.repository.getModel(id)
          if (!config) return undefined
          const apiKey = config.secretRef ? await this.vault.read(config.secretRef) : undefined
          this.check(signal)
          return { config: { ...config }, apiKey }
        }, signal),
      getConfig: async (id) => this.repository.getModel(id),
      readSecret: async (reference) => (reference ? this.vault.read(reference) : undefined)
    }
  }
  async close(): Promise<void> {
    this.closing = true
    await this.tail
  }
}
