// ── 工具：multi_edit（同一文件多处精确替换，全部成功才写入）──────
// 规则沿用 str_replace（str-replace-core.ts）：
// - 每处替换在上一处的结果上匹配（顺序应用）；
// - replace_all=false 时 old_string 必须唯一，走精确 → CRLF/LF → 空白归一化三层匹配；
// - replace_all=true 时替换所有精确匹配（按文件换行风格对齐 CRLF/LF），不做空白归一化；
// - 任一处失败整体不写盘，返回失败序号与诊断。
// 额外约束：文件必须已在本会话中被 Read 读取，且读取后未被外部改动（file-read-tracker）。
// overwrite-guard 的骤降检查针对整文件覆盖写的截断，锚点替换不会产生截断，这里不套用。

import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import type { ToolDefinition } from "../registry/tool-registry";
import type { ToolContext } from "../registry/tool-context";
import { buildReplacedDiff, countLines, finalizeFileChanges } from "../registry/tool-evidence";
import { resolveFileAccessPath } from "../file-access";
import { applyStrReplaceEdits, type StrReplaceFailureDiagnostic } from "../str-replace-core";
import { checkFileReadFreshness, recordFileKnownContent } from "../file-read-tracker";
import { getRunReviewTracker } from "../../review/run-review-tracker";

const MAX_EDITS = 50;

interface MultiEditItem {
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

type ParsedEdits = { ok: true; edits: MultiEditItem[] } | { ok: false; error: string };

function failure(errorCode: string, error: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ success: false, tool: "multi_edit", errorCode, error, retryable: false, ...extra });
}

function parseEdits(raw: unknown): ParsedEdits {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "edits 必须是非空数组。" };
  if (raw.length > MAX_EDITS) return { ok: false, error: `edits 最多 ${MAX_EDITS} 项，请拆成多次调用。` };
  const edits: MultiEditItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown> | null;
    const label = `第 ${i + 1} 处`;
    if (!item || typeof item !== "object" || typeof item.old_string !== "string" || typeof item.new_string !== "string") {
      return { ok: false, error: `${label}缺少字符串类型的 old_string / new_string。` };
    }
    if (item.old_string === item.new_string) {
      return { ok: false, error: `${label}的 old_string 与 new_string 相同，没有需要修改的内容。` };
    }
    const replaceAll = item.replace_all === true;
    if (replaceAll && !item.old_string) {
      return { ok: false, error: `${label}设置了 replace_all，old_string 不能为空。` };
    }
    edits.push({ old_string: item.old_string, new_string: item.new_string, replace_all: replaceAll });
  }
  return { ok: true, edits };
}

type EditStep =
  | { ok: true; content: string; segments: Array<{ beforeLines: string[]; afterLines: string[] }>; replacements: number }
  | { ok: false; errorCode: string; error: string; diagnostic?: StrReplaceFailureDiagnostic };

function applyReplaceAll(content: string, edit: MultiEditItem): EditStep {
  let oldText = edit.old_string;
  let newText = edit.new_string;
  const crlfFile = content.includes("\r\n");
  if (crlfFile && !oldText.includes("\r")) {
    oldText = oldText.replaceAll("\n", "\r\n");
    newText = newText.replaceAll("\n", "\r\n");
  } else if (!crlfFile && oldText.includes("\r\n")) {
    oldText = oldText.replaceAll("\r\n", "\n");
    newText = newText.replaceAll("\r\n", "\n");
  }
  const parts = content.split(oldText);
  const replacements = parts.length - 1;
  if (replacements === 0) {
    return {
      ok: false,
      errorCode: "OLD_STRING_NOT_FOUND",
      error: "old_string 在文件中未找到（replace_all 只做精确匹配，不做空白归一化）。请用 Read 核对实际内容后重试。",
    };
  }
  const beforeLines = oldText.replaceAll("\r\n", "\n").split("\n");
  const afterLines = newText.replaceAll("\r\n", "\n").split("\n");
  return {
    ok: true,
    content: parts.join(newText),
    segments: Array.from({ length: replacements }, () => ({ beforeLines, afterLines })),
    replacements,
  };
}

function applyOne(content: string, edit: MultiEditItem): EditStep {
  if (edit.replace_all) return applyReplaceAll(content, edit);
  const result = applyStrReplaceEdits(content, [{ old_string: edit.old_string, new_string: edit.new_string }]);
  if (!result.ok) return { ok: false, errorCode: result.errorCode, error: result.error, diagnostic: result.diagnostic };
  return { ok: true, content: result.newContent, segments: result.segments, replacements: 1 };
}

