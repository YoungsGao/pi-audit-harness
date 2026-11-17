import type {
  RiskCandidate,
  RiskRule,
  RuleCatalog,
  SourceRange
} from '../../shared/code-query-contracts.ts'
import { indexJavaFile } from '../scanning/java-index.ts'
import type { JavaFileIndex } from '../scanning/java-index.ts'

const limitations =
  'Java 文本候选；不解析类型绑定、别名、重载、跨文件调用或运行时派发，必须结合源码核实。'
const rules: RiskRule[] = [
  {
    id: 'JAVA-SQL-SPRING-JDBC',
    category: 'sql-injection',
    cwe: 'CWE-89',
    apis: [
      'JdbcTemplate.query',
      'JdbcTemplate.queryForObject',
      'JdbcTemplate.queryForList',
      'JdbcTemplate.queryForMap',
      'JdbcTemplate.queryForRowSet',
      'JdbcTemplate.update',
      'JdbcTemplate.batchUpdate',
      'JdbcTemplate.execute',
      'NamedParameterJdbcTemplate.query',
      'NamedParameterJdbcTemplate.queryForObject',
      'NamedParameterJdbcTemplate.queryForList',
      'NamedParameterJdbcTemplate.update',
      'NamedParameterJdbcTemplate.batchUpdate',
      'JdbcClient.sql',
      ...[
        'query',
        'queryForObject',
        'queryForList',
        'queryForMap',
        'queryForRowSet',
        'update',
        'batchUpdate',
        'execute'
      ].map((name) => 'JdbcOperations.' + name),
      ...['query', 'queryForObject', 'queryForList', 'update', 'batchUpdate'].map(
        (name) => 'NamedParameterJdbcOperations.' + name
      )
    ],
    argumentIndexes: [0],
    review: {
      source: 'HTTP 参数、请求体、Servlet 请求中的外部输入。',
      propagation: '核查第0个SQL文本如何构造；跟踪辅助方法、StringBuilder和动态表名/排序字段。',
      defenses: [
        '占位符及对应参数绑定能保护值，不能保护拼接进SQL结构的表名或列名。',
        '区分SQL字符串重载和PreparedStatementCreator回调；框架类型本身不是安全证明。'
      ],
      limitations
    }
  },
  {
    id: 'JAVA-SQL-ORM',
    category: 'sql-injection',
    cwe: 'CWE-89',
    apis: [
      'EntityManager.createQuery',
      'EntityManager.createNativeQuery',
      'Session.createQuery',
      'Session.createNativeQuery',
      'Session.createSQLQuery'
    ],
    argumentIndexes: [0],
    review: {
      source: '外部可控查询值、排序、表名和条件片段。',
      propagation: '核查JPQL/HQL/原生SQL文本构造；创建查询只是候选，须检查终端执行及可达性。',
      defenses: [
        '核实setParameter绑定与实际占位符对应；不能为此前拼接内容补救。',
        'CriteriaQuery对象重载不是字符串SQL；缺少类型或执行证据时保留未知。'
      ],
      limitations
    }
  },
  {
    id: 'JAVA-SQL-STATEMENT',
    category: 'sql-injection',
    cwe: 'CWE-89',
    apis: [
      'Statement.executeQuery',
      'Statement.executeUpdate',
      'Statement.execute',
      'Statement.addBatch'
    ],
    argumentIndexes: [0],
    review: {
      source: 'HTTP 参数、请求体及其他外部可控文本。',
      propagation: '核实第 0 个 SQL 参数的拼接、赋值、返回值和实参到形参传播。',
      defenses: [
        '核实 PreparedStatement / MyBatis 参数绑定是否覆盖当前危险参数。',
        '区分 SQL 结构白名单与普通字符串转义。'
      ],
      limitations
    }
  },
  {
    id: 'JAVA-SQL-PREPARE',
    category: 'sql-injection',
    cwe: 'CWE-89',
    apis: ['Connection.prepareStatement', 'Connection.prepareCall'],
    argumentIndexes: [0],
    review: {
      source: '外部可控SQL文本或结构片段。',
      propagation:
        '核查准备语句时第0个SQL表达式及后续execute调用；已拼接的SQL不会因PreparedStatement类名而安全。',
      defenses: [
        'SQL结构固定、危险值只通过占位符绑定，且绑定与实际执行匹配。',
        '区分存储过程构造和过程内部动态SQL；缺少实现时保留未知。'
      ],
      limitations
    }
  },
  {
    id: 'JAVA-CMD-RUNTIME',
    category: 'command-injection',
    cwe: 'CWE-78',
    apis: ['Runtime.exec'],
    argumentIndexes: [0],
    review: {
      source: '外部可控命令、程序名、参数或选项。',
      propagation: '核实第 0 个命令参数的构造、拼接和 shell 包装。',
      defenses: ['固定程序与参数模板，检查可控命令选项。', '核实业务白名单覆盖实际执行值。'],
      limitations
    }
  },
  {
    id: 'JAVA-CMD-PROCESS-BUILDER',
    category: 'command-injection',
    cwe: 'CWE-78',
    apis: ['ProcessBuilder.<init>', 'ProcessBuilder.command'],
    argumentIndexes: 'all',
    review: {
      source: '外部可控程序名、命令参数、参数列表。',
      propagation: '核实所有命令参数及后续 start()；构造命令不等于已经执行。',
      defenses: ['检查程序名、参数白名单与选项注入。', '参数数组本身不能证明输入安全。'],
      limitations
    }
  },
  {
    id: 'JAVA-PATH-FILES',
    category: 'path-traversal',
    cwe: 'CWE-22',
    apis: [
      'Files.readAllBytes',
      'Files.readString',
      'Files.newInputStream',
      'Files.newOutputStream',
      'Files.write',
      'Files.writeString',
      'Files.delete'
    ],
    argumentIndexes: [0],
    review: {
      source: '外部提供的文件名、目录或路径片段。',
      propagation: '追踪第 0 个 Path 参数，包括 Paths.get / resolve / 字符串拼接。',
      defenses: ['核实规范化后路径仍在允许根目录。', '检查绝对路径、符号链接和业务文件授权。'],
      limitations
    }
  },
  {
    id: 'JAVA-PATH-STREAM',
    category: 'path-traversal',
    cwe: 'CWE-22',
    apis: [
      'FileInputStream.<init>',
      'FileOutputStream.<init>',
      'FileReader.<init>',
      'FileWriter.<init>'
    ],
    argumentIndexes: [0],
    review: {
      source: '外部提供的文件名或 File 对象。',
      propagation: '核实第 0 个路径参数；FileDescriptor 重载需另行排除。',
      defenses: ['核实规范化路径与允许根目录。', '检查文件访问权限与链接目标。'],
      limitations
    }
  }
]

