---
name: audit-code-query
description: Query the running local audit service using fixed, read-only snapshot operations.
---

# 审计代码查询接口使用说明

这是交付给调用方的接口说明，不会自动载入 Pi，不安装或执行项目提供的 Skill。

## 连接与调用

由可信的本地服务启动方注入 `PI_AUDIT_QUERY_PORT`、`PI_AUDIT_QUERY_TOKEN`。令牌至少 32 字符，属于当前服务实例，不写入模板、聊天、源码或日志。CLI 只连接 `127.0.0.1` 的固定 `/code/query`，不接受任意 URL、命令或 SQL。不会每次启动一个 Java 服务器。

命令行用户可用 Node 24+ 长驻启动 `npm run query:serve`，启动前设置 `PI_AUDIT_DATA_ROOT` 指向已有任务数据库目录，并设置本次随机令牌；服务只输出 ready 和端口，不输出令牌。第二个终端使用相同令牌与返回端口运行 CLI。桌面程序内部也直接使用同一个 HTTP 契约，但不向渲染器公开服务令牌。长驻服务 Ctrl+C 正常退出；测试监督器可向标准输入写入 `shutdown`。

在 desktop 目录把一个 JSON 对象送入 `node scripts/query-cli.mjs` 的标准输入。每次调用只处理一份请求，标准输出是一行 JSON。

```json
{"operation":"definition","language":"java","projectId":"已登记项目ID","runId":"已有快照的任务ID","filePath":"demo/Web.java","line":8,"column":24,"maxResults":20,"fallback":true}
```

`projectId`、`runId` 必填，先由正常预处理创建并保存任务快照。`filePath` 只能是 manifest 中的相对路径。公开行列从 1 开始，列按 UTF-16 计数，范围末尾不包含字符。

| 操作 | 额外输入 | 用途 |
| --- | --- | --- |
| capabilities | 无 | 支持的语言/操作和该运行时实际协商能力 |
| status | 无 | 准备、索引、失败、排队状态，不启动服务器 |
| prepare | 无 | 复用或准备项目/语言/内容指纹对应的 JDT-LS |
| read | filePath, line, endLine | 最多 80 行、12000 字符原文 |
| search | text | 固定文本候选，非语义引用 |
| symbols | filePath | 文件符号、容器限定名、重载签名和位置 |
| definition / references | filePath, line, column | 符号定义/引用 |
| incomingCalls / outgoingCalls | filePath, line, column | 只在服务器声明调用层次能力时使用 |

最大请求 16KiB，最多 100 条结果，标准返回内容有总量限制。`fallback:false` 用来观察原始未就绪/超时/不支持状态；默认允许基础候选降级。

## 解释结果

先看 `status`、`backend`、`gaps`、`truncated`、`resolution` 和 `runtime`，再引用位置。`partial`、`not-ready`、`timeout`、`unsupported`、`cancelled`、`failed` 都不能解释成安全；`no-match` 只表示本次范围没命中。文本/CST 同名候选不能冒充语义确认。

每项包含 `location`、可取得时的完整 `symbol`（name/qualifiedName/signature/kind/location/resolution）；调用关系的 `callSite` 是调用发生位置，symbol.location 是声明位置。返回携带语言、后端、任务、快照与内容指纹；不能混用其他任务的结果。

JDT-LS 只读取受控 Java 快照副本，不导入目标 Maven/Gradle 构建文件，不执行目标脚本、业务或注解处理器。外部库、反射、动态分派和跨语言传播不作完整性承诺。诊断通知与一次成功请求都不证明全工作区索引完成，`wholeWorkspaceIndexed` 始终为 false。

CLI 退出码：ok/no-match 为 0，partial 为 2，unsupported 为 3，not-ready 为 4，timeout 为 5，cancelled 为 130，其他失败为 1。消费 partial 的调用方应同时保存覆盖缺口。

## 本机运行时

服务启动前配置 `PI_AUDIT_JAVA_HOME`（Java 21+，也可用 JAVA_HOME）与 `PI_AUDIT_JDTLS_HOME`（已解压、可信的 JDT-LS）。不自动下载。缓存由服务管理，进程关闭或空闲回收时释放；运行时失败后等待回收或重启服务重试。

具体发行包可能要求更高JDK。本次固定JDT-LS1.64快照实测使用Temurin25，Java21不能装载其Eclipse依赖。版本、摘要与完整说明见 [技术文档10](../../docs/technical/10.统一代码查询与Java语义服务.md)。
