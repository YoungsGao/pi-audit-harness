// Independently authored acceptance cases. Expected labels are never included in a model prompt.
export const corpusVersion = 'qa-java-2026.11.09.1'
export const cases = [
  [
    'sql-positive-1',
    'sql-injection',
    'dangerous',
    'raw request parameter reaches SQL text',
    'Statement stmt; @GetMapping("/lookup") void lookup(String q) throws Exception { stmt.executeQuery("SELECT name FROM clients WHERE id=" + q); }'
  ],
  [
    'sql-positive-2',
    'sql-injection',
    'dangerous',
    'concatenated LIKE clause is not parameter binding',
    'Statement stmt; @PostMapping("/find") void find(String term) throws Exception { String sql="SELECT id FROM clients WHERE name LIKE \'%"+term+"%\'"; stmt.executeQuery(sql); }'
  ],
  [
    'sql-blocked-1',
    'sql-injection',
    'safe',
    'query uses only a server-owned literal selected by closed whitelist',
    'Statement stmt; @GetMapping("/sort") void sort(String order) throws Exception { String column; if("name".equals(order)) column="name"; else if("id".equals(order)) column="id"; else throw new IllegalArgumentException(); stmt.executeQuery("SELECT id FROM clients ORDER BY "+column); }'
  ],
  [
    'sql-blocked-2',
    'sql-injection',
    'safe',
    'digits-only validation covers the numeric SQL insertion point',
    'Statement stmt; @GetMapping("/number") void number(String id) throws Exception { if(!id.matches("[0-9]{1,8}")) throw new IllegalArgumentException(); stmt.executeQuery("SELECT name FROM clients WHERE id="+id); }'
  ],
  [
    'cmd-positive-1',
    'command-injection',
    'dangerous',
    'attacker controls shell command body',
    '@GetMapping("/shell") void shell(String command) throws Exception { Runtime.getRuntime().exec(new String[]{"cmd.exe","/c",command}); }'
  ],
  [
    'cmd-positive-2',
    'command-injection',
    'dangerous',
    'shell -c receives concatenated external input',
    '@PostMapping("/archive") void archive(String name) throws Exception { new ProcessBuilder("sh","-c","tar -cf /tmp/result.tar "+name).start(); }'
  ],
  [
    'cmd-blocked-1',
    'command-injection',
    'safe',
    'both executable and argument are server-owned literals',
    '@GetMapping("/status") void status(String ignored) throws Exception { new ProcessBuilder("/usr/bin/id","-u").start(); }'
  ],
  [
    'cmd-blocked-2',
    'command-injection',
    'safe',
    'closed allowlist selects a fixed command, no user string reaches exec',
    '@GetMapping("/version") void version(String action) throws Exception { if(!"version".equals(action)) throw new IllegalArgumentException(); Runtime.getRuntime().exec(new String[]{"/usr/bin/java","-version"}); }'
  ],
  [
    'path-positive-1',
    'path-traversal',
    'dangerous',
    'relative traversal is resolved without a root containment guard',
    '@GetMapping("/download") byte[] download(String name) throws Exception { Path target=Path.of("/srv/public").resolve(name); return Files.readAllBytes(target); }'
  ],
  [
    'path-positive-2',
    'path-traversal',
    'dangerous',
    'external absolute or relative path is directly opened',
    '@PostMapping("/open") void open(String filename) throws Exception { new FileInputStream(filename).close(); }'
  ],
  [
    'path-blocked-1',
    'path-traversal',
    'safe',
    'exact name and fixed absolute file path; input never participates in the open',
    '@GetMapping("/guide") byte[] guide(String name) throws Exception { if(!"guide".equals(name)) throw new IllegalArgumentException(); return Files.readAllBytes(Path.of("/srv/static/guide.txt")); }'
  ],
  [
    'path-blocked-2',
    'path-traversal',
    'safe',
    'closed enum maps to fixed trusted files rather than resolving user text',
    '@GetMapping("/document") byte[] document(String name) throws Exception { Path target; if("terms".equals(name)) target=Path.of("/srv/static/terms.txt"); else if("privacy".equals(name)) target=Path.of("/srv/static/privacy.txt"); else throw new IllegalArgumentException(); return Files.readAllBytes(target); }'
  ],
  [
    'sql-unknown-dependency',
    'sql-injection',
    'unknown',
    'sanitizer implementation and guarantees are unavailable',
    'Statement stmt; ExternalSqlPolicy policy; @GetMapping("/external-sql") void external(String q) throws Exception { String cleaned=policy.sanitize(q); stmt.executeQuery("SELECT id FROM clients WHERE name="+cleaned); }'
  ],
  [
    'sql-unknown-recursion',
    'sql-injection',
    'unknown',
    'bounded candidate expansion contains a recursive boundary; do not assert complete coverage',
    'Statement stmt; @GetMapping("/recursive") void entry(String q,int n) throws Exception { recursive(q,n); } void recursive(String q,int n) throws Exception { if(n>0) recursive(q,n-1); else stmt.executeQuery(q); }'
  ],
  [
    'cmd-unknown-dependency',
    'command-injection',
    'unknown',
    'external command policy may replace or reject input, but its source is absent',
    'CommandPolicy policy; @GetMapping("/policy") void command(String q) throws Exception { Runtime.getRuntime().exec(policy.resolve(q)); }'
  ],
  [
    'cmd-unknown-source',
    'command-injection',
    'unknown',
    'public method has no supported HTTP or other verified external source',
    'void scheduled(String command) throws Exception { Runtime.getRuntime().exec(command); }'
  ],
  [
    'path-unknown-dependency',
    'path-traversal',
    'unknown',
    'unavailable resolver prevents verifying containment and authorization',
    'FilePolicy policy; @GetMapping("/policy-file") byte[] file(String name) throws Exception { return Files.readAllBytes(policy.authorizeAndResolve(name)); }'
  ],
  [
    'path-unknown-overload',
    'path-traversal',
    'unknown',
    'same-arity receiver type is unresolved; do not pick an arbitrary wrapper target',
    'UnknownSelector selector; @GetMapping("/ambiguous") byte[] entry(String name) throws Exception { return load(selector.select(name)); } byte[] load(String value) throws Exception { return Files.readAllBytes(Path.of(value)); } byte[] load(Path value) throws Exception { return Files.readAllBytes(value); }'
  ]
].map(([id, category, expected, rationale, body], i) => {
  const name = 'Acceptance' + String(i + 1).padStart(2, '0')
  return {
    id,
    category,
    expected,
    rationale,
    className: name,
    fileName: name + '.java',
    source:
      [
        'package acceptance;',
        'import java.sql.Statement;',
        'import java.nio.file.Files;',
        'import java.nio.file.Path;',
        'import java.io.FileInputStream;',
        `class ${name} {`,
        body,
        '}'
      ].join('\n') + '\n',
    // This is a reference annotation, not a claim of human sign-off or general vulnerability accuracy.
    annotation: 'source-derived engineering baseline; owner review can revise the versioned label'
  }
})