// 模型解释、预处理与 API 读取同一份规则；禁止调用方修改进程内目录。
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
export const builtinRules: RuleCatalog = freeze({
  version: 'java-framework-2026.11.15.2',
  language: 'java',
  rules
})

// 保留所有位置和换行，只遮蔽注释/字符串内容，避免把它们当成可执行调用。
export function maskJava(source: string, preserveLiterals = false): string {
  const pattern =
    /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"""[\s\S]*?"""|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g
  return source.replace(pattern, (match) =>
    preserveLiterals && !match.startsWith('/') ? match : match.replace(/[^\r\n]/g, ' ')
  )
}

function range(filePath: string, source: string, start: number, end: number): SourceRange {
  const position = (offset: number): [number, number] => {
    const prefix = source.slice(0, offset)
    return [prefix.split('\n').length, offset - prefix.lastIndexOf('\n')]
  }
  const [startLine, startColumn] = position(start),
    [endLine, endColumn] = position(end)
  return { filePath, startLine, endLine, startColumn, endColumn, text: source.slice(start, end) }
}

function argumentsAt(
  masked: string,
  open: number
): { end: number; spans: [number, number][] } | undefined {
  const spans: [number, number][] = []
  let start = open + 1,
    depth = 1
  for (let i = start; i < masked.length && i - open <= 12000; i++) {
    const char = masked[i]
    if ('([{'.includes(char)) depth++
    if (')]}'.includes(char)) depth--
    if (depth === 0) {
      spans.push([start, i])
      return { end: i + 1, spans }
    }
    if (char === ',' && depth === 1) {
      spans.push([start, i])
      start = i + 1
    }
  }
  return undefined
}

