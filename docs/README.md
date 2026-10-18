# 文档站点维护

站点发布在 GitHub Pages 的 `/docs` 路径下。页面之间用相对路径互相链接，README 用绝对地址（它同时被 GitHub 仓库页、Jekyll 根路径和阅读器渲染）。

- index.html：渲染根目录 README.md。
- prd/index.html：产品需求。
- prototype/index.html：交互原型。
- technical/index.html：Markdown 技术方案索引与阅读器。
- technical/assets/：仅这两个需要渲染 Markdown 的页面使用的样式与脚本（config / fallback / markdown / reader）。

在 technical/ 新建 Markdown，推送到 Pages 发布分支即可。支持子目录；下划线/点开头文件不进入索引。不需要手工修改 HTML 或运行生成脚本。

首页与技术方案读取公开仓库 main 分支。分支变化时修改 technical/assets/config.js 的 ref。原文优先通过 raw.githubusercontent.com 读取，失败切到 jsDelivr；目录优先进 jsDelivr 文件清单接口发现，失败再退到 GitHub 公共树接口。两者都不可用时提示重试并显示附带 README/指南，无需密钥。

直接打开本地 HTML 可阅读附带文档，不会扫描本地新增文件。支持标题、列表、引用、表格、代码块、链接和图片；原始 HTML 按文本显示；Mermaid 暂按代码展示。

## 发布

Pages 使用 Deploy from a branch，发布分支 main 的**根目录**（Jekyll 负责根路径的 README 渲染）。站点静态资源都在 docs/ 下，因此页面地址为 `https://youngsgao.github.io/pi-audit-harness/docs/...`。static.yml 已移除；不依赖自定义 Actions。
