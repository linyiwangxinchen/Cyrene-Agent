// 从 GitHub 安装 Skill —— 下载提交快照 tarball → 内存解析 tar → 校验 → 暂存 → 放入用户 Skill 目录。
// 纯逻辑模块：fetch 与目录由调用方注入（测试用本地夹具，不访问真实网络），不碰 electron。
//
// 安全边界（任何一条不满足就整体拒绝，不落半个 Skill）：
//   - 只接受普通文件与目录；符号链接、硬链接、设备文件等一律拒绝。
//   - 路径必须是相对路径，不含 `..`、`.`、空段、反斜杠、盘符/冒号、NUL。
//   - 压缩包大小、解压后大小、Skill 内文件数、Skill 总字节数都有上限。
//   - Skill 根目录必须有能通过解析的 SKILL.md。
//   - 目标 id 受 checkSkillTarget 的所有权规则约束（不能覆盖内置/未托管 Skill）。

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { randomUUID } from "crypto";
import { parseSkillFrontmatter } from "./skill-scanner";
import {
  SKILL_SOURCE_MARKER,
  SkillAuthoringError,
  checkSkillTarget,
  isValidSkillId,
  replaceSkillDirectory,
  type SkillDirectories,
  type SkillOrigin,
} from "./skill-authoring";

export interface GitHubSkillSource {
  owner: string;
  repo: string;
  /** 仓库内 Skill 目录（posix，无首尾斜杠）；空串 = 仓库根目录就是 Skill。 */
  path: string;
  ref?: string;
}

export interface SkillInstallLimits {
  maxDownloadBytes: number;
  maxUnpackedBytes: number;
  maxFiles: number;
  maxSkillBytes: number;
}

export const DEFAULT_SKILL_INSTALL_LIMITS: SkillInstallLimits = {
  maxDownloadBytes: 25 * 1024 * 1024,
  maxUnpackedBytes: 200 * 1024 * 1024,
  maxFiles: 200,
  maxSkillBytes: 5 * 1024 * 1024,
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const NAME_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const REF_PATTERN = /^[A-Za-z0-9._/-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const FETCH_TIMEOUT_MS = 60_000;

function installError(code: string, message: string): SkillAuthoringError {
  return new SkillAuthoringError(code, message);
}

function validRepoSegment(value: string): boolean {
  return NAME_SEGMENT.test(value) && value !== "." && value !== "..";
}

function validPathSegments(segments: string[]): boolean {
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".."
    && !/[\\:\0]/.test(segment));
}

/**
 * 解析安装来源：`owner/repo`、`owner/repo/path/to/skill`、
 * `https://github.com/owner/repo(.git)`、`https://github.com/owner/repo/tree/<ref>/<path>`、
 * `.../blob/<ref>/<path>/SKILL.md`。tree/blob 链接里的 ref 只取一个路径段。
 */
export function parseGitHubSkillSource(input: string, ref?: string): GitHubSkillSource {
  const raw = String(input ?? "").trim();
  if (!raw) throw installError("E_SKILL_SOURCE_INVALID", "缺少安装来源。");
  let segments: string[];
  let urlRef: string | undefined;
  const urlMatch = raw.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i);
  if (urlMatch) {
    const pathname = urlMatch[1].split(/[?#]/)[0].replace(/\/+$/, "");
    segments = pathname.split("/");
    if (segments.length >= 2) segments[1] = segments[1].replace(/\.git$/i, "");
    if (segments.length >= 4 && (segments[2] === "tree" || segments[2] === "blob")) {
      urlRef = segments[3];
      segments = [segments[0], segments[1], ...segments.slice(4)];
    } else if (segments.length > 2) {
      throw installError("E_SKILL_SOURCE_INVALID", "仓库链接只支持仓库首页或 /tree/<分支>/<目录> 形式。");
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    throw installError("E_SKILL_SOURCE_INVALID", "只支持 GitHub 仓库（owner/repo 或 https://github.com/...）。");
  } else {
    segments = raw.replace(/\/+$/, "").split("/");
  }
  if (segments.at(-1) === "SKILL.md") segments = segments.slice(0, -1);
  const [owner, repo, ...rest] = segments;
  if (!owner || !repo || !validRepoSegment(owner) || !validRepoSegment(repo)) {
    throw installError("E_SKILL_SOURCE_INVALID", `无法识别的 GitHub 来源: ${raw}`);
  }
  if (!validPathSegments(rest)) {
    throw installError("E_SKILL_SOURCE_INVALID", `仓库内路径不合法: ${rest.join("/")}`);
  }
  const effectiveRef = (ref ?? "").trim() || urlRef;
  if (effectiveRef !== undefined && (!REF_PATTERN.test(effectiveRef) || effectiveRef.split("/").some((s) => s === ".." || s === ""))) {
    throw installError("E_SKILL_SOURCE_INVALID", `分支/标签/提交不合法: ${effectiveRef}`);
  }
  return { owner, repo, path: rest.join("/"), ...(effectiveRef ? { ref: effectiveRef } : {}) };
}

// ── tar 解析（GitHub tarball 为 gzip 压缩的 ustar + pax 头） ──────────────

export interface TarEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "hardlink" | "other";
  data: Buffer;
}

function readString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readSize(buf: Buffer, start: number): number {
  const field = buf.subarray(start, start + 12);
  if (field[0] & 0x80) {
    // base-256 编码：只支持安全整数范围
    let value = 0;
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i];
    return value;
  }
  const text = readString(buf, start, 12).trim();
  return text ? parseInt(text, 8) : 0;
}

function parsePax(data: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) result[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return result;
}

/** 解析未压缩 tar。结构损坏时抛错。 */
export function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingName: string | undefined;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = readSize(header, 124);
    if (!Number.isSafeInteger(size) || size < 0) throw installError("E_SKILL_ARCHIVE_INVALID", "压缩包结构损坏。");
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw installError("E_SKILL_ARCHIVE_INVALID", "压缩包被截断。");
    const data = buf.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;

    const typeflag = String.fromCharCode(header[156] || 0x30);
    if (typeflag === "g" || typeflag === "K") continue;
    if (typeflag === "x") {
      const pax = parsePax(data);
      if (pax.path) pendingName = pax.path;
      continue;
    }
    if (typeflag === "L") {
      pendingName = readString(data, 0, data.length);
      continue;
    }
    const prefix = readString(header, 345, 155);
    const baseName = readString(header, 0, 100);
    const name = pendingName ?? (prefix ? `${prefix}/${baseName}` : baseName);
    pendingName = undefined;
    const type: TarEntry["type"] = typeflag === "0" || typeflag === "7" ? "file"
      : typeflag === "5" ? "directory"
        : typeflag === "2" ? "symlink"
          : typeflag === "1" ? "hardlink"
            : "other";
    entries.push({ name, type, data });
  }
  return entries;
}

