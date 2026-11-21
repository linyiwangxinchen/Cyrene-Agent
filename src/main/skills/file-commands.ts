// 文件定义的斜杠命令 —— `<userData>/commands/*.md` 与工作区 `.cyrene/commands/*.md`。
// 文件名即命令名，可选 frontmatter（description / argument-hint / mode），
// 正文是提示模板，`$ARGUMENTS` 与 `$1..$9` 替换为用户参数。
// 纯 fs 模块：目录由调用方传入，不碰 electron，便于单测。
//
// 优先级（同名时）：工作区命令 > 用户命令 > Skill。
// 渠道控制命令（/stop /status /help /cancel 等）是保留名，命令文件不会生效，
// 渠道调度器在进入 Agent 之前就会截获它们。

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

export type FileCommandSource = "workspace" | "user";
export type FileCommandMode = "chat" | "work" | "code" | "learn";

export interface FileCommand {
  name: string;
  source: FileCommandSource;
  description: string;
  argumentHint?: string;
  /** 未设置 = 全模式可用。 */
  modes?: FileCommandMode[];
  body: string;
  filePath: string;
}

export interface FileCommandDirectories {
  /** `<userData>/commands` */
  userDir?: string;
  /** 会话绑定的可信工作区根目录；命令目录为 `<root>/.cyrene/commands`。 */
  workspaceRoot?: string;
}

/** 命令名规则与 Skill 斜杠解析一致：小写字母/数字开头，只含小写字母/数字/短横线。 */
export const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 与渠道控制命令（channels/control-commands.ts）同名的保留名，命令文件不生效。 */
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set(["stop", "cancel", "status", "help"]);

/** 单个命令文件大小上限，防止误放大文件撑爆上下文。 */
export const MAX_COMMAND_FILE_BYTES = 64 * 1024;

const VALID_MODES = new Set<FileCommandMode>(["chat", "work", "code", "learn"]);

export function isValidCommandName(name: string): boolean {
  return COMMAND_NAME_PATTERN.test(name) && !RESERVED_COMMAND_NAMES.has(name);
}

export function workspaceCommandDirectory(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".cyrene", "commands");
}

function normalizeModes(raw: unknown): FileCommandMode[] | undefined {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s]+/) : [];
  const modes = list
    .map((m) => (typeof m === "string" ? m.trim().toLowerCase() : ""))
    .filter((m): m is FileCommandMode => VALID_MODES.has(m as FileCommandMode));
  return modes.length > 0 ? Array.from(new Set(modes)) : undefined;
}

/** 解析命令文件文本。frontmatter 可选；解析失败时整段按正文处理。 */
export function parseCommandFile(
  content: string,
  name: string,
  source: FileCommandSource,
  filePath: string,
): FileCommand {
  let data: Record<string, unknown> = {};
  let body = content;
  try {
    const parsed = matter(content) as unknown as { data: Record<string, unknown>; content: string };
    data = parsed.data ?? {};
    body = parsed.content;
  } catch {
    data = {};
  }
  const description = typeof data.description === "string" ? data.description.trim() : "";
  const hint = data["argument-hint"] ?? data.argumentHint;
  return {
    name,
    source,
    description,
    ...(typeof hint === "string" && hint.trim() ? { argumentHint: hint.trim() } : {}),
    ...(normalizeModes(data.mode ?? data.modes) ? { modes: normalizeModes(data.mode ?? data.modes) } : {}),
    body: body.trim(),
    filePath,
  };
}

/** 只读普通文件；符号链接、超限、非 .md 一律跳过，避免工作区借链接读出目录外文件。 */
function readCommandFile(dir: string, name: string, source: FileCommandSource): FileCommand | null {
  if (!isValidCommandName(name)) return null;
  const filePath = path.join(dir, `${name}.md`);
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > MAX_COMMAND_FILE_BYTES) return null;
    return parseCommandFile(fs.readFileSync(filePath, "utf8"), name, source, filePath);
  } catch {
    return null;
  }
}

function listDirectory(dir: string, source: FileCommandSource): FileCommand[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir)
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.slice(0, -3));
  } catch {
    return [];
  }
  return names
    .map((name) => readCommandFile(dir, name, source))
    .filter((command): command is FileCommand => command !== null);
}

function orderedDirectories(dirs: FileCommandDirectories): Array<{ dir: string; source: FileCommandSource }> {
  const result: Array<{ dir: string; source: FileCommandSource }> = [];
  if (dirs.workspaceRoot) result.push({ dir: workspaceCommandDirectory(dirs.workspaceRoot), source: "workspace" });
  if (dirs.userDir) result.push({ dir: dirs.userDir, source: "user" });
  return result;
}

