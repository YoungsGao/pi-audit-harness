# pi-audit-harness 需求看板

15 个父需求，59 个子需求；P0 5 项、P1 7 项、P2 3 项。
导航：需求总览、需求列表、关键设计。详情侧栏覆盖 60%，不重排列表。职责按前端、后端、前后端协作区分。

关键设计顺序：
1. 调用链状态机。
2. SSE 三段帧：event 驱动状态，id 为事件游标，data 是 JSON。
3. 会话管理（待确认）：优先验证 Pi SessionManager；LevelDB / ZSet 仅为备选。SSE id 与会话检查点不强绑定。

会话恢复仍为 P1。当前范围以 index.html / requirements.json 为准，旧 Markdown 为背景资料；文档不代表功能已实现。
