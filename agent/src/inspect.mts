import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync
} from "node:fs";

import { resolve } from "node:path";

import {
  createAgentSession,
  SessionManager
} from "@earendil-works/pi-coding-agent";

// 1. 确定目标目录
const targetDir = resolve("../fixtures/express");
const targetFile = resolve(targetDir, "app.js");

if (!existsSync(targetFile)) {
  throw new Error(
  "找不到 fixtures/express/app.js，请在 agent 目录运行。"
);
}

// 2. 为本次运行创建输出目录
const outputDir = resolve("../runs", String(Date.now()));
mkdirSync(outputDir, { recursive: true });

const logFile = resolve(outputDir, "events.jsonl");
const reportFile = resolve(outputDir, "report.md");

writeFileSync(logFile, "", "utf8");

console.log("目标目录：", targetDir);
console.log("输出目录：", outputDir);

// 3. 创建能够读取代码的会话
const { session } = await createAgentSession({
  cwd: targetDir,
  tools: ["read", "grep", "find", "ls"],
  sessionManager: SessionManager.inMemory(targetDir)
});

let lastAssistantFailed = false;

try {
  console.log("当前模型：", session.model?.provider, session.model?.id);
  console.log("可用工具：", session.getActiveToolNames());

  // 4. 记录工具操作和已经完成的消息
  session.subscribe((event) => {
    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_end" ||
      event.type === "message_end"
    ) {
      appendFileSync(
        logFile,
        JSON.stringify({
          recordedAt: new Date().toISOString(),
          event
        }) + "\n",
        "utf8"
      );
    }

    if (event.type === "tool_execution_start") {
      console.log("开始调用：", event.toolName, event.args);
    }

    if (event.type === "tool_execution_end") {
      console.log(
        "调用结束：",
        event.toolName,
        event.isError ? "失败" : "成功"
      );
    }

    if (
      event.type === "message_end" &&
      event.message.role === "assistant"
    ) {
      lastAssistantFailed =
        event.message.stopReason === "error" ||
        event.message.stopReason === "aborted";
    }
  });

  // 5. 发起分析任务
  await session.prompt(`
请实际读取当前目录中的 app.js，分析其中的 HTTP 接口。

请用中文 Markdown 表格列出：
- HTTP 方法
- 完整接口路径
- 接口的实际行为
- 对应文件和行号

请检查 Router 的挂载前缀。
仅根据实际读取的源码回答。
对无法确认的行为明确说明，不要推测不存在的实现。
`);

  // 6. 取得并保存回答
  if (lastAssistantFailed) {
    throw new Error("模型运行失败或被中止，请查看 events.jsonl。");
  }

  const answer = session.getLastAssistantText();

  if (!answer?.trim()) {
    throw new Error("没有得到最终文本，请查看 events.jsonl。");
  }

  writeFileSync(reportFile, answer, "utf8");

  console.log("\n模型分析结果：");
  console.log(answer);
  console.log("\n报告位置：", reportFile);
  console.log("日志位置：", logFile);
} finally {
  session.dispose();
}