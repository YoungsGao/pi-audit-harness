import { useEffect, useRef, useState } from 'react'
import type { AppInfo, ServiceStatus } from '../../shared/desktop-api'

const pages = [
  { id: 'models', title: '模型配置', description: '后续填写服务地址、模型 ID 和密钥。' },
  { id: 'projects', title: '项目管理', description: '后续导入本地源码或公开 GitHub 仓库。' },
  { id: 'analysis', title: '审计分析', description: '后续查看调用链、分析进度和源码证据。' },
  { id: 'reports', title: '审计报告', description: '后续查看并打开已生成的 HTML 报告。' }
] as const

type PageId = (typeof pages)[number]['id']

function describeApp(info: AppInfo): string {
  return `客户端通信正常：${info.name} ${info.version} / Electron ${info.electron} / Node ${info.node}`
}

function App(): React.JSX.Element {
  const [pageId, setPageId] = useState<PageId>('projects')
  const [checking, setChecking] = useState(false)
  const [bridgeMessage, setBridgeMessage] = useState('正在读取客户端信息…')
  const [service, setService] = useState<ServiceStatus | null>(null)
  const statusEvents = useRef(0)
  const page = pages.find((item) => item.id === pageId)!

  useEffect(() => {
    let active = true
    const unsubscribe = window.audit.onServiceStatus((status) => {
      statusEvents.current += 1
      if (active) setService(status)
    })
    const revision = statusEvents.current
    void window.audit
      .getServiceStatus()
      .then((status) => {
        if (active && statusEvents.current === revision) setService(status)
      })
      .catch((error: unknown) => {
        if (active)
          setBridgeMessage(
            `读取服务状态失败：${error instanceof Error ? error.message : String(error)}`
          )
      })
    void window.audit
      .getAppInfo()
      .then((info) => {
        if (active) setBridgeMessage(describeApp(info))
      })
      .catch((error: unknown) => {
        if (active)
          setBridgeMessage(
            `客户端通信失败：${error instanceof Error ? error.message : String(error)}`
          )
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  async function checkDesktopConnection(): Promise<void> {
    setChecking(true)
    const revision = statusEvents.current
    try {
      const [info, status] = await Promise.all([
        window.audit.getAppInfo(),
        window.audit.checkServiceHealth()
      ])
      setBridgeMessage(describeApp(info))
      if (statusEvents.current === revision) setService(status)
    } catch (error) {
      setBridgeMessage(`客户端通信失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">Pi Audit Harness</div>
        <p className="muted">源码审计客户端</p>
        <nav aria-label="主导航">
          {pages.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={pageId === item.id ? 'page' : undefined}
              onClick={() => setPageId(item.id)}
            >
              {item.title}
            </button>
          ))}
        </nav>
        <div className="phase">ENV-02 · Pi 运行环境</div>
      </aside>
      <main>
        <header>
          <h1>{page.title}</h1>
          <p className="muted">{page.description}</p>
        </header>
        <section className="card" aria-label="当前页面">
          <h2>{page.title}</h2>
          <p>页面导航已建立，具体功能将在对应 P0 步骤接入。</p>
        </section>
        <section className="card" aria-label="运行状态">
          <h2>运行状态</h2>
          <p role="status">服务状态：{service?.status ?? '读取中'}</p>
          {service?.pi && (
            <div>
              <p>
                Pi 状态：{service.pi.state} / 版本：{service.pi.sdkVersion}
              </p>
              <p>{service.pi.message}</p>
              {service.pi.code && <p>Pi 错误码：{service.pi.code}</p>}
            </div>
          )}
          <p>{service?.message ?? '正在读取本地服务状态…'}</p>
          {service?.code && <p className="muted">错误码：{service.code}</p>}
          {service?.requestId && <p className="muted">请求编号：{service.requestId}</p>}
          <p className="muted" role="status">
            {bridgeMessage}
          </p>
          <button type="button" disabled={checking} onClick={checkDesktopConnection}>
            {checking ? '检查中…' : '检查客户端与服务'}
          </button>
        </section>
      </main>
    </div>
  )
}

export default App
