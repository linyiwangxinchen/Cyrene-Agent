// ── 工具：glob（按文件名模式查找工作区文件）──────────────────
// 只在当前会话绑定的工作区内查找，按修改时间倒序返回绝对路径：
// - path 必须解析（含符号链接 realpath）后仍在工作区内，否则拒绝；
// - 遵守工作区根到搜索目录沿途及遍历中遇到的 .gitignore 与 .git/info/exclude；
// - .git、node_modules 与 git worktree 镜像目录无条件跳过；
// - 符号链接目录不进入，符号链接文件只在目标仍位于工作区内时返回；
// - 先收集全部命中再排序截断，保证返回的是"最新的 N 个"。
// 与 zcode-file-tools 的 Glob 区别：后者跟随权限档位可搜工作区外、不读 .gitignore、
// 先截断后排序。

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "../registry/tool-registry";
import type { ToolContext } from "../registry/tool-context";
import { resolveFileAccessPath } from "../file-access";
import { isIgnoredByRules, parseGitignore, type GitignoreRule } from "./gitignore-rules";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/** 单次最多检查的目录项数，防止超大仓库拖住工具调用。 */
const MAX_SCANNED_ENTRIES = 200_000;
const GLOB_TIMEOUT_MS = 20_000;
const ALWAYS_SKIPPED_DIRS = new Set([".git", "node_modules", ".worktrees", "worktrees"]);

type GlobFailureCode = "INVALID_PATTERN" | "NO_WORKSPACE" | "PATH_OUTSIDE_WORKSPACE" | "PERMISSION_DENIED" | "INVALID_PATH" | "PATH_IGNORED" | "GLOB_FAILED";

function failure(errorCode: GlobFailureCode, error: string): string {
  return JSON.stringify({ success: false, errorCode, ...(errorCode === "PERMISSION_DENIED" || errorCode === "PATH_OUTSIDE_WORKSPACE" ? { category: "permission_denied" } : {}), error, retryable: false });
}

function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

function readRules(dir: string, base: string): GitignoreRule[] {
  try {
    return parseGitignore(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), base);
  } catch {
    return [];
  }
}

/** 模式开头的纯字面目录段：从这里开始遍历，避免 `src/**` 扫全仓库。 */
function literalPrefix(pattern: string): string[] {
  const segments = pattern.split("/");
  const literal: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (/[*?[\]{}()!+@\\]/.test(segment)) break;
    literal.push(segment);
  }
  return literal;
}

interface GlobMatch {
  path: string;
  mtimeMs: number;
}

