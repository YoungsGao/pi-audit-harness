import { ApiError } from '../../shared/api-error.ts'
import { SourceRepository } from './repository.ts'
import { importLocal, openProject, input, text } from './local.ts'
import { importGithub } from './github.ts'
import { detectTools } from './tools.ts'
import type { LocalDatabase } from '../storage/database'
import type { SourceTools, SourceCatalog } from '../../shared/source-contracts'
export class SourceService {
  private repo: SourceRepository
  private root: string
  private busy = false
  private closing = new AbortController()
  private task?: Promise<unknown>
  constructor(db: LocalDatabase, root: string) {
    this.repo = new SourceRepository(db)
    this.root = root
  }
  tools(signal?: AbortSignal): Promise<SourceTools> {
    return detectTools(AbortSignal.any([this.closing.signal, ...(signal ? [signal] : [])]))
  }
  list(): SourceCatalog {
    return this.repo.catalog()
  }
  async action(
    action: 'local' | 'github' | 'open',
    value: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.closing.signal.aborted) throw new ApiError('SOURCE_CANCELLED', '源码服务正在关闭', 503)
    if (this.busy) throw new ApiError('SOURCE_BUSY', '已有源码操作执行中，请等待完成', 409, true)
    this.busy = true
    const combined = AbortSignal.any([this.closing.signal, ...(signal ? [signal] : [])])
    this.task = (async () => {
      if (action === 'local') return importLocal(this.repo, value, combined)
      if (action === 'github') return importGithub(this.repo, this.root, value, combined)
      const row = input(value, ['projectId'])
      return openProject(this.repo, text(row.projectId, 80), combined)
    })()
    try {
      return await this.task
    } finally {
      this.busy = false
      this.task = undefined
    }
  }
  async close(): Promise<void> {
    this.closing.abort()
    await this.task?.catch(() => {})
  }
}
