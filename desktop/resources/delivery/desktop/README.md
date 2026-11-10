# pi-audit-harness 桌面客户端

Electron + React + TypeScript，业务后端由 utilityProcess 承载。当前验证平台 Windows x64，凭据使用 Windows Credential Manager，数据库使用 Node 内置 SQLite。

## 安装与运行

使用 Node.js 24，在本目录运行：

```powershell
npm ci
npm run dev
```

构建：`npm run build`；解包：`npm run build:unpack`；Windows安装交付步骤见[技术15](../docs/technical/15.质量验收性能基线与交付.md)。先生成合规清单与离线材料，再生成未签名NSIS。当前验证Windows10 x64，签名、多平台和远端发布未验收。

## 使用


1. 项目管理：检测 Git/rg，登记本地 Java 目录或下载公开 GitHub 仓库。
2. 审计分析：选项目并预处理，固定 Java 快照，持久化候选调用边、路径、有序步骤和覆盖限制；可从快照补充手工风险点。
3. 模型配置：首次配置可阅读 OpenRouter 教程，保存供应商 URL、模型 ID 和 Key，再明确应用选择；点击测试才发送 ping。
4. 审计分析：先查看并确认目标服务、模型及源码发送范围，再主动审阅一条路径或待办队列。配置或快照范围变化后重新确认。失败、未知与安全分开显示。
5. 点选调用图的节点、关系和防护查看固定快照源码；四个路径标签与过程保持可查。人工状态和备注独立保存，不改机器结论或原始证据。
6. 报告页按机器结论、调查状态和人工状态筛选，预览后生成HTML/JSON；原生另存或打开已登记HTML。未知、未完成、筛选范围与结束原因保留为阶段说明。
7. 审计模板页可新建/编辑知识文档，导入 .md、SKILL.md 或 Skill 目录；审计页选择模板并保存项目要求，创建任务固定全文和版本。导入只读取文档，不执行关联脚本。

当前协议为 OpenAI Chat Completions 兼容接口；Responses-only 服务不支持。Base URL 和模型 ID 按供应商支持填写。支持 ping 不保证供应商能稳定完成审计工具循环或结构化输出。

任务控制面板可主动停止，区分受理、等待与已停止；重启后先核对恢复清单再主动继续。Pi会话、证据、原配置及累计预算一并校验，已提交路径不重复调查。停止/恢复详见[技术文档12](../docs/technical/12.任务停止与可验证会话恢复.md)。

## 验证

