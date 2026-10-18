# 文档站点维护

- index.html：渲染根目录 README.md。
- prd/index.html：产品需求。
- prototype/index.html：交互原型。
- technical/index.html：Markdown 技术方案索引与阅读器。

在 technical/ 新建 Markdown，推送到 Pages 发布分支即可。支持子目录；下划线/点开头文件不进入索引。不需要手工修改 HTML 或运行生成脚本。

首页与技术方案读取公开仓库 main 分支。分支变化时修改 assets/config.js 的 ref。原文通过 raw.githubusercontent.com 读取，目录通过 GitHub 公共树接口发现。接口暂不可用时提示重试并显示附带 README/指南，无需密钥。

直接打开本地 HTML 可阅读附带文档，不会扫描本地新增文件。支持标题、列表、引用、表格、代码块、链接和图片；原始 HTML 按文本显示；Mermaid 暂按代码展示。

## 发布

Pages 使用 Deploy from a branch，选择发布分支的 /docs。static.yml 已移除；不依赖自定义 Actions。保留 .nojekyll，静态发布。
