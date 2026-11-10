// Inspect the produced app rather than trusting source-directory ignore patterns.
import assert from 'node:assert/strict'
import { listPackage } from '@electron/asar'
import { access, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const unpacked = resolve(process.argv[2])
const files = listPackage(join(unpacked, 'resources/app.asar'))
const forbidden = files.filter((file) => {
  const parts = file.replaceAll('\\', '/').split('/').filter(Boolean)
  if (!['out', 'node_modules', 'package.json'].includes(parts[0])) return true
  return (
    parts[0] !== 'node_modules' &&
    /(?:\.sqlite3(?:-|$)|\.jsonl$|(?:^|\/)\.env(?:\.|$))/.test(parts.join('/'))
  )
})
assert.deepEqual(
  forbidden,
  [],
  'Only compiled out, locked modules and package.json may enter app.asar'
)
for (const path of [
  'delivery/LICENSE',
  'delivery/desktop/package-lock.json',
  'delivery/THIRD_PARTY_NOTICES.md',
  'delivery/docs/technical/15.质量验收性能基线与交付.md',
  'delivery/docs/technical/16.真实模型输出可靠性与工程纠错.md',
  'delivery/docs/technical/assets/reliability-2026-11-10.json',
  'delivery/skills/code-query/SKILL.md',
  'delivery/samples/example-report.json',
  'compliance/inventory.json',
  'compliance/CODEGRAPH-NODE-LICENSE.txt',
  'codegraph-worker.cjs',
  'codegraph-packages/codegraph-win32-x64/node.exe'
])
  await access(join(unpacked, 'resources', path))
const result = {
  ok: true,
  asarEntries: files.length,
  forbiddenEntries: 0,
  allowedApplicationRoots: ['out', 'node_modules', 'package.json'],
  offlineResourcesPresent: true
}
await writeFile(
  join(unpacked, '../package-content-check.json'),
  JSON.stringify(result, null, 2) + '\n'
)
console.log(JSON.stringify(result))
