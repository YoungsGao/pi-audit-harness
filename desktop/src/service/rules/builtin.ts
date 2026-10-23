import type {
  RiskCandidate,
  RiskRule,
  RuleCatalog,
  SourceRange
} from '../../shared/code-query-contracts.ts'

const limitations =
  'Java 文本候选；不解析类型绑定、别名、重载、跨文件调用或运行时派发，必须结合源码核实。'
const rules: RiskRule[] = [
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
  version: 'java-basic-2026.10.23.1',
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
  maxCandidates = 101
): RiskCandidate[] {
  const masked = maskJava(source),
    candidates: RiskCandidate[] = []
  const calls =
    /\bnew\s+(?:[\w$]+\.)*(ProcessBuilder|FileInputStream|FileOutputStream|FileReader|FileWriter)\s*\(|\.\s*(executeQuery|executeUpdate|execute|addBatch|exec|command)\s*\(|\b(?:java\.nio\.file\.)?Files\s*\.\s*(readAllBytes|readString|newInputStream|newOutputStream|writeString|write|delete)\s*\(/g
  for (const match of masked.matchAll(calls)) {
    const method = match[2] ?? match[3]
    const rule = rules.find((item) =>
      match[1]
        ? item.apis.includes(match[1] + '.<init>')
        : item.apis.some((api) => api.endsWith('.' + method))
    )
    if (!rule) continue
    const parsed = argumentsAt(masked, match.index + match[0].lastIndexOf('('))
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
    const indexes = rule.argumentIndexes
    const dangerous = indexes === 'all' ? args : args.filter((arg) => indexes.includes(arg.index))
    const api = match[1]
      ? match[1] + '.<init>'
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