/** 校验并规范化归档内相对路径；不合法返回 null。 */
export function normalizeArchivePath(name: string): string | null {
  if (!name || /[\\\0]/.test(name) || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  const segments = name.replace(/\/+$/, "").split("/");
  if (!validPathSegments(segments)) return null;
  return segments.join("/");
}

export interface ExtractedSkillFile {
  relativePath: string;
  data: Buffer;
}

/**
 * 从 GitHub tarball 中挑出 Skill 目录的文件。tarball 首层目录（owner-repo-sha/）会被去掉。
 * skillPath 为空表示仓库根目录就是 Skill。
 */
export function selectSkillFiles(
  entries: TarEntry[],
  skillPath: string,
  limits: SkillInstallLimits = DEFAULT_SKILL_INSTALL_LIMITS,
): ExtractedSkillFile[] {
  const files: ExtractedSkillFile[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const normalized = normalizeArchivePath(entry.name);
    const firstSlash = entry.name.indexOf("/");
    const rawWithinRepo = firstSlash === -1 ? "" : entry.name.slice(firstSlash + 1);
    if (!rawWithinRepo || rawWithinRepo === "/") continue;
    // 路径校验覆盖范围内的每个条目；范围外的条目不会落盘，忽略即可。
    const inScope = !skillPath || rawWithinRepo === skillPath || rawWithinRepo === `${skillPath}/`
      || rawWithinRepo.startsWith(`${skillPath}/`);
    if (!inScope) continue;
    if (!normalized) throw installError("E_SKILL_ARCHIVE_PATH", `压缩包含不安全的路径，已拒绝安装: ${entry.name}`);
    const withinRepo = normalized.slice(normalized.indexOf("/") + 1);
    if (withinRepo === skillPath) continue;
    const relativePath = skillPath ? withinRepo.slice(skillPath.length + 1) : withinRepo;
    if (!relativePath) continue;
    if (entry.type === "symlink" || entry.type === "hardlink") {
      throw installError("E_SKILL_ARCHIVE_LINK", `Skill 内包含链接文件，已拒绝安装: ${relativePath}`);
    }
    if (entry.type === "other") {
      throw installError("E_SKILL_ARCHIVE_TYPE", `Skill 内包含不支持的文件类型，已拒绝安装: ${relativePath}`);
    }
    if (entry.type === "directory") continue;
    files.push({ relativePath, data: entry.data });
    totalBytes += entry.data.length;
    if (files.length > limits.maxFiles) {
      throw installError("E_SKILL_TOO_MANY_FILES", `Skill 文件数超过上限 ${limits.maxFiles}。`);
    }
    if (totalBytes > limits.maxSkillBytes) {
      throw installError("E_SKILL_TOO_LARGE", `Skill 总大小超过上限 ${Math.round(limits.maxSkillBytes / 1024)} KB。`);
    }
  }
  if (files.length === 0) {
    throw installError("E_SKILL_NOT_FOUND", `仓库里没有找到目录: ${skillPath || "(根目录)"}`);
  }
  if (!files.some((file) => file.relativePath === "SKILL.md")) {
    throw installError("E_SKILL_MD_MISSING", `${skillPath || "仓库根目录"} 下没有 SKILL.md，不是一个 Skill。`);
  }
  return files;
}

// ── 网络 ────────────────────────────────────────────────────────

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw installError("E_SKILL_DOWNLOAD_TOO_LARGE", `下载内容超过上限 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
  }
  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) throw installError("E_SKILL_DOWNLOAD_TOO_LARGE", `下载内容超过上限 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw installError("E_SKILL_DOWNLOAD_TOO_LARGE", `下载内容超过上限 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function requestInit(accept: string, signal?: AbortSignal): RequestInit {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  return {
    headers: { Accept: accept, "User-Agent": "Cyrene-Agent-Skill-Installer" },
    redirect: "follow",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  };
}

function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

/** 把分支/标签/HEAD 解析为确定的提交 sha，安装与来源记录都钉在这个提交上。 */
export async function resolveGitHubCommit(
  source: GitHubSkillSource,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<string> {
  if (source.ref && SHA_PATTERN.test(source.ref)) return source.ref;
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeRef(source.ref ?? "HEAD")}`;
  const response = await fetchImpl(url, requestInit("application/vnd.github.sha", signal));
  if (!response.ok) {
    throw installError("E_SKILL_FETCH_FAILED", `查询 ${source.owner}/${source.repo}${source.ref ? "@" + source.ref : ""} 的提交失败（HTTP ${response.status}）。仓库可能不存在、是私有仓库或触发了 GitHub 限流。`);
  }
  const sha = (await readBodyWithLimit(response, 1024)).toString("utf8").trim();
  if (!SHA_PATTERN.test(sha)) throw installError("E_SKILL_FETCH_FAILED", "GitHub 返回的提交号格式异常。");
  return sha;
}

export async function downloadGitHubTarball(
  source: GitHubSkillSource,
  commit: string,
  fetchImpl: FetchLike,
  limits: SkillInstallLimits,
  signal?: AbortSignal,
): Promise<TarEntry[]> {
  const url = `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${commit}`;
  const response = await fetchImpl(url, requestInit("application/gzip", signal));
  if (!response.ok) throw installError("E_SKILL_FETCH_FAILED", `下载仓库快照失败（HTTP ${response.status}）。`);
  const gz = await readBodyWithLimit(response, limits.maxDownloadBytes);
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(gz, { maxOutputLength: limits.maxUnpackedBytes });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|buffer/i.test(String((error as Error).message))) {
      throw installError("E_SKILL_DOWNLOAD_TOO_LARGE", `仓库解压后超过上限 ${Math.round(limits.maxUnpackedBytes / 1024 / 1024)} MB。`);
    }
    throw installError("E_SKILL_ARCHIVE_INVALID", "仓库快照不是有效的 gzip 压缩包。");
  }
  return parseTar(tar);
}

