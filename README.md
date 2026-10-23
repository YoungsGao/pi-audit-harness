# pi-audit-harness

面向企业蓝队的 Agent 源码审计客户端。以 Pi 扩展实现 Goal / Loop，通过代码查询与污点传播分析，呈现可复核的风险路径和源码证据。

**Windows x64 · Electron + Pi SDK + Skill + Cli**

## 文档导航

[文档站](https://youngsgao.github.io/pi-audit-harness/)

| 入口 | 内容 |
| --- | --- |
| [产品需求](https://youngsgao.github.io/pi-audit-harness/docs/prd/index.html) | 首版范围、需求总览、需求列表、右侧详情与关键设计 |
| [交互原型](https://youngsgao.github.io/pi-audit-harness/docs/prototype/index.html) | 体验项目导入、模拟审计、调用链查看、模板管理、模型配置及报告导出 |
| [技术方案](https://youngsgao.github.io/pi-audit-harness/docs/technical/index.html) | 在 [docs/technical](https://github.com/YoungsGao/pi-audit-harness/tree/main/docs/technical) 中使用 Markdown 编写技术方案，新增文件后运行 `node docs/technical/assets/gen-index.mjs` 再推送，由[技术方案页面](https://youngsgao.github.io/pi-audit-harness/docs/technical/index.html)列出并渲染，[文档模板](https://github.com/YoungsGao/pi-audit-harness/blob/main/docs/technical/_template.md) |

## 当前进度

- BUILD-01：Electron 客户端、TypeScript 本地服务、SQLite、Windows 系统凭据、模型配置和真实 Pi ping 已接通。
- SOURCE-01：工具检测、本地 Java 源码登记、公开 GitHub 下载、三类风险规则、有界候选调用链及工作台已接通。
- SQLite 保存必要调用边、路径、有序步骤、调查状态和证据；共享调用边的路径结论独立保存。
- 工作台支持用户主动启动一次有界单路径模型审阅；完整 Goal / Loop、SSE、交互图和正式报告仍待后续实现。

完成范围、关键代码、测试记录及当前限制见 [BUILD-01 / SOURCE-01 实现记录与学习指南](docs/technical/05.BUILD-SOURCE-实现记录与学习指南.md)。需求页面与交互原型描述产品范围，不表示全部功能已实现。

## 启动桌面客户端

当前验证平台为 Windows x64，使用 Node.js 24（需提供 `node:sqlite`）和 npm。

```powershell
cd desktop
npm ci
npm run dev
```

先在“项目管理”导入 Java 目录，再在“审计分析”生成候选路径。不配置模型也能预处理；模型请求需在配置保存、选择后由用户主动触发。完整命令见 [desktop/README.md](desktop/README.md)。

`desktop/` 是正式桌面应用及 TypeScript 业务服务；`agent/`、`python/`、`contracts/` 和 `fixtures/` 保留早期 Pi / Python 取证练习，Python 工具并非桌面业务后端。
