// MCP Manager — 管理多个 MCP server 的生命周期、配置持久化、启动自动连接
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { connectMcpServer, disconnectMcpServer, getMcpServerStates, McpServerConfig } from "./mcp-adapter";
import { logger, LogTag } from "../logger";

const LOG_PREFIX = "[MCP Manager]";
let mutations: Promise<unknown> = Promise.resolve();
function mutate<T>(action: () => Promise<T>): Promise<T> {
  const next = mutations.then(action, action); mutations = next.catch(() => undefined); return next;
}


/** Validate before spawning a process or opening a remote connection. */
export function validateMcpConfig(config: McpServerConfig): void {
  if (!config || typeof config !== "object" || typeof config.id !== "string" || !/^[a-zA-Z0-9_-]{1,48}$/.test(config.id) || typeof config.name !== "string" || !config.name.trim()) throw new Error("MCP 名称或 ID 无效（ID 只能包含字母、数字、下划线和短横线）");
  if (!["stdio", "http", "sse"].includes(config.transport)) throw new Error("不支持的 MCP 连接类型");
  if (config.transport === "stdio") {
    if (typeof config.command !== "string" || !config.command.trim()) throw new Error("请填写 MCP 启动命令");
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== "string"))) throw new Error("MCP args 必须是字符串数组");
    if (config.cwd !== undefined && (typeof config.cwd !== "string" || !path.isAbsolute(config.cwd) || !fs.statSync(config.cwd).isDirectory())) throw new Error("MCP 工作目录必须是服务器上的绝对目录");
  } else {
    const url = new URL(config.url || "");
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("MCP URL 必须使用 HTTP 或 HTTPS");
  }
  for (const record of [config.env, config.headers]) {
    if (record !== undefined && (!record || typeof record !== "object" || Array.isArray(record) || Object.values(record).some(value => typeof value !== "string"))) throw new Error("MCP 环境变量和请求头必须是字符串对象");
  }
  if (config.effectKindOverrides && Object.values(config.effectKindOverrides).some(value => !["read", "mutation", "verification", "external_side_effect", "unknown"].includes(value))) throw new Error("MCP 工具 effectKind 无效");
}

function getConfigPath(): string {
  const userDataPath = app.getPath("userData");
  return path.join(userDataPath, "mcp-servers.json");
}

function loadConfigs(): McpServerConfig[] {
  try {
    const raw = fs.readFileSync(getConfigPath(), "utf-8");
    const configs = JSON.parse(raw);
    if (Array.isArray(configs)) {
      logger.info(LogTag.MCP, `loaded ${configs.length} MCP server configs`);
      return configs;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(LOG_PREFIX, "读取配置失败:", (err as Error).message);
    }
  }
  return [];
}

function saveConfigs(configs: McpServerConfig[]): void {
  try {
    const dir = path.dirname(getConfigPath());
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const temporary = getConfigPath() + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(configs, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temporary, getConfigPath());
    if (process.platform !== "win32") fs.chmodSync(getConfigPath(), 0o600);
    console.log(LOG_PREFIX, "已保存 " + configs.length + " 个 MCP server 配置");
  } catch (err) {
    console.error(LOG_PREFIX, "保存配置失败:", (err as Error).message);
    throw err;
  }
}

/**
 * 一次性清理已下架的内置 MCP server 配置（id 白名单模式）。
 * 幂等：条目不存在时不报错、不写盘。
 * 只删除传入的固定 id，不会误删用户自定义 MCP。
 * 返回被实际移除的 id 列表（用于日志）。
 */
export async function pruneMcpServersByIds(serverIds: string[]): Promise<string[]> {
  const configs = loadConfigs();
  const removed: string[] = [];
  const kept = configs.filter((c) => {
    if (serverIds.includes(c.id)) {
      removed.push(c.id);
      return false;
    }
    return true;
  });
  if (removed.length > 0) {
    saveConfigs(kept);
  }
  // 如果有已连接的实例也断开（启动期通常还没连，但如果早期注册过会存在）
  for (const id of removed) {
    try {
      await disconnectMcpServer(id);
    } catch {
      // ignore
    }
  }
  return removed;
}

