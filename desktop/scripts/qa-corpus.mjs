import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { cases, corpusVersion } from '../qa/corpus.mjs'
const target = resolve(import.meta.dirname, '../../fixtures/acceptance')
const sha = (text) => createHash('sha256').update(text).digest('hex')
if (process.argv[2] === 'init') {
  await mkdir(target, { recursive: true })
  for (const item of cases) {
    await mkdir(join(target, item.id), { recursive: true })
    await writeFile(join(target, item.id, item.fileName), item.source)
  }
  await writeFile(
    join(target, 'manifest.json'),
    JSON.stringify(
      {
        version: corpusVersion,
        split: 'acceptance',
        annotationPolicy:
          'reference labels with rationale; not copied from development fixtures; not provider-generated labels',
        cases: cases.map(({ source, ...rest }) => ({ ...rest, sha256: sha(source) }))
      },
      null,
      2
    ) + '\n'
  )
  console.log('Generated ' + cases.length + ' acceptance cases at ' + target)
} else {
  const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))
  assert.equal(manifest.version, corpusVersion)
  assert.equal(manifest.cases.length, 18)
  const dev = new Set()
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (file.endsWith('.java')) dev.add(sha(await readFile(file)))
    }
  }
  await walk(resolve(import.meta.dirname, '../tests/fixtures'))
  for (const item of manifest.cases) {
    const actual = sha(await readFile(join(target, item.id, item.fileName)))
    assert.equal(actual, item.sha256)
    assert.equal(dev.has(actual), false, item.id + ' duplicates a development fixture')
  }
  for (const category of ['sql-injection', 'command-injection', 'path-traversal'])
    for (const expected of ['dangerous', 'safe'])
      assert.ok(
        manifest.cases.filter((c) => c.category === category && c.expected === expected).length >= 2
      )
  assert.equal(manifest.cases.filter((c) => c.expected === 'unknown').length, 6)
  console.log(
    JSON.stringify({ ok: true, version: corpusVersion, cases: 18, independentOfDevelopment: true })
  )
}
