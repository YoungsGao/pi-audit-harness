# pi-audit-harness 桌面客户端

Electron + React + TypeScript，业务后端由 utilityProcess 承载。当前验证平台 Windows x64，凭据使用 Windows Credential Manager，数据库使用 Node 内置 SQLite。

## 安装与运行

使用 Node.js 24，在本目录运行：

```powershell
npm ci
npm run dev
```

构建：`npm run build`；解包：`npm run build:unpack`；生成 Windows 安装程序：`npm run build:win`。打包脚本存在不等于签名、多平台和发布专项验收已完成。

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
npm run test:qa04
```

最后一项需真实访问公开 GitHub，额外验证公开下载、缺 Git、本地回退、模型配置 ping 和客户端至报告全流程。模型请求使用本机替身，凭据测试只操作测试自己生成的引用，不使用用户保存的付费模型 Key。

应用数据根目录以启动日志为准，SQLite 为 `runtime/storage/audit.sqlite3`，报告在 runtime/reports。测试产物、数据库、node_modules、安装包和个人笔记不提交。

四项增强的重点验证：`node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/input-enhancements.test.mjs`。历史任务缺少固定快照时可查看旧结果，但新取证需要重新登记并创建新任务；旧任务不从当前磁盘补造快照。

模板功能验证：`node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/template-workflow.test.mjs`。自定义知识未经验证，不自动改变内置扫描规则；选定文档与项目要求实际进入对应任务 Agent 上下文。

[模板技术方案](../docs/technical/09.审计知识模板与项目审查配置.md)。

停止与恢复专项：`node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/run-recovery.test.mjs`。14项测试包含真实Pi、跨进程强制中断、原生续跑、回退、累计预算与停止报告；不使用真实付费模型。

## 技术文档

交互调用图、原配色配置布局、人工复核及筛选导出见 [11 交互路径图、人工复核与结果导出](../docs/technical/11.交互路径图人工复核与结果导出.md)。新增9项确定性测试为tests/review-export.test.mjs；Electron联调覆盖节点/关系/防护/分支、键盘、备注恢复、筛选、另存取消/保存、HTML打开及1450/920/480布局。

查询增强见 [统一代码查询与Java语义服务](../docs/technical/10.统一代码查询与Java语义服务.md)。启动前用 PI_AUDIT_JAVA_HOME、PI_AUDIT_JDTLS_HOME 指定兼容的本机安装；本次实测 Temurin25 + 固定 JDT-LS1.64 快照。缺失时保留基础候选与覆盖告警，不自动安装。

`npm run query:serve` 在已有任务数据库上启动常驻查询监督器；`npm run query` 从标准输入接收一个JSON查询。调用方安全注入PI_AUDIT_DATA_ROOT、PI_AUDIT_QUERY_TOKEN与返回端口PI_AUDIT_QUERY_PORT；用法见 [接口说明](query-skill/SKILL.md)。确定性测试为tests/query-enhancements.test.mjs；设置PI_AUDIT_TEST_JDTLS=1及两个运行时目录后，tests/query-jdtls.test.mjs才实际启动Java服务器。

[架构与运行](../docs/technical/01.项目架构与运行.md) · [源码与预处理](../docs/technical/02.源码输入与预处理.md) · [数据模型](../docs/technical/03.数据模型与持久化.md) · [Agent 与 SSE](../docs/technical/04.Agent分析与事件协议.md) · [工作台](../docs/technical/05.审计工作台.md) · [报告](../docs/technical/06.报告生成与管理.md) · [进度与验收](../docs/technical/07.实现进度与验收.md) · [配置授权、快照与手工调查](../docs/technical/08.配置授权快照与手工调查.md)。
