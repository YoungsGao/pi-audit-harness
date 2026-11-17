import { mkdir, mkdtemp, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { command } from '../sources/process.ts'
import { ApiError } from '../../shared/api-error.ts'
import { mcpHash } from './contracts.ts'

export const SEMGREP_VERSION = '1.185.0'
// Product-owned local patterns only: never load target-repository YAML, plugins or scripts.
export const staticRules = {
  rules: [
    {
      id: 'audit-java-framework-sql',
      languages: ['java'],
      severity: 'WARNING',
      message: '框架动态查询文本候选，需核查输入来源、执行可达性与参数绑定。',
      'pattern-either': [
        ...['query', 'queryForList', 'queryForObject', 'update'].flatMap((method) => [
          { pattern: `(JdbcTemplate $DB).${method}($A + $B, ...)` },
          {
            patterns: [
              { 'pattern-inside': '$RET $METHOD(...) { ... String $SQL = $A + $B; ... }' },
              { pattern: `(JdbcTemplate $DB).${method}($SQL, ...)` }
            ]
          }
        ]),
        ...['createQuery', 'createNativeQuery'].flatMap((method) => [
          { pattern: `(EntityManager $DB).${method}($A + $B, ...)` },
          {
            patterns: [
              { 'pattern-inside': '$RET $METHOD(...) { ... String $SQL = $A + $B; ... }' },
              { pattern: `(EntityManager $DB).${method}($SQL, ...)` }
            ]
          }
        ])
      ]
    },
    {
      id: 'audit-java-sql-concat',
      languages: ['java'],
      severity: 'WARNING',
      message: 'SQL字符串拼接候选，需核查输入来源和参数绑定。',
      'pattern-either': [
        { pattern: '$S.executeQuery($A + $B)' },
        { pattern: '$S.executeUpdate($A + $B)' },
        { pattern: '$S.execute($A + $B)' },
        { pattern: '$C.prepareStatement($A + $B, ...)' },
        { pattern: '$C.prepareCall($A + $B, ...)' },
        {
          patterns: [
            { 'pattern-inside': '$RET $METHOD(...) { ... String $SQL = $A + $B; ... }' },
            { pattern: '$S.executeQuery($SQL)' }
          ]
        }
      ]
    },
    {
      id: 'audit-java-runtime-exec',
      languages: ['java'],
      severity: 'WARNING',
      message: '命令执行候选，需核查命令及参数来源。',
      pattern: 'Runtime.getRuntime().exec(...)'
    },
    {
      id: 'audit-java-process-builder',
      languages: ['java'],
      severity: 'WARNING',
      message: '进程参数候选，需区分常量命令和可控参数。',
      pattern: 'new ProcessBuilder(...)'
    },
    {
      id: 'audit-java-path',
      languages: ['java'],
      severity: 'WARNING',
      message: '文件路径候选，需核查规范化和根目录约束。',
      'pattern-either': [{ pattern: 'Paths.get(...)' }, { pattern: 'new File(...)' }]
    }
  ]
}
export const STATIC_RULES_DIGEST = mcpHash(staticRules)
export interface StaticScan {
  status: 'ok' | 'partial' | 'unavailable' | 'failed'
  engine: string
  gaps: string[]
  truncated: boolean
  items: Record<string, unknown>[]
}
export async function scanStatic(
  files: { filePath: string; source: string }[],
  signal: AbortSignal,
  executable = process.env.PI_AUDIT_SEMGREP_PATH
): Promise<StaticScan> {
  const empty = (status: StaticScan['status'], gap: string): StaticScan => ({
    status,
    engine: 'semgrep/' + SEMGREP_VERSION,
    gaps: [gap],
    truncated: false,
    items: []
  })
  if (!executable) return empty('unavailable', 'SEMGREP_NOT_CONFIGURED')
  if (!isAbsolute(executable) || !/^[^\r\n]+$/.test(executable))
    return empty('unavailable', 'SEMGREP_PATH_INVALID')
  if (
    !files.length ||
    files.length > 2 ||
    files.some((f) => Buffer.byteLength(f.source) > 256 * 1024)
  )
    return empty('partial', 'STATIC_INPUT_LIMIT')
  const folder = await mkdtemp(join(tmpdir(), 'pi-static-'))
  // Temporary home isolates user Semgrep settings, credentials, ignore files and caches.
  const env: NodeJS.ProcessEnv = {
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    SEMGREP_SEND_METRICS: 'off',
    SEMGREP_ENABLE_VERSION_CHECK: '0',
    HOME: folder,
    USERPROFILE: folder,
    APPDATA: folder,
    LOCALAPPDATA: folder,
    XDG_CONFIG_HOME: folder,
    XDG_CACHE_HOME: folder,
    TEMP: folder,
    TMP: folder
  }
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'LD_LIBRARY_PATH'])
    if (process.env[key]) env[key] = process.env[key]
  try {
    if (!(await stat(executable)).isFile()) return empty('unavailable', 'SEMGREP_PATH_INVALID')
    const version = await command(executable, ['--version'], {
      cwd: folder,
      env,
      signal,
      timeoutMs: 10000
    })
    if (version.trim() !== SEMGREP_VERSION) return empty('unavailable', 'SEMGREP_VERSION_MISMATCH')
    await mkdir(join(folder, 'sources'))
    const ruleFile = join(folder, 'rules.json')
    await writeFile(ruleFile, JSON.stringify(staticRules))
    for (const [i, file] of files.entries())
      await writeFile(join(folder, 'sources', `Input${i}.java`), file.source)
    const raw = await command(
      executable,
      [
        'scan',
        '--json',
        '--metrics=off',
        '--disable-version-check',
        '--no-git-ignore',
        '--no-rewrite-rule-ids',
        '--jobs=1',
        '--timeout=5',
        '--max-memory=256',
        '--max-target-bytes=262144',
        '--config',
        ruleFile,
        'sources'
      ],
      { cwd: folder, env, signal, timeoutMs: 20000 }
    )
    const data = JSON.parse(raw)
    if (!Array.isArray(data.results) || !Array.isArray(data.errors))
      throw Error('invalid Semgrep result')
    const items: Record<string, unknown>[] = []
    for (const hit of data.results) {
      const index = /^sources[\\/]Input([01])\.java$/.exec(hit.path)?.[1]
      const file = index === undefined ? undefined : files[Number(index)]
      const rule = staticRules.rules.find((r) => r.id === hit.check_id)
      if (
        !file ||
        !rule ||
        !Number.isInteger(hit.start?.line) ||
        !Number.isInteger(hit.end?.line) ||
        hit.start.line < 1 ||
        hit.end.line < hit.start.line ||
        hit.end.line > file.source.split('\n').length
      )
        throw Error('invalid Semgrep location')
      if (items.length < 12)
        items.push({
          findingId:
            'finding-' +
            mcpHash([STATIC_RULES_DIGEST, file, hit.check_id, hit.start.line, hit.end.line]).slice(
              0,
              24
            ),
          ruleId: rule.id,
          filePath: file.filePath,
          startLine: hit.start.line,
          endLine: hit.end.line,
          message: rule.message,
          classification: 'static-finding',
          confirmedVulnerability: false
        })
    }
    return {
      status: data.errors.length || data.results.length > 12 ? 'partial' : 'ok',
      engine: 'semgrep/' + version,
      gaps: data.errors.length ? ['STATIC_PARSE_OR_TIMEOUT_GAPS'] : [],
      truncated: data.results.length > 12,
      items
    }
  } catch (error) {
    if (signal.aborted) throw new ApiError('QUERY_CANCELLED', '静态扫描已取消', 499)
    return empty(
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
        (error instanceof ApiError && error.code === 'TOOL_MISSING')
        ? 'unavailable'
        : 'failed',
      error instanceof ApiError && error.code === 'SOURCE_COMMAND_TIMEOUT'
        ? 'STATIC_TIMEOUT'
        : 'STATIC_EXECUTION_FAILED'
    )
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}
