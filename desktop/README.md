# Pi Audit Harness 桌面客户端

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
2. 审计分析：选项目并预处理，持久化候选调用边、路径、有序步骤和覆盖限制。
3. 模型配置：保存供应商 URL、模型 ID 和 Key，再明确应用选择；点击测试才发送 ping。
4. 审计分析：主动审阅一条路径或待办队列；受控源码片段发送至所选供应商。失败、未知与安全分开显示。
5. 查看四个路径标签及三段过程；切换、刷新历史、原会话重连不重新调用模型。
6. 报告页按项目/任务生成、查询并打开已登记 HTML，未知和未完成内容保留为阶段报告。

当前协议为 OpenAI Chat Completions 兼容接口；Responses-only 服务不支持。Base URL 和模型 ID 按供应商支持填写。支持 ping 不保证供应商能稳定完成审计工具循环或结构化输出。

## 验证

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/*.test.mjs
npm run build
npm run lint -- --max-warnings=0
.\node_modules\.bin\electron-vite.cmd build --config electron.scan-test.config.ts
node tests/run-scan-electron.mjs
npm run test:qa04
```

最后一项需真实访问公开 GitHub，额外验证公开下载、缺 Git、本地回退、模型配置 ping 和客户端至报告全流程。模型请求使用本机替身，凭据测试只操作测试自己生成的引用，不使用用户保存的付费模型 Key。

应用数据根目录以启动日志为准，SQLite 为 `runtime/storage/audit.sqlite3`，报告在 runtime/reports。测试产物、数据库、node_modules、安装包和个人笔记不提交。

## 技术文档

[架构与运行](../docs/technical/01.项目架构与运行.md) · [源码与预处理](../docs/technical/02.源码输入与预处理.md) · [数据模型](../docs/technical/03.数据模型与持久化.md) · [Agent 与 SSE](../docs/technical/04.Agent分析与事件协议.md) · [工作台](../docs/technical/05.审计工作台.md) · [报告](../docs/technical/06.报告生成与管理.md) · [进度与验收](../docs/technical/07.实现进度与验收.md)。
