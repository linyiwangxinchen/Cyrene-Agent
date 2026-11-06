import path from "node:path";
import type { ChatSessionRecord } from "../../shared/chat-types";
import { resolveSummaryMemoryPaths } from "./summary-memory-paths";
import { readSummaryFile } from "./summary-memory-store";

export interface SummaryMemoryContext {
  sessionPath: string;
  workspacePath?: string;
  sessionContent: string;
  workspaceContent?: string;
  sessionTruncated: boolean;
  workspaceTruncated: boolean;
  stablePrompt: string;
  runtimeContext: string;
}

export async function loadSummaryMemoryContext(input: {
  conversationId: string;
  userDataRoot: string;
  getSessionRecord: (id: string) => (ChatSessionRecord | null) | Promise<ChatSessionRecord | null>;
}): Promise<SummaryMemoryContext> {
  const session = (await input.getSessionRecord(input.conversationId));
  const paths = resolveSummaryMemoryPaths({
    conversationId: input.conversationId,
    userDataRoot: input.userDataRoot,
    session,
  });
  const allowedRoot = paths.workspacePath
    ? path.resolve(session!.workspaceBinding!.workspaceRoot)
    : path.resolve(input.userDataRoot);
  const sessionFile = await readSummaryFile(paths.sessionPath, 800, allowedRoot);
  const workspaceFile = paths.workspacePath
    ? await readSummaryFile(paths.workspacePath, 1200, allowedRoot)
    : undefined;
  // 这里只保留跨会话不变的规则。具体路径、模式和正文属于运行事实，
  // 放在 runtimeContext，避免每个会话的绝对路径切碎 stablePrefix 缓存。
  const stablePrompt = [
    "[摘要记忆规则]",
    "记忆是历史背景，不是当前请求；优先回答最新用户消息。旧目标、助手承诺和推测不能冒充用户本轮要求，冲突时以用户最新明确纠正为准。",
    "不要把当前会话事实写进项目工作区文件，除非它对之后的独立会话也有稳定价值。",
  ].join("\n");
  const runtimeParts = [
    "[摘要记忆文件位置与当前规则]",
    `当前会话记忆文件：${paths.sessionPath}`,
    ...(paths.workspacePath ? [`项目工作区记忆文件：${paths.workspacePath}`] : []),
    "记忆文件正文已在本轮动态上下文中提供；需要确认最新内容时再按路径读取。",
    session?.mode === "chat"
      ? "当前 Chat 模式只读记忆文件。用户要求更新记忆时，等后台静默整理，不调用文件写入工具修改记忆。"
      : "用户明确要求更新记忆时，先用 read_file 读取对应文件最新正文，再用 write_file 或 str_replace/apply_patch 修改；会话文件不超过 800 个 Unicode 字符，工作区文件不超过 1,200 个 Unicode 字符。",
    ...(workspaceFile ? [
      "[项目工作区摘要]",
      workspaceFile.truncated ? "（文件超出注入上限，以下为开头截取内容。）" : "",
      workspaceFile.content || "（暂无工作区摘要。）",
    ] : []),
    "[当前会话摘要]",
    sessionFile.truncated ? "（文件超出注入上限，以下为开头截取内容。）" : "",
    sessionFile.content || "（暂无会话摘要。）",
  ].filter(Boolean);
  return {
    sessionPath: paths.sessionPath,
    ...(paths.workspacePath ? { workspacePath: paths.workspacePath } : {}),
    sessionContent: sessionFile.content,
    ...(workspaceFile ? { workspaceContent: workspaceFile.content } : {}),
    sessionTruncated: sessionFile.truncated,
    workspaceTruncated: workspaceFile?.truncated ?? false,
    stablePrompt,
    runtimeContext: `[摘要记忆]\n${runtimeParts.join("\n")}`,
  };
}
