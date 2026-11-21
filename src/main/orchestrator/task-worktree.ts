/**
 * 子任务隔离 worktree：为 `task(isolation: "worktree")` 在 `<仓库>/.cyrene/worktrees/<taskId>`
 * 创建基于当前 HEAD 的独立分支 worktree，子任务结束后无改动自动清理，有改动保留给主代理审阅。
 *
 * 不变量：
 * - 只删除可证明没有改动的 worktree（工作区干净且 HEAD 仍等于基线提交），任何不确定都保留。
 * - 每个 worktree 旁有一份清单 `<taskId>.json`；进程崩溃后由下一次隔离子任务识别遗留并列出。
 * - 同一仓库的 git 管理操作（add/remove/branch -D）串行，避免并发写 `.git` 锁文件。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "./tools/registry/tool-registry";

export const TASK_WORKTREE_BRANCH_PREFIX = "cyrene/task-";
const WORKTREE_DIR_SEGMENTS = [".cyrene", "worktrees"] as const;
const EXCLUDE_PATTERN = "/.cyrene/worktrees/";
const DIFF_STAT_LIMIT = 4_000;
const FILE_LIST_LIMIT = 200;

export type TaskIsolation = "worktree";

export interface GitInvocation {
  command: string;
  env?: NodeJS.ProcessEnv;
}

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export class TaskIsolationError extends Error {
  constructor(readonly code: "TASK_WORKTREE_NO_WORKSPACE" | "TASK_WORKTREE_NOT_GIT" | "TASK_WORKTREE_BUSY" | "TASK_WORKTREE_FAILED", message: string) {
    super(message);
    this.name = "TaskIsolationError";
  }
}

export function isTaskIsolationError(error: unknown): error is TaskIsolationError {
  return error instanceof TaskIsolationError;
}

export interface TaskWorktreeRecord {
  schemaVersion: 1;
  taskId: string;
  branch: string;
  worktreePath: string;
  baseCommit: string;
  createdAt: number;
  updatedAt: number;
  /** active：某个进程正在使用；retained：有改动或无法确认干净，等待主代理处理。 */
  state: "active" | "retained";
  /** 写入 active 的进程实例；与当前进程不同即为遗留（崩溃或强退）。 */
  ownerId?: string;
  /** 进程异常退出后由恢复流程标记。 */
  interrupted?: boolean;
  diffStat?: string;
}

export interface TaskWorktreeHandle {
  taskId: string;
  repoRoot: string;
  worktreePath: string;
  /** 子任务的工作区根：主工作区在仓库中的相对位置映射到 worktree 内。 */
  workspaceRoot: string;
  mainWorkspaceRoot: string;
  branch: string;
  baseCommit: string;
  reused: boolean;
  /** 本仓库中其他被保留的子任务 worktree（含重启后识别的遗留）。 */
  retainedWorktrees: TaskWorktreeSummary[];
}

export interface TaskWorktreeSummary {
  taskId: string;
  branch: string;
  worktreePath: string;
  interrupted?: boolean;
  diffStat?: string;
}

export interface TaskWorktreeOutcome {
  kind: "removed" | "retained";
  branch: string;
  worktreePath: string;
  baseCommit: string;
  headCommit?: string;
  commitsAhead: number;
  /** 工作区内尚未提交的改动（含未跟踪文件）。 */
  uncommitted: boolean;
  /** `git diff --stat <base>`（已提交 + 未提交的已跟踪文件改动）。 */
  diffStat: string;
  changedFiles: string[];
  untrackedFiles: string[];
  /** 清理失败或状态无法确认时的说明；此时一律保留。 */
  note?: string;
}

export interface TaskWorktreeManagerOptions {
  resolveGit?: () => Promise<GitInvocation | null>;
  now?: () => number;
  /** 进程实例标识；测试可注入以模拟重启。 */
  ownerId?: string;
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function realPath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text;
}

