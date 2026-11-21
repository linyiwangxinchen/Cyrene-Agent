import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentFileAccessLevel } from "../../../permission-policy";

const permissionFixture = vi.hoisted(() => ({ level: "full" as AgentFileAccessLevel }));

vi.mock("../../../permission", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../permission")>(),
  getCurrentLevel: () => permissionFixture.level,
}));

import { executeGlob } from "./glob-tool";

let sandbox: string;
let workspace: string;

function write(relative: string, content = "x", mtimeSeconds?: number): string {
  const full = path.join(workspace, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  if (mtimeSeconds !== undefined) fs.utimesSync(full, mtimeSeconds, mtimeSeconds);
  return fs.realpathSync.native(full);
}

async function glob(args: Record<string, unknown>) {
  return JSON.parse(await executeGlob(args, { userQuery: "", resolvedWorkspaceRoot: workspace })) as {
    success: boolean;
    errorCode?: string;
    filenames?: string[];
    totalMatches?: number;
    truncated?: boolean;
  };
}

beforeEach(() => {
  permissionFixture.level = "full";
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "glob-tool-")));
  workspace = path.join(sandbox, "workspace");
  fs.mkdirSync(workspace);
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("glob 工具", () => {
  it("按修改时间倒序返回绝对路径，limit 截断的是最新的 N 个", async () => {
    const oldest = write("src/a.ts", "a", 1_000_000);
    const newest = write("src/nested/b.ts", "b", 3_000_000);
    const middle = write("src/c.ts", "c", 2_000_000);
    write("src/readme.md");

    const all = await glob({ pattern: "src/**/*.ts" });
    expect(all.success).toBe(true);
    expect(all.filenames).toEqual([newest, middle, oldest]);

    const limited = await glob({ pattern: "**/*.ts", limit: 2 });
    expect(limited.filenames).toEqual([newest, middle]);
    expect(limited.totalMatches).toBe(3);
    expect(limited.truncated).toBe(true);
  });

  it("* 只匹配一层，path 参数限定搜索目录且 pattern 相对 path", async () => {
    const top = write("src/top.ts");
    const deep = write("src/inner/deep.ts");
    write("other/x.ts");

    expect((await glob({ pattern: "*.ts", path: "src" })).filenames).toEqual([top]);
    expect((await glob({ pattern: "**/*.ts", path: "src" })).filenames?.sort()).toEqual([deep, top].sort());
  });

  it("遵守根目录与子目录的 .gitignore（含取反规则），并跳过 node_modules", async () => {
    write(".gitignore", "dist/\n*.log\n!keep.log\n");
    write("packages/app/.gitignore", "/generated\n");
    const kept = write("src/keep.log");
    write("src/debug.log");
    write("dist/bundle.js");
    write("node_modules/pkg/index.js");
    write("packages/app/generated/out.js");
    const appSource = write("packages/app/src/main.js");

    const logs = await glob({ pattern: "**/*.log" });
    expect(logs.filenames).toEqual([kept]);
    const scripts = await glob({ pattern: "**/*.js" });
    expect(scripts.filenames).toEqual([appSource]);
  });

  it("path 指向被忽略的目录时直接拒绝而不是返回被忽略的文件", async () => {
    write(".gitignore", "build/\n");
    write("build/out.js");
    const result = await glob({ pattern: "**/*", path: "build" });
    expect(result).toMatchObject({ success: false, errorCode: "PATH_IGNORED" });
  });

  it("拒绝工作区外的 path（即使当前权限档位允许读取）与含 .. 的 pattern", async () => {
    fs.writeFileSync(path.join(sandbox, "secret.txt"), "s");

    expect(await glob({ pattern: "*.txt", path: sandbox })).toMatchObject({ success: false, errorCode: "PATH_OUTSIDE_WORKSPACE" });
    expect(await glob({ pattern: "*.txt", path: ".." })).toMatchObject({ success: false, errorCode: "PATH_OUTSIDE_WORKSPACE" });
    expect(await glob({ pattern: "../*.txt" })).toMatchObject({ success: false, errorCode: "INVALID_PATTERN" });
    expect(await glob({ pattern: path.join(sandbox, "*.txt") })).toMatchObject({ success: false, errorCode: "INVALID_PATTERN" });
  });

  it("指向工作区外的符号链接文件不返回", async () => {
    const outside = path.join(sandbox, "outside.ts");
    fs.writeFileSync(outside, "o");
    const inside = write("src/inside.ts");
    try {
      fs.symlinkSync(outside, path.join(workspace, "src", "link.ts"), "file");
    } catch {
      return; // Windows 未开启开发者模式时无法创建符号链接
    }
    expect((await glob({ pattern: "**/*.ts" })).filenames).toEqual([inside]);
  });

  it("未绑定工作区时拒绝", async () => {
    write("a.ts");
    const result = JSON.parse(await executeGlob({ pattern: "*.ts" }, { userQuery: "" }));
    expect(result).toMatchObject({ success: false, errorCode: "NO_WORKSPACE" });
  });
});