export function isCommandAvailableInMode(command: FileCommand, mode?: FileCommandMode): boolean {
  return !mode || !command.modes || command.modes.includes(mode);
}

/**
 * 按优先级查找一个命令：工作区 > 用户。当前模式不可用的命令视为不存在，
 * 让低优先级的同名命令或 Skill 接手。
 */
export function findFileCommand(
  name: string,
  dirs: FileCommandDirectories,
  mode?: FileCommandMode,
): FileCommand | null {
  if (!isValidCommandName(name)) return null;
  for (const { dir, source } of orderedDirectories(dirs)) {
    const command = readCommandFile(dir, name, source);
    if (command && isCommandAvailableInMode(command, mode)) return command;
  }
  return null;
}

/** 列出当前生效的命令（同名只保留最高优先级），按名称排序。供斜杠补全使用。 */
export function listFileCommands(dirs: FileCommandDirectories, mode?: FileCommandMode): FileCommand[] {
  const map = new Map<string, FileCommand>();
  for (const { dir, source } of orderedDirectories(dirs)) {
    for (const command of listDirectory(dir, source)) {
      if (!map.has(command.name) && isCommandAvailableInMode(command, mode)) map.set(command.name, command);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** 参数切分：空白分隔，支持 "双引号" 与 '单引号' 包住含空格的参数。 */
export function splitCommandArguments(args: string): string[] {
  const result: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(args)) !== null) {
    result.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return result;
}

/**
 * 展开命令模板：`$ARGUMENTS` → 完整参数串，`$1..$9` → 对应位置参数（缺失为空）。
 * 模板里没有任何占位符而用户给了参数时，参数追加在正文末尾，避免静默丢弃。
 */
export function expandCommandTemplate(body: string, args: string): string {
  const trimmedArgs = args.trim();
  const positional = splitCommandArguments(trimmedArgs);
  const hasPlaceholder = /\$ARGUMENTS|\$[1-9]/.test(body);
  // 单次扫描替换，参数里出现的 `$1` / `$ARGUMENTS` 不会被二次展开。
  const expanded = body.replace(/\$ARGUMENTS|\$([1-9])/g, (_m, index?: string) =>
    index ? positional[Number(index) - 1] ?? "" : trimmedArgs);
  if (!hasPlaceholder && trimmedArgs) return `${expanded}\n\n参数：${trimmedArgs}`;
  return expanded;
}

export interface ParsedCommandInvocation {
  name: string;
  args: string;
}

/** 解析 `/命令名 参数`。命令名规则与 Skill 斜杠解析一致；`/a/b`、`//x` 不命中。 */
export function parseCommandInvocation(text: string): ParsedCommandInvocation | null {
  const match = text.match(/^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1], args: match[2] ?? "" };
}

/** 附件路径段由 build-options 追加在用户消息末尾，展开时保持在末尾。 */
const ATTACHMENT_SECTION_MARKER = "\n\n【本轮附件路径】";

export interface FileCommandExpansion {
  name: string;
  source: FileCommandSource;
  content: string;
}

/**
 * 把一条用户消息文本展开为命令提示。未命中返回 null（原样放行给 Skill 斜杠激活等后续处理）。
 */
export function expandFileCommandText(
  text: string,
  dirs: FileCommandDirectories,
  mode?: FileCommandMode,
): FileCommandExpansion | null {
  const markerIndex = text.indexOf(ATTACHMENT_SECTION_MARKER);
  const head = markerIndex >= 0 ? text.slice(0, markerIndex) : text;
  const tail = markerIndex >= 0 ? text.slice(markerIndex) : "";
  const invocation = parseCommandInvocation(head);
  if (!invocation) return null;
  const command = findFileCommand(invocation.name, dirs, mode);
  if (!command) return null;
  return {
    name: command.name,
    source: command.source,
    content: expandCommandTemplate(command.body, invocation.args) + tail,
  };
}

/**
 * 就地展开消息列表里最后一条 user 消息（只改本轮发给模型的副本，不改持久化轨迹）。
 * 非字符串内容（多模态）不处理。
 */
export function expandLatestUserCommand<T extends { role: string; content?: unknown }>(
  messages: T[],
  dirs: FileCommandDirectories,
  mode?: FileCommandMode,
): FileCommandExpansion | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user" || (message as { visibility?: unknown }).visibility === "internal") continue;
    if (typeof message.content !== "string") return null;
    const expansion = expandFileCommandText(message.content, dirs, mode);
    if (expansion) messages[i] = { ...message, content: expansion.content };
    return expansion;
  }
  return null;
}
