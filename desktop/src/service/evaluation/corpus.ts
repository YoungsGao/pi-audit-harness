export const evaluationCorpusVersion = 'java-realistic-2026.11.15.1'
export interface EvaluationCase {
  id: string
  title: string
  category: string
  expected: 'dangerous' | 'safe' | 'unknown'
  files: Record<string, string>
}
// Original source patterns, never upstream project copies. Reference labels are not model input.
export const evaluationCases: EvaluationCase[] = [
  {
    id: 'jdbc-concat',
    title: 'Spring JDBC 跨文件动态 SQL',
    category: 'sql-injection',
    expected: 'dangerous',
    files: {
      'Web.java':
        'class Web { UserDao dao; @GetMapping("/users") Object users(String name) { return dao.find(name); } }',
      'UserDao.java':
        'class UserDao { JdbcTemplate jdbc; Object find(String name) { String sql = "SELECT id FROM users WHERE name=\'" + name + "\'"; return jdbc.queryForList(sql); } }'
    }
  },
  {
    id: 'jdbc-bound',
    title: 'Spring JDBC 值参数绑定',
    category: 'sql-injection',
    expected: 'safe',
    files: {
      'Web.java':
        'class Web { JdbcTemplate jdbc; @GetMapping("/users") Object users(String name) { return jdbc.queryForList("SELECT id FROM users WHERE name=?", name); } }'
    }
  },
  {
    id: 'orm-order',
    title: 'ORM 参数绑定不能保护拼接排序',
    category: 'sql-injection',
    expected: 'dangerous',
    files: {
      'Web.java':
        'class Web { EntityManager em; @GetMapping("/users") Object users(String sort, String name) { String sql = "SELECT u FROM User u WHERE u.name=:name ORDER BY " + sort; return em.createQuery(sql).setParameter("name", name).getResultList(); } }'
    }
  },
  {
    id: 'orm-bound',
    title: 'ORM 常量查询与 setParameter',
    category: 'sql-injection',
    expected: 'safe',
    files: {
      'Web.java':
        'class Web { EntityManager em; @GetMapping("/users") Object users(String name) { return em.createQuery("SELECT u FROM User u WHERE u.name=:name").setParameter("name", name).getResultList(); } }'
    }
  },
  {
    id: 'servlet-source',
    title: 'Servlet getParameter 到 SQL',
    category: 'sql-injection',
    expected: 'dangerous',
    files: {
      'Web.java':
        'class Web { Statement stmt; protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws Exception { String id = req.getParameter("id"); stmt.executeQuery("SELECT id FROM users WHERE id=" + id); } }'
    }
  },
  {
    id: 'helper-allowlist',
    title: '辅助方法中的排序白名单',
    category: 'sql-injection',
    expected: 'safe',
    files: {
      'Web.java':
        'class Web { Statement stmt; SortPolicy policy; @GetMapping("/sort") void sort(String column) throws Exception { String approved = policy.column(column); stmt.executeQuery("SELECT id FROM users ORDER BY " + approved); } }',
      'SortPolicy.java':
        'class SortPolicy { String column(String input) { if ("name".equals(input)) return "name"; if ("id".equals(input)) return "id"; throw new IllegalArgumentException(); } }'
    }
  },
  {
    id: 'external-policy',
    title: '外部策略缺源码应保留未知',
    category: 'sql-injection',
    expected: 'unknown',
    files: {
      'Web.java':
        'class Web { Statement stmt; ExternalPolicy policy; @GetMapping("/search") void search(String input) throws Exception { String value = policy.sanitize(input); stmt.executeQuery("SELECT id FROM users WHERE name=" + value); } }'
    }
  },
  {
    id: 'shell-command',
    title: 'ProcessBuilder 启动 shell',
    category: 'command-injection',
    expected: 'dangerous',
    files: {
      'Web.java':
        'class Web { @PostMapping("/archive") void archive(String name) throws Exception { new ProcessBuilder("sh", "-c", "tar -cf /tmp/out.tar " + name).start(); } }'
    }
  },
  {
    id: 'path-normalize',
    title: '路径 normalize 缺少根目录检查',
    category: 'path-traversal',
    expected: 'dangerous',
    files: {
      'Web.java':
        'class Web { @GetMapping("/download") byte[] download(String name) throws Exception { Path target = Path.of("/srv/public").resolve(name).normalize(); return Files.readAllBytes(target); } }'
    }
  }
]