// ── 安装主流程 ──────────────────────────────────────────────────

export interface InstallSkillOptions extends SkillDirectories {
  source: string;
  ref?: string;
  /** 指定安装后的 id；缺省依次取 SKILL.md 的 name、目录名、仓库名。 */
  id?: string;
  overwrite?: boolean;
  fetchImpl?: FetchLike;
  limits?: Partial<SkillInstallLimits>;
  signal?: AbortSignal;
  now?: Date;
}

export interface InstallSkillResult {
  id: string;
  name: string;
  description: string;
  repository: string;
  path: string;
  commit: string;
  fileCount: number;
  updated: boolean;
  dirPath: string;
}

function deriveSkillId(explicit: string | undefined, frontmatterName: string, source: GitHubSkillSource): string {
  if (explicit !== undefined && explicit.trim()) return explicit.trim();
  const candidates = [frontmatterName, source.path.split("/").at(-1) ?? "", source.repo]
    .map((value) => value.trim().toLowerCase());
  const id = candidates.find((value) => isValidSkillId(value));
  if (!id) throw installError("E_SKILL_ID_INVALID", "无法从仓库推导出合法的 Skill id，请用 id 参数指定（小写字母、数字、短横线）。");
  return id;
}

/** 暂存根目录放在用户 Skill 目录之外，扫描器不会把半成品当 Skill。 */
export function skillStagingRoot(userSkillsDir: string): string {
  return path.join(path.dirname(path.resolve(userSkillsDir)), ".skill-staging");
}

