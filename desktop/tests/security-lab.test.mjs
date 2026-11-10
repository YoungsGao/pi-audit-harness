import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, relative, isAbsolute } from 'node:path'
import { rm, readFile } from 'node:fs/promises'
const run = promisify(execFile)
test('SEC lab emits PowerShell-safe JSON, creates fresh CodeGraph scope and completes offline checks/reports', async () => {
  const options = { cwd: resolve(import.meta.dirname, '..'), timeout: 60000, windowsHide: true }
  const init = await run(
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/security-lab.mjs', 'init'],
    options
  )
  assert.ok(Array.from(init.stdout).every((c) => c.charCodeAt(0) < 128))
  const lab = JSON.parse(init.stdout)
  const base = resolve(options.cwd, '../.local/security-lab'),
    target = resolve(lab.root),
    rel = relative(base, target)
  assert.ok(
    rel && !isAbsolute(rel) && !rel.startsWith('..'),
    'lab cleanup must remain in the expected workspace directory'
  )
  try {
    const checked = await run(
      process.execPath,
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        'scripts/security-lab.mjs',
        'check',
        lab.labFile
      ],
      options
    )
    assert.ok(Array.from(checked.stdout).every((c) => c.charCodeAt(0) < 128))
    const result = JSON.parse(checked.stdout)
    assert.equal(result.ok, true)
    assert.equal(result.backend, 'codegraph')
    assert.equal(result.sourceUnchanged, true)
    assert.equal(result.projectScriptExecuted, false)
    assert.equal(result.modelRequests, 0)
    assert.deepEqual(result.snapshotFiles, ['Demo.java'])
    assert.equal(result.reports.length, 2)
    for (const report of result.reports) {
      const text = await readFile(report.filePath, 'utf8')
      if (report.format === 'json') assert.equal(JSON.parse(text).schema, 'pi-audit-harness.report')
      else {
        assert.ok(text.includes('Content-Security-Policy'))
        assert.ok(!text.includes('<script>'))
      }
    }
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})
