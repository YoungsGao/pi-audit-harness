import { mkdir, copyFile, cp, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { builtinRules } from '../src/service/rules/builtin.ts'
const desktop = resolve(import.meta.dirname, '..'),
  root = resolve(desktop, '..'),
  out = join(desktop, 'resources/delivery')
await mkdir(out, { recursive: true })
for (const name of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'])
  await copyFile(join(root, name), join(out, name))
await mkdir(join(out, 'docs'), { recursive: true })
await cp(join(root, 'docs/technical'), join(out, 'docs/technical'), { recursive: true })
await mkdir(join(out, 'desktop'), { recursive: true })
await copyFile(join(desktop, 'README.md'), join(out, 'desktop/README.md'))
for (const name of ['package.json', 'package-lock.json'])
  await copyFile(join(desktop, name), join(out, 'desktop', name))
await cp(join(desktop, 'query-skill'), join(out, 'desktop/query-skill'), { recursive: true })
await mkdir(join(out, 'skills'), { recursive: true })
await cp(join(desktop, 'query-skill'), join(out, 'skills/code-query'), { recursive: true })
await mkdir(join(out, 'templates'), { recursive: true })
await writeFile(
  join(out, 'templates/builtin-rules.json'),
  JSON.stringify(builtinRules, null, 2) + '\n'
)
await cp(join(root, 'fixtures/acceptance'), join(out, 'samples/acceptance'), { recursive: true })
const example = resolve(process.argv[2] ?? '../.local/qa/acceptance/run-zZrQfz')
for (const [from, to] of [
  ['example-report.html', 'samples/example-report.html'],
  ['example-report.json', 'samples/example-report.json']
])
  await copyFile(join(example, from), join(out, to))
await writeFile(
  join(out, 'samples/README.md'),
  '# Acceptance samples and demonstration report\n\nThe 18 source samples are independently authored. The demonstration report uses the local deterministic protocol oracle, not a paid model and not a measured vulnerability accuracy result. Reference-model results and known limitations are documented separately.\n'
)
await writeFile(
  join(out, 'DELIVERY.md'),
  '# Packaged offline materials\n\nREADME and LICENSE are project materials. docs/technical contains the specifications and operation commands; skills/code-query is a query usage document, not automatically executed; templates/builtin-rules.json is the pinned built-in catalog; samples contains original acceptance sources and HTML/JSON demonstrations. ../compliance retains third-party inventories and notices. No API keys, personal databases, Pi sessions, or private learning notes are included.\n'
)
console.log('Release assets staged at ' + out)
