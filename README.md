# pi-audit-harness

面向企业蓝队的 Agent 源码审计客户端。以 Pi 扩展实现 Goal / Loop，通过代码查询与污点传播分析，呈现可复核的风险路径和源码证据。

**Windows x64 · Java / Spring · Electron + Pi · CLI + Skill**

## 文档导航

| 入口 | 内容 |
| --- | --- |
| [产品需求](https://youngsgao.github.io/pi-audit-harness/docs/prd/index.html) | 首版范围、需求总览、需求列表、右侧详情与关键设计 |
| [交互原型](https://youngsgao.github.io/pi-audit-harness/docs/prototype/index.html) | 项目导入、模拟审计、调用链、模板、模型配置及报告导出 |
| [技术方案](https://youngsgao.github.io/pi-audit-harness/docs/technical/index.html) | 人工编写的 Markdown 技术文档，自动索引并渲染 |

## 产品需求

查看首版范围与模块划分，从需求列表进入具体说明、验收条件和关联资料。

- [需求总览](https://youngsgao.github.io/pi-audit-harness/docs/prd/index.html)
- [需求列表与右侧详情](https://youngsgao.github.io/pi-audit-harness/docs/prd/index.html#requirements)
- [关键设计](https://youngsgao.github.io/pi-audit-harness/docs/prd/index.html#design)

## 交互原型

体验项目导入、模拟审计、调用链查看、模板管理、模型配置及报告导出。

- [可点击的交互流程](https://youngsgao.github.io/pi-audit-harness/docs/prototype/index.html)
- [Markdown / Skill 模板界面](https://youngsgao.github.io/pi-audit-harness/docs/prototype/index.html#templates)

> 交互原型不接入后端，不上传源码，也不调用模型；审计结果均为示例数据。原型演示与实际开发进度分别记录。

## 技术方案

在 [docs/technical](https://github.com/YoungsGao/pi-audit-harness/tree/main/docs/technical) 中使用 Markdown 编写技术方案，推送到发布分支后由[技术方案页面](https://youngsgao.github.io/pi-audit-harness/docs/technical/index.html)自动列出并渲染，无需修改 HTML。

- [编写指南](https://github.com/YoungsGao/pi-audit-harness/blob/main/docs/technical/README.md)
- [文档模板](https://github.com/YoungsGao/pi-audit-harness/blob/main/docs/technical/_template.md)
- 推荐命名：01.系统架构.md、02.风险点预处理.md、03.Agent调度.md。

## 当前进度

- 已完成 Pi SDK 的基础调用练习
- 已实现读取目标源码、生成接口说明
- 已实现工具调用日志和分析报告保存
- 已通过小型 Express 示例核对接口识别结果

## 文档站点

- [文档站入口](https://youngsgao.github.io/pi-audit-harness/docs/)，由 [docs/index.html](https://github.com/YoungsGao/pi-audit-harness/blob/main/docs/index.html) 渲染本文件。
- 产品需求和原型左上角的项目名均返回文档站入口。
- GitHub Pages 使用 **Deploy from a branch**，发布分支 `main` 的**根目录**；站点资源都在 `docs/` 下，因此指向站点的地址要带 `/docs`。
- 页面之间的导航（首页 / 产品需求 / 交互原型 / 技术方案）全部使用**相对路径**，换域名或本地预览都不会失效。
- 本文件的链接用绝对地址，因为同一份 README 会在三处渲染：GitHub 仓库页、Jekyll 根路径、以及 docs/ 下的阅读器；只有绝对地址在三处都跳到站点页面。
- 仓库根路径 <https://youngsgao.github.io/pi-audit-harness/> 是 Jekyll 渲染的本文件，`/docs` 下才是静态站点。
- 首页与技术方案页读取仓库 `main` 分支的 Markdown：原文优先走 raw.githubusercontent.com，失败时切到 jsDelivr；目录通过 jsDelivr 文件清单接口发现，再退回 GitHub 公共树接口。
- 默认读取 main 分支，配置位于 [docs/technical/assets/config.js](docs/technical/assets/config.js)。若发布分支变化，请同步修改 ref。
- 目录读取失败时会提示并允许重试，同时显示随页面附带的索引，无需配置密钥。