export async function executeGlob(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const startedAt = Date.now();
  const pattern = typeof args.pattern === "string" ? args.pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "") : "";
  if (!pattern || path.isAbsolute(pattern) || pattern.startsWith("/") || pattern.split("/").includes("..")) {
    return failure("INVALID_PATTERN", "pattern 必须是相对 glob 模式（如 src/**/*.ts），不能是绝对路径，也不能包含 '..'。");
  }
  if (!ctx?.resolvedWorkspaceRoot) {
    return failure("NO_WORKSPACE", "当前会话没有绑定工作区，glob 不可用。请先绑定项目目录。");
  }
  const rawLimit = Math.trunc(Number(args.limit));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(MAX_LIMIT, rawLimit) : DEFAULT_LIMIT;

  const rootAccess = resolveFileAccessPath(ctx.resolvedWorkspaceRoot, "read", ctx);
  if (!rootAccess.ok) return failure("PERMISSION_DENIED", rootAccess.message);
  const workspaceRoot = rootAccess.path;

  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  const requested = rawPath ? path.resolve(workspaceRoot, rawPath) : workspaceRoot;
  const access = resolveFileAccessPath(requested, "read", ctx);
  if (!access.ok) return failure("PERMISSION_DENIED", access.message);
  if (!isWithin(access.path, workspaceRoot)) {
    return failure("PATH_OUTSIDE_WORKSPACE", `path 解析后位于工作区外，glob 只在工作区内查找：${access.path}`);
  }
  const searchRoot = access.path;
  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(searchRoot);
  } catch {
    return failure("INVALID_PATH", `path 不存在：${searchRoot}`);
  }
  if (!rootStat.isDirectory()) return failure("INVALID_PATH", `path 必须是目录：${searchRoot}`);

  // 工作区根 .git/info/exclude 与沿途各级 .gitignore；沿途目录本身被忽略则直接返回
  const rules: GitignoreRule[] = [];
  try {
    rules.push(...parseGitignore(fs.readFileSync(path.join(workspaceRoot, ".git", "info", "exclude"), "utf8"), ""));
  } catch { /* 非 git 仓库或没有 exclude */ }
  rules.push(...readRules(workspaceRoot, ""));
  const searchRel = toPosix(path.relative(workspaceRoot, searchRoot));
  if (searchRel) {
    let current = "";
    for (const segment of searchRel.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      if (ALWAYS_SKIPPED_DIRS.has(segment) || isIgnoredByRules(rules, current, true)) {
        return failure("PATH_IGNORED", `path 位于被忽略的目录（${current}），glob 不查找被 .gitignore 或默认规则排除的内容。`);
      }
      rules.push(...readRules(path.join(workspaceRoot, ...current.split("/")), current));
    }
  }

  // 模式的字面前缀直接下钻；前缀目录不存在或被忽略时结果为空
  const prefix = literalPrefix(pattern);
  let walkStart = searchRoot;
  let walkRel = searchRel;
  for (const segment of prefix) {
    const next = path.join(walkStart, segment);
    const nextRel = walkRel ? `${walkRel}/${segment}` : segment;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(next);
    } catch {
      walkStart = "";
      break;
    }
    if (!stat.isDirectory() || ALWAYS_SKIPPED_DIRS.has(segment) || isIgnoredByRules(rules, nextRel, true)) {
      walkStart = "";
      break;
    }
    rules.push(...readRules(next, nextRel));
    walkStart = next;
    walkRel = nextRel;
  }

  const signal = ctx.signal;
  const deadline = startedAt + GLOB_TIMEOUT_MS;
  const matches: GlobMatch[] = [];
  let scanned = 0;
  let scanLimited = false;

  const walk = (dir: string, dirRel: string, inheritedRules: GitignoreRule[]): void => {
    if (scanLimited) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const localRules = dir === walkStart ? inheritedRules : [...inheritedRules, ...readRules(dir, dirRel)];
    for (const entry of entries) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      scanned += 1;
      if (scanned > MAX_SCANNED_ENTRIES || Date.now() > deadline) {
        scanLimited = true;
        return;
      }
      const full = path.join(dir, entry.name);
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (ALWAYS_SKIPPED_DIRS.has(entry.name) || isIgnoredByRules(localRules, rel, true)) continue;
        walk(full, rel, localRules);
        continue;
      }
      if (entry.isSymbolicLink()) {
        // 符号链接文件：目标必须仍在工作区内且是普通文件；符号链接目录不进入
        const target = resolveFileAccessPath(full, "read", ctx);
        if (!target.ok || !isWithin(target.path, workspaceRoot)) continue;
        try {
          if (!fs.statSync(target.path).isFile()) continue;
        } catch {
          continue;
        }
      } else if (!entry.isFile()) {
        continue;
      }
      if (isIgnoredByRules(localRules, rel, false)) continue;
      const patternRel = searchRel ? rel.slice(searchRel.length + 1) : rel;
      if (!path.posix.matchesGlob(patternRel, pattern)) continue;
      try {
        matches.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs });
      } catch {
        // 遍历期间被删除的文件直接跳过
      }
    }
  };

  try {
    if (walkStart) walk(walkStart, walkRel, rules);
  } catch (error) {
    if (signal?.aborted) throw error;
    return failure("GLOB_FAILED", error instanceof Error ? error.message : String(error));
  }

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  const returned = matches.slice(0, limit);
  const truncated = matches.length > limit;
  const notes: string[] = [];
  if (matches.length === 0) notes.push("没有匹配的文件。注意 *.ts 只匹配搜索目录本层，递归请写 **/*.ts；被 .gitignore 忽略的文件不会出现。");
  if (truncated) notes.push(`共 ${matches.length} 个匹配，只返回最近修改的 ${limit} 个；需要更多请收窄 pattern 或 path。`);
  if (scanLimited) notes.push("目录过大，扫描在上限处停止，结果可能不完整；请用 path 缩小范围。");
  return JSON.stringify({
    success: true,
    pattern,
    searchRoot,
    numFiles: returned.length,
    totalMatches: matches.length,
    filenames: returned.map((item) => item.path),
    truncated,
    ...(scanLimited ? { scanLimited: true } : {}),
    durationMs: Date.now() - startedAt,
    ...(notes.length ? { message: notes.join(" ") } : {}),
  });
}

export const globTool: ToolDefinition = {
  id: "glob",
  name: "按模式查找文件",
  catalogHint: "按 glob 模式在当前工作区查找文件名，按修改时间倒序返回，遵守 .gitignore。",
  description:
    "按 glob 模式在当前工作区查找文件，返回绝对路径，最近修改的排在前面。\n\n" +
    "何时用：\n" +
    "- 知道文件名或路径形状，要找出具体文件（如 src/**/*.ts、**/package.json、docs/*.md）\n" +
    "- 想看某个目录下最近改动过哪些文件\n" +
    "- 用 Read / multi_edit 之前先拿到准确的绝对路径\n\n" +
    "不要用于：\n" +
    "- 搜索文件内容里的文字 → Grep / search_text\n" +
    "- 查看单层目录结构 → list_dir\n" +
    "- 查找工作区以外的文件（会被拒绝）\n\n" +
    "规则：* 只匹配一层，** 跨目录，支持 ? [abc] {ts,tsx}；以点开头的文件和目录需要在模式里写出点（如 .github/**）。" +
    "被 .gitignore 忽略的文件、.git 与 node_modules 不会返回。\n" +
    "参数：pattern（必填，相对 glob 模式），path（可选，搜索目录，相对工作区根或工作区内的绝对路径，默认工作区根），" +
    "limit（可选，最多返回条数，默认 100，上限 500）。",
  enabled: true,
  risk: "fs-read",
  modes: ["learn", "code", "work"],
  effectKind: "read",
  verificationPolicy: "none",
  isConcurrencySafe: () => true,
  needsContext: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "相对 glob 模式，如 src/**/*.ts；pattern 相对 path 匹配" },
      path: { type: "string", description: "搜索目录（相对工作区根，或工作区内的绝对路径），默认工作区根" },
      limit: { type: "number", description: "最多返回条数，默认 100，上限 500" },
    },
    required: ["pattern"],
  },
  execute: executeGlob,
};