function lines(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

function createGitRunner(resolveGit: () => Promise<GitInvocation | null>): GitRunner {
  return async (args, cwd) => {
    const git = await resolveGit();
    if (!git) throw new TaskIsolationError("TASK_WORKTREE_FAILED", "未找到可用的 git，无法使用 worktree 隔离");
    return new Promise<string>((resolve, reject) => {
      execFile(git.command, args, {
        cwd,
        env: { ...(git.env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60_000,
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args.join(" ")} 失败：${String(stderr || error.message).trim()}`));
          return;
        }
        resolve(String(stdout));
      });
    });
  };
}

/** 子任务 shell 不允许推送：匹配 `git ... push`（含 `git -C x push`），宁可误拒。 */
const GIT_PUSH_PATTERN = /(?:^|[\s;&|()`"'])git(?:\.exe)?(?=[\s"'])[^\n;&|]*?\spush(?:$|[\s;&|"'])/i;

export function isGitPushCommand(command: string): boolean {
  return GIT_PUSH_PATTERN.test(` ${command} `);
}
export interface TaskWorktreeManager {
  /** 校验主工作区是 git 仓库；否则抛出 TaskIsolationError。 */
  resolveRepository(workspaceRoot: string | undefined): Promise<{ repoRoot: string; relative: string; mainWorkspaceRoot: string }>;
  acquire(input: { workspaceRoot: string | undefined; taskId: string }): Promise<TaskWorktreeHandle>;
  finalize(handle: TaskWorktreeHandle): Promise<TaskWorktreeOutcome>;
  /** 列出仓库中的子任务 worktree 清单（不修改任何状态）。 */
  list(workspaceRoot: string): Promise<TaskWorktreeRecord[]>;
}

export function createTaskWorktreeManager(options: TaskWorktreeManagerOptions = {}): TaskWorktreeManager {
  const git = createGitRunner(options.resolveGit ?? (async () => ({ command: "git" })));
  const now = options.now ?? Date.now;
  const ownerId = options.ownerId ?? randomUUID();
  const active = new Set<string>();
  const repoLocks = new Map<string, Promise<unknown>>();

  const withRepoLock = <T>(repoRoot: string, work: () => Promise<T>): Promise<T> => {
    const key = process.platform === "win32" ? repoRoot.toLowerCase() : repoRoot;
    const previous = repoLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    repoLocks.set(key, next.catch(() => undefined));
    return next;
  };

  const worktreesDir = (repoRoot: string) => path.join(repoRoot, ...WORKTREE_DIR_SEGMENTS);
  const manifestPath = (repoRoot: string, taskId: string) => path.join(worktreesDir(repoRoot), `${taskId}.json`);

  const readRecord = (file: string): TaskWorktreeRecord | null => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as TaskWorktreeRecord;
      return parsed?.schemaVersion === 1 && typeof parsed.taskId === "string" ? parsed : null;
    } catch {
      return null;
    }
  };
  const writeRecord = (repoRoot: string, record: TaskWorktreeRecord): void => {
    fs.mkdirSync(worktreesDir(repoRoot), { recursive: true });
    const file = manifestPath(repoRoot, record.taskId);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record, null, 2), "utf8");
    fs.renameSync(temp, file);
  };
  const listRecords = (repoRoot: string): TaskWorktreeRecord[] => {
    let names: string[];
    try {
      names = fs.readdirSync(worktreesDir(repoRoot));
    } catch {
      return [];
    }
    return names.filter((name) => name.endsWith(".json"))
      .map((name) => readRecord(path.join(worktreesDir(repoRoot), name)))
      .filter((record): record is TaskWorktreeRecord => record !== null);
  };

  const resolveRepository: TaskWorktreeManager["resolveRepository"] = async (workspaceRoot) => {
    if (!workspaceRoot) {
      throw new TaskIsolationError("TASK_WORKTREE_NO_WORKSPACE", "isolation=worktree 需要主运行绑定 git 仓库工作区；当前没有绑定工作目录。请去掉 isolation 或先绑定仓库工作区。");
    }
    const mainWorkspaceRoot = realPath(workspaceRoot);
    let topLevel: string;
    try {
      topLevel = (await git(["rev-parse", "--show-toplevel"], mainWorkspaceRoot)).trim();
    } catch (error) {
      if (isTaskIsolationError(error)) throw error;
      topLevel = "";
    }
    if (!topLevel) {
      throw new TaskIsolationError("TASK_WORKTREE_NOT_GIT", `isolation=worktree 需要 git 仓库工作区；当前工作区不是 git 仓库：${mainWorkspaceRoot}`);
    }
    const repoRoot = realPath(topLevel);
    const relative = path.relative(repoRoot, mainWorkspaceRoot);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new TaskIsolationError("TASK_WORKTREE_NOT_GIT", `无法确定工作区在仓库中的位置：${mainWorkspaceRoot}`);
    }
    return { repoRoot, relative, mainWorkspaceRoot };
  };

  const ensureExcluded = async (repoRoot: string): Promise<void> => {
    try {
      const commonDir = (await git(["rev-parse", "--git-common-dir"], repoRoot)).trim();
      const excludeFile = path.join(path.resolve(repoRoot, commonDir), "info", "exclude");
      const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
      if (current.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_PATTERN)) return;
      fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
      fs.appendFileSync(excludeFile, `${current && !current.endsWith("\n") ? "\n" : ""}${EXCLUDE_PATTERN}\n`, "utf8");
    } catch (error) {
      // 忽略规则只影响主工作区 git status 的展示，不影响隔离本身。
      console.warn("[TaskWorktree] 写入 info/exclude 失败:", error);
    }
  };

  const inspect = async (record: Pick<TaskWorktreeRecord, "worktreePath" | "baseCommit">) => {
    const status = await git(["status", "--porcelain=v1", "--untracked-files=all"], record.worktreePath);
    const headCommit = (await git(["rev-parse", "HEAD"], record.worktreePath)).trim();
    const commitsAhead = Number.parseInt((await git(["rev-list", "--count", `${record.baseCommit}..HEAD`], record.worktreePath)).trim(), 10) || 0;
    const diffStat = (await git(["diff", "--stat", record.baseCommit], record.worktreePath)).trim();
    const changedFiles = lines(await git(["diff", "--name-status", record.baseCommit], record.worktreePath));
    const untrackedFiles = lines(await git(["ls-files", "--others", "--exclude-standard"], record.worktreePath));
    const uncommitted = lines(status).length > 0;
    return {
      headCommit,
      commitsAhead,
      uncommitted,
      diffStat: truncate(diffStat, DIFF_STAT_LIMIT),
      changedFiles: changedFiles.slice(0, FILE_LIST_LIMIT),
      untrackedFiles: untrackedFiles.slice(0, FILE_LIST_LIMIT),
      hasChanges: uncommitted || headCommit !== record.baseCommit,
    };
  };

  /** 只在调用方已证明无改动后调用；失败时抛错，由调用方转为保留。 */
  const removeWorktree = async (repoRoot: string, record: TaskWorktreeRecord): Promise<void> => {
    try {
      await git(["worktree", "remove", "--force", record.worktreePath], repoRoot);
    } catch (error) {
      // Windows 下文件占用等原因可能导致 git 删除失败；目录已不存在时只需 prune。
      if (fs.existsSync(record.worktreePath)) throw error;
    }
    await git(["worktree", "prune"], repoRoot).catch(() => undefined);
    const branches = await git(["branch", "--list", record.branch], repoRoot).catch(() => "");
    if (branches.trim()) await git(["branch", "-D", record.branch], repoRoot);
    fs.rmSync(manifestPath(repoRoot, record.taskId), { force: true });
  };

  /** 识别其他进程留下的 active 清单：干净则清理，有改动则标记 interrupted 并保留。 */
  const recoverStale = async (repoRoot: string, exceptTaskId: string): Promise<TaskWorktreeSummary[]> => {
    const retained: TaskWorktreeSummary[] = [];
    for (const record of listRecords(repoRoot)) {
      if (record.taskId === exceptTaskId || active.has(record.taskId)) continue;
      let current = record;
      if (record.state === "active" && record.ownerId !== ownerId) {
        if (!fs.existsSync(record.worktreePath)) {
          // worktree 目录已被外部删除：分支仍有提交则保留记录，否则清除清单。
          const branchExists = (await git(["branch", "--list", record.branch], repoRoot).catch(() => "x")).trim() !== "";
          const ahead = branchExists
            ? await git(["rev-list", "--count", `${record.baseCommit}..${record.branch}`], repoRoot).catch(() => "")
            : "0";
          if (ahead.trim() === "0") {
            await removeWorktree(repoRoot, record).catch(() => undefined);
            continue;
          }
          current = { ...record, state: "retained", interrupted: true, updatedAt: now() };
          writeRecord(repoRoot, current);
        } else {
          try {
            const state = await inspect(record);
            if (!state.hasChanges) {
              await removeWorktree(repoRoot, record);
              continue;
            }
            current = { ...record, state: "retained", interrupted: true, diffStat: state.diffStat, updatedAt: now() };
          } catch (error) {
            console.warn(`[TaskWorktree] 遗留 worktree 检查失败，保留：${record.worktreePath}`, error);
            current = { ...record, state: "retained", interrupted: true, updatedAt: now() };
          }
          writeRecord(repoRoot, current);
        }
        console.warn(`[TaskWorktree] 发现上次运行遗留的子任务 worktree（已保留）：${current.worktreePath} 分支 ${current.branch}`);
      }
      if (current.state === "retained") {
        retained.push({
          taskId: current.taskId,
          branch: current.branch,
          worktreePath: current.worktreePath,
          ...(current.interrupted ? { interrupted: true } : {}),
          ...(current.diffStat ? { diffStat: current.diffStat } : {}),
        });
      }
    }
    return retained;
  };

  const acquire: TaskWorktreeManager["acquire"] = async ({ workspaceRoot, taskId }) => {
    const { repoRoot, relative, mainWorkspaceRoot } = await resolveRepository(workspaceRoot);
    if (!/^[A-Za-z0-9._-]+$/.test(taskId)) {
      throw new TaskIsolationError("TASK_WORKTREE_FAILED", `子任务 ID 不能用作 worktree 名称：${taskId}`);
    }
    if (active.has(taskId)) {
      throw new TaskIsolationError("TASK_WORKTREE_BUSY", `子任务 ${taskId} 的 worktree 正在使用`);
    }
    active.add(taskId);
    try {
      return await withRepoLock(repoRoot, async () => {
        const retainedWorktrees = await recoverStale(repoRoot, taskId);
        const existing = readRecord(manifestPath(repoRoot, taskId));
        let record: TaskWorktreeRecord;
        let reused = false;
        if (existing && fs.existsSync(existing.worktreePath)) {
          // 恢复同一子任务：继续在保留的 worktree 上工作，不丢已有改动。
          record = { ...existing, state: "active", ownerId, interrupted: undefined, updatedAt: now() };
          reused = true;
        } else {
          await ensureExcluded(repoRoot);
          const worktreePath = path.join(worktreesDir(repoRoot), taskId);
          const branch = existing?.branch ?? `${TASK_WORKTREE_BRANCH_PREFIX}${taskId}`;
          if (fs.existsSync(worktreePath)) {
            throw new TaskIsolationError("TASK_WORKTREE_FAILED", `worktree 目录已存在但没有清单，拒绝覆盖：${worktreePath}`);
          }
          // 清单在、目录被删但分支仍在：重新挂载原分支，绝不重建或删除它。
          const branchExists = (await git(["branch", "--list", branch], repoRoot)).trim() !== "";
          const baseCommit = existing && branchExists ? existing.baseCommit : (await git(["rev-parse", "HEAD"], repoRoot)).trim();
          fs.mkdirSync(worktreesDir(repoRoot), { recursive: true });
          const timestamp = now();
          record = { schemaVersion: 1, taskId, branch, worktreePath, baseCommit, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp, state: "active", ownerId };
          // 先写清单再创建：创建中途崩溃时，下次恢复也能找到并清理。
          writeRecord(repoRoot, record);
          await git(["worktree", "prune"], repoRoot).catch(() => undefined);
          try {
            await git(branchExists ? ["worktree", "add", worktreePath, branch] : ["worktree", "add", "-b", branch, worktreePath, baseCommit], repoRoot);
          } catch (error) {
            if (!branchExists) await removeWorktree(repoRoot, record).catch(() => undefined);
            else writeRecord(repoRoot, { ...record, state: "retained", ownerId: undefined });
            throw new TaskIsolationError("TASK_WORKTREE_FAILED", `创建 worktree 失败：${error instanceof Error ? error.message : String(error)}`);
          }
          reused = branchExists;
        }
        writeRecord(repoRoot, record);
        const childRoot = path.join(record.worktreePath, relative);
        fs.mkdirSync(childRoot, { recursive: true });
        return {
          taskId,
          repoRoot,
          worktreePath: realPath(record.worktreePath),
          workspaceRoot: realPath(childRoot),
          mainWorkspaceRoot,
          branch: record.branch,
          baseCommit: record.baseCommit,
          reused,
          retainedWorktrees,
        };
      });
    } catch (error) {
      active.delete(taskId);
      throw error;
    }
  };

  const finalize: TaskWorktreeManager["finalize"] = async (handle) => {
    try {
      return await withRepoLock(handle.repoRoot, async () => {
        const record = readRecord(manifestPath(handle.repoRoot, handle.taskId)) ?? {
          schemaVersion: 1 as const, taskId: handle.taskId, branch: handle.branch, worktreePath: handle.worktreePath,
          baseCommit: handle.baseCommit, createdAt: now(), updatedAt: now(), state: "active" as const, ownerId,
        };
        const base = { branch: handle.branch, worktreePath: handle.worktreePath, baseCommit: handle.baseCommit };
        let state: Awaited<ReturnType<typeof inspect>>;
        try {
          state = await inspect(record);
        } catch (error) {
          writeRecord(handle.repoRoot, { ...record, state: "retained", ownerId: undefined, updatedAt: now() });
          return { ...base, kind: "retained" as const, commitsAhead: 0, uncommitted: false, diffStat: "", changedFiles: [], untrackedFiles: [],
            note: `无法确认 worktree 是否有改动，已保留：${error instanceof Error ? error.message : String(error)}` };
        }
        const outcome = {
          ...base,
          headCommit: state.headCommit,
          commitsAhead: state.commitsAhead,
          uncommitted: state.uncommitted,
          diffStat: state.diffStat,
          changedFiles: state.changedFiles,
          untrackedFiles: state.untrackedFiles,
        };
        if (!state.hasChanges) {
          try {
            await removeWorktree(handle.repoRoot, record);
            return { ...outcome, kind: "removed" as const };
          } catch (error) {
            writeRecord(handle.repoRoot, { ...record, state: "retained", ownerId: undefined, updatedAt: now() });
            return { ...outcome, kind: "retained" as const, note: `worktree 无改动但清理失败，已保留：${error instanceof Error ? error.message : String(error)}` };
          }
        }
        writeRecord(handle.repoRoot, { ...record, state: "retained", ownerId: undefined, diffStat: state.diffStat, updatedAt: now() });
        return { ...outcome, kind: "retained" as const };
      });
    } finally {
      active.delete(handle.taskId);
    }
  };

  const list: TaskWorktreeManager["list"] = async (workspaceRoot) => {
    const { repoRoot } = await resolveRepository(workspaceRoot);
    return listRecords(repoRoot);
  };

  return { resolveRepository, acquire, finalize, list };
}

