import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTaskWorktreeManager,
  isGitPushCommand,
  isolateTaskTools,
  TaskIsolationError,
} from "./task-worktree";
import { resolveFileAccessPath } from "./tools/file-access";
import type { ToolDefinition } from "./tools/registry/tool-registry";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

/** 真实临时仓库：含一个已提交文件与一个子目录，覆盖工作区是仓库子目录的情形。 */
function createRepo(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-wt-")));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  fs.mkdirSync(path.join(root, "pkg"));
  fs.writeFileSync(path.join(root, "pkg", "index.ts"), "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (fs.existsSync(path.join(root, ".git"))) git(root, "worktree", "prune");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("TaskWorktreeManager", () => {
  it("creates a branch worktree from HEAD and keeps the main workspace untouched", async () => {
    const repo = createRepo();
    const manager = createTaskWorktreeManager();
    const handle = await manager.acquire({ workspaceRoot: repo, taskId: "task-a" });

    expect(handle.worktreePath).toBe(fs.realpathSync.native(path.join(repo, ".cyrene", "worktrees", "task-a")));
    expect(handle.branch).toBe("cyrene/task-task-a");
    expect(handle.baseCommit).toBe(git(repo, "rev-parse", "HEAD").trim());
    expect(fs.readFileSync(path.join(handle.worktreePath, "README.md"), "utf8")).toBe("hello\n");

    fs.writeFileSync(path.join(handle.workspaceRoot, "README.md"), "changed\n");
    fs.writeFileSync(path.join(handle.workspaceRoot, "new.txt"), "new\n");

    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("hello\n");
    expect(fs.existsSync(path.join(repo, "new.txt"))).toBe(false);
    // info/exclude 让主工作区 git status 不显示 worktree 目录
    expect(git(repo, "status", "--porcelain")).toBe("");

    const outcome = await manager.finalize(handle);
    expect(outcome).toMatchObject({ kind: "retained", branch: "cyrene/task-task-a", uncommitted: true, commitsAhead: 0 });
    expect(outcome.diffStat).toContain("README.md");
    expect(outcome.changedFiles).toEqual(["M\tREADME.md"]);
    expect(outcome.untrackedFiles).toEqual(["new.txt"]);
    expect(fs.existsSync(handle.worktreePath)).toBe(true);
    expect(git(repo, "branch", "--list", handle.branch).trim()).not.toBe("");
    const [record] = await manager.list(repo);
    expect(record).toMatchObject({ taskId: "task-a", state: "retained" });
  });

  it("maps a sub-directory workspace into the worktree", async () => {
    const repo = createRepo();
    const manager = createTaskWorktreeManager();
    const handle = await manager.acquire({ workspaceRoot: path.join(repo, "pkg"), taskId: "task-sub" });
    expect(handle.workspaceRoot).toBe(path.join(handle.worktreePath, "pkg"));
    expect(fs.existsSync(path.join(handle.workspaceRoot, "index.ts"))).toBe(true);
    await manager.finalize(handle);
  });

  it("removes the worktree and branch when the task made no changes", async () => {
    const repo = createRepo();
    const manager = createTaskWorktreeManager();
    const handle = await manager.acquire({ workspaceRoot: repo, taskId: "task-clean" });
    const outcome = await manager.finalize(handle);

    expect(outcome.kind).toBe("removed");
    expect(fs.existsSync(handle.worktreePath)).toBe(false);
    expect(git(repo, "branch", "--list", handle.branch).trim()).toBe("");
    expect(git(repo, "worktree", "list")).not.toContain("task-clean");
    expect(await manager.list(repo)).toEqual([]);
  });

  it("keeps committed work even when the working tree is clean", async () => {
    const repo = createRepo();
    const manager = createTaskWorktreeManager();
    const handle = await manager.acquire({ workspaceRoot: repo, taskId: "task-commit" });
    fs.writeFileSync(path.join(handle.worktreePath, "feature.ts"), "export {};\n");
    git(handle.worktreePath, "add", "-A");
    git(handle.worktreePath, "commit", "-q", "-m", "feature");

    const outcome = await manager.finalize(handle);
    expect(outcome).toMatchObject({ kind: "retained", commitsAhead: 1, uncommitted: false });
    expect(outcome.diffStat).toContain("feature.ts");
    expect(git(repo, "log", "--oneline", "main")).not.toContain("feature");
  });

  it("creates worktrees concurrently without git lock conflicts", async () => {
    const repo = createRepo();
    const manager = createTaskWorktreeManager();
    const handles = await Promise.all(["p1", "p2", "p3"].map((taskId) => manager.acquire({ workspaceRoot: repo, taskId })));
    expect(new Set(handles.map((handle) => handle.worktreePath)).size).toBe(3);
    const outcomes = await Promise.all(handles.map((handle) => manager.finalize(handle)));
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["removed", "removed", "removed"]);
  });

  it("rejects non-git and unbound workspaces with a clear error", async () => {
    const manager = createTaskWorktreeManager();
    const plain = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-plain-")));
    roots.push(plain);
    await expect(manager.acquire({ workspaceRoot: plain, taskId: "x" }))
      .rejects.toMatchObject({ name: "TaskIsolationError", code: "TASK_WORKTREE_NOT_GIT" });
    await expect(manager.acquire({ workspaceRoot: undefined, taskId: "x" }))
      .rejects.toMatchObject({ code: "TASK_WORKTREE_NO_WORKSPACE" });
    expect(fs.existsSync(path.join(plain, ".cyrene"))).toBe(false);
  });

  it("recognizes worktrees left by a crashed process: lists dirty ones, cleans clean ones", async () => {
    const repo = createRepo();
    const crashed = createTaskWorktreeManager({ ownerId: "old-process" });
    const dirty = await crashed.acquire({ workspaceRoot: repo, taskId: "left-dirty" });
    const clean = await crashed.acquire({ workspaceRoot: repo, taskId: "left-clean" });
    fs.writeFileSync(path.join(dirty.worktreePath, "README.md"), "unsaved work\n");
    // 不调用 finalize：模拟应用强退

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const restarted = createTaskWorktreeManager({ ownerId: "new-process" });
    const handle = await restarted.acquire({ workspaceRoot: repo, taskId: "next" });

    expect(handle.retainedWorktrees).toEqual([expect.objectContaining({
      taskId: "left-dirty", branch: "cyrene/task-left-dirty", interrupted: true,
    })]);
    expect(fs.readFileSync(path.join(dirty.worktreePath, "README.md"), "utf8")).toBe("unsaved work\n");
    expect(fs.existsSync(clean.worktreePath)).toBe(false);
    expect(git(repo, "branch", "--list", clean.branch).trim()).toBe("");
    expect(warn).toHaveBeenCalled();

    // 恢复同一子任务时复用保留的 worktree，不丢改动
    const resumed = await restarted.acquire({ workspaceRoot: repo, taskId: "left-dirty" });
    expect(resumed.reused).toBe(true);
    expect(fs.readFileSync(path.join(resumed.worktreePath, "README.md"), "utf8")).toBe("unsaved work\n");
    expect((await restarted.finalize(resumed)).kind).toBe("retained");
    await restarted.finalize(handle);
  });
});

