import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'

test('QRY-02 lab init preserves JSON and Chinese warnings across Windows pipe encodings', async (t) => {
  const desktop = resolve(import.meta.dirname, '..')
  const fixtureRoot = resolve(desktop, '../.local/query-lab')
  for (const backend of ['basic', 'codegraph']) {
    const child = spawn(
      process.execPath,
      ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/query-lab.mjs', 'init'],
      {
        cwd: desktop,
        windowsHide: true,
        env: { ...process.env, PI_AUDIT_QUERY_BACKEND: backend },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    const stdout = [],
      stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    const timeout = setTimeout(() => child.kill(), 20000)
    let code
    try {
      code = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
    } finally {
      clearTimeout(timeout)
    }
    assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'))
    const bytes = Buffer.concat(stdout)
    const lab = JSON.parse(bytes.toString('utf8'))
    const root = resolve(lab.root)
    assert.equal(dirname(root), fixtureRoot)
    assert.match(basename(root), /^lab-[A-Za-z0-9]+$/)
    t.after(() => rm(root, { recursive: true, force: true }))

    assert.doesNotMatch(bytes.toString('utf8'), /[\u0080-\uffff]/)
    for (const encoding of ['utf-8', 'gbk', 'big5', 'windows-1252']) {
      assert.deepEqual(JSON.parse(new TextDecoder(encoding).decode(bytes)), lab)
    }
    assert.ok(lab.warnings.some((warning) => /\p{Script=Han}/u.test(warning.message)))
    const saved = JSON.parse(await readFile(lab.labFile, 'utf8'))
    const { warnings, ...metadata } = lab
    assert.deepEqual(saved, metadata)
    assert.ok(warnings.length)
  }
})
