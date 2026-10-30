# pi-audit-harness

本地 Agent 源码审计客户端，面向 Java/Spring 源码的有界候选调用链、受控取证、传播核查和可复核报告。

**Windows x64 · Electron / React / TypeScript · Pi SDK 1.2.0 · SQLite**

## 当前进度

已实现构建与模型配置、源码输入、调用链预处理、受控 Agent 循环、持久化 SSE、四标签证据详情和报告主流程，并完成配置/输入增强、TPL-02～TPL-04、QRY-02～QRY-05，以及 UI-02、UI-04、REP-01、REP-03、RUN-01、RUN-02，覆盖 45 个子需求的当前范围。源码登记、模板编辑/导入、预处理、语义查询、补充手工点、历史查看、人工复核和报告导出不会调用模型；分析前须确认发送范围并主动开始。

| 模块 | 当前能力 |
| --- | --- |
| 构建与配置 | 本地认证服务、Windows 凭据、显式模型选择、主动 Pi ping、OpenRouter 教程和发送授权 |
| 源码与扫描 | 本地 Java / 公开 GitHub、固定 Java 快照、SQL/命令/路径遍历内置规则、有界候选路径、手工风险点 |
| 审计知识 | 模板表单编辑、安全 Markdown/Skill 文档导入、版本固定、项目要求与实际 Agent 上下文 |
| 查询增强 | 统一 HTTP/CLI、Java JDT-LS 定义/引用/调用层次、会话复用与明确降级，固定快照内语义关系进入风险路径 |
| 分析 | SQLite 原子队列、真实 Pi 工具循环、预算/无进展停止、结构与原文核查、错误收敛 |
| 结果 | 交互调用图与固定源码定位、传播/防护/过程、独立人工复核版本、历史尝试和断线补发 |
| 报告 | 同快照预览与筛选、HTML/JSON、机器与人工独立统计、阶段原因、摘要验证和原生另存 |
| 工作台 | 保留既有配色、完整宽度配置、固定导航、独立滚动、窄屏布局和键盘交互 |
| 执行恢复 | 主动停止/等待确认、原快照下的Pi会话与取证进度恢复、累计预算、已提交结果幂等和恢复清单 |

本次 Node 回归 177 项通过，包含真实 JDT-LS 与 Pi 联调、0跳过。验证范围、命令和后续需求见 [实现进度与验收](docs/technical/07.实现进度与验收.md)。候选调用、模型结论与已确认漏洞不等价；未知和失败不计为安全。

## 启动

Windows x64，Node.js 24（包含 node:sqlite），在 `desktop` 目录执行：

```powershell
npm ci
npm run dev
```

项目管理导入源码 → 按需管理模板和项目要求 → 选择模板版本，预处理并固定源码与审查材料 → 按需补充手工点 → 配置并选择模型 → 确认发送范围 → 明确开始路径分析 → 点选调用图查看证据并独立复核 → 报告页预览、筛选并生成/另存。当前模型接口支持 OpenAI Chat Completions 兼容协议，Responses-only 服务尚未支持。

完整使用和验证命令见 [桌面客户端说明](desktop/README.md)。API Key 存系统凭据库，运行数据库、生成报告、安装包与个人资料不提交 Git。

## 文档

| 入口 | 内容 |
| --- | --- |
| [文档站](https://youngsgao.github.io/pi-audit-harness/) | 项目入口 |
| [产品需求](https://youngsgao.github.io/pi-audit-harness/docs/prd/index.html) | 需求范围、依赖与验收条目 |
| [交互原型](https://youngsgao.github.io/pi-audit-harness/docs/prototype/index.html) | 产品交互参考，包含尚未实现内容 |
| [技术文档](docs/technical/README.md) | 01—13 连续编号的架构、输入、数据、Agent、界面、报告、进度、增强模块与操作手册 |
| [在线技术目录](https://youngsgao.github.io/pi-audit-harness/docs/technical/index.html) | 仓库 Markdown 阅读器 |

Java 语义增强在服务启动前配置 PI_AUDIT_JAVA_HOME 与 PI_AUDIT_JDTLS_HOME，缺失时保留基础候选与覆盖告警。安装、CLI 与兼容版本见 [统一查询技术文档](docs/technical/10.统一代码查询与Java语义服务.md)。

`desktop/` 是当前正式桌面和 TypeScript 业务服务；`agent/`、`python/`、`contracts/`、`fixtures/` 保留早期取证原型，Python 不是桌面业务后端。固定源码快照覆盖明确的 Java 范围；当前不包含全仓库全语言快照、跨语言传播、完整依赖解析、Agent 检查点续跑或完整交互调用图；后续范围见进度文档。