2026-11-10新增[真实模型可靠性](../docs/technical/16.真实模型输出可靠性与工程纠错.md)：证据编号还原原文、具体字段反馈、JSON受限结构修复、固定输入核验、一次纠错与一次瞬态重试，均受原预算约束。`npm run test:reliability`不调用付费模型；`node scripts/reliability-lab.mjs 18767`提供badonce/bad/normal本机实验服务器。更新后退出旧客户端并重启；旧失败会话只读，需明确新建尝试。

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/*.test.mjs
npm run build
npm run lint -- --max-warnings=0
.\node_modules\.bin\electron-vite.cmd build --config electron.scan-test.config.ts
node tests/run-scan-electron.mjs
.\node_modules\.bin\electron-vite.cmd build --config electron.mod01-test.config.ts
node tests/run-mod01-electron.mjs
.\node_modules\.bin\electron-vite.cmd build --config electron.templates-test.config.ts
node tests/run-templates-electron.mjs
.\node_modules\.bin\electron-vite.cmd build --config electron.review-test.config.ts
node tests/run-review-electron.mjs
.\node_modules\.bin\electron-vite.cmd build --config electron.run-test.config.ts
node tests/run-run-electron.mjs
npm run test:security
npm run test:qa04
```

最后一项需真实访问公开 GitHub，额外验证公开下载、缺 Git、本地回退、模型配置 ping 和客户端至报告全流程。模型请求使用本机替身，凭据测试只操作测试自己生成的引用，不使用用户保存的付费模型 Key。

应用数据根目录以启动日志为准，SQLite 为 `runtime/storage/audit.sqlite3`，报告在 runtime/reports。测试产物、数据库、node_modules、安装包和个人笔记不提交。

四项增强的重点验证：`node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/input-enhancements.test.mjs`。历史任务缺少固定快照时可查看旧结果，但新取证需要重新登记并创建新任务；旧任务不从当前磁盘补造快照。

模板功能验证：`node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/template-workflow.test.mjs`。自定义知识未经验证，不自动改变内置扫描规则；选定文档与项目要求实际进入对应任务 Agent 上下文。

[模板技术方案](../docs/technical/09.审计知识模板与项目审查配置.md)。

停止与恢复专项：`node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/run-recovery.test.mjs`。14项测试包含真实Pi、跨进程强制中断、原生续跑、回退、累计预算与停止报告；不使用真实付费模型。

安全专项：`npm run test:security`，包含12项边界、1项实验脚本与真实Electron渲染/IPC验证。无需真实Key；隔离材料与运行资源，检查只读工具/CodeGraph边界、凭据回显及HTML转义。详见[14 安全边界](../docs/technical/14.安全边界与不可信输入防护.md)。这是应用访问限制，不是业务后端的OS级沙箱。

亲手实验（当前desktop目录）：

```powershell
$raw = node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/security-lab.mjs init | Out-String
if ($LASTEXITCODE -ne 0) { throw '实验初始化失败，请查看上方错误' }
$sec = $raw | ConvertFrom-Json -ErrorAction Stop
$sec | Format-List source, skill, labFile
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/security-lab.mjs check $sec.labFile
Test-Path -LiteralPath $sec.marker
```

检查预期ok=true、backend=codegraph、sourceUnchanged=true、projectScriptExecuted=false、modelRequests=0，最后False。每次独立目录位于根.local/security-lab，完整知识点与桌面逐步操作在本地学习43—46。

## 技术文档

QA-01～03：[质量验收、性能基线与交付](../docs/technical/15.质量验收性能基线与交付.md)。`npm run test:qa`检查语料与4项基础回归，`npm run qa:acceptance`执行54次本机模型协议链路，`npm run qa:ui`运行真实Electron性能/停止/恢复，`npm run qa:soak`实际运行一小时；这些命令均不调用付费模型。真实模型校准需另行显式开启，共享预算账本不会自动归零。

本地项目许可证：[MIT](../LICENSE)。运行依赖与内嵌CodeGraph组件的版本和原许可证见[第三方说明](../THIRD_PARTY_NOTICES.md)，安装包的resources/compliance保留完整清单；项目许可证不改变上游许可。

交互调用图、原配色配置布局、人工复核及筛选导出见 [11 交互路径图、人工复核与结果导出](../docs/technical/11.交互路径图人工复核与结果导出.md)。新增9项确定性测试为tests/review-export.test.mjs；Electron联调覆盖节点/关系/防护/分支、键盘、备注恢复、筛选、另存取消/保存、HTML打开及1450/920/480布局。

查询后端已改为CodeGraph1.6.2，JDT-LS及Java进程管理已删除，无需JDK。见[统一查询](../docs/technical/10.统一代码查询与Java语义服务.md)和[图资源管理](../docs/technical/13.CodeGraph固定快照图与资源管理.md)。

`npm run query:serve`在已有任务库上启动轻量监督器，CLI从stdin接收JSON；使用可信父进程注入连接token。接口见[说明](query-skill/SKILL.md)。真实SDK及统一查询验证：`node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/query-codegraph.test.mjs tests/query-enhancements.test.mjs tests/query-lab.test.mjs`。亲手实验：`node scripts/query-lab.mjs init`，再用输出的labFile执行`node scripts/query-lab.mjs query <labFile>`。

[架构与运行](../docs/technical/01.项目架构与运行.md) · [源码与预处理](../docs/technical/02.源码输入与预处理.md) · [数据模型](../docs/technical/03.数据模型与持久化.md) · [Agent 与 SSE](../docs/technical/04.Agent分析与事件协议.md) · [工作台](../docs/technical/05.审计工作台.md) · [报告](../docs/technical/06.报告生成与管理.md) · [进度与验收](../docs/technical/07.实现进度与验收.md) · [配置授权、快照与手工调查](../docs/technical/08.配置授权快照与手工调查.md)。
