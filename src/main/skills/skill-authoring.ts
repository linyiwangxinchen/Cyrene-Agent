// 用户级 Skill 的自写与落盘 —— skill_write / skill_install 共用的目标检查与目录替换。
// 纯 fs 模块：目录由调用方传入，不碰 electron，便于单测。
//
// 所有权规则：
//   - 内置目录（<install>/skills）里存在同 id → 一律拒绝（user 同名会覆盖内置，等于改内置）。
//   - user 目录里已存在、但没有来源标记 `.cyrene-source.json` → 视为打包快照或用户手放的 Skill，拒绝覆盖。
//   - 有来源标记（昔涟自写或 GitHub 安装）→ 必须显式 overwrite=true 才能更新。

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import { parseSkillFrontmatter } from "./skill-scanner";
import type { SkillMode } from "./types";

/** Skill id：小写字母/数字，以短横线连接（不允许首尾或连续短横线），最长 64。 */
export const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_ID_MAX_LENGTH = 64;
export const SKILL_SOURCE_MARKER = ".cyrene-source.json";
export const SKILL_BODY_MAX_CHARS = 100_000;
export const SKILL_DESCRIPTION_MAX_CHARS = 1024;

export type SkillOrigin =
  | { origin: "authored"; createdAt: string; updatedAt: string }
  | {
    origin: "github";
    repository: string;
    path: string;
    ref?: string;
    commit: string;
    installedAt: string;
  };

export class SkillAuthoringError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SkillAuthoringError";
  }
}

export interface SkillDirectories {
  /** `<userData>/skills` */
  userSkillsDir: string;
  /** `<install>/skills`（内置/打包，只读） */
  builtinSkillDir?: string;
}

export function isValidSkillId(id: string): boolean {
  return id.length > 0 && id.length <= SKILL_ID_MAX_LENGTH && SKILL_ID_PATTERN.test(id);
}

export function readSkillOrigin(skillDir: string): SkillOrigin | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(skillDir, SKILL_SOURCE_MARKER), "utf8")) as SkillOrigin;
    return value && (value.origin === "authored" || value.origin === "github") ? value : null;
  } catch {
    return null;
  }
}

export interface SkillTargetCheck {
  targetDir: string;
  exists: boolean;
  origin: SkillOrigin | null;
}

/** 检查写入目标是否允许；不允许时抛 SkillAuthoringError。 */
export function checkSkillTarget(
  id: string,
  dirs: SkillDirectories,
  overwrite: boolean,
): SkillTargetCheck {
  if (!isValidSkillId(id)) {
    throw new SkillAuthoringError(
      "E_SKILL_ID_INVALID",
      `Skill id 不合法: ${JSON.stringify(id)}。只能用小写字母、数字和单个短横线连接（如 weekly-report），最长 ${SKILL_ID_MAX_LENGTH} 字符。`,
    );
  }
  if (dirs.builtinSkillDir && fs.existsSync(path.join(dirs.builtinSkillDir, id))) {
    throw new SkillAuthoringError("E_SKILL_BUILTIN", `"${id}" 是内置 Skill，不能覆盖或修改。请换一个 id。`);
  }
  const targetDir = path.join(dirs.userSkillsDir, id);
  let exists = false;
  try {
    const stat = fs.lstatSync(targetDir);
    exists = true;
    if (!stat.isDirectory()) {
      throw new SkillAuthoringError("E_SKILL_TARGET_INVALID", `目标路径不是普通目录，拒绝写入: ${targetDir}`);
    }
  } catch (error) {
    if (error instanceof SkillAuthoringError) throw error;
  }
  const origin = exists ? readSkillOrigin(targetDir) : null;
  if (exists && !origin) {
    throw new SkillAuthoringError(
      "E_SKILL_UNMANAGED",
      `"${id}" 是随安装包分发或手动放置的 Skill，不由昔涟管理，不能覆盖。请换一个 id，或手动编辑 ${targetDir}。`,
    );
  }
  if (exists && !overwrite) {
    throw new SkillAuthoringError("E_SKILL_EXISTS", `Skill "${id}" 已存在。确认要更新时传 overwrite=true。`);
  }
  return { targetDir, exists, origin };
}

export interface WriteUserSkillInput {
  id: string;
  name?: string;
  description: string;
  body: string;
  modes?: SkillMode[];
  overwrite?: boolean;
  now?: Date;
}