let defaultManager: TaskWorktreeManager | undefined;

/** 进程级单例：active 集合与仓库锁必须跨 run 共享。首次调用的配置生效。 */
export function getTaskWorktreeManager(options?: TaskWorktreeManagerOptions): TaskWorktreeManager {
  defaultManager ??= createTaskWorktreeManager(options);
  return defaultManager;
}

/**
 * 把子任务工具收窄到 worktree 内：
 * - run_shell 的 cwd 必须在 worktree 内，且禁止 git push；
 * - 文件写入边界由 ToolContext.writeRoot 在 file-access 统一落实。
 */
export function isolateTaskTools(tools: ToolDefinition[], handle: Pick<TaskWorktreeHandle, "worktreePath" | "workspaceRoot">): ToolDefinition[] {
  return tools.map((tool) => {
    if (tool.id !== "run_shell") return tool;
    return {
      ...tool,
      execute: async (args, context) => {
        const command = String(args.command ?? "");
        if (isGitPushCommand(command)) {
          return JSON.stringify({ success: false, errorCode: "TASK_GIT_PUSH_FORBIDDEN", category: "permission_denied",
            error: "隔离子任务不允许 git push；改动保留在 worktree 分支上，由主代理决定是否合并或推送。" });
        }
        if (args.cwd !== undefined && args.cwd !== "") {
          const cwd = path.resolve(handle.workspaceRoot, String(args.cwd));
          if (!isWithin(realPath(cwd), handle.worktreePath)) {
            return JSON.stringify({ success: false, errorCode: "TASK_WORKTREE_CWD_OUTSIDE", category: "permission_denied",
              error: `隔离子任务的命令只能在 worktree 内执行：${handle.worktreePath}` });
          }
        }
        return tool.execute(args, context);
      },
    };
  });
}

/** 结果里给主代理看的摘要。 */
export function describeTaskWorktreeOutcome(outcome: TaskWorktreeOutcome): string {
  if (outcome.kind === "removed") return "隔离 worktree 无改动，已自动删除 worktree 和分支。";
  return [
    `隔离 worktree 已保留：分支 ${outcome.branch}，路径 ${outcome.worktreePath}，基线 ${outcome.baseCommit.slice(0, 12)}。`,
    `新提交 ${outcome.commitsAhead} 个；${outcome.uncommitted ? "有未提交改动" : "没有未提交改动"}。`,
    outcome.note ?? "",
    "改动不会自动合并；请审阅后决定合并（如在 worktree 提交后 git merge 该分支）或删除（git worktree remove + git branch -D）。",
  ].filter(Boolean).join("\n");
}
