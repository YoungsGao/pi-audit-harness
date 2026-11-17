# pi-audit-harness

本地 Agent 源码审计客户端，面向 Java/Spring 源码的有界候选调用链、受控取证、传播核查和可复核报告。

**Windows x64 · Electron / React / TypeScript · Pi SDK 1.2.0 · SQLite**

## 当前进度

已实现构建与模型配置、源码输入、调用链预处理、受控 Agent 循环、持久化 SSE、四标签证据详情和报告主流程，并完成配置/输入增强、TPL-02～TPL-04、QRY-02～QRY-05，以及 UI-02、UI-04、REP-01、REP-03、RUN-01、RUN-02、SEC-01～SEC-03、QA-01～QA-03，覆盖 51 个子需求的当前范围。源码登记、模板编辑/导入、预处理、语义查询、补充手工点、历史查看、人工复核和报告导出不会调用模型；分析前须确认发送范围并主动开始。

| 模块 | 当前能力 |
| --- | --- |
| 构建与配置 | 本地认证服务、Windows 凭据、显式模型选择、主动 Pi ping、OpenRouter 教程和发送授权 |
| 源码与扫描 | 本地 Java / 公开 GitHub、固定 Java 快照、SQL/命令/路径遍历内置规则、有界候选路径、手工风险点 |
| 审计知识 | 模板表单编辑、安全 Markdown/Skill 文档导入、版本固定、项目要求与实际 Agent 上下文 |
| 查询增强 | CodeGraph固定快照图、认证HTTP/CLI、候选精度分层、投影复用与basic降级；无需JDK |
| 分析 | SQLite 原子队列、真实 Pi 工具循环、证据缺口调查面板、预算/无进展停止、结构与原文核查、错误收敛 |
| 对照评测 | 固定9类Java场景，比较只读步骤/CodeGraph/静态扫描；工程替身与真实模型分开，记录用量、失败、历史和JSON导出 |
| 结果 | 交互调用图与固定源码定位、传播/防护/过程、独立人工复核版本、历史尝试和断线补发 |
| 报告 | 同快照预览与筛选、HTML/JSON、机器与人工独立统计、阶段原因、摘要验证和原生另存 |
| 工作台 | 保留既有配色、完整宽度配置、固定导航、独立滚动、窄屏布局和键盘交互 |
| 执行恢复 | 主动停止/等待确认、原快照下的Pi会话与取证进度恢复、累计预算、已提交结果幂等和恢复清单 |
| 安全边界 | 仓库指令与运行资源隔离、受控只读工具、CodeGraph最少输入与环境、密钥回显拒绝、固定IPC与文本转义 |

当前Node回归240项通过、0失败、0跳过。2026-11-09 QA基线包含18例工程回归、真实证据卡分类、一小时后端运行、50节点与停止恢复、Windows安装验收；2026-11-10进一步验证真实完整模型循环并修正输出可靠性。2026-11-15调查与对照评测验证见技术文档21。范围与限制见[质量验收](docs/technical/15.质量验收性能基线与交付.md)及[实现验收](docs/technical/07.实现进度与验收.md)。旧JDT测试随后端删除。

## MCP 补证与静态扫描

2026-11-11：新增 CodeGraph 一层关联查询/原文补证和固定 Semgrep 静态扫描 MCP，接入原工具预算、证据校验、恢复回执、时间线及 HTML/JSON 报告。旧会话保留原工具权限；Semgrep 需显式配置本地固定版本路径。零付费实验：在 desktop 目录执行 `npm run mcp:lab -- init`，随后按 [17 MCP 技术文档](docs/technical/17.CodeGraph补证与静态扫描MCP.md) 运行 demo。

## 启动

2026-11-10：[真实模型输出可靠性](docs/technical/16.真实模型输出可靠性与工程纠错.md)已补齐完整路径实测、证据编号、字段诊断、有限纠错和瞬态重试；最终18例三轮54条完整循环均提交完成，标签差异按具体路径保留。源码更新后需退出旧进程再启动，新尝试使用新逻辑。

