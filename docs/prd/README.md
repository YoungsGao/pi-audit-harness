# pi-audit-harness 需求看板

当前看板包含 15 个父需求、59 个子需求，详情覆盖职责、依赖与验收要求。产品范围以 index.html 和 requirements.json 为准；需求条目与交互原型不等于实现进度。

当前已实现主流程、验证记录及未完成增强项见 [07 实现进度与验收](../technical/07.实现进度与验收.md)。

| 需求组 | 对应项目技术文档 |
| --- | --- |
| BUILD-01 | [01 项目架构与运行](../technical/01.项目架构与运行.md) |
| SOURCE-01 | [02 源码输入与预处理](../technical/02.源码输入与预处理.md)、[03 数据模型与持久化](../technical/03.数据模型与持久化.md) |
| ANALYZE-01 | [04 Agent 分析与事件协议](../technical/04.Agent分析与事件协议.md) |
| RESULT-01 | [05 审计工作台](../technical/05.审计工作台.md) |
| REPORT-01 | [06 报告生成与管理](../technical/06.报告生成与管理.md) |

关键设计包括调用链状态机、SSE event/id/data、会话与尝试归属。当前已实现 SQLite 事件持久化和传输回放，Agent 检查点续跑仍属于后续恢复需求。
