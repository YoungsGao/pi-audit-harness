# pi-audit-harness

面向企业蓝队的 Agent 源码审计客户端。以 Pi 扩展实现 Goal / Loop，通过代码查询与污点传播分析，呈现可复核的风险路径和源码证据。

**Windows x64 · Java / Spring · Electron + Pi · CLI + Skill**

## 文档导航

| 入口 | 内容 |
| --- | --- |
| [产品需求](https://youngsgao.github.io/pi-audit-harness/prd/index.html) | 首版范围、需求总览、需求列表、右侧详情与关键设计 |
| [交互原型](https://youngsgao.github.io/pi-audit-harness/prototype/index.html) | 项目导入、模拟审计、调用链、模板、模型配置及报告导出 |
| [技术方案](https://youngsgao.github.io/pi-audit-harness/technical/index.html) | 人工编写的 Markdown 技术文档，自动索引并渲染 |

## 产品需求

查看首版范围与模块划分，从需求列表进入具体说明、验收条件和关联资料。

- [需求总览](https://youngsgao.github.io/pi-audit-harness/prd/index.html)
- [需求列表与右侧详情](https://youngsgao.github.io/pi-audit-harness/prd/index.html#requirements)
- [关键设计](https://youngsgao.github.io/pi-audit-harness/prd/index.html#design)

## 交互原型

体验项目导入、模拟审计、调用链查看、模板管理、模型配置及报告导出。

- [可点击的交互流程](https://youngsgao.github.io/pi-audit-harness/prototype/index.html)
- [Markdown / Skill 模板界面](https://youngsgao.github.io/pi-audit-harness/prototype/index.html#templates)

> 交互原型不接入后端，不上传源码，也不调用模型；审计结果均为示例数据。原型演示与实际开发进度分别记录。

## 技术方案

在 [docs/technical](docs/technical/) 中使用 Markdown 编写技术方案，推送到发布分支后由[技术方案页面](https://youngsgao.github.io/pi-audit-harness/technical/index.html)自动列出并渲染，无需修改 HTML。

- [编写指南](docs/technical/README.md)
- [文档模板](docs/technical/_template.md)
- 推荐命名：01.系统架构.md、02.风险点预处理.md、03.Agent调度.md。

## 当前进度

- 已完成 Pi SDK 的基础调用练习
- 已实现读取目标源码、生成接口说明
- 已实现工具调用日志和分析报告保存
- 已通过小型 Express 示例核对接口识别结果

## 文档站点

- [在线首页](https://youngsgao.github.io/pi-audit-harness/)渲染本文件。
- 产品需求和原型左上角的项目名均返回在线首页。
- GitHub Pages 使用 **Deploy from a branch**，发布目录为 /docs，无需自定义 Actions。
- 首页读取仓库 README，技术方案页通过 GitHub 公共目录接口发现 Markdown，再读取原文。
- 默认读取 main 分支，配置位于 [docs/assets/config.js](docs/assets/config.js)。若发布分支变化，请同步修改 ref。
- 目录读取失败时提供重试并显示附带索引，无需填写 Token。
