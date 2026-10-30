import { SourcesPage } from './components/SourcesPage'
import { AuditPage } from './components/AuditPage'
import { ReportsPage } from './components/ReportsPage'
import { ModelsPage } from './components/ModelsPage'
import { TemplatesPage } from './components/TemplatesPage'
import { useEffect, useRef, useState } from 'react'
import { MetadataCard } from './components/MetadataCard'
import { StorageCard } from './components/StorageCard'
import type { AppInfo, ServiceStatus } from '../../shared/desktop-api'

const pages = [
  {
    id: 'models',
    title: '模型配置',
    description: '手动保存、编辑并选择模型配置；密钥交给系统凭据管理器。'
  },
  {
    id: 'projects',
    title: '项目管理',
    description: '检测工具、导入本地 Java 源码或公开 GitHub 仓库并登记项目。'
  },
  {
    id: 'analysis',
    title: '审计分析',
    description: '预处理源码，查看数据库中的调用链、分析状态和路径证据。'
  },
  {
    id: 'templates',
    title: '审计模板',
    description: '编辑、预览或导入审计知识文档；创建任务时按版本选择。'
  },
  {
    id: 'reports',
    title: '审计报告',
    description: '筛选已保存结果，保留独立人工结论，生成 HTML 或导出 JSON。'
  }
] as const

type PageId = (typeof pages)[number]['id']

function PageIcon({ page }: { page: PageId }): React.JSX.Element {
  const paths: Record<PageId, React.JSX.Element> = {
    templates: (
      <>
        <path d="M5 3h14v18H5ZM8 7h8M8 11h8M8 15h5" />
      </>
    ),
    models: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="15" cy="17" r="3" />
      </>
    ),
    projects: <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3Z" />,
    analysis: (
      <>
        <circle cx="5" cy="6" r="2" />
        <circle cx="19" cy="6" r="2" />
        <circle cx="12" cy="18" r="2" />
        <path d="m6 8 5 8m7-8-5 8M7 6h10" />
      </>
    ),
    reports: (
      <>
        <path d="M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6M9 16h6" />
      </>
    )
  }
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[page]}
    </svg>
  )
}

function describeApp(info: AppInfo): string {
  return `客户端通信正常：${info.name} ${info.version} / Electron ${info.electron} / Node ${info.node}`
}

function App(): React.JSX.Element {
  const [pageId, setPageId] = useState<PageId>('projects')
  const [checking, setChecking] = useState(false)
  const [bridgeMessage, setBridgeMessage] = useState('正在读取客户端信息…')
  const [service, setService] = useState<ServiceStatus | null>(null)
  const statusEvents = useRef(0)
  const workspace = useRef<HTMLElement>(null)
  const page = pages.find((item) => item.id === pageId)!
  const serviceLabel = service
    ? {
        starting: '本地服务启动中',
        ready: '本地服务就绪',
        failed: '本地服务异常',
        stopping: '本地服务停止中',
        stopped: '本地服务已停止'
      }[service.status]
    : '正在读取服务状态'

  useEffect(() => {
    workspace.current?.scrollTo({ top: 0 })
  }, [pageId])

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
      <a className="skip-link" href="#workspace-main">
        跳转到正文
      </a>
      <aside className="sidebar">
        <div className="brand-lockup">
          <svg className="brand-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">
            <path d="M12 11h16M12 11l8 18 8-18" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="12" cy="11" r="4" />
            <circle cx="28" cy="11" r="4" />
            <circle cx="20" cy="29" r="4" />
          </svg>
          <div className="brand-copy">
            <div className="brand">pi-audit-harness</div>
            <p>源码审计工作台</p>
          </div>
        </div>
        <nav aria-label="主导航">
          {pages.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.title}
              aria-current={pageId === item.id ? 'page' : undefined}
              onClick={() => setPageId(item.id)}
            >
              <PageIcon page={item.id} />
              <span className="nav-label">{item.title}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-status" title={serviceLabel}>
            <span className="status-dot" data-state={service?.status ?? 'loading'} />
            <span>{serviceLabel}</span>
          </div>
          <p className="phase">
            本地源码审计
            <br />
            调用链与证据
          </p>
        </div>
      </aside>
      <main id="workspace-main" className="workspace-main" ref={workspace} tabIndex={-1}>
        <div className="workspace-content">
          <header className="workspace-header">
            <div>
              <h1>{page.title}</h1>
              <p>{page.description}</p>
            </div>
            <span className="workspace-location">
              <span className="status-dot" data-state={service?.status ?? 'loading'} />
              {serviceLabel}
            </span>
          </header>
          {pageId === 'models' ? (
            <ModelsPage />
          ) : pageId === 'projects' ? (
            <>
              <SourcesPage />
              <MetadataCard />
            </>
          ) : pageId === 'templates' ? (
            <TemplatesPage />
          ) : pageId === 'analysis' ? (
            <AuditPage />
          ) : (
            <ReportsPage />
          )}
          <div className="workspace-diagnostics">
            <StorageCard />
            <section className="card runtime-card" aria-label="运行状态">
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
          </div>
        </div>
      </main>
    </div>
  )
}

export default App