function writeStagedFiles(stagingDir: string, files: ExtractedSkillFile[]): void {
  const root = path.resolve(stagingDir);
  for (const file of files) {
    const target = path.resolve(root, ...file.relativePath.split("/"));
    if (!target.startsWith(root + path.sep)) {
      throw installError("E_SKILL_ARCHIVE_PATH", `压缩包含不安全的路径，已拒绝安装: ${file.relativePath}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.data);
  }
}

export async function installSkillFromGitHub(options: InstallSkillOptions): Promise<InstallSkillResult> {
  const limits = { ...DEFAULT_SKILL_INSTALL_LIMITS, ...options.limits };
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const source = parseGitHubSkillSource(options.source, options.ref);
  const dirs: SkillDirectories = { userSkillsDir: options.userSkillsDir, builtinSkillDir: options.builtinSkillDir };
  // 已知 id 时先做所有权检查，避免白白下载。
  if (options.id !== undefined && options.id.trim()) checkSkillTarget(options.id.trim(), dirs, options.overwrite === true);

  const commit = await resolveGitHubCommit(source, fetchImpl, options.signal);
  const entries = await downloadGitHubTarball(source, commit, fetchImpl, limits, options.signal);
  const files = selectSkillFiles(entries, source.path, limits);
  const skillMd = files.find((file) => file.relativePath === "SKILL.md")!;
  const parsed = parseSkillFrontmatter(skillMd.data.toString("utf8"));
  if (!parsed) {
    throw installError("E_SKILL_MD_INVALID", "SKILL.md 缺少 name/description frontmatter，无法作为 Skill 加载。");
  }
  const id = deriveSkillId(options.id, parsed.name, source);
  const target = checkSkillTarget(id, dirs, options.overwrite === true);
  if (files.some((file) => file.relativePath === SKILL_SOURCE_MARKER)) {
    throw installError("E_SKILL_ARCHIVE_PATH", `Skill 内不能自带 ${SKILL_SOURCE_MARKER}。`);
  }

  const stagingRoot = skillStagingRoot(options.userSkillsDir);
  const stagingDir = path.join(stagingRoot, `install-${randomUUID()}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    writeStagedFiles(stagingDir, files);
    const origin: SkillOrigin = {
      origin: "github",
      repository: `${source.owner}/${source.repo}`,
      path: source.path,
      ...(source.ref ? { ref: source.ref } : {}),
      commit,
      installedAt: (options.now ?? new Date()).toISOString(),
    };
    fs.writeFileSync(path.join(stagingDir, SKILL_SOURCE_MARKER), JSON.stringify(origin, null, 2), "utf8");
    replaceSkillDirectory(stagingDir, target.targetDir, stagingRoot);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  return {
    id,
    name: parsed.name,
    description: parsed.description,
    repository: `${source.owner}/${source.repo}`,
    path: source.path,
    commit,
    fileCount: files.length,
    updated: target.exists,
    dirPath: target.targetDir,
  };
}
