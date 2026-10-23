import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { openStorage } from '../src/service/storage/schema.ts'
import { MetadataRepository } from '../src/service/storage/metadata-repository.ts'
import { parseProject, parseModel } from '../src/service/storage/metadata-validation.ts'
import { inspectProject } from '../src/service/storage/project-source.ts'
import { isMetadataOverview } from '../src/shared/metadata-contracts.ts'
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-db02-metadata-')),
    db = openStorage(root)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, db, repo: new MetadataRepository(db) }
}
test('local project allows null URL; stable project ID and optimistic revision', async (t) => {
  const { root, repo } = setup(t),
    input = parseProject({ projectName: '本地教学项目', path: root, sourceType: 'local' })
  const saved = repo.saveProject(input, await inspectProject(input))
  assert.equal(saved.gitUrl, null)
  assert.equal(saved.commit, null)
  const edit = parseProject({
    ...input,
    projectId: saved.projectId,
    expectedRevision: 1,
    projectName: '重命名'
  })
  assert.equal(repo.saveProject(edit, await inspectProject(edit)).projectId, saved.projectId)
  assert.throws(() => repo.saveProject(edit, { path: root, commit: null, dirty: null }), {
    code: 'METADATA_REVISION_CONFLICT'
  })
  assert.equal(repo.overview().projects[0].revision, 2)
})
test('Git source records actual HEAD and dirty status; metadata save never fetches', async (t) => {
  const { root, repo } = setup(t)
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim()
  git('init', '--quiet')
  writeFileSync(join(root, 'Demo.java'), 'class Demo {}\n')
  git('add', 'Demo.java')
  git(
    '-c',
    'user.name=DB02 Fixture',
    '-c',
    'user.email=db02@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture'
  )
  const input = parseProject({
    projectName: 'Git教学项目',
    path: root,
    sourceType: 'git',
    gitUrl: 'https://github.com/example/fixture.git'
  })
  const saved = repo.saveProject(input, await inspectProject(input))
  assert.equal(saved.commit, git('rev-parse', 'HEAD'))
  // 数据库在测试根目录中，因此存在未跟踪测试数据，dirty 应如实报告。
  assert.equal(saved.dirty, true)
  assert.equal(saved.needsMetadata, false)
})
test('strict input validation rejects client commit, secretRef, unsafe URL, stale identity and plaintext overflow', () => {
  const project = { projectName: 'p', path: 'C:/source', sourceType: 'local' }
  assert.throws(() => parseProject({ ...project, commit: 'made-up' }), { code: 'INVALID_METADATA' })
  assert.throws(() => parseProject({ ...project, sourceType: 'git' }), { code: 'INVALID_METADATA' })
  const model = { name: 'm', baseUrl: 'https://example.invalid/v1', modelId: 'explicit-model' }
  for (const extra of [
    { secretRef: 'foreign' },
    { baseUrl: 'https://user:key@example.invalid' },
    { baseUrl: 'https://example.invalid?key=hidden' },
    { apiKey: '\n' },
    { apiKey: 'x'.repeat(2049) },
    { configId: 'saved-id' }
  ])
    assert.throws(() => parseModel({ ...model, ...extra }), { code: 'INVALID_METADATA' })
})
test('non-sensitive model fields persist; DTO never exposes API key or secret reference', (t) => {
  const { repo } = setup(t),
    input = parseModel({
      name: '测试模型',
      baseUrl: 'https://example.invalid/v1/',
      modelId: 'chosen-model'
    })
  const first = repo.commitModel(input, 'fixture-config', null)
  assert.equal(first.configId, 'fixture-config')
  assert.equal(first.credentialState, 'missing')
  const edit = parseModel({ ...input, configId: first.configId, expectedRevision: 1, name: '改名' })
  const updated = repo.commitModel(edit, first.configId, null)
  assert.equal(updated.revision, 2)
  assert.equal(updated.configId, first.configId)
  assert.ok(isMetadataOverview(repo.overview()))
  assert.equal(JSON.stringify(repo.overview()).includes('secretRef'), false)
  assert.equal(JSON.stringify(repo.overview()).includes('apiKey'), false)
})
