import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinRules, findRiskCandidates } from '../src/service/rules/builtin.ts'
import { CodeQueryService } from '../src/service/query/service.ts'
import { openStorage } from '../src/service/storage/schema.ts'
import { SourceRepository } from '../src/service/sources/repository.ts'
import { importLocal } from '../src/service/sources/local.ts'

export async function queryFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-query-'))
  const path = join(root, 'source')
  await mkdir(path)
  const source = [
    'import java.sql.Statement;',
    'class Demo {',
    '  void search(Statement stmt, String input) throws Exception {',
    '    stmt.executeQuery(',
    '      "SELECT * FROM users WHERE name=" + input);',
    '    Runtime.getRuntime().exec(input);',
    '    java.nio.file.Files.readAllBytes(path);',
    '    // stmt.executeQuery(input);',
    '    String text = "Runtime.getRuntime().exec(input)";',
    '  }',
    '}'
  ].join('\n')
  await writeFile(join(path, 'Demo.java'), source)
  await mkdir(join(path, 'target'))
  await writeFile(join(path, 'target', 'Ignored.java'), 'stmt.executeQuery(input);')
  const db = openStorage(join(root, 'runtime'))
  const repo = new SourceRepository(db)
  const project = await importLocal(repo, { projectName: '真实源码查询样例', path })
  const service = new CodeQueryService(repo)
  t.after(async () => {
    await service.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, path, db, repo, project, service, source }
}

test('versioned three-category rules locate multiline dangerous arguments and ignore comments/literals', () => {
  assert.deepEqual(
    new Set(builtinRules.rules.map((r) => r.category)),
    new Set(['sql-injection', 'command-injection', 'path-traversal'])
  )
  const source =
    'stmt.executeQuery(\n "sql" + input);\nnew ProcessBuilder("sh", "-c", input);\nFiles.readString(path);\n// stmt.execute(input);\nString s = "Files.readString(path)";\nprepared.executeQuery();'
  const hits = findRiskCandidates('Demo.java', source)
  assert.equal(hits.length, 3)
  assert.equal(hits[0].startLine, 1)
  assert.equal(hits[0].arguments[0].text, '"sql" + input')
  assert.equal(hits[0].arguments[0].startLine, 2)
  assert.equal(hits[1].arguments[0].index, 0)
  assert.ok(hits.every((h) => h.resolutionStatus === 'candidate'))
  assert.ok(hits.every((h) => builtinRules.rules.some((r) => r.id === h.ruleId)))
  assert.ok(builtinRules.rules.every((r) => r.review.propagation && r.review.defenses.length))
})

test('all declared rule APIs map to the same catalog; nested arguments, string commas and comment-only empty calls are handled', () => {
  for (const rule of builtinRules.rules) {
    for (const api of rule.apis) {
      const code = api.endsWith('.<init>')
        ? `new ${api.replace('.<init>', '')}(input);`
        : api.replace('Statement.', 'statement.').replace('Runtime.', 'runtime.') + '(input);'
      const hits = findRiskCandidates('Matrix.java', code)
      assert.equal(hits.length, 1, api)
      assert.equal(hits[0].ruleId, rule.id, api)
    }
  }
  const nested = findRiskCandidates(
    'Nested.java',
    'stmt.executeQuery(makeSql(input, foo(1,2))); new ProcessBuilder("sh", "-c", "x,y");'
  )
  assert.equal(nested[0].arguments[0].text, 'makeSql(input, foo(1,2))')
  assert.deepEqual(
    nested[1].arguments.map((a) => a.text),
    ['"sh"', '"-c"', '"x,y"']
  )
  assert.deepEqual(findRiskCandidates('Empty.java', 'prepared.executeQuery(/* no SQL arg */);'), [])
  assert.equal(findRiskCandidates('Literal.java', 'stmt.executeQuery("literal");').length, 1)
})

