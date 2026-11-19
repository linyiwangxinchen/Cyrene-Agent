import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { CompanionTaskKind, CompanionTaskLesson, CompanionTaskMethod } from "../../shared/companion";
import type { ToolCallResult } from "./types";

const READ_TOOLS = ["Read", "read_file"] as const;
const SEARCH_TOOLS = ["Grep", "search_text"] as const;
const LIST_TOOLS = ["list_dir", "Glob"] as const;
const DOCUMENT_NAME = /[\p{L}\p{N}_.-]+\.(?:md|txt|csv|tsv|rst|log)\b/iu;

export function classifyTaskMethodRequest(text: string): CompanionTaskKind | undefined {
  const request = text.trim();
  if (!request || request.length > 500 || /[\r\n]/.test(request)) return;
  if (/(?:删掉|删除|改写|修改|替换|写入|生成文件|下载|上传|运行|执行|部署|漏洞|利用链|渗透|攻击|口令|密钥|密码)/.test(request)) return;
  if (/(?:查找|搜索|检索|找一下|找出|找找|定位|哪份文档|哪个文件|哪些文件)/.test(request)
    && /(?:写了|写着|提到|包含|出现|关键字|关键词|哪一行|哪一段|在哪一页)/.test(request)) return "find-content";
  if (/(?:列出|列一下|看看|查看|盘点|梳理|有哪些|有什么)/.test(request)
    && /(?:目录|工作区|文件夹)/.test(request)) return "survey-directory";
  if (DOCUMENT_NAME.test(request) && /(?:读|打开|看看|看一下|查看|概括|总结|写了什么)/.test(request)) return "read-document";
}

