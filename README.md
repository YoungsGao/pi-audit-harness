# pi-audit-harness

面向企业蓝队的 Agent 源码审计客户端。以 Pi 扩展实现 Goal / Loop，通过代码查询与污点传播分析，呈现可复核的风险路径和源码证据。

**Windows x64 · Electron + Pi SDK + Skill + Cli**

## 文档导航

[文档站](https://youngsgao.github.io/pi-audit-harness/)

| 入口 | 内容 |
| --- | --- |
| [产品需求](https://youngsgao.github.io/pi-audit-harness/docs/prd/index.html) | 首版范围、需求总览、需求列表、右侧详情与关键设计 |
| [交互原型](https://youngsgao.github.io/pi-audit-harness/docs/prototype/index.html) | 体验项目导入、模拟审计、调用链查看、模板管理、模型配置及报告导出 |
| [技术方案](https://youngsgao.github.io/pi-audit-harness/docs/technical/index.html) | 在 [docs/technical](https://github.com/YoungsGao/pi-audit-harness/tree/main/docs/technical) 中使用 Markdown 编写技术方案，新增文件后运行 `node scripts/gen-index.mjs` 再推送，由[技术方案页面](https://youngsgao.github.io/pi-audit-harness/docs/technical/index.html)列出并渲染，[文档模板](https://github.com/YoungsGao/pi-audit-harness/blob/main/docs/technical/_template.md) |

## 当前进度

- 已完成 Pi SDK 的基础调用练习
- 已实现读取目标源码、生成接口说明
- 已实现工具调用日志和分析报告保存
- 已通过小型 Express 示例核对接口识别结果
