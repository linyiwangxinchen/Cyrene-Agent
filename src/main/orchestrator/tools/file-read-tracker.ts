// 先读后写记录：记下当前会话里模型已读过（或刚写过）的文件内容指纹。
//
// multi_edit 只修改模型看过当前内容的文件：没读过直接拒绝；读过之后文件又被
// 外部改动（指纹不一致）也拒绝，要求重新读取，避免基于过期内容做替换。
// 作用域优先按会话 conversationId，缺失时按 runId；纯内存，进程重启后需重新读取。

import { createHash } from "node:crypto";
import type { ToolContext } from "./registry/tool-context";

const MAX_SCOPES = 64;
const MAX_FILES_PER_SCOPE = 512;

const scopes = new Map<string, Map<string, string>>();

function scopeKey(ctx?: Pick<ToolContext, "conversationId" | "runId">): string {
  return ctx?.conversationId || ctx?.runId || "__default__";
}

function fileKey(filePath: string): string {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

export function contentFingerprint(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 记录模型已知的文件内容（Read 成功、或本工具链刚写入后）。filePath 应为 realpath。 */
export function recordFileKnownContent(
  ctx: Pick<ToolContext, "conversationId" | "runId"> | undefined,
  filePath: string,
  content: Buffer | string,
): void {
  const key = scopeKey(ctx);
  let files = scopes.get(key);
  if (files) {
    scopes.delete(key);
  } else {
    files = new Map();
  }
  scopes.set(key, files);
  if (scopes.size > MAX_SCOPES) scopes.delete(scopes.keys().next().value!);
  const file = fileKey(filePath);
  files.delete(file);
  files.set(file, contentFingerprint(content));
  if (files.size > MAX_FILES_PER_SCOPE) files.delete(files.keys().next().value!);
}

export type FileReadFreshness = "fresh" | "not_read" | "stale";

/** 判断当前内容是否就是模型上次读到/写入的内容。 */
export function checkFileReadFreshness(
  ctx: Pick<ToolContext, "conversationId" | "runId"> | undefined,
  filePath: string,
  currentContent: Buffer | string,
): FileReadFreshness {
  const recorded = scopes.get(scopeKey(ctx))?.get(fileKey(filePath));
  if (!recorded) return "not_read";
  return recorded === contentFingerprint(currentContent) ? "fresh" : "stale";
}

/** 测试隔离用。 */
export function resetFileReadTrackerForTest(): void {
  scopes.clear();
}