Windows x64，Node.js 24（包含 node:sqlite），在 `desktop` 目录执行：

```powershell
npm ci
npm run dev
```

项目管理导入源码 → 按需管理模板和项目要求 → 选择模板版本，预处理并固定源码与审查材料 → 按需补充手工点 → 配置并选择模型 → 确认发送范围 → 明确开始路径分析 → 点选调用图查看证据并独立复核 → 报告页预览、筛选并生成/另存。当前模型接口支持 OpenAI Chat Completions 兼容协议，Responses-only 服务尚未支持。

完整使用和验证命令见 [桌面客户端说明](desktop/README.md)。API Key 存系统凭据库，运行数据库、生成报告、安装包与个人资料不提交 Git。

项目本地许可证草稿为 [MIT](LICENSE)，上游许可见[第三方依赖说明](THIRD_PARTY_NOTICES.md)。Windows 安装包尚未作为 GitHub Release 发布；此前本地安装包随附离线技术文档、模板、查询Skill说明、原创样例与示例报告。

## 文档

| 入口 | 内容 |
| --- | --- |
| [文档站](https://youngsgao.github.io/pi-audit-harness/) | 项目入口 |
| [产品需求](https://youngsgao.github.io/pi-audit-harness/docs/prd/index.html) | 需求范围、依赖与验收条目 |
| [交互原型](https://youngsgao.github.io/pi-audit-harness/docs/prototype/index.html) | 产品交互参考，包含尚未实现内容 |
| [技术文档](docs/technical/README.md) | 01—21 连续编号的架构、输入、数据、Agent、界面、报告、图资源、安全、交付、调查面板与对照评测 |
| [在线技术目录](https://youngsgao.github.io/pi-audit-harness/docs/technical/index.html) | 仓库 Markdown 阅读器 |

查询默认CodeGraph，JDT-LS已删除，不再配置Java运行时；可显式选择basic。见[统一查询](docs/technical/10.统一代码查询与Java语义服务.md)和[图资源管理](docs/technical/13.CodeGraph固定快照图与资源管理.md)。

`desktop/` 是正式桌面和 TypeScript 业务服务；`python/src/pi_audit/audit_mcp/` 是正式本地 MCP 后端。`agent/`、旧Python取证入口和部分fixtures保留早期原型。固定Java快照支持路径交互及经证据核验的恢复；跨语言传播、完整依赖解析等范围见进度文档。

项目汇报可直接查看 [数据库表设计与ER图](docs/technical/18.数据库表设计与ER图汇报.md) 或打开 [离线汇报网页](docs/technical/assets/data-model/项目数据库设计汇报.html)，包含21表、244字段与实际外键图。

2026-11-12：SQLite v15 将 33 表合并为 21 表，统一事件、尝试、工具回执和模型请求，收拢一对一配置；只重试临时锁错误。含数据旧库迁移、SSE游标、原生恢复及报告验证见 [19 表合并](docs/technical/19.数据库表合并与工程简化.md)。

2026-11-12：CodeGraph补证与静态扫描现使用真实 Python 本地 HTTP MCP；新增“扩展服务”页，支持配置CRUD、JSON导入、连接测试、工具启停、自定义工具手动调用。运行需 Python 3.11+ 和 python/requirements-runtime.txt；安装配置、独立启动与边界见[20 技术文档](docs/technical/20.Python本地MCP服务与客户端管理.md)。

2026-11-15：新增证据缺口调查面板与三组对照评测中心，增加Spring JDBC/ORM/准备语句候选、Servlet入口及同名接收者排除；修复真实服务的扫描stdin等待、评测长路径及MCP回执交接。真实小样本、初始失败和预算停止均保留，见[21 技术文档](docs/technical/21.证据调查面板对照评测与Java检测增强.md)。
