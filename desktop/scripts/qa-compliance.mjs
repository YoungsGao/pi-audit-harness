// Inventory the runtime lock and the actual nested CodeGraph bundle. Retain upstream license texts.
import { readFile, readdir, mkdir, writeFile, copyFile, lstat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
const desktop = resolve(import.meta.dirname, '..'),
  out = join(desktop, 'resources/compliance')
await mkdir(join(out, 'licenses'), { recursive: true })
const lockBytes = await readFile(join(desktop, 'package-lock.json')),
  lock = JSON.parse(lockBytes)
const packages = [],
  seen = new Set()
async function inspect(path, origin) {
  let pkg
  try {
    pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
  } catch {
    return
  }
  const id = pkg.name + '@' + pkg.version
  if (seen.has(id)) return
  seen.add(id)
  const texts = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name)) {
      const file = `licenses/${createHash('sha256').update(id).digest('hex').slice(0, 16)}-${entry.name}`
      await copyFile(join(path, entry.name), join(out, file))
      texts.push(file)
    }
  }
  packages.push({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license ?? 'NOT-DECLARED',
    repository: typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? null),
    origin,
    licenseTexts: texts
  })
}
for (const [path, pkg] of Object.entries(lock.packages))
  if (path && !pkg.dev && !pkg.devOptional)
    await inspect(join(desktop, path), 'desktop runtime lock')
async function scanModules(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (!entry.isDirectory() || (await lstat(path)).isSymbolicLink() || entry.name.startsWith('.'))
      continue
    if (entry.name.startsWith('@')) {
      await scanModules(path)
      continue
    }
    await inspect(path, 'CodeGraph self-contained bundle')
    await scanModules(join(path, 'node_modules'))
  }
}
for (const entry of await readdir(join(desktop, 'node_modules/@colbymchenry'), {
  withFileTypes: true
})) {
  if (entry.isDirectory() && /^codegraph-(win32|linux|darwin)-/.test(entry.name)) {
    const root = join(desktop, 'node_modules/@colbymchenry', entry.name)
    await inspect(join(root, 'lib'), 'CodeGraph embedded SDK')
    await scanModules(join(root, 'lib/node_modules'))
  }
}
packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
const inventory = {
  generatedAt: new Date().toISOString(),
  lockSha256: createHash('sha256').update(lockBytes).digest('hex'),
  scope:
    'installed desktop runtime lock + actual nested CodeGraph package metadata; Electron/Chromium and embedded Node have separate notices',
  packages
}
await writeFile(join(out, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n')
await copyFile(resolve(desktop, '../LICENSE'), join(out, 'PROJECT-LICENSE.txt'))
const text = [
  '# Third-party components',
  '',
  'This inventory records declared licenses, not a legal compatibility certification. Bundled upstream code retains its own terms. Electron/Chromium notices are shipped by electron-builder; the CodeGraph embedded Node license is included separately.',
  '',
  `Runtime lock SHA256: ${inventory.lockSha256}`,
  '',
  '| Component | Declared license | Copied license files |',
  '| --- | --- | --- |',
  ...packages.map(
    (p) =>
      `| ${p.name}@${p.version} | ${typeof p.license === 'string' ? p.license : JSON.stringify(p.license)} | ${p.licenseTexts.length} |`
  ),
  '',
  'Do not remove upstream notices. Components without an adjacent license file are recorded explicitly; consult the pinned upstream package/source before redistributing a modified bundle.',
  ''
].join('\n')
await writeFile(join(out, 'THIRD-PARTY-NOTICES.md'), text)
console.log(
  JSON.stringify({
    packages: packages.length,
    licenseTexts: packages.reduce((n, p) => n + p.licenseTexts.length, 0),
    undeclared: packages.filter((p) => p.license === 'NOT-DECLARED').map((p) => p.name),
    output: out
  })
)
