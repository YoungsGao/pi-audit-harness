import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { openStorage } from '../src/service/storage/schema.ts'
import { SourceRepository } from '../src/service/sources/repository.ts'
import { importLocal } from '../src/service/sources/local.ts'
import { CodeQueryService } from '../src/service/query/service.ts'
import { CallChainRepository } from '../src/service/storage/call-chain-repository.ts'
import { CallChainService } from '../src/service/chains/service.ts'
export const acceptanceRoot = resolve(import.meta.dirname, '../../fixtures/acceptance')
export const digest = (text) => createHash('sha256').update(text).digest('hex')
export async function qaRoot(name) {
  const base = resolve(import.meta.dirname, '../../.local/qa', name)
  await mkdir(base, { recursive: true })
  return mkdtemp(join(base, 'run-'))
}
export async function openHarness(root) {
  const dataRoot = join(root, 'runtime'),
    db = openStorage(dataRoot),
    sources = new SourceRepository(db)
  const query = new CodeQueryService(sources, { dataRoot }),
    repo = new CallChainRepository(db),
    chains = new CallChainService(repo, query)
  return {
    root,
    dataRoot,
    db,
    sources,
    query,
    repo,
    chains,
    async close() {
      await chains.close()
      await query.close()
      db.close()
    }
  }
}
export async function prepareCase(h, item) {
  const project = await importLocal(h.sources, {
    projectName: item.id,
    path: join(acceptanceRoot, item.id),
    duplicate: 'new'
  })
  const prepared = await h.chains.action('prepare', { projectId: project.projectId })
  const scope = { projectId: project.projectId, runId: prepared.runId }
  return { project, prepared, scope }
}
export async function authorize(h, scope, configId) {
  const target = { ...scope, modelConfigId: configId }
  const disclosure = await h.chains.action('disclosure', target)
  await h.chains.action('authorize', { ...target, scopeKey: disclosure.scopeKey })
}
export async function writeResult(root, name, value) {
  await writeFile(join(root, name), JSON.stringify(value, null, 2) + '\n')
}
export async function loadManifest() {
  return JSON.parse(await readFile(join(acceptanceRoot, 'manifest.json'), 'utf8'))
}
