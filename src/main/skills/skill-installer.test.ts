// skill_install 安全边界：全部用本地 tarball 夹具 + 注入 fetch，不访问真实网络。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import {
  installSkillFromGitHub,
  parseGitHubSkillSource,
  parseTar,
  skillStagingRoot,
  type FetchLike,
} from "./skill-installer";
import { SKILL_SOURCE_MARKER } from "./skill-authoring";
import { scanSkills } from "./skill-scanner";

interface FixtureEntry {
  name: string;
  type?: "0" | "5" | "2" | "1" | "x";
  data?: string | Buffer;
  linkname?: string;
}

function tarHeader(name: string, size: number, type: string, linkname = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(size.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write(type, 156);
  header.write(linkname, 157, 100, "utf8");
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return header;
}

function buildTarball(entries: FixtureEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf8");
    parts.push(tarHeader(entry.name, data.length, entry.type ?? "0", entry.linkname));
    parts.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TOP = "octo-skills-0123456";
const SKILL_MD = "---\nname: pdf-helper\ndescription: 处理 PDF 的做法\n---\n# PDF\n步骤一";

function fakeFetch(tarball: Buffer, calls: string[] = []): FetchLike {
  return async (url) => {
    calls.push(url);
    if (url.startsWith("https://api.github.com/")) return new Response(SHA, { status: 200 });
    if (url.startsWith("https://codeload.github.com/")) return new Response(tarball, { status: 200 });
    return new Response("not found", { status: 404 });
  };
}

let root: string;
let userSkillsDir: string;
let builtinSkillDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-skill-install-"));
  userSkillsDir = path.join(root, "userData", "skills");
  builtinSkillDir = path.join(root, "install", "skills");
  fs.mkdirSync(path.join(builtinSkillDir, "cyrene-diagram"), { recursive: true });
  fs.writeFileSync(path.join(builtinSkillDir, "cyrene-diagram", "SKILL.md"), "---\nname: cyrene-diagram\ndescription: 内置\n---\n内置正文");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("parseGitHubSkillSource", () => {
  it("支持 owner/repo、owner/repo/path 与仓库 URL", () => {
    expect(parseGitHubSkillSource("octo/skills")).toEqual({ owner: "octo", repo: "skills", path: "" });
    expect(parseGitHubSkillSource("octo/skills/skills/pdf-helper")).toEqual({ owner: "octo", repo: "skills", path: "skills/pdf-helper" });
    expect(parseGitHubSkillSource("https://github.com/octo/skills.git")).toEqual({ owner: "octo", repo: "skills", path: "" });
    expect(parseGitHubSkillSource("https://github.com/octo/skills/tree/main/skills/pdf-helper"))
      .toEqual({ owner: "octo", repo: "skills", path: "skills/pdf-helper", ref: "main" });
    expect(parseGitHubSkillSource("https://github.com/octo/skills/blob/v1/pdf/SKILL.md"))
      .toEqual({ owner: "octo", repo: "skills", path: "pdf", ref: "v1" });
  });

  it("拒绝路径穿越与非 GitHub 来源", () => {
    expect(() => parseGitHubSkillSource("octo/skills/../etc")).toThrow(/路径不合法/);
    expect(() => parseGitHubSkillSource("octo/..")).toThrow();
    expect(() => parseGitHubSkillSource("https://gitlab.com/octo/skills")).toThrow(/只支持 GitHub/);
    expect(() => parseGitHubSkillSource("file:///etc/passwd")).toThrow(/只支持 GitHub/);
    expect(() => parseGitHubSkillSource("octo/skills", "../main")).toThrow(/不合法/);
  });
});

describe("installSkillFromGitHub", () => {
  it("安装子目录 Skill，钉在提交 sha 上并记录来源，扫描器能加载", async () => {
    const calls: string[] = [];
    const tarball = buildTarball([
      { name: `${TOP}/`, type: "5" },
      { name: `${TOP}/README.md`, data: "仓库说明" },
      { name: `${TOP}/skills/pdf-helper/`, type: "5" },
      { name: `${TOP}/skills/pdf-helper/SKILL.md`, data: SKILL_MD },
      { name: `${TOP}/skills/pdf-helper/references/guide.md`, data: "参考" },
      { name: `${TOP}/skills/other/link`, type: "2", linkname: "/etc/passwd" },
    ]);
    const result = await installSkillFromGitHub({
      source: "octo/skills/skills/pdf-helper",
      userSkillsDir,
      builtinSkillDir,
      fetchImpl: fakeFetch(tarball, calls),
    });
    expect(result).toMatchObject({ id: "pdf-helper", repository: "octo/skills", path: "skills/pdf-helper", commit: SHA, fileCount: 2, updated: false });
    expect(calls).toEqual([
      "https://api.github.com/repos/octo/skills/commits/HEAD",
      `https://codeload.github.com/octo/skills/tar.gz/${SHA}`,
    ]);
    const dir = path.join(userSkillsDir, "pdf-helper");
    expect(fs.readFileSync(path.join(dir, "references", "guide.md"), "utf8")).toBe("参考");
    expect(fs.existsSync(path.join(dir, "README.md"))).toBe(false);
    const origin = JSON.parse(fs.readFileSync(path.join(dir, SKILL_SOURCE_MARKER), "utf8"));
    expect(origin).toMatchObject({ origin: "github", repository: "octo/skills", path: "skills/pdf-helper", commit: SHA });
    expect(scanSkills(userSkillsDir, "user").map((s) => s.id)).toEqual(["pdf-helper"]);
    // 暂存区不残留半成品
    expect(fs.readdirSync(skillStagingRoot(userSkillsDir))).toEqual([]);
  });

  it("Skill 内含符号链接或硬链接时整体拒绝，不落盘", async () => {
    for (const type of ["2", "1"] as const) {
      const tarball = buildTarball([
        { name: `${TOP}/SKILL.md`, data: SKILL_MD },
        { name: `${TOP}/evil`, type, linkname: "../../../../etc/passwd" },
      ]);
      await expect(installSkillFromGitHub({ source: "octo/skills", userSkillsDir, builtinSkillDir, fetchImpl: fakeFetch(tarball) }))
        .rejects.toMatchObject({ code: "E_SKILL_ARCHIVE_LINK" });
    }
    expect(fs.existsSync(path.join(userSkillsDir, "pdf-helper"))).toBe(false);
  });

  it("路径穿越条目整体拒绝", async () => {
    const tarball = buildTarball([
      { name: `${TOP}/SKILL.md`, data: SKILL_MD },
      { name: `${TOP}/../../escape.txt`, data: "逃逸" },
    ]);
    await expect(installSkillFromGitHub({ source: "octo/skills", userSkillsDir, builtinSkillDir, fetchImpl: fakeFetch(tarball) }))
      .rejects.toMatchObject({ code: "E_SKILL_ARCHIVE_PATH" });
    const sub = buildTarball([
      { name: `${TOP}/pdf/SKILL.md`, data: SKILL_MD },
      { name: `${TOP}/pdf/../../../escape.txt`, data: "逃逸" },
    ]);
    await expect(installSkillFromGitHub({ source: "octo/skills/pdf", userSkillsDir, builtinSkillDir, fetchImpl: fakeFetch(sub) }))
      .rejects.toMatchObject({ code: "E_SKILL_ARCHIVE_PATH" });
    expect(fs.existsSync(path.join(root, "escape.txt"))).toBe(false);
    expect(fs.existsSync(path.join(root, "userData", "escape.txt"))).toBe(false);
  });

  it("缺 SKILL.md、文件数超限、总大小超限、下载超限都拒绝", async () => {
    const noMd = buildTarball([{ name: `${TOP}/README.md`, data: "只有说明" }]);
    await expect(installSkillFromGitHub({ source: "octo/skills", userSkillsDir, builtinSkillDir, fetchImpl: fakeFetch(noMd) }))
      .rejects.toMatchObject({ code: "E_SKILL_MD_MISSING" });

    const many = buildTarball([
      { name: `${TOP}/SKILL.md`, data: SKILL_MD },
      ...Array.from({ length: 5 }, (_, i) => ({ name: `${TOP}/f${i}.txt`, data: "x" })),
    ]);
    await expect(installSkillFromGitHub({ source: "octo/skills", userSkillsDir, builtinSkillDir, fetchImpl: fakeFetch(many), limits: { maxFiles: 3 } }))
      .rejects.toMatchObject({ code: "E_SKILL_TOO_MANY_FILES" });

    const big = buildTarball([
      { name: `${TOP}/SKILL.md`, data: SKILL_MD },
      { name: `${TOP}/big.bin`, data: Buffer.alloc(4096, 1) },
    ]);
    await expect(installSkillFromGitHub({ source: "octo/skills", userSkillsDir, builtinSkillDir, fetchImpl: fakeFetch(big), limits: { maxSkillBytes: 2048 } }))
      .rejects.toMatchObject({ code: "E_SKILL_TOO_LARGE" });
    await expect(installSkillFromGitHub({ source: "octo/skills", userSkillsDir, builtinSkillDir, fetchImpl: fakeFetch(big), limits: { maxDownloadBytes: 16 } }))
      .rejects.toMatchObject({ code: "E_SKILL_DOWNLOAD_TOO_LARGE" });
    expect(fs.existsSync(userSkillsDir) ? fs.readdirSync(userSkillsDir) : []).toEqual([]);
  });

  it("不能覆盖内置 Skill；已安装的更新必须 overwrite=true", async () => {
    const builtinClash = buildTarball([{ name: `${TOP}/SKILL.md`, data: "---\nname: cyrene-diagram\ndescription: 冒充\n---\n正文" }]);
    await expect(installSkillFromGitHub({ source: "octo/skills", userSkillsDir, builtinSkillDir, fetchImpl: fakeFetch(builtinClash) }))
      .rejects.toMatchObject({ code: "E_SKILL_BUILTIN" });

    const v1 = buildTarball([{ name: `${TOP}/SKILL.md`, data: SKILL_MD }]);
    await installSkillFromGitHub({ source: "octo/skills", userSkillsDir, builtinSkillDir, fetchImpl: fakeFetch(v1) });
    const v2 = buildTarball([{ name: `${TOP}/SKILL.md`, data: SKILL_MD.replace("步骤一", "步骤二") }]);
    await expect(installSkillFromGitHub({ source: "octo/skills", userSkillsDir, builtinSkillDir, fetchImpl: fakeFetch(v2) }))
      .rejects.toMatchObject({ code: "E_SKILL_EXISTS" });
    const updated = await installSkillFromGitHub({ source: "octo/skills", userSkillsDir, builtinSkillDir, fetchImpl: fakeFetch(v2), overwrite: true });
    expect(updated.updated).toBe(true);
    expect(fs.readFileSync(path.join(userSkillsDir, "pdf-helper", "SKILL.md"), "utf8")).toContain("步骤二");
  });

  it("不能覆盖未托管（随安装包快照或手动放置）的用户 Skill", async () => {
    fs.mkdirSync(path.join(userSkillsDir, "pdf-helper"), { recursive: true });
    fs.writeFileSync(path.join(userSkillsDir, "pdf-helper", "SKILL.md"), SKILL_MD);
    const tarball = buildTarball([{ name: `${TOP}/SKILL.md`, data: SKILL_MD }]);
    await expect(installSkillFromGitHub({ source: "octo/skills", userSkillsDir, builtinSkillDir, fetchImpl: fakeFetch(tarball), overwrite: true }))
      .rejects.toMatchObject({ code: "E_SKILL_UNMANAGED" });
  });

  it("指定非法 id 在联网前就拒绝", async () => {
    const calls: string[] = [];
    await expect(installSkillFromGitHub({ source: "octo/skills", id: "Bad_Id", userSkillsDir, builtinSkillDir, fetchImpl: fakeFetch(Buffer.alloc(0), calls) }))
      .rejects.toMatchObject({ code: "E_SKILL_ID_INVALID" });
    expect(calls).toEqual([]);
  });

  it("GitHub 请求失败时给出明确错误", async () => {
    const failing: FetchLike = async () => new Response("rate limited", { status: 403 });
    await expect(installSkillFromGitHub({ source: "octo/skills", userSkillsDir, builtinSkillDir, fetchImpl: failing }))
      .rejects.toMatchObject({ code: "E_SKILL_FETCH_FAILED" });
  });
});

describe("parseTar", () => {
  it("支持 pax 长路径", () => {
    const longName = `${TOP}/${"a".repeat(120)}/SKILL.md`;
    const record = ` path=${longName}\n`;
    const len = Buffer.byteLength(record) + 3;
    const pax = `${len}${record}`;
    const gz = buildTarball([
      { name: "pax", type: "x", data: pax },
      { name: "truncated-name", data: "内容" },
    ]);
    const entries = parseTar(zlib.gunzipSync(gz));
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe(longName);
  });
});
