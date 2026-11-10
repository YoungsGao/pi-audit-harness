// Launches only a task-owned build/profile. CDP is enabled only for this local acceptance process.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { qaRoot } from '../qa/harness.mjs'
import { createAgentModelFixture } from '../tests/agent-model-fixture.mjs'
const installer = resolve(process.argv[2]),
  root = await qaRoot('installed'),
  target = join(root, 'app'),
  profile = join(root, 'profile')
const rel = relative(resolve(import.meta.dirname, '../../.local/qa'), root)
assert.ok(
  rel && !isAbsolute(rel) && !rel.startsWith('..'),
  'Installation/profile must be task owned'
)
await mkdir(target)
const run = promisify(execFile)
// NSIS upgrades can uninstall an existing registered application even with /D.
// Refuse to touch a personal install; only task-owned QA installs may be replaced.
const registry = await run(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'pi-audit-harness' } | Select-Object InstallLocation) | ConvertTo-Json -Compress"
  ],
  { windowsHide: true, timeout: 15000 }
)
const registered = JSON.parse(registry.stdout.trim() || '[]')
for (const entry of Array.isArray(registered) ? registered : [registered]) {
  const location = typeof entry.InstallLocation === 'string' ? resolve(entry.InstallLocation) : ''
  const owned = location
    ? relative(resolve(import.meta.dirname, '../../.local/qa/installed'), location)
    : '..'
  assert.ok(
    location && owned && !owned.startsWith('..') && !isAbsolute(owned),
    'An existing personal installation was found; use test:reliability or a clean installation-test environment'
  )
}
await run(installer, ['/S', '/D=' + target], { windowsHide: true, timeout: 120000 })
const exe = join(target, 'pi-audit-harness.exe')
await access(exe)
const portProbe = createServer()
await new Promise((r) => portProbe.listen(0, '127.0.0.1', r))
const port = portProbe.address().port
await new Promise((r) => portProbe.close(r))
const child = spawn(exe, ['--remote-debugging-port=' + port, '--user-data-dir=' + profile], {
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
})
let logs = '',
  socket,
  model,
  ownCredentialCreated = false,
  credentialError
