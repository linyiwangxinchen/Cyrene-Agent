import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SummaryMemoryTurnSource } from "./summary-memory-sources";

export interface SummaryReadResult {
  content: string;
  truncated: boolean;
  /** Undefined denotes legacy Markdown. Null denotes unreadable tracked metadata. */
  sources?: SummaryMemoryTurnSource[] | null;
}

export const MAX_SUMMARY_SOURCES = 256;
const SUMMARY_SOURCE_MARKER = "<!-- cyrene-summary-sources-";
const MAX_SUMMARY_SOURCE_BYTES = 512 * 1024;

function validSummarySources(value: unknown): value is SummaryMemoryTurnSource[] {
  const isId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 256;
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_SUMMARY_SOURCES && value.every(source =>
    source && isId(source.conversationId) && isId(source.userTurnId) && isId(source.assistantEntryId)
    && isId(source.userEntryId));
}

function parseSummarySources(line: string): SummaryMemoryTurnSource[] | null {
  const match = /^<!-- cyrene-summary-sources-v1:([A-Za-z0-9_-]+) -->$/u.exec(line.replace(/^\uFEFF|\r$/gu, ""));
  if (!match) return null;
  try {
    const value = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as unknown;
    return validSummarySources(value) ? value : null;
  } catch {
    return null;
  }
}

export function countUnicodeCharacters(text: string): number {
  return Array.from(text).length;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function clampCharacters(text: string, maxChars: number): string {
  return Array.from(text).slice(0, maxChars).join("");
}

async function ensureSafeDirectories(root: string, directories: string[]): Promise<string> {
  const absoluteRoot = path.resolve(root);
  await fs.mkdir(absoluteRoot, { recursive: true });
  let current = absoluteRoot;
  for (const segment of directories) {
    current = path.join(current, segment);
    const relative = path.relative(absoluteRoot, current);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new Error("SUMMARY_MEMORY_PATH_OUTSIDE_ROOT");
    }
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("SUMMARY_MEMORY_UNSAFE_DIRECTORY");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(current);
    }
  }
  return current;
}

export async function readSummaryFile(filePath: string, maxChars: number, allowedRoot: string): Promise<SummaryReadResult> {
  const absolutePath = path.resolve(filePath);
  const absoluteRoot = path.resolve(allowedRoot);
  const relative = path.relative(absoluteRoot, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("SUMMARY_MEMORY_PATH_OUTSIDE_ROOT");
  }
  const parentRelative = path.dirname(relative);
  const parentParts = parentRelative === "." ? [] : parentRelative.split(path.sep);
  let parent = absoluteRoot;
  try {
    for (const segment of parentParts) {
      parent = path.join(parent, segment);
      const parentStat = await fs.lstat(parent);
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error("SUMMARY_MEMORY_UNSAFE_DIRECTORY");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: "", truncated: false };
    throw error;
  }
  try {
    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("SUMMARY_MEMORY_UNSAFE_FILE");
    const maxBytes = Math.max(4, maxChars * 4 + 16);
    const handle = await fs.open(absolutePath, "r");
    let text: string;
    let sourceBytes = 0;
    let sources: SummaryReadResult["sources"];
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      text = buffer.subarray(0, bytesRead).toString("utf8");
      if (text.replace(/^\uFEFF/u, "").startsWith(SUMMARY_SOURCE_MARKER)) {
        const headerAndBody = Buffer.alloc(Math.min(stat.size, MAX_SUMMARY_SOURCE_BYTES + maxBytes));
        const tracked = await handle.read(headerAndBody, 0, headerAndBody.length, 0);
        const lineEnd = headerAndBody.indexOf(0x0a, 0);
        if (lineEnd < 0 || lineEnd >= MAX_SUMMARY_SOURCE_BYTES || lineEnd >= tracked.bytesRead) {
          return { content: "", truncated: false, sources: null };
        }
        sources = parseSummarySources(headerAndBody.subarray(0, lineEnd).toString("utf8"));
        if (sources === null) return { content: "", truncated: false, sources };
        sourceBytes = lineEnd + 1;
        text = headerAndBody.subarray(sourceBytes, Math.min(tracked.bytesRead, sourceBytes + maxBytes)).toString("utf8");
      }
    } finally {
      await handle.close();
    }
    text = normalizeText(text);
    const chars = Array.from(text);
    const truncated = stat.size - sourceBytes > maxBytes || chars.length > maxChars;
    return { content: chars.slice(0, maxChars).join(""), truncated, ...(sources ? { sources } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: "", truncated: false };
    throw error;
  }
}

export async function writeSummaryFileAtomic(
  filePath: string,
  content: string,
  maxChars: number,
  allowedRoot: string,
  shouldCommit?: () => boolean | Promise<boolean>,
  sources?: SummaryMemoryTurnSource[],
): Promise<void> {
  const normalized = normalizeText(content);
  if (countUnicodeCharacters(normalized) > maxChars) throw new Error("SUMMARY_MEMORY_TOO_LONG");
  let markdown = normalized;
  if (sources) {
    if (!validSummarySources(sources)) throw new Error("SUMMARY_MEMORY_INVALID_SOURCES");
    const header = `${SUMMARY_SOURCE_MARKER}v1:${Buffer.from(JSON.stringify(sources)).toString("base64url")} -->\n`;
    if (Buffer.byteLength(header) > MAX_SUMMARY_SOURCE_BYTES) throw new Error("SUMMARY_MEMORY_SOURCES_TOO_LONG");
    markdown = header + normalized;
  }
  const absoluteRoot = path.resolve(allowedRoot);
  const absolutePath = path.resolve(filePath);
  const relative = path.relative(absoluteRoot, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("SUMMARY_MEMORY_PATH_OUTSIDE_ROOT");
  }
  const parentRelative = path.dirname(relative);
  const parentParts = parentRelative === "." ? [] : parentRelative.split(path.sep);
  const parent = await ensureSafeDirectories(absoluteRoot, parentParts);
  try {
    const existing = await fs.lstat(absolutePath);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("SUMMARY_MEMORY_UNSAFE_FILE");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const tempPath = path.join(parent, `.${path.basename(absolutePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tempPath, markdown, { encoding: "utf8", flag: "wx" });
    if (shouldCommit && !(await shouldCommit())) throw new Error("SUMMARY_MEMORY_CANCELLED");
    await fs.rename(tempPath, absolutePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function deleteSummaryFile(filePath: string, allowedRoot: string): Promise<void> {
  const absoluteRoot = path.resolve(allowedRoot);
  const absolutePath = path.resolve(filePath);
  const relative = path.relative(absoluteRoot, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("SUMMARY_MEMORY_PATH_OUTSIDE_ROOT");
  }
  let parent = absoluteRoot;
  const parentRelative = path.dirname(relative);
  try {
    for (const segment of parentRelative === "." ? [] : parentRelative.split(path.sep)) {
      parent = path.join(parent, segment);
      const parentStat = await fs.lstat(parent);
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error("SUMMARY_MEMORY_UNSAFE_DIRECTORY");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    await fs.unlink(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
