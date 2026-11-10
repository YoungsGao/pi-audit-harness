import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export async function generateScale(source, physicalLines = 50000, candidates = 100) {
  await mkdir(source, { recursive: true })
  const perFile = physicalLines / candidates
  if (!Number.isInteger(perFile) || perFile < 12) throw Error('QA_SCALE_INVALID')
  for (let i = 0; i < candidates; i++) {
    const name = 'Load' + String(i).padStart(3, '0')
    const lines = [
      'package qa.load;',
      'import java.sql.Statement;',
      `class ${name} {`,
      'Statement stmt;',
      `@GetMapping("/load/${i}")`,
      'String endpoint(String q) throws Exception {',
      'String value=q;',
      ...Array.from({ length: perFile - 11 }, () => 'value = q;'),
      'stmt.executeQuery("SELECT "+value);',
      'return value;',
      '}',
      '}'
    ]
    await writeFile(join(source, name + '.java'), lines.join('\n'))
  }
  return {
    physicalLines,
    candidates,
    files: candidates,
    construction: 'synthetic repeated assignments; not a real-project throughput estimate'
  }
}
export async function generateLongPath(source) {
  await mkdir(source, { recursive: true })
  await writeFile(
    join(source, 'DeepPath.java'),
    [
      'class DeepPath { Statement stmt;',
      ...Array.from(
        { length: 49 },
        (_, i) =>
          `${i === 0 ? '@GetMapping("/deep") ' : ''}void step${i}(String q) throws Exception { ${i < 48 ? `step${i + 1}(q);` : 'stmt.executeQuery(q);'} }`
      ),
      '}'
    ].join('\n')
  )
}