export async function executeMultiEdit(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const rawPath = typeof args.file_path === "string" ? args.file_path.trim() : "";
  if (!rawPath) return failure("INVALID_PATH", "file_path 不能为空。");
  const access = resolveFileAccessPath(path.resolve(ctx?.resolvedWorkspaceRoot ?? process.cwd(), rawPath), "write", ctx);
  if (!access.ok) return failure("PERMISSION_DENIED", access.message, { category: "permission_denied" });
  const filePath = access.path;

  const parsed = parseEdits(args.edits);
  if (!parsed.ok) return failure("INVALID_INPUT", parsed.error);

  let originalBuffer: Buffer;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return failure("NOT_A_FILE", `不是文件：${filePath}`);
    originalBuffer = fs.readFileSync(filePath);
  } catch {
    return failure("FILE_NOT_FOUND", `文件不存在：${filePath}。multi_edit 只修改已有文件，新建文件请用 Write。`);
  }

  const freshness = checkFileReadFreshness(ctx, filePath, originalBuffer);
  if (freshness === "not_read") {
    return failure("FILE_NOT_READ", `修改前必须先用 Read 读取该文件：${filePath}。本次未写入。`);
  }
  if (freshness === "stale") {
    return failure("FILE_CHANGED_SINCE_READ", `文件在上次读取后已被修改，请重新 Read 后再编辑：${filePath}。本次未写入。`);
  }

  const original = originalBuffer.toString("utf8");
  let current = original;
  const segments: Array<{ beforeLines: string[]; afterLines: string[] }> = [];
  const replacementCounts: number[] = [];
  for (let i = 0; i < parsed.edits.length; i++) {
    const step = applyOne(current, parsed.edits[i]);
    if (!step.ok) {
      // 任一处失败：整体不写盘，报告失败序号（1-based 给模型看，editIndex 0-based 给程序用）
      return failure(step.errorCode, `第 ${i + 1} 处替换失败，全部 ${parsed.edits.length} 处均未写入：${step.error}`, {
        failedEdit: i + 1,
        editIndex: i,
        ...(step.diagnostic ? { diagnostic: { ...step.diagnostic, editIndex: i } } : {}),
      });
    }
    current = step.content;
    segments.push(...step.segments);
    replacementCounts.push(step.replacements);
  }

  if (ctx?.runId) {
    getRunReviewTracker(app.getPath("userData")).captureBefore(ctx.runId, filePath);
  }
  try {
    fs.writeFileSync(filePath, current, "utf8");
  } catch (error) {
    return failure("WRITE_FAILED", `写入失败：${error instanceof Error ? error.message : String(error)}`);
  }
  recordFileKnownContent(ctx, filePath, current);

  const changes = segments.map((segment) => ({
    file: filePath,
    kind: "modified" as const,
    insertions: countLines(segment.afterLines.join("\n")),
    deletions: countLines(segment.beforeLines.join("\n")),
    diff: buildReplacedDiff(segment.beforeLines, segment.afterLines),
  }));
  return JSON.stringify({
    success: true,
    tool: "multi_edit",
    filePath,
    action: "modified",
    appliedEdits: parsed.edits.length,
    replacements: replacementCounts,
    sizeBytes: Buffer.byteLength(current, "utf8"),
    changes: finalizeFileChanges(changes),
  });
}

export const multiEditTool: ToolDefinition = {
  id: "multi_edit",
  name: "多处精确替换",
  catalogHint: "对同一文件按顺序做多处精确替换，全部成功才写入；需先 Read。",
  description:
    "对同一个文件按顺序应用多处精确替换，全部成功才写入；任何一处失败，文件保持原样并说明是第几处失败。\n\n" +
    "何时用：\n" +
    "- 同一文件要改好几处（改函数签名并同步调用点、批量改名、改多段配置）\n" +
    "- 某个字符串要在文件里全部替换（该处设 replace_all=true）\n\n" +
    "不要用于：\n" +
    "- 只改一处 → Edit\n" +
    "- 跨多个文件修改 → apply_patch，或对每个文件分别调用\n" +
    "- 新建文件或整文件重写 → Write\n\n" +
    "规则：修改前必须先用 Read 读过该文件，读后文件被改动需要重新读取；" +
    "edits 按数组顺序依次应用，后一处在前一处的结果上匹配；" +
    "replace_all=false（默认）时 old_string 必须在当时内容中唯一，缩进/空白略有出入会自动归一化匹配；" +
    "replace_all=true 时替换全部精确匹配。\n" +
    "参数：file_path（必填，绝对路径），edits（必填，数组，每项含 old_string、new_string，可选 replace_all）。",
  enabled: true,
  risk: "fs-write",
  modes: ["learn", "code", "work"],
  effectKind: "mutation",
  verificationPolicy: "code",
  needsContext: true,
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "目标文件的绝对路径" },
      edits: {
        type: "array",
        description: "按顺序应用的替换列表；任一处失败则全部不写入",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "要替换的原文本（含缩进）" },
            new_string: { type: "string", description: "替换后的文本，必须与 old_string 不同" },
            replace_all: { type: "boolean", description: "是否替换全部匹配，默认 false" },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["file_path", "edits"],
  },
  execute: executeMultiEdit,
};
