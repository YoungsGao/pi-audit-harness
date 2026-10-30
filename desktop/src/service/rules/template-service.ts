import type { LocalDatabase } from '../storage/database'
import { TemplateRepository } from '../storage/template-repository.ts'
import { templateId, templateObject } from './template-validation.ts'
import { importTemplateDocument } from './template-import.ts'
import type { TemplateAction, TemplateData } from '../../shared/template-contracts'
import { ApiError } from '../../shared/api-error.ts'
export class TemplateService {
  readonly repository: TemplateRepository
  constructor(db: LocalDatabase) {
    this.repository = new TemplateRepository(db)
  }
  async action(
    action: TemplateAction,
    value: unknown,
    signal?: AbortSignal
  ): Promise<TemplateData> {
    if (signal?.aborted) throw new ApiError('TEMPLATE_CANCELLED', '模板操作已取消', 499)
    if (action === 'list') {
      templateObject(value, [])
      return this.repository.catalog()
    }
    if (action === 'save') return this.repository.save(value)
    if (action === 'import') return importTemplateDocument(value, signal)
    if (action === 'saveProject') return this.repository.saveProject(value)
    const row = templateObject(value, action === 'run' ? ['projectId', 'runId'] : ['projectId'])
    const projectId = templateId(row.projectId)
    if (action === 'project') return this.repository.project(projectId)
    if (action === 'run') return this.repository.run(projectId, templateId(row.runId))
    throw new ApiError('TEMPLATE_ACTION_INVALID', '不支持的模板操作', 400)
  }
}
