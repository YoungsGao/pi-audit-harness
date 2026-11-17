import test from 'node:test'
import assert from 'node:assert/strict'
import { findRiskCandidates } from '../src/service/rules/builtin.ts'
import { indexJavaFile } from '../src/service/scanning/java-index.ts'
import { openHarness } from '../qa/harness.mjs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { importLocal } from '../src/service/sources/local.ts'

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'pi-framework-')),
    source = join(root, 'source')
  await mkdir(source)
  for (const [name, text] of Object.entries(files)) await writeFile(join(source, name), text)
  const h = await openHarness(root)
  const project = await importLocal(h.sources, {
    projectName: 'framework regression',
    path: source
  })
  t.after(async () => {
    await h.close()
    await rm(root, { recursive: true, force: true })
  })
  return { ...h, project }
}

test('typed Spring JDBC and ORM SQL candidates preserve exact SQL argument and ignore unrelated methods', () => {
  const source = `class Dao {
    org.springframework.jdbc.core.JdbcTemplate jdbc;
    NamedParameterJdbcTemplate named;
    jakarta.persistence.EntityManager em;
    ExecutorService executor;
    UserRepository users;
    void query(String input) {
      jdbc.queryForList("SELECT * FROM users WHERE name=" + input);
      named.query("SELECT * FROM users WHERE name=:name", params, mapper);
      em.createNativeQuery("SELECT * FROM users ORDER BY " + input).getResultList();
      executor.execute(task);
      users.query(input);
      users.update(input);
    }
  }`
  const hits = findRiskCandidates('Dao.java', source)
  assert.deepEqual(
    hits.map((h) => h.ruleId),
    ['JAVA-SQL-SPRING-JDBC', 'JAVA-SQL-SPRING-JDBC', 'JAVA-SQL-ORM']
  )
  assert.equal(hits[0].arguments[0].text, '"SELECT * FROM users WHERE name=" + input')
  assert.equal(
    hits[1].arguments.length,
    1,
    'only the SQL expression is a risk argument, not bound values'
  )
  assert.ok(hits.every((h) => source.includes(h.arguments[0].text)))
  assert.equal(
    findRiskCandidates(
      'Criteria.java',
      'class D { EntityManager em; void f(CriteriaQuery<User> criteria) { em.createQuery(criteria); } }'
    ).length,
    0
  )
})
test('prepared SQL text and interface/fluent JDBC entry points are candidates; a prepared class name does not sanitize concatenation', () => {
  const hits = findRiskCandidates(
    'Dao.java',
    'class Dao { Connection conn; JdbcOperations jdbc; JdbcClient client; void find(String q) { conn.prepareStatement("SELECT " + q).executeQuery(); jdbc.queryForList("SELECT " + q); client.sql("SELECT " + q).query(User.class).list(); } }'
  )
  assert.deepEqual(
    hits.map((h) => h.ruleId),
    ['JAVA-SQL-PREPARE', 'JAVA-SQL-SPRING-JDBC', 'JAVA-SQL-SPRING-JDBC']
  )
})

test('HTTP entry detection accepts qualified mappings and Servlet methods, not annotation-looking strings', () => {
  const bomSource =
    '\uFEFFclass Web { Statement stmt; @GetMapping("/x") void q(String q){stmt.executeQuery(q);} }'
  assert.equal(indexJavaFile('Bom.java', bomSource).methods[0].entry, true)
  assert.equal(
    findRiskCandidates('Bom.java', bomSource)[0].arguments[0].startColumn,
    bomSource.lastIndexOf('q);') + 1,
    'BOM handling must preserve the original source column'
  )
  const index = indexJavaFile(
    'Web.java',
    `class Web {
    @org.springframework.web.bind.annotation.GetMapping("/x") void web(String q) {}
    protected void doPost(jakarta.servlet.http.HttpServletRequest req, HttpServletResponse resp) {}
    @SuppressWarnings("@GetMapping") void background(String q) {}
  }`
  )
  assert.deepEqual(
    index.methods.map((m) => [m.name, m.entry]),
    [
      ['web', true],
      ['doPost', true],
      ['background', false]
    ]
  )
})

test('cross-file Spring JDBC and Servlet paths are discovered by actual preprocessing', async (t) => {
  const h = await fixture(t, {
    'Web.java':
      'class Web { Service service; @GetMapping("/search") Object search(String q) { return service.find(q); } }',
    'Service.java':
      'class Service { JdbcTemplate jdbc; Object find(String q) { return jdbc.queryForList("SELECT * FROM users WHERE name=" + q); } }',
    'Servlet.java':
      'class Servlet { Statement stmt; void doGet(HttpServletRequest req, HttpServletResponse resp) { stmt.executeQuery(req.getParameter("sql")); } }'
  })
  const prepared = await h.chains.action('prepare', { projectId: h.project.projectId })
  const paths = prepared.pathIds.map((pathId) =>
    h.repo.detail({ projectId: h.project.projectId, runId: prepared.runId, pathId })
  )
  assert.ok(paths.some((p) => p.ruleId === 'JAVA-SQL-SPRING-JDBC' && p.steps.length === 2))
  assert.ok(
    paths.some(
      (p) =>
        p.steps[0].edge.functionName.includes('doGet') &&
        p.sourceRef.startsWith('http-entry-candidate:')
    )
  )
})
