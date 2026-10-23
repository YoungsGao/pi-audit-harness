import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openStorage } from '../src/service/storage/schema.ts'
import { SourceRepository } from '../src/service/sources/repository.ts'
import { SourceService } from '../src/service/sources/service.ts'
import { importLocal } from '../src/service/sources/local.ts'
import { importGithub } from '../src/service/sources/github.ts'
import { scanJava } from '../src/service/sources/scan.ts'
test('missing Git blocks download while local Java import succeeds without Git', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-source-nogit-')),
    db = openStorage(join(root, 'runtime'))
  t.after(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  const path = join(root, 'source')
  await mkdir(path)
  await writeFile(join(path, 'Demo.java'), 'class Demo{}')
  const previous = process.env.PATH
  process.env.PATH = ''
  try {
    const repo = new SourceRepository(db)
    await assert.rejects(
      importGithub(repo, join(root, 'runtime'), { gitUrl: 'https://github.com/fixture/source' }),
      { code: 'GIT_REQUIRED' }
    )
    assert.equal((await importLocal(repo, { projectName: 'No Git', path })).sourceType, 'local')
  } finally {
    process.env.PATH = previous
  }
})
test('directory junction not followed, oversize file refused, closing cancels active work and rejects new work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-source-limits-')),
    db = openStorage(join(root, 'runtime')),
    service = new SourceService(db, join(root, 'runtime'))
  t.after(async () => {
    await service.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  const path = join(root, 'source'),
    outside = join(root, 'outside')
  await mkdir(path)
  await mkdir(outside)
  await writeFile(join(outside, 'Hidden.java'), 'outside')
  await symlink(outside, join(path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(scanJava(path), { code: 'SOURCE_NO_JAVA' })
  await writeFile(join(path, 'Big.java'), Buffer.alloc(2 * 1024 * 1024 + 1))
  await assert.rejects(scanJava(path), { code: 'SOURCE_LIMIT' })
  const pending = service.action('local', { projectName: 'cancel', path })
  await assert.rejects(service.action('local', { projectName: 'busy', path }), {
    code: 'SOURCE_BUSY'
  })
  const cancelled = assert.rejects(pending, { code: 'SOURCE_CANCELLED' })
  await service.close()
  await cancelled
  await assert.rejects(service.action('local', { projectName: 'closed', path }), {
    code: 'SOURCE_CANCELLED'
  })
})
