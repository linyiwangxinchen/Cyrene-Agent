import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskSessionStore } from "../tasks/task-session-store";
import { closeConversationDatabases } from "../storage/conversation-database-client";
import { TaskCharacterLeasePool } from "../tasks/task-character-pool";
import { createTaskExecutor } from "./task-runtime";
import { createTaskWorktreeManager } from "./task-worktree";
import { executeTask } from "./harness/builtin-tools";
import { classifyToolExecutionMode } from "./harness/tool-call-scheduler";
import { resolveFileAccessPath } from "./tools/file-access";
import type { ToolContext } from "./tools/registry/tool-context";
import type { ToolDefinition } from "./tools/registry/tool-registry";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

function tempDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

function createRepo(): string {
  const root = tempDir("cyrene-task-wt-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

let taskSeq = 0;
function createStore() {
  return new TaskSessionStore(tempDir("cyrene-task-store-"), {
    createId: () => `task-${++taskSeq}`,
    createChildRunId: () => `child-run-${taskSeq}-${Math.random().toString(36).slice(2, 8)}`,
  });
}

function tool(id: string): ToolDefinition {
  return { id, name: id, description: id, enabled: true, inputSchema: { type: "object", properties: {} }, execute: async () => "ok" };
}

function parentFor(workspace: string | undefined, signal?: AbortSignal) {
  return {
    parentConversationId: "conversation-1",
    parentRunId: "parent-run-1",
    mode: "code" as const,
    systemPrompt: "",
    vendorConfig: { provider: "fake", model: "fake" } as never,
    tools: [tool("Read"), tool("Write"), tool("run_shell")],
    permissionMode: "allow_all" as const,
    resolvedWorkspaceRoot: workspace,
    signal,
    checkPermission: vi.fn(async () => true),
  };
}

const success = { finalAnswer: "完成。", finalState: { todoItems: [], uncertainEffects: [] }, terminated: false, rounds: 1,
  terminal: { status: "success" as const, externalEffectsMayContinue: false } };

/** 子任务通过与 Write 工具相同的文件访问边界写入。 */
function childWrite(context: ToolContext, relative: string, content: string): boolean {
  const access = resolveFileAccessPath(path.resolve(context.resolvedWorkspaceRoot!, relative), "write", context);
  if (!access.ok) return false;
  fs.writeFileSync(access.path, content);
  return true;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeConversationDatabases().catch(() => {});
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("task isolation=worktree", () => {
  it("runs writes inside the worktree, keeps the main workspace unchanged and returns a diff summary", async () => {
    const repo = createRepo();
    const contexts: ToolContext[] = [];
    let systemPrompt = "";
    const runHarness = vi.fn(async (input: any) => {
      contexts.push(input.toolContext);
      systemPrompt = input.promptLayers.stablePrefix;
      expect(childWrite(input.toolContext, "README.md", "from task\n")).toBe(true);
      // 绝对路径指向主工作区：即使完全访问也被拒绝
      expect(childWrite(input.toolContext, path.join(repo, "README.md"), "escape\n")).toBe(false);
      return success;
    });
    const execute = createTaskExecutor({ parent: parentFor(repo), store: createStore(), runHarness,
      characterPool: new TaskCharacterLeasePool(), worktrees: createTaskWorktreeManager() });

    const result = await execute({ description: "隔离修改", prompt: "改 README", subagentType: "general", companionId: "风堇", isolation: "worktree" });

    const worktreePath = path.join(repo, ".cyrene", "worktrees", result.taskId);
    expect(contexts[0]).toMatchObject({ resolvedWorkspaceRoot: worktreePath, writeRoot: worktreePath });
    expect(systemPrompt).toContain("独立 git worktree");
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("hello\n");
    expect(fs.readFileSync(path.join(worktreePath, "README.md"), "utf8")).toBe("from task\n");
    expect(result.worktree).toMatchObject({ kind: "retained", branch: `cyrene/task-${result.taskId}`, worktreePath, uncommitted: true });
    expect(result.worktree?.diffStat).toContain("README.md");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("deletes the worktree and branch automatically when nothing changed", async () => {
    const repo = createRepo();
    const execute = createTaskExecutor({ parent: parentFor(repo), store: createStore(), runHarness: vi.fn(async () => success),
      characterPool: new TaskCharacterLeasePool(), worktrees: createTaskWorktreeManager() });

    const result = await execute({ description: "只看看", prompt: "检查", subagentType: "general", companionId: "风堇", isolation: "worktree" });

    expect(result.worktree?.kind).toBe("removed");
    expect(fs.existsSync(path.join(repo, ".cyrene", "worktrees", result.taskId))).toBe(false);
    expect(git(repo, "branch", "--list", "cyrene/*").trim()).toBe("");
  });

  it("runs isolated write tasks in parallel", async () => {
    const repo = createRepo();
    let running = 0;
    let peak = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    const runHarness = vi.fn(async (input: any) => {
      running++;
      peak = Math.max(peak, running);
      if (running === 2) release();
      await bothStarted;
      childWrite(input.toolContext, `${input.runId}.txt`, "x\n");
      running--;
      return success;
    });
    const execute = createTaskExecutor({ parent: parentFor(repo), store: createStore(), runHarness,
      characterPool: new TaskCharacterLeasePool(), worktrees: createTaskWorktreeManager() });

    const results = await Promise.all([
      execute({ description: "方案一", prompt: "a", subagentType: "general", companionId: "风堇", isolation: "worktree" }),
      execute({ description: "方案二", prompt: "b", subagentType: "general", companionId: "遐蝶", isolation: "worktree" }),
    ]);

    expect(peak).toBe(2);
    expect(new Set(results.map((result) => result.worktree?.worktreePath)).size).toBe(2);
    expect(results.every((result) => result.worktree?.kind === "retained")).toBe(true);
    expect(fs.readdirSync(repo).filter((name) => name.endsWith(".txt"))).toEqual([]);

    const taskCall = (args: Record<string, unknown>) => ({ id: "c", name: "task", arguments: JSON.stringify(args) });
    expect(classifyToolExecutionMode(taskCall({ access_mode: "write", isolation: "worktree" }), [])).toBe("parallel");
    expect(classifyToolExecutionMode(taskCall({ access_mode: "write" }), [])).toBe("exclusive");
  });

  it("cleans a clean worktree on cancellation and keeps a dirty one", async () => {
    const repo = createRepo();
    const worktrees = createTaskWorktreeManager();
    const cancelled = { ...success, terminated: true, terminal: { status: "cancelled" as const, externalEffectsMayContinue: false } };

    const cleanAbort = new AbortController();
    const cleanResult = await createTaskExecutor({
      parent: parentFor(repo, cleanAbort.signal), store: createStore(), characterPool: new TaskCharacterLeasePool(), worktrees,
      runHarness: vi.fn(async () => { cleanAbort.abort(); return cancelled; }),
    })({ description: "取消干净", prompt: "x", subagentType: "general", companionId: "风堇", isolation: "worktree" });
    expect(cleanResult.status).toBe("cancelled");
    expect(cleanResult.worktree?.kind).toBe("removed");

    const dirtyAbort = new AbortController();
    const dirtyExecute = createTaskExecutor({
      parent: parentFor(repo, dirtyAbort.signal), store: createStore(), characterPool: new TaskCharacterLeasePool(), worktrees,
      runHarness: vi.fn(async (input: any) => {
        childWrite(input.toolContext, "wip.txt", "half done\n");
        dirtyAbort.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }),
    });
    const failure = await dirtyExecute({ description: "取消有改动", prompt: "x", subagentType: "general", companionId: "风堇", isolation: "worktree" })
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("隔离 worktree 已保留");
    const kept = (await worktrees.list(repo)).find((record) => record.state === "retained");
    expect(kept && fs.readFileSync(path.join(kept.worktreePath, "wip.txt"), "utf8")).toBe("half done\n");
  });

  it("returns a clear tool error for non-git workspaces without creating a session", async () => {
    const plain = tempDir("cyrene-plain-ws-");
    const store = createStore();
    const runHarness = vi.fn(async () => success);
    const execute = createTaskExecutor({ parent: parentFor(plain), store, runHarness,
      characterPool: new TaskCharacterLeasePool(), worktrees: createTaskWorktreeManager() });

    const observation = await executeTask({ id: "call-1", name: "task", arguments: JSON.stringify({
      description: "隔离修改", prompt: "改", subagent_type: "general", companion_id: "风堇", isolation: "worktree",
    }) }, execute);

    expect(observation).toMatchObject({ outcome: "failure", category: "invalid_arguments" });
    expect(observation.message).toContain("不是 git 仓库");
    expect(runHarness).not.toHaveBeenCalled();
    expect(await store.listForParent("conversation-1")).toEqual([]);

    const invalid = await executeTask({ id: "call-2", name: "task", arguments: JSON.stringify({
      description: "隔离修改", prompt: "改", subagent_type: "general", companion_id: "风堇", isolation: "container",
    }) }, execute);
    expect(invalid).toMatchObject({ outcome: "failure", category: "invalid_arguments" });
  });
});