describe("worktree isolation boundaries", () => {
  it("denies file writes outside the worktree even with full access", async () => {
    const repo = createRepo();
    const manager = createTaskWorktreeManager();
    const handle = await manager.acquire({ workspaceRoot: repo, taskId: "task-fs" });
    const context = { userQuery: "", permissionMode: "allow_all" as const, resolvedWorkspaceRoot: handle.workspaceRoot, writeRoot: handle.worktreePath };

    expect(resolveFileAccessPath(path.join(handle.workspaceRoot, "a.txt"), "write", context).ok).toBe(true);
    const outside = resolveFileAccessPath(path.join(repo, "README.md"), "write", context);
    expect(outside.ok).toBe(false);
    expect(resolveFileAccessPath(path.join(repo, "README.md"), "read", context).ok).toBe(true);
    await manager.finalize(handle);
  });

  it("blocks git push and shell cwd outside the worktree", async () => {
    const execute = vi.fn(async () => "ran");
    const shell: ToolDefinition = { id: "run_shell", name: "shell", description: "", enabled: true, inputSchema: { type: "object", properties: {} }, execute };
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-shell-")));
    roots.push(root);
    const worktreePath = path.join(root, "wt");
    fs.mkdirSync(worktreePath);
    const [isolated] = isolateTaskTools([shell], { worktreePath, workspaceRoot: worktreePath });

    expect(JSON.parse(await isolated.execute({ command: "git push origin HEAD" }))).toMatchObject({ errorCode: "TASK_GIT_PUSH_FORBIDDEN" });
    expect(JSON.parse(await isolated.execute({ command: "git status", cwd: root }))).toMatchObject({ errorCode: "TASK_WORKTREE_CWD_OUTSIDE" });
    expect(JSON.parse(await isolated.execute({ command: "git status", cwd: ".." }))).toMatchObject({ errorCode: "TASK_WORKTREE_CWD_OUTSIDE" });
    expect(await isolated.execute({ command: "git status", cwd: "." })).toBe("ran");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("detects push across common shell spellings", () => {
    for (const command of ["git push", "git -C repo push origin main", "cd x && git push -f", "git.exe push", "echo a; git  push"]) {
      expect(isGitPushCommand(command), command).toBe(true);
    }
    for (const command of ["git status", "git log --grep=push", "npm run push-docs", "github push"]) {
      expect(isGitPushCommand(command), command).toBe(false);
    }
  });

  it("exposes a typed error", () => {
    expect(new TaskIsolationError("TASK_WORKTREE_BUSY", "x")).toBeInstanceOf(Error);
  });
});