export function findRiskCandidates(
  filePath: string,
  source: string,
  maxCandidates = 101,
  syntax?: JavaFileIndex
): RiskCandidate[] {
  const masked = maskJava(source),
    candidates: RiskCandidate[] = []
  if (!syntax) {
    try {
      syntax = indexJavaFile(filePath, source)
    } catch {
      /* Incomplete Java retains the existing bounded text fallback. */
    }
  }
  const calls =
    /\bnew\s+(?:[\w$]+\.)*(ProcessBuilder|FileInputStream|FileOutputStream|FileReader|FileWriter)\s*\(|\.\s*(executeQuery|executeUpdate|execute|addBatch|exec|command|prepareStatement|prepareCall|query|queryForObject|queryForList|queryForMap|queryForRowSet|update|batchUpdate|sql|createQuery|createNativeQuery|createSQLQuery)\s*\(|\b(?:java\.nio\.file\.)?Files\s*\.\s*(readAllBytes|readString|newInputStream|newOutputStream|writeString|write|delete)\s*\(/g
  for (const match of masked.matchAll(calls)) {
    const method = match[2] ?? match[3]
    const open = match.index + match[0].lastIndexOf('(')
    const call = syntax?.calls.find((c) => c.open === open)
    const receiver =
      call?.receiver.replace(/^this\./, '') ??
      masked.slice(0, match.index).match(/[\w$]+$/)?.[0] ??
      ''
    const binding = call?.caller.bindings
      .filter((b) => b.name === receiver && b.start <= call.start && b.end >= call.end)
      .at(-1)
    const receiverType =
      (binding?.type ?? receiver)
        .replace(/<.*>|\[\]|\s/g, '')
        .split('.')
        .at(-1) ?? ''
    const framework = rules.find((r) => r.apis.includes(receiverType + '.' + method))
    // Generic names such as query/update/execute also occur in ordinary application APIs.
    const legacy = [
      'executeQuery',
      'executeUpdate',
      'execute',
      'addBatch',
      'exec',
      'command',
      'prepareStatement',
      'prepareCall'
    ].includes(method)
    if (!match[1] && !match[3] && !framework && !legacy) continue
    if (
      binding &&
      !framework &&
      legacy &&
      ![
        'Statement',
        'PreparedStatement',
        'CallableStatement',
        'Runtime',
        'ProcessBuilder',
        'Connection'
      ].includes(receiverType)
    )
      continue
    const rule =
      framework ??
      rules
        .filter((r) => !['JAVA-SQL-SPRING-JDBC', 'JAVA-SQL-ORM'].includes(r.id))
        .find((item) =>
          match[1]
            ? item.apis.includes(match[1] + '.<init>')
            : item.apis.some((api) => api.endsWith('.' + method))
        )
    if (!rule) continue
    const parsed = argumentsAt(masked, open)
    if (!parsed) continue
    const args = parsed.spans
      .map(([left, right], index) => {
        const text = source.slice(left, right),
          leading = text.length - text.trimStart().length
        return {
          ...range(filePath, source, left + leading, right - (text.length - text.trimEnd().length)),
          index
        }
      })
      .filter((arg) => maskJava(arg.text, true).trim())
    if (!args.length) continue // executeQuery() 并没有第 0 个 SQL 参数。
    if (framework && call && /^[\w$]+$/.test(args[0].text)) {
      const type =
        call.caller.bindings
          .filter((b) => b.name === args[0].text && b.start <= call.start && b.end >= call.end)
          .at(-1)?.type ?? ''
      if (
        /(?:CriteriaQuery|PreparedStatementCreator|CallableStatementCreator|ConnectionCallback|StatementCallback)(?:<|$)/.test(
          type
        )
      )
        continue
    }
    const indexes = rule.argumentIndexes
    const dangerous = indexes === 'all' ? args : args.filter((arg) => indexes.includes(arg.index))
    const api = match[1]
      ? match[1] + '.<init>'
      : framework
        ? receiverType + '.' + method
        : rule.apis.find((item) => item.endsWith('.' + method))!
    candidates.push({
      ...range(filePath, source, match.index, parsed.end),
      ruleId: rule.id,
      api,
      resolutionStatus: 'candidate',
      arguments: dangerous
    })
    if (candidates.length >= maxCandidates) break
  }
  return candidates
}