child.stdout.on('data', (b) => {
  logs += b.toString()
})
child.stderr.on('data', (b) => {
  logs += b.toString()
})
const pending = new Map()
let next = 0
async function until(check, label) {
  const end = Date.now() + 45000
  while (!(await check())) {
    if (Date.now() > end) throw Error(label + ' timeout')
    await new Promise((r) => setTimeout(r, 100))
  }
}
function call(method, params = {}) {
  const id = ++next
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function js(expression) {
  const result = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails)
    throw Error('Installed renderer evaluation failed: ' + result.exceptionDetails.text)
  return result.result.value
}
try {
  let page
  await until(async () => {
    try {
      page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t) => t.type === 'page'
      )
      return !!page
    } catch {
      return false
    }
  }, 'installed window')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await once(socket, 'open')
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const work = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) work.reject(Error(message.error.message))
      else work.resolve(message.result)
    }
  })
  await until(() => js('typeof window.audit === "object"'), 'installed bridge')
  await until(
    () => js('window.audit.getServiceStatus().then(s=>s.status==="ready")'),
    'installed service'
  )
  assert.ok(
    logs.includes(profile),
    'Standard --user-data-dir was not applied; refuse to write user profile'
  )
  assert.equal(await js('typeof require'), 'undefined')
  const app = await js('window.audit.getAppInfo()')
  assert.equal(app.electron, '44.9.1')
  const imported = await js(
    `window.audit.importLocalSource(${JSON.stringify({ projectName: 'QA installed fixture', path: resolve(import.meta.dirname, '../../fixtures/acceptance/sql-positive-1') })})`
  )
  assert.ok(imported.ok)
  const prepared = await js(
    `window.audit.audit('prepare',${JSON.stringify({ projectId: imported.data.projectId })})`
  )
  assert.ok(prepared.ok)
  assert.ok(prepared.data.pathIds.length > 0)
  const scope = { projectId: imported.data.projectId, runId: prepared.data.runId },
    pathId = prepared.data.pathIds[0]
  let submissions = 0
  model = await createAgentModelFixture({
    mode: 'finish',
    transformDecision: (decision, { tools }) => {
      submissions++
      for (const step of decision.result.steps)
        step.quotes = [
          submissions === 1
            ? 'ev-invented'
            : tools.find((t) => t.stepIndex === step.stepIndex).citations[0].id
        ]
      return decision
    }
  })
  const saved = await js(
    `window.audit.saveModelConfig(${JSON.stringify({ name: 'QA installed local model', baseUrl: model.baseUrl, modelId: 'fixture', apiKey: 'local-fixture-key' })})`
  )
  assert.ok(saved.ok)
  ownCredentialCreated = true
  const modelConfigId = saved.data.model.configId
  const transmission = { ...scope, modelConfigId }
  const disclosure = await js(`window.audit.audit('disclosure',${JSON.stringify(transmission)})`)
  assert.ok(disclosure.ok)
  const allowed = await js(
    `window.audit.audit('authorize',${JSON.stringify({ ...transmission, scopeKey: disclosure.data.scopeKey })})`
  )
  assert.ok(allowed.ok)
  const started = await js(
    `window.audit.audit('analyze',${JSON.stringify({ ...transmission, pathId })})`
  )
  assert.ok(started.ok)
  let detail
  await until(async () => {
    const response = await js(
      `window.audit.audit('detail',${JSON.stringify({ ...scope, pathId })})`
    )
    if (!response.ok) return false
    detail = response.data
    return detail.status !== 'analyzing'
  }, 'installed Pi loop')
  assert.equal(detail.verdict, 'unknown')
  assert.ok(detail.steps.every((s) => s.evidence.length > 0))
  assert.ok(model.requests.length >= 2)
  assert.equal(
    submissions,
    2,
    'packaged agent must correct one rejected citation in the same attempt'
  )
  const history = await js(`window.audit.audit('history',${JSON.stringify({ ...scope, pathId })})`)
  assert.ok(history.ok)
  assert.ok(
    history.data.frames.some(
      (f) => f.event === 'validation_info' && f.data.details.payload.canRetry === true
    )
  )
  assert.equal(history.data.sessions[0].attemptId, 1)
  const generated = await js(`window.audit.reports('generate',${JSON.stringify(scope)})`)
  assert.ok(generated.ok)
  assert.equal(generated.data.status, 'ready')
  const html = await readFile(generated.data.filePath, 'utf8')
  assert.ok(html.includes('Content-Security-Policy'))
  const filter = { verdict: 'all', pathStatus: 'all', reviewStatus: 'all' }
  const preview = await js(
    `window.audit.reports('preview',${JSON.stringify({ ...scope, filter })})`
  )
  assert.ok(preview.ok, JSON.stringify(preview))
  const jsonReport = await js(
    `window.audit.reports('export',${JSON.stringify({ ...scope, format: 'json', filter, expectedSnapshotKey: preview.data.snapshotKey })})`
  )
  assert.ok(jsonReport.ok, JSON.stringify(jsonReport))
  const json = JSON.parse(await readFile(jsonReport.data.filePath, 'utf8'))
  assert.equal(
    json.queryGraph.backend,
    'codegraph',
    'packaged runtime must not silently fall back to basic'
  )
  assert.equal(json.paths.find((p) => p.pathId === pathId).verdict, detail.verdict)
  for (const file of [
    'delivery/LICENSE',
    'delivery/desktop/package-lock.json',
    'delivery/templates/builtin-rules.json',
    'delivery/skills/code-query/SKILL.md',
    'delivery/samples/example-report.json',
    'compliance/inventory.json',
    'compliance/CODEGRAPH-NODE-LICENSE.txt'
  ])
    await access(join(target, 'resources', file))
  await js(
    `localStorage.setItem('audit.detail.selection.v1',JSON.stringify(${JSON.stringify({ ...scope, pathId, tab: 'process' })}));Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='审计分析').click()`
  )
  await until(
    () => js('!!document.querySelector("[data-testid=validation-feedback]")'),
    'installed evidence view'
  )
  await js(
    'document.querySelector("[data-testid=validation-feedback]").scrollIntoView({block:"center"})'
  )
  const screenshot = await call('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(root, 'installed-window.png'), Buffer.from(screenshot.data, 'base64'))
  await writeFile(
    join(root, 'result.json'),
    JSON.stringify(
      {
        ok: true,
        installer,
        installedTo: target,
        profile,
        runtime: app,
        scope,
        pathId,
        model: 'local fixture through real packaged Pi SDK; no paid provider',
        modelRequests: model.requests.length,
        verdict: detail.verdict,
        evidenceSteps: detail.steps.length,
        graphBackend: json.queryGraph.backend,
        correctedSubmissions: submissions,
        reportId: generated.data.reportId,
        checks: [
          'actual NSIS installation',
          'packaged bridge/service',
          'real CodeGraph worker resource',
          'native credential write',
          'actual Pi tool loop',
          'saved evidence',
          'report command',
          'offline delivery resources'
        ]
      },
      null,
      2
    )
  )
} finally {
  socket?.close()
  await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(
    () => child.kill()
  )
  await model?.close()
  await writeFile(join(root, 'process.log'), logs)
  // The profile/database is retained for diagnostics. Only this test's fake credential is removed.
  const { DatabaseSync } = await import('node:sqlite')
  const { WindowsCredentialStore } = await import('../src/service/storage/credential-store.ts')
  let removedCredentials = 0
  try {
    const db = new DatabaseSync(join(profile, 'runtime/storage/audit.sqlite3'), { readOnly: true })
    const refs = db
      .prepare('SELECT secret_ref FROM model_configs WHERE name=?')
      .all('QA installed local model')
    db.close()
    if (ownCredentialCreated) assert.equal(refs.length, 1)
    for (const ref of refs)
      if (ref.secret_ref) {
        const store = new WindowsCredentialStore()
        await store.delete(ref.secret_ref)
        assert.equal(await store.read(ref.secret_ref), undefined)
        removedCredentials++
      }
  } catch (error) {
    if (ownCredentialCreated) credentialError = error
  }
  await run(join(target, 'Uninstall pi-audit-harness.exe'), ['/S'], {
    windowsHide: true,
    timeout: 120000
  })
  await until(async () => {
    try {
      await access(exe)
      return false
    } catch {
      return true
    }
  }, 'task-owned uninstall')
  await writeFile(
    join(root, 'cleanup.json'),
    JSON.stringify(
      {
        uninstalled: true,
        removedFakeCredentials: removedCredentials,
        fakeCredentialsRemoved: !credentialError,
        personalProfileUsed: false
      },
      null,
      2
    )
  )
}
if (credentialError) throw credentialError
console.log(
  'PASS QA-03 installed NSIS -> isolated profile -> real CodeGraph -> Pi tools -> evidence -> HTML/JSON -> offline materials -> uninstall and credential cleanup'
)
console.log('QA_INSTALLED_ROOT=' + root)