test('risk result limit, long evidence, missing rg and closed service fail or truncate explicitly', async (t) => {
  const { service, project, path, repo } = await queryFixture(t)
  const bounded = await service.action('risks', { projectId: project.projectId, maxResults: 1 })
  assert.equal(bounded.candidates.length, 1)
  assert.equal(bounded.truncated, true)
  const oldPath = process.env.PATH
  process.env.PATH = ''
  try {
    await assert.rejects(service.action('search', { projectId: project.projectId, text: 'run' }), {
      code: 'TOOL_MISSING'
    })
    // 源码读取是 Node 文件 API；没有 rg 仍可取证。
    assert.ok(
      (
        await service.action('read', {
          projectId: project.projectId,
          filePath: 'Demo.java',
          startLine: 1,
          endLine: 1
        })
      ).text
    )
  } finally {
    process.env.PATH = oldPath
  }
  await writeFile(
    join(path, 'Long.java'),
    'class Long { String text = "' + 'x'.repeat(12000) + '"; }'
  )
  const updated = await importLocal(repo, {
    projectName: 'long evidence fixture',
    path,
    duplicate: 'new'
  })
  await assert.rejects(
    service.action('read', {
      projectId: updated.projectId,
      filePath: 'Long.java',
      startLine: 1,
      endLine: 1
    }),
    { code: 'QUERY_OUTPUT_LIMIT' }
  )
  await service.close()
  await assert.rejects(service.action('read', { projectId: project.projectId }), {
    code: 'QUERY_CANCELLED'
  })
})

test('literal rg query/read return exact source range; no-match is a normal empty result and limits are explicit', async (t) => {
  const { service, project } = await queryFixture(t)
  const result = await service.action('search', {
    projectId: project.projectId,
    text: 'executeQuery',
    maxResults: 1
  })
  assert.equal(result.backend, 'rg')
  assert.equal(result.matches.length, 1)
  assert.equal(result.truncated, true)
  assert.equal(result.matches[0].filePath, 'Demo.java')
  assert.equal(result.matches[0].startLine, 4)
  assert.equal(result.matches[0].resolutionStatus, 'candidate')
  const empty = await service.action('search', {
    projectId: project.projectId,
    text: 'not-in-source-37654'
  })
  assert.deepEqual(empty.matches, [])
  const evidence = await service.action('read', {
    projectId: project.projectId,
    filePath: 'Demo.java',
    startLine: 4,
    endLine: 5
  })
  assert.equal(
    evidence.text,
    '    stmt.executeQuery(\n      "SELECT * FROM users WHERE name=" + input);'
  )
  assert.match(evidence.fileSha256, /^[a-f0-9]{64}$/)
  await assert.rejects(
    service.action('read', {
      projectId: project.projectId,
      filePath: '../outside.java',
      startLine: 1,
      endLine: 2
    }),
    { code: 'QUERY_INVALID_INPUT' }
  )
  await assert.rejects(
    service.action('read', {
      projectId: project.projectId,
      filePath: 'target/Ignored.java',
      startLine: 1,
      endLine: 1
    }),
    { code: 'QUERY_FILE_OUT_OF_SCOPE' }
  )
  await assert.rejects(
    service.action('read', {
      projectId: project.projectId,
      filePath: 'Demo.java',
      startLine: 1,
      endLine: 81
    }),
    { code: 'QUERY_INVALID_INPUT' }
  )
  await assert.rejects(
    service.action('search', { projectId: project.projectId, text: 'x', command: 'bad' }),
    { code: 'QUERY_INVALID_INPUT' }
  )
})

test('risk query shares catalog/version; changed files, directory links and cancelled requests are not read as old evidence', async (t) => {
  const { service, project, path, root } = await queryFixture(t)
  const result = await service.action('risks', { projectId: project.projectId })
  assert.equal(result.rulesVersion, builtinRules.version)
  assert.equal(result.candidates.length, 3)
  assert.deepEqual(
    result.candidates.map((c) => c.startLine),
    [4, 6, 7]
  )
  const ctl = new AbortController()
  ctl.abort()
  await assert.rejects(service.action('risks', { projectId: project.projectId }, ctl.signal), {
    code: 'QUERY_CANCELLED'
  })
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'Hidden.java'), 'stmt.execute(input);')
  await symlink(outside, join(path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(
    service.action('read', {
      projectId: project.projectId,
      filePath: 'linked/Hidden.java',
      startLine: 1,
      endLine: 1
    }),
    { code: 'QUERY_FILE_OUT_OF_SCOPE' }
  )
  await writeFile(join(path, 'Demo.java'), 'class Changed {}')
  await assert.rejects(service.action('risks', { projectId: project.projectId }), {
    code: 'QUERY_SOURCE_CHANGED'
  })
})
