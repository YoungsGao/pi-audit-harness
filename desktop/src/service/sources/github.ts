import { mkdir, mkdtemp, rename, rm, realpath, lstat } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SourceProject } from '../../shared/source-contracts'
import { ApiError } from '../../shared/api-error.ts'
import { command } from './process.ts'
import { detectTool } from './tools.ts'
import { input, text, duplicate, openProject } from './local.ts'
import { scanJava } from './scan.ts'
import type { SourceRepository } from './repository'
export function githubUrl(value: unknown): { url: string; name: string } {
  const raw = text(value, 2048)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ApiError('SOURCE_URL_INVALID', '请输入公开 GitHub 仓库 HTTPS 链接', 400)
  }
  const parts = url.pathname.replace(/\/$/, '').split('/').slice(1)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    parts.length !== 2 ||
    !parts.every((p) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/.test(p))
  )
    throw new ApiError(
      'SOURCE_URL_INVALID',
      '仅支持 https://github.com/所有者/仓库，不接受凭据、分支路径或其他主机',
      400
    )
  const name = parts[1].replace(/\.git$/, '')
  if (!name || name === '.' || name === '..')
    throw new ApiError('SOURCE_URL_INVALID', '仓库名称无效', 400)
  return { url: `https://github.com/${parts[0]}/${name}.git`, name }
}
export interface CloneContext {
  url: string
  destination: string
  hooks: string
  signal?: AbortSignal
}
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env))
    if (/^GIT_/i.test(key) || /^(?:GH_TOKEN|GITHUB_TOKEN)$/i.test(key)) delete env[key]
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_LFS_SKIP_SMUDGE: '1'
  })
  return env
}
export async function clonePublic(context: CloneContext): Promise<void> {
  // 不继承凭据助手/URL 重写/外部 filter，不运行 hooks、不递归下载子模块。
  await command(
    'git',
    [
      '-c',
      'credential.helper=',
      '-c',
      'core.askPass=',
      '-c',
      'http.followRedirects=false',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      '-c',
      `core.hooksPath=${context.hooks}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.symlinks=false',
      'clone',
      '--depth=1',
      '--single-branch',
      '--no-tags',
      '--no-recurse-submodules',
      '--',
      context.url,
      context.destination
    ],
    { env: gitEnvironment(), timeoutMs: 60000, signal: context.signal }
  )
}
// 只注入测试 transport；HTTP 仍只允许 githubUrl，不暴露自定义命令或 file://。
export async function importGithub(
  repo: SourceRepository,
  dataRoot: string,
  value: unknown,
  signal?: AbortSignal,
  clone = clonePublic
): Promise<SourceProject> {
  const row = input(value, ['gitUrl', 'projectName', 'duplicate']),
    parsed = githubUrl(row.gitUrl),
    choice = duplicate(row.duplicate)
  const name =
      row.projectName === undefined || row.projectName === ''
        ? parsed.name
        : text(row.projectName, 200),
    key = 'git:' + parsed.url.toLowerCase(),
    old = repo.find(key)
  if (old && choice === 'reject')
    throw new ApiError('SOURCE_DUPLICATE', '仓库已经导入；请选择打开已有或下载独立副本', 409)
  if (old && choice === 'open') return (await openProject(repo, old.projectId, signal)).project
  if ((await detectTool('git', signal)).state !== 'available')
    throw new ApiError(
      'GIT_REQUIRED',
      '未检测到可用 Git，请手动安装后重新检测；本地导入仍可使用',
      503
    )
  const managed = resolve(dataRoot, 'repositories')
  await mkdir(managed, { recursive: true })
  if ((await realpath(managed)).toLowerCase() !== managed.toLowerCase())
    throw new ApiError('SOURCE_MANAGED_PATH_INVALID', '应用仓库目录不可经过目录链接', 400)
  const staging = await mkdtemp(join(managed, '.partial-')),
    destination = join(staging, 'checkout'),
    hooks = join(staging, 'empty-hooks')
  await mkdir(hooks)
  let owned = staging
  try {
    await clone({ url: parsed.url, destination, hooks, signal })
    const scan = await scanJava(destination, signal)
    const commit = await command(
      'git',
      ['-c', 'core.fsmonitor=false', '-C', destination, 'rev-parse', '--verify', 'HEAD'],
      { signal, env: gitEnvironment() }
    )
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
      throw new ApiError('SOURCE_COMMIT_INVALID', '无法确认下载仓库的 commit', 502)
    const dirty = !!(await command(
      'git',
      [
        '-c',
        'core.fsmonitor=false',
        '-C',
        destination,
        'status',
        '--porcelain=v1',
        '--untracked-files=normal'
      ],
      { signal, env: gitEnvironment() }
    ))
    if (signal?.aborted) throw new ApiError('SOURCE_CANCELLED', '源码操作已取消', 499)
    // 只重命名本次独占的随机目录；绝不 pull/reset 或覆盖已登记目录。
    const final = join(managed, randomUUID())
    await rename(staging, final)
    owned = final
    return repo.save(
      name,
      key,
      { ...scan, path: join(final, 'checkout') },
      { url: parsed.url, commit, dirty }
    )
  } catch (error) {
    // 删除前验证所有权边界；失败不触碰用户本地源码或其他已导入仓库。
    try {
      if (
        dirname(owned) === managed &&
        !(await lstat(owned)).isSymbolicLink() &&
        (await realpath(owned)).toLowerCase() === owned.toLowerCase()
      )
        await rm(owned, { recursive: true, force: true })
    } catch {
      /* 保留残留目录供人工排查，不记录仓库内容。 */
    }
    throw error
  }
}
