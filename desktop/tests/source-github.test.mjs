import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStorage } from '../src/service/storage/schema.ts'
import { SourceRepository } from '../src/service/sources/repository.ts'
import { githubUrl, importGithub } from '../src/service/sources/github.ts'
import { command } from '../src/service/sources/process.ts'
test('GitHub URL whitelist and canonicalization reject credentials, branch URLs, traversal and protocols', () => {
  assert.equal(
    githubUrl('https://github.com/spring-guides/gs-rest-service').url,
    'https://github.com/spring-guides/gs-rest-service.git'
  )
  for (const url of [
    'http://github.com/a/b',
    'https://user:pass@github.com/a/b',
    'https://github.com/a/b/tree/main',
    'https://github.com.evil/a/b',
    'file:///repo',
    'git@github.com:a/b',
    'https://github.com/a/b?token=x',
    'https://github.com/a/%2e%2e'
  ])
    assert.throws(() => githubUrl(url))
})
test('actual Git local transport fixture clones to own directory; duplicate open has no clone, new is distinct, failure cleans only own partial', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-source-git-'))
  const db = openStorage(join(root, 'runtime'))
  t.after(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  const origin = join(root, 'origin')
  await mkdir(origin)
  await writeFile(join(origin, 'Demo.java'), 'class Demo{}')
  await command('git', ['-C', origin, 'init', '--quiet'])
  await command('git', ['-C', origin, 'add', 'Demo.java'])
  await command('git', [
    '-C',
    origin,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture'
  ])
  const repo = new SourceRepository(db)
  let calls = 0
  const clone = async (c) => {
    calls++
    await command('git', ['clone', '--quiet', '--no-hardlinks', '--', origin, c.destination], {
      signal: c.signal
    })
  }
  const args = { gitUrl: 'https://github.com/fixture/source' }
  const a = await importGithub(repo, join(root, 'runtime'), args, undefined, clone)
  assert.match(a.commit, /^[a-f0-9]{40,64}$/)
  assert.equal(a.dirty, false)
  assert.ok(a.path.startsWith(join(root, 'runtime', 'repositories')))
  await assert.rejects(importGithub(repo, join(root, 'runtime'), args, undefined, clone), {
    code: 'SOURCE_DUPLICATE'
  })
  assert.equal(
    (
      await importGithub(
        repo,
        join(root, 'runtime'),
        { ...args, duplicate: 'open' },
        undefined,
        clone
      )
    ).projectId,
    a.projectId
  )
  assert.equal(calls, 1)
  const b = await importGithub(
    repo,
    join(root, 'runtime'),
    { ...args, duplicate: 'new' },
    undefined,
    clone
  )
  assert.notEqual(a.path, b.path)
  await assert.rejects(
    importGithub(
      repo,
      join(root, 'runtime'),
      { gitUrl: 'https://github.com/fixture/fail' },
      undefined,
      async (c) => {
        await mkdir(c.destination)
        throw Error('controlled clone failure')
      }
    )
  )
  assert.equal(
    (await readdir(join(root, 'runtime', 'repositories'))).filter((x) => x.startsWith('.partial-'))
      .length,
    0
  )
  assert.equal(repo.catalog().total, 2)
})
