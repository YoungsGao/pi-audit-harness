# Pi Audit Harness 桌面客户端

Electron + React + TypeScript，业务后端由 Electron `utilityProcess` 承载。当前验证平台为 Windows x64；密钥使用 Windows Credential Manager，SQLite 使用 Node 内置 `node:sqlite`。

## 安装与运行

在本目录使用 Node.js 24 与 npm：

```powershell
npm ci
npm run dev
```

正式构建与 Windows 打包：

```powershell
npm run build
npm run build:unpack
# 如需生成未签名安装程序：npm run build:win
```

`build:unpack` 的可执行文件在 `dist/win-unpacked/desktop.exe`。Mac/Linux 脚本来自构建模板，本次没有做对应平台验收，凭据适配目前仅支持 Windows。

## 使用流程

1. “项目管理”：检测 Git/rg，导入已有 Java 源码目录，或下载公开 GitHub 仓库。缺少 Git 时仍可本地导入。
2. “审计分析”：选择项目，手动执行预处理，查看持久化的路径、源码位置和数据库统计；此时不调用模型。
3. “模型配置”：填写名称、Base URL、模型 ID 和 API Key，保存后另行“应用选择”，点击测试才发送一次 ping。
4. “审计分析”：选中路径与已保存模型，再主动开始一次单路径审阅。源码片段将发送至所选服务。

当前协议为 OpenAI Chat Completions 兼容接口。Responses-only 服务尚不支持；模型 ID 按供应商实际支持填写。不要把 Codex 的整个 TOML 配置粘贴进应用。

## 验证

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/*.test.mjs
npm run lint -- --max-warnings=0
npm run build

.\node_modules\.bin\electron-vite.cmd build --config electron.source-test.config.ts
node tests/run-source-electron.mjs
.\node_modules\.bin\electron-vite.cmd build --config electron.mod03-test.config.ts
node tests/run-mod03-electron.mjs
.\node_modules\.bin\electron-vite.cmd build --config electron.scan-test.config.ts
node tests/run-scan-electron.mjs
```

测试使用独立目录与本机模型替身；Windows 凭据测试仅操作测试创建的随机引用。不会使用你保存的模型密钥请求外部供应商。

SQLite 位于应用 `userData` 下的 `runtime/storage/audit.sqlite3`，以启动日志显示的数据根目录为准。运行数据、凭据、node_modules、测试产物与安装包不提交 Git。不要通过删除正式数据库来解决模型超时。

## 技术文档

- [BUILD-01 / SOURCE-01：实现记录与学习指南](../docs/technical/05.BUILD-SOURCE-实现记录与学习指南.md)
- [规则 / 查询 / 必要调用链](../docs/technical/03.TPL-QRY-DB03-实现与学习指南.md)
- [预处理 / 路径上下文 / 工作台](../docs/technical/04.SCAN-UI-调用链预处理与工作台学习指南.md)

当前审阅有 60 秒 Pi 操作超时，单路径全流程有 90 秒上限。完整 Goal/Loop、SSE、交互图、不可变源码快照和正式报告另有后续需求。
