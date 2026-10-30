import { useState } from 'react'
import { helpLinks } from '../../../shared/help-links'
import type { HelpLink } from '../../../shared/help-links'

export function OpenRouterGuide({
  firstConfiguration
}: {
  firstConfiguration: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(firstConfiguration),
    [error, setError] = useState('')
  function link(id: HelpLink, label: string): React.JSX.Element {
    return (
      <a
        href={helpLinks[id]}
        onClick={(event) => {
          event.preventDefault()
          void window.audit
            .openHelpLink(id)
            .catch(() => setError('无法打开浏览器，请复制链接手动访问：' + helpLinks[id]))
        }}
      >
        {label}
      </a>
    )
  }
  return (
    <section className="input-help" aria-label="OpenRouter 配置帮助">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid="openrouter-guide-toggle"
      >
        {open ? '收起 OpenRouter 配置教程' : '打开 OpenRouter 配置教程'}
      </button>
      {open && (
        <div data-testid="openrouter-guide">
          <h3>OpenRouter 手动配置教程</h3>
          <ol>
            <li>在 {link('account', 'OpenRouter 官网')}注册并登录账号。</li>
            <li>
              打开 {link('keys', 'API Keys')}，创建自己的
              Key，并按需要设置额度上限。只在下方密码框填写，保存后由系统凭据库保管。
            </li>
            <li>
              在 {link('models', '官方模型目录')}查看模型详情，复制完整模型 ID。占位格式为{' '}
              <code>provider/model-name</code>，需要替换成你实际选择且支持工具调用的模型 ID。
            </li>
            <li>
              Base URL 填写 <code>https://openrouter.ai/api/v1</code>。不要追加{' '}
              <code>/chat/completions</code>；配置名称可以自行命名。
            </li>
            <li>
              在 {link('credits', '账户额度页')}检查余额和 Key
              限额；价格、免费模型限制和可用性以官网当前信息为准，参阅{' '}
              {link('limits', '额度与速率限制')}。
            </li>
            <li>
              保存配置后显式“应用选择”，再主动“测试模型连通性”。测试只发送固定
              ping，不包含项目源码；正式审计前另行确认源码发送范围。
            </li>
          </ol>
          <p>
            401：检查 Key；402：检查余额/额度；404：检查 Base URL 和完整模型
            ID；429：检查速率限制后稍后再试。连通成功只证明请求可达，不能证明审计准确性。
          </p>
          <p>
            本应用按你填写的模型 ID 调用，不自动发现、选择或切换模型。OpenRouter
            可能将请求路由到其上游供应商，发送前应查看其数据政策。
          </p>
          <p>{link('quickstart', '官方快速入门')} · 所有外链均需你主动点击。</p>
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </section>
  )
}
