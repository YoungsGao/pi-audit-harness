// 后端离线入口：不启动模型、不访问网络；只读目标 Java 源码，写入指定的数据目录。
import { resolve } from 'node:path'
import { openStorage } from '../src/service/storage/schema.ts'
import { SourceRepository } from '../src/service/sources/repository.ts'
import { importLocal } from '../src/service/sources/local.ts'
import { CodeQueryService } from '../src/service/query/service.ts'
import { CallChainRepository } from '../src/service/storage/call-chain-repository.ts'
import { CallChainService } from '../src/service/chains/service.ts'

if (process.argv.length !== 4) {
  console.error('用法: node scripts/prepare-call-chains.mjs <Java源码目录> <应用数据目录>')
  process.exitCode = 2
} else {
  let db, queries, chains
  try {
    db = openStorage(resolve(process.argv[3]))
    const sources = new SourceRepository(db)
    const project = await importLocal(sources, {
      projectName: '离线候选调用登记',
      path: resolve(process.argv[2]),
      duplicate: 'new'
    })
    queries = new CodeQueryService(sources)
    const repo = new CallChainRepository(db)
    chains = new CallChainService(repo, queries)
    const prepared = await chains.action('prepare', {
      projectId: project.projectId,
      maxResults: 100
    })
    console.log(
      JSON.stringify(
        {
          database: db.filePath,
          ...prepared,
          paths: repo.list({ projectId: project.projectId, runId: prepared.runId, limit: 100 })
            .paths,
          statistics: repo.scans.statistics(project.projectId, prepared.runId)
        },
        null,
        2
      )
    )
  } catch (error) {
    console.error(error.code ?? 'DEMO_FAILED', error.message)
    process.exitCode = 1
  } finally {
    await chains?.close()
    await queries?.close()
    db?.close()
  }
}