export interface WriteUserSkillResult {
  id: string;
  skillPath: string;
  updated: boolean;
}

const VALID_MODES = new Set<SkillMode>(["work", "code", "learn"]);

export function normalizeSkillModesInput(raw: unknown): SkillMode[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s]+/) : [];
  const modes = list.map((m) => String(m).trim().toLowerCase()).filter(Boolean);
  const invalid = modes.filter((m) => !VALID_MODES.has(m as SkillMode));
  if (invalid.length > 0) {
    throw new SkillAuthoringError("E_SKILL_MODES_INVALID", `适用模式只能是 work / code / learn，收到: ${invalid.join(", ")}`);
  }
  return modes.length > 0 ? Array.from(new Set(modes)) as SkillMode[] : undefined;
}

/** 生成 SKILL.md 文本（YAML frontmatter 由 gray-matter 负责转义）。 */
export function renderSkillMarkdown(input: Pick<WriteUserSkillInput, "id" | "name" | "description" | "body" | "modes">): string {
  const data: Record<string, unknown> = {
    name: input.name?.trim() || input.id,
    description: input.description.trim(),
  };
  if (input.modes && input.modes.length > 0) data.modes = input.modes;
  return matter.stringify(`\n${input.body.trim()}\n`, data);
}

/** 写入/更新 `<userSkillsDir>/<id>/SKILL.md`，保留目录内其他文件（references 等）。 */
export function writeUserSkill(input: WriteUserSkillInput, dirs: SkillDirectories): WriteUserSkillResult {
  const description = String(input.description ?? "").trim();
  const body = String(input.body ?? "").trim();
  if (!description) throw new SkillAuthoringError("E_SKILL_DESCRIPTION_REQUIRED", "description 不能为空：写清楚什么时候该用这个 Skill。");
  if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
    throw new SkillAuthoringError("E_SKILL_DESCRIPTION_TOO_LONG", `description 超过 ${SKILL_DESCRIPTION_MAX_CHARS} 字符。`);
  }
  if (!body) throw new SkillAuthoringError("E_SKILL_BODY_REQUIRED", "正文不能为空。");
  if (body.length > SKILL_BODY_MAX_CHARS) {
    throw new SkillAuthoringError("E_SKILL_BODY_TOO_LONG", `正文超过 ${SKILL_BODY_MAX_CHARS} 字符，请拆分或精简。`);
  }
  const target = checkSkillTarget(input.id, dirs, input.overwrite === true);
  const content = renderSkillMarkdown({ ...input, description, body });
  if (!parseSkillFrontmatter(content)) {
    throw new SkillAuthoringError("E_SKILL_RENDER_FAILED", "生成的 SKILL.md 无法通过解析校验。");
  }
  const now = (input.now ?? new Date()).toISOString();
  const previous = target.origin?.origin === "authored" ? target.origin : null;
  // 在安装来的 Skill 上改写后不再是上游原样，来源改记为自写。
  const origin: SkillOrigin = { origin: "authored", createdAt: previous?.createdAt ?? now, updatedAt: now };

  fs.mkdirSync(target.targetDir, { recursive: true });
  const skillPath = path.join(target.targetDir, "SKILL.md");
  const tmpPath = `${skillPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, skillPath);
  fs.writeFileSync(path.join(target.targetDir, SKILL_SOURCE_MARKER), JSON.stringify(origin, null, 2), "utf8");
  return { id: input.id, skillPath, updated: target.exists };
}

/**
 * 用已校验的暂存目录替换用户 Skill 目录。旧目录先挪到暂存区备份，替换失败时回滚。
 * stagingRoot 必须在 userSkillsDir 之外（否则扫描器会把备份当成 Skill）。
 */
export function replaceSkillDirectory(stagedDir: string, targetDir: string, stagingRoot: string): void {
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  let backup: string | null = null;
  if (fs.existsSync(targetDir)) {
    backup = path.join(stagingRoot, `backup-${path.basename(targetDir)}-${Date.now()}`);
    fs.renameSync(targetDir, backup);
  }
  try {
    moveDirectory(stagedDir, targetDir);
  } catch (error) {
    if (backup) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(backup, targetDir);
    }
    throw error;
  }
  if (backup) fs.rmSync(backup, { recursive: true, force: true });
}

function moveDirectory(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}
