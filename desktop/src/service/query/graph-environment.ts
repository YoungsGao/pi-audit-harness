// A graph worker needs runtime/locale/temp paths, not the parent's API keys, proxies or preload hooks.
export function graphEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parent))
    if (/^(?:path|pathext|systemroot|windir|temp|tmp|tmpdir|lang|lc_all|tz)$/i.test(key))
      env[key] = value
  return Object.assign(env, {
    CODEGRAPH_PARSE_WORKERS: '1',
    CODEGRAPH_RESOLVE_WORKERS: '0',
    CODEGRAPH_NO_PARALLEL_RESOLVE: '1',
    CODEGRAPH_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
    CODEGRAPH_NO_UPDATE_CHECK: '1',
    CODEGRAPH_NO_DAEMON: '1'
  })
}