function canonicalPath(value: string): string | undefined {
  try {
    const resolved = realpathSync.native(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  } catch {
    return undefined;
  }
}

export function workspaceTaskKey(workspaceRoot: string): string | undefined {
  const root = canonicalPath(workspaceRoot);
  return root && hashWorkspaceRoot(root);
}

function hashWorkspaceRoot(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

function workspacePath(root: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return;
  const resolved = canonicalPath(path.resolve(root, value));
  if (!resolved) return;
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return;
  return resolved;
}

function jsonResult(output: string): Record<string, unknown> {
  if (!output.startsWith("{")) return {};
  try {
    return JSON.parse(output) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function completeSearch(root: string, result: ToolCallResult, data: Record<string, unknown>): boolean {
  if (data.rejectedPaths || data.truncated) return false;
  const grep = result.toolId === "Grep";
  const { args } = result;
  const sources = grep ? [args.path || "."] : Array.isArray(args.paths) ? args.paths : ["."];
  if (sources.length === 0 || sources.some(source => !workspacePath(root, source))) return false;
  const query = grep ? args.pattern : args.query;
  if (typeof query !== "string" || !query.trim()) return false;
  try {
    if (grep || args.mode === "regex") new RegExp(query);
    return true;
  } catch {
    return false;
  }
}

function taskPrompt(lessons: readonly CompanionTaskLesson[], tools: ReadonlySet<string>): string {
  const read = READ_TOOLS.find(id => tools.has(id));
  const search = SEARCH_TOOLS.find(id => tools.has(id));
  const list = LIST_TOOLS.find(id => tools.has(id));
  const hints: Record<CompanionTaskMethod, string | undefined> = {
    "search-then-read": read && search ? "先用 " + search + " 找到内容命中，再用 " + read + " 核对命中文件的上下文。" : undefined,
    "list-then-read": read && list ? "先用 " + list + " 缩小文件范围，再用 " + read + " 阅读相关文本。" : undefined,
    "read-direct": read ? "用户给出明确文件名和位置时，直接用 " + read + " 阅读。" : undefined,
    "list-directory": list ? "盘点工作区文件时，先用 " + list + " 取得实际清单。" : undefined,
  };
  const hint = lessons.map(item => hints[item.method]).find(Boolean);
  return hint ? "[当前工作区做事经验]\n同类任务可优先尝试：" + hint
    + "\n以本轮请求、工具权限和实际返回为准。命中不足时换一种方式核对。" : "";
}

type Observation = { method: CompanionTaskMethod; outcome: "worked" | "missed" };
type LocatedFiles = { round: number; files: Set<string>; directory?: string };

function documentName(filename: string): string {
  const name = path.basename(filename);
  return process.platform === "win32" ? name.toLowerCase() : name;
}

export interface TaskMethodRun {
  workspaceKey: string;
  task: CompanionTaskKind;
  prompt: string;
  observe: (result: ToolCallResult, round: number) => void;
  discard: () => void;
  observations: () => Observation[];
}

/** 一轮只产出枚举证据。临时路径只用于核实后续读取是否来自同一结果。 */
export function createTaskMethodRun(
  task: CompanionTaskKind,
  userText: string,
  workspaceRoot: string,
  toolIds: ReadonlySet<string>,
  getLessons: (workspaceKey: string, task: CompanionTaskKind) => readonly CompanionTaskLesson[],
): TaskMethodRun | undefined {
  const root = canonicalPath(workspaceRoot);
  if (!root) return;
  const workspaceKey = hashWorkspaceRoot(root);
  const available = task === "find-content"
    ? SEARCH_TOOLS.some(id => toolIds.has(id)) && READ_TOOLS.some(id => toolIds.has(id))
    : task === "survey-directory" ? LIST_TOOLS.some(id => toolIds.has(id)) : READ_TOOLS.some(id => toolIds.has(id));
  if (!available) return;
  const requestedName = userText.match(DOCUMENT_NAME)?.[0];
  const expectedName = requestedName && documentName(requestedName);
  let search: LocatedFiles | undefined;
  let listing: LocatedFiles | undefined;
  let usedLocator = false;
  let worked: CompanionTaskMethod | undefined;
  let missed: CompanionTaskMethod | undefined;
  let discarded = false;

  return {
    workspaceKey,
    task,
    prompt: taskPrompt(getLessons(workspaceKey, task), toolIds),
    discard: () => { discarded = true; },
    observations: () => discarded ? [] : [
      ...(worked ? [{ method: worked, outcome: "worked" } as const] : []),
      ...(missed && missed !== worked ? [{ method: missed, outcome: "missed" } as const] : []),
    ],
    observe: (result, round) => {
      if (discarded || result.deduplicated || result.toolExecuted === false) return;
      const { toolId: id, args, output, status } = result;
      if ((SEARCH_TOOLS as readonly string[]).includes(id)) {
        usedLocator = true;
        if (task !== "find-content" || status !== "succeeded") return;
        const data = jsonResult(output);
        const reported = Array.isArray(data.matches)
          ? data.matches.map(item => item?.path)
          : Array.isArray(data.matchedPaths) ? data.matchedPaths
          : Array.isArray(data.filenames) ? data.filenames : [];
        const files = new Set(reported.flatMap(item => workspacePath(root, item) ?? []));
        search = { round, files };
        if ((data.totalMatches === 0 || data.numMatches === 0) && completeSearch(root, result, data)) {
          missed = "search-then-read";
        }
        return;
      }
      if ((LIST_TOOLS as readonly string[]).includes(id)) {
        usedLocator = true;
        if (task === "find-content" || status !== "succeeded") return;
        const directory = workspacePath(root, args.path ?? ".");
        if (!directory) return;
        const data = id === "Glob" ? jsonResult(output) : undefined;
        const count = data ? data.numFiles : /^dir: [^\r\n]+\r?\ncount: (\d+)/.exec(output)?.[1];
        if (count === undefined) return;
        const files = new Set((Array.isArray(data?.filenames) ? data.filenames : [])
          .flatMap(item => workspacePath(root, item) ?? []));
        listing = { round, files, ...(id === "list_dir" ? { directory } : {}) };
        if (task === "survey-directory" && Number(count) > 0
          && (id === "list_dir" || args.pattern === "*" || args.pattern === "**/*")) {
          worked = "list-directory";
        }
        return;
      }
      if (!(READ_TOOLS as readonly string[]).includes(id)) {
        // 其它执行步骤使这一轮无法归因到只读方法。
        discarded = true;
        return;
      }
      const requested = id === "Read" ? args.file_path : args.path;
      const correctName = typeof requested === "string" && documentName(requested) === expectedName;
      if (status !== "succeeded") {
        if (task === "read-document" && correctName && !usedLocator && result.errorCode === "FILE_NOT_FOUND") {
          missed = "read-direct";
        }
        return;
      }
      const data = id === "read_file" ? jsonResult(output) : undefined;
      const readableText = data ? data.content : output;
      if (typeof readableText !== "string" || !/^[^\S\r\n]*\d+ \|[^\S\r\n]+\S/m.test(readableText)) return;
      const filename = workspacePath(root, data?.path ?? requested);
      if (!filename) return;
      if (task === "find-content" && search && round > search.round && search.files.has(filename)) worked = "search-then-read";
      if ((task === "survey-directory" || correctName) && listing && round > listing.round
        && (listing.files.has(filename) || listing.directory === path.dirname(filename))) worked = "list-then-read";
      if (task === "read-document" && correctName && !usedLocator) worked = "read-direct";
    },
  };
}
