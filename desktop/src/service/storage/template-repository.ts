import { createHash, randomUUID } from 'node:crypto'
import { ApiError } from '../../shared/api-error.ts'
import {
  emptyProjectReview,
  isRunReviewConfig,
  REVIEW_CONTEXT_BYTES,
  utf8Bytes
} from '../../shared/template-contracts.ts'
import type {
  TemplateRecord,
  TemplateCatalog,
  ProjectReview,
  RunReviewConfig,
  TemplateReference
} from '../../shared/template-contracts'
import { builtinRules } from '../rules/builtin.ts'
import {
  templateId,
  templateObject,
  validateTemplate,
  validateProjectReview
} from '../rules/template-validation.ts'
import type { LocalDatabase, SqlSession, Row } from './database'

export const builtinTemplates: TemplateRecord[] = builtinRules.rules.map((rule) => ({
  templateId: 'builtin-' + rule.id,
  revision: 1,
  name: rule.id,
  language: 'java',
  category: rule.category,
  description: rule.review.source,
  markdown: `# ${rule.id}\n\n## 输入来源\n${rule.review.source}\n\n## 传播核查\n${rule.review.propagation}\n\n## 防护检查\n${rule.review.defenses.map((s) => '- ' + s).join('\n')}\n\n## 范围限制\n${rule.review.limitations}`,
  origin: 'builtin',
  sourceName: null,
  createdAt: '2026-10-23T00:00:00.000Z',
  verification: 'builtin-reference'
}))
function record(row: Row): TemplateRecord {
  return {
    templateId: String(row.template_id),
    revision: Number(row.revision),
    name: String(row.name),
    language: String(row.language),
    category: row.category as TemplateRecord['category'],
    description: String(row.description),
    markdown: String(row.markdown),
    origin: row.origin as TemplateRecord['origin'],
    sourceName: row.source_name === null ? null : String(row.source_name),
    createdAt: String(row.created_at),
    verification: 'unverified'
  }
}
function projectReview(row: Row): ProjectReview {
  return {
    projectId: String(row.project_id),
    revision: Number(row.revision),
    businessWrappers: String(row.business_wrappers),
    inputSources: String(row.input_sources),
    defenseConventions: String(row.defense_conventions),
    focus: String(row.focus),
    updatedAt: String(row.updated_at)
  }
}
export function reviewContextHash(templates: TemplateRecord[], review: ProjectReview): string {
  return createHash('sha256')
    .update(JSON.stringify({ templates, projectReview: review }))
    .digest('hex')
}
export class TemplateRepository {
  private readonly db: LocalDatabase
  constructor(db: LocalDatabase) {
    this.db = db
  }
  catalog(): TemplateCatalog {
    const rows = this.db
      .all(`SELECT v.* FROM audit_template_versions v WHERE revision=(SELECT max(revision)
      FROM audit_template_versions x WHERE x.template_id=v.template_id) ORDER BY created_at DESC,template_id LIMIT 100`)
    const templates = [...structuredClone(builtinTemplates), ...rows.map(record)]
    return { templates, total: templates.length }
  }
  private latest(id: string, tx: SqlSession = this.db): TemplateRecord | undefined {
    const builtin = builtinTemplates.find((t) => t.templateId === id)
    if (builtin) return structuredClone(builtin)
    const row = tx.get(
      'SELECT * FROM audit_template_versions WHERE template_id=? ORDER BY revision DESC LIMIT 1',
      id
    )
    return row ? record(row) : undefined
  }
  save(value: unknown): TemplateRecord {
    const input = validateTemplate(value),
      id = input.templateId ?? randomUUID(),
      now = new Date().toISOString()
    return this.db.transaction((tx) => {
      if (id.startsWith('builtin-'))
        throw new ApiError('TEMPLATE_READ_ONLY', '内置模板只读，请新建自定义模板', 409)
      const old = this.latest(id, tx)
      if (input.templateId && !old) throw new ApiError('TEMPLATE_NOT_FOUND', '模板不存在', 404)
      if (old && old.revision !== input.expectedRevision)
        throw new ApiError(
          'TEMPLATE_REVISION_CONFLICT',
          '模板已被更新，请刷新并检查新版本后再编辑',
          409
        )
      if (
        !old &&
        Number(tx.get('SELECT count(DISTINCT template_id) AS n FROM audit_template_versions')!.n) >=
          100
      )
        throw new ApiError('TEMPLATE_LIMIT', '最多保存 100 个自定义模板', 413)
      const rev = (old?.revision ?? 0) + 1
      tx.run(
        'INSERT INTO audit_template_versions VALUES (?,?,?,?,?,?,?,?,?,?)',
        id,
        rev,
        input.name,
        input.language,
        input.category,
        input.description,
        input.markdown,
        input.origin,
        input.sourceName,
        now
      )
      return this.latest(id, tx)!
    })
  }
  project(projectId: string, tx: SqlSession = this.db): ProjectReview {
    templateId(projectId)
    if (!tx.get('SELECT id FROM projects WHERE id=?', projectId))
      throw new ApiError('PROJECT_NOT_FOUND', '未找到项目', 404)
    const row = tx.get('SELECT * FROM project_review_settings WHERE project_id=?', projectId)
    return row ? projectReview(row) : emptyProjectReview(projectId)
  }
  saveProject(value: unknown): ProjectReview {
    const input = validateProjectReview(value)
    return this.db.transaction((tx) => {
      const old = this.project(input.projectId, tx)
      if (old.revision !== input.expectedRevision)
        throw new ApiError('PROJECT_REVIEW_CONFLICT', '项目补充要求已被更新，请刷新后再保存', 409)
      tx.run(
        `INSERT INTO project_review_settings VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET
        revision=excluded.revision,business_wrappers=excluded.business_wrappers,input_sources=excluded.input_sources,
        defense_conventions=excluded.defense_conventions,focus=excluded.focus,updated_at=excluded.updated_at`,
        input.projectId,
        old.revision + 1,
        input.businessWrappers,
        input.inputSources,
        input.defenseConventions,
        input.focus,
        new Date().toISOString()
      )
      return this.project(input.projectId, tx)
    })
  }
  freeze(
    tx: SqlSession,
    projectId: string,
    runId: string,
    references: unknown = [],
    expectedReview?: unknown
  ): RunReviewConfig {
    if (!Array.isArray(references) || references.length > 4)
      throw new ApiError('TEMPLATE_SELECTION_INVALID', '每个任务最多选择 4 个知识模板', 400)
    const refs = references.map((v) => {
      const ref = templateObject(v, ['templateId', 'revision'])
      templateId(ref.templateId)
      if (!Number.isSafeInteger(ref.revision) || Number(ref.revision) < 1)
        throw new ApiError('TEMPLATE_SELECTION_INVALID', '模板版本无效', 400)
      return ref as unknown as TemplateReference
    })
    if (new Set(refs.map((r) => r.templateId)).size !== refs.length)
      throw new ApiError('TEMPLATE_SELECTION_INVALID', '不能重复选择同一模板', 400)
    const templates = refs.map((ref) => {
      const latest = this.latest(ref.templateId, tx)
      if (!latest) throw new ApiError('TEMPLATE_NOT_FOUND', '所选模板不存在', 404)
      if (latest.revision !== ref.revision)
        throw new ApiError('TEMPLATE_SELECTION_STALE', '所选模板已更新，请刷新选择后创建任务', 409)
      return latest
    })
    const review = this.project(projectId, tx)
    if (
      expectedReview !== undefined &&
      (!Number.isSafeInteger(expectedReview) || expectedReview !== review.revision)
    )
      throw new ApiError(
        'PROJECT_REVIEW_CONFLICT',
        '创建任务前补充要求已变化，请重新读取并确认',
        409
      )
    if (utf8Bytes(JSON.stringify({ templates, projectReview: review })) > REVIEW_CONTEXT_BYTES)
      throw new ApiError(
        'TEMPLATE_CONTEXT_LIMIT',
        '所选模板及项目补充要求总计超过 12KiB，请缩减内容或选择数量',
        413
      )
    const config: RunReviewConfig = {
      projectId,
      runId,
      state: 'saved',
      templates,
      projectReview: review,
      contextHash: reviewContextHash(templates, review),
      createdAt: new Date().toISOString()
    }
    tx.run(
      'INSERT INTO run_review_configs VALUES (?,?,?,?,?)',
      runId,
      projectId,
      JSON.stringify(config),
      config.contextHash,
      config.createdAt
    )
    return config
  }
  run(projectId: string, runId: string): RunReviewConfig {
    templateId(projectId)
    templateId(runId)
    if (!this.db.get('SELECT id FROM audit_runs WHERE id=? AND project_id=?', runId, projectId))
      throw new ApiError('CHAIN_NOT_FOUND', '任务不属于指定项目', 404)
    const row = this.db.get(
      'SELECT * FROM run_review_configs WHERE project_id=? AND run_id=?',
      projectId,
      runId
    )
    if (!row) {
      const review = emptyProjectReview(projectId)
      return {
        projectId,
        runId,
        state: 'legacy-missing',
        templates: [],
        projectReview: review,
        contextHash: reviewContextHash([], review),
        createdAt: null
      }
    }
    let config: unknown
    try {
      config = JSON.parse(String(row.context_json))
    } catch {
      /* 后续统一报告损坏。 */
    }
    if (
      !isRunReviewConfig(config) ||
      config.state !== 'saved' ||
      config.projectId !== projectId ||
      config.runId !== runId ||
      config.contextHash !== row.context_hash ||
      config.contextHash !== reviewContextHash(config.templates, config.projectReview)
    )
      throw new ApiError('RUN_REVIEW_CORRUPT', '任务审查配置损坏，停止使用；请创建新任务', 409)
    return config
  }
}
