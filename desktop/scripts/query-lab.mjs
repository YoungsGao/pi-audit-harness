// Reproducible local CodeGraph exercise; never invokes a model/provider.
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { queryOnce } from './query-cli.mjs'
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [mode, file] = process.argv.slice(2)
if (mode === 'init' && !file) {
  const { openStorage } = await import('../src/service/storage/schema.ts')
  const { SourceRepository } = await import('../src/service/sources/repository.ts')
  const { importLocal } = await import('../src/service/sources/local.ts')
  const { CodeQueryService } = await import('../src/service/query/service.ts')
  const { CallChainService } = await import('../src/service/chains/service.ts')
  const { CallChainRepository } = await import('../src/service/storage/call-chain-repository.ts')
  const base = resolve(desktop, '../.local/query-lab')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'lab-')),
    source = join(root, 'source'),
    dataRoot = join(root, 'runtime')
  await mkdir(source)
  const web =
    'package demo; class Web { Service service; @GetMapping("/q") String query(String input) throws Exception { service.search(input); return service.search(input); } } @interface GetMapping { String value(); }'
  const serviceText =
    'package demo; class Service { Repo repo; String search(String input) throws Exception { return repo.query(input); } String search(int input) { return "n"; } }'
  await writeFile(join(source, 'Web.java'), web)
  await writeFile(join(source, 'Service.java'), serviceText)
  await writeFile(
    join(source, 'Repo.java'),
    'package demo; import java.sql.Statement; class Repo { Statement stmt; String query(String input) throws Exception { stmt.executeQuery("SELECT "+input); return input; } }'
  )
  const db = openStorage(dataRoot),
    sources = new SourceRepository(db),
    query = new CodeQueryService(sources, { dataRoot }),
    chains = new CallChainService(new CallChainRepository(db), query)
  try {
    const project = await importLocal(sources, { projectName: 'CodeGraph亲手实验', path: source })
    const run = await chains.action('prepare', { projectId: project.projectId })
    const lab = {
      root,
      source,
      dataRoot,
      labFile: join(root, 'lab.json'),
      projectId: project.projectId,
      runId: run.runId,
      callColumn: web.indexOf('search(input)') + 1,
      declarationColumn: serviceText.indexOf('search(String') + 1
    }
    await writeFile(lab.labFile, JSON.stringify(lab, null, 2))
    // Legacy PowerShell code pages must preserve JSON punctuation and Unicode values.
    const json = JSON.stringify({ ...lab, warnings: run.warnings }, null, 2)
    console.log(
      json.replace(
        /[\u0080-\uffff]/g,
        (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')
      )
    )
  } finally {
    await chains.close()
    await query.close()
    db.close()
  }
} else if (mode === 'query' && file) {
  const lab = JSON.parse(await readFile(resolve(file), 'utf8')),
    token = randomBytes(32).toString('hex')
  const child = spawn(
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/query-service.mjs'],
    {
      cwd: desktop,
      windowsHide: true,
      env: { ...process.env, PI_AUDIT_DATA_ROOT: lab.dataRoot, PI_AUDIT_QUERY_TOKEN: token },
      stdio: ['pipe', 'pipe', 'inherit']
    }
  )
  child.stdin.on('error', () => {})
  const exited = once(child, 'close'),
    output = createInterface({ input: child.stdout })
  let input, timer
  try {
    const ready = await Promise.race([
      once(output, 'line').then(([line]) => JSON.parse(line)),
      exited.then(() => {
        throw Error('QUERY_LAB_EXITED')
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('QUERY_LAB_TIMEOUT')), 10000)
      })
    ])
    clearTimeout(timer)
    if (ready.state !== 'ready') throw Error(ready.errorCode)
    console.log('输入操作名或一行JSON；quit退出。令牌只在父/子进程内传递。')
    console.log('definition列号=' + lab.callColumn + '；Service声明列号=' + lab.declarationColumn)
    input = createInterface({ input: process.stdin })
    for await (const line of input) {
      if (line.trim() === 'quit') break
      if (!line.trim()) continue
      try {
        const value = line.trim().startsWith('{') ? JSON.parse(line) : { operation: line.trim() }
        const result = await queryOnce(
          { projectId: lab.projectId, runId: lab.runId, language: 'java', ...value },
          { port: ready.port, token }
        )
        console.log(JSON.stringify(result, null, 2))
      } catch (error) {
        console.log(error.message)
      }
    }
  } finally {
    clearTimeout(timer)
    input?.close()
    output.close()
    child.stdin.end('shutdown\n')
    const guard = setTimeout(() => child.kill(), 10000)
    await exited
    clearTimeout(guard)
  }
} else {
  console.error('用法：node scripts/query-lab.mjs init | query <本次lab.json>')
  process.exitCode = 2
}