/**
 * 启动时自动连接所有已保存的 MCP server。
 * 支持 AbortSignal 协作取消：退出（或恢复屏障超时后放弃等待）时，
 * 未开始的连接不再启动；单个连接完成后若信号已中止，立即断开该连接，
 * 保证迟到的连接不残留为无所有者资源。
 */
export async function initMcpManager(options: { signal?: AbortSignal } = {}): Promise<void> {
  const signal = options.signal;
  logger.info(LogTag.MCP, "initializing MCP Manager...");
  const configs = loadConfigs();

  if (configs.length === 0) {
    logger.info(LogTag.MCP, "no MCP servers configured, skipping");
    return;
  }

  let connected = 0;
  let failed = 0;

  for (const config of configs) {
    if (signal?.aborted) {
      console.log(LOG_PREFIX, "restore aborted, remaining servers skipped:", config.name);
      break;
    }
    try {
      validateMcpConfig(config);
      await mutate(() => signal ? connectMcpServer(config, { signal }) : connectMcpServer(config));
      connected++;
      // 连接完成后再核对一次信号：退出中则立刻断开这条迟到连接
      if (signal?.aborted) {
        try {
          await disconnectMcpServer(config.id);
        } catch {
          // ignore
        }
        console.log(LOG_PREFIX, "late connection disconnected after abort:", config.name);
      }
    } catch (err) {
      failed++;
      console.error(LOG_PREFIX, "自动连接失败 [" + config.name + "]:", (err as Error).message);
    }
  }

  console.log(LOG_PREFIX, "初始化完成: " + connected + " 个成功, " + failed + " 个失败");
}

/**
 * 添加一个新的 MCP server 配置，连接并持久化。
 */
export async function addMcpServer(config: McpServerConfig): Promise<{
  ok: boolean;
  toolIds?: string[];
  error?: string;
}> {
  return mutate(async () => {
    try { validateMcpConfig(config); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    console.log(LOG_PREFIX, "添加 MCP server:", config.name);

    // 检查是否已存在
    const configs = loadConfigs();
    if (configs.some(c => c.id === config.id)) {
      return { ok: false, error: "已存在相同 ID 的 MCP server: " + config.id };
    }

    try {
      const toolIds = await connectMcpServer(config);
      const current = loadConfigs();
      if (!current.some(entry => entry.id === config.id)) current.push(config);
      saveConfigs(current);
      return { ok: true, toolIds };
    } catch (err) {
      await disconnectMcpServer(config.id);
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });
}

export async function reconnectMcpServer(serverId: string): Promise<{ ok: boolean; toolIds?: string[]; error?: string }> {
  return mutate(async () => {
    const config = loadConfigs().find(entry => entry.id === serverId);
    if (!config) return { ok: false, error: "MCP 配置不存在" };
    try { validateMcpConfig(config); await disconnectMcpServer(serverId); return { ok: true, toolIds: await connectMcpServer(config) }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  });
}

/**
 * 移除一个 MCP server，断开连接并持久化。
 *
 * 配置清理不依赖连接状态：历史上「配置存在但连接从未成功」的 server
 * （如 npx 不可用的场景）在 mcpServerStates 中没有记录，若因 disconnect
 * 失败而跳过配置清理，残留配置会导致后续 addMcpServer 报"已存在相同 ID"
 * 且永远无法修复。
 */
export async function removeMcpServer(serverId: string): Promise<{ ok: boolean; error?: string }> {
  return mutate(async () => {
    console.log(LOG_PREFIX, "移除 MCP server:", serverId);

    await disconnectMcpServer(serverId);

    const configs = loadConfigs().filter(c => c.id !== serverId);
    saveConfigs(configs);
    return { ok: true };
  });
}

/**
 * 获取所有 MCP server 的状态列表。
 */
export function listMcpServers(): Array<{
  id: string;
  name: string;
  connected: boolean;
  toolCount: number;
  toolIds: string[];
}> {
  return getMcpServerStates();
}

/**
 * 读取已持久化的 MCP server 配置（含连接失败、未连接的）。
 * 与 listMcpServers（仅运行时连接态）互补：内置 MCP 同步逻辑需要
 * 以配置文件为事实源，避免「配置存在但连接失败」被误判为不存在。
 */
export function listMcpServerConfigs(): McpServerConfig[] {
  return loadConfigs();
}
