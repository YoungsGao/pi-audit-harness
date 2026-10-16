# pi-audit-harness 文档站点

## 页面入口

- `index.html`：引导页。
- `prd/index.html`：需求总览、需求列表与右侧详情。
- `prototype/index.html`：源码审计客户端交互原型。
- `prd/Agent源码审计客户端-PRD.md`：文本 PRD。

子页面左上角项目名可返回引导页。所有站内链接使用相对路径，可部署到 GitHub Pages 仓库子路径，也可直接打开 HTML。两份应用页面各自内嵌数据，无需接口、构建或依赖安装。

## GitHub Pages 部署

1. 将 `docs/` 内容提交并推送到需要发布的仓库分支。
2. 在仓库 `Settings → Pages → Build and deployment` 中，选择 `Deploy from a branch`。
3. 选择已包含这些文件的分支，目录选择 `/docs`，保存。
4. 部署成功后访问 GitHub 返回的站点地址。

`.nojekyll` 保留在 docs 根目录，按静态文件直接发布。当前文件准备工作不包含 Git 提交、推送、Pages 设置或线上部署。

官方说明：https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site

## 交互说明

原型使用固定示例数据，不执行真实审计、安装工具或调用模型。模型配置为手动填写并提供教程，不自动发现或选择模型。Markdown / Skill 仅在本地读取为模板文档。

需求页面仅用于阅读；源码快照已内嵌，页面不会读取开发机器绝对路径。原型不持久化 API Key；模板和人工复核等模拟状态可保存在当前浏览器。
