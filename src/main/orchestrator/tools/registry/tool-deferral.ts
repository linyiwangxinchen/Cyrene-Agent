// tool-deferral —— 按需加载工具（deferred tools）的划分规则。
//
// 设计原则：
// - 纯函数、无副作用：build-options（工具目录提示）与 harness（工具规格）共用同一份划分结果，
//   避免两边各算一次导致目录与实际规格不一致。
// - 划分只取决于本次运行的工具集合与配置，不取决于运行中已加载了哪些工具，
//   因此写进 stablePrefix 的目录文本在加载前后保持不变（提示缓存契约）。
// - 只决定"完整规格是否随每轮请求发送"，不改变权限：延迟工具仍是本次运行
//   capabilities 允许的工具，执行时照常走权限检查与计划只读限制。

import type { ToolDefinition } from "./tool-registry";

/** 用户可调的按需加载配置（general-settings.json 的 toolDeferral 字段）。 */
export interface ToolDeferralSettings {
  /** 总开关；默认开启。关闭后所有工具每轮都发送完整规格。 */
  enabled?: boolean;
  /** 本次运行的 registry 工具数不超过该值时不启用延迟；默认 30。 */
  threshold?: number;
  /** 在默认常驻列表之外追加总是完整加载的工具 ID。 */
  alwaysLoadToolIds?: string[];
}

export const DEFAULT_TOOL_DEFERRAL_THRESHOLD = 30;

/**
 * 默认常驻工具：文件读写编辑、搜索、shell、git_status、联网搜索与 Skill 加载。
 * Harness 内置工具（update_todo / ask_user / task / 计划模式工具等）不在 registry 中，
 * 本来就不参与延迟，始终完整加载。
 */
export const DEFAULT_ALWAYS_LOADED_TOOL_IDS: readonly string[] = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "read_file",
  "write_file",
  "list_dir",
  "glob",
  "str_replace",
  "multi_edit",
  "apply_patch",
  "search_text",
  "run_shell",
  "shell_job",
  "git_status",
  "git_diff",
  "web_search",
  "fetch_url",
  "invoke_skill",
  "read_skill_reference",
  "channel_send_file",
  // 私聊里随时可能用到的显式记忆
  "memory_remember",
  "memory_recall",
  "memory_forget",
];

/** 前缀匹配的常驻工具（当前搜索后端的 MiniMax 搜索工具）。 */
const DEFAULT_ALWAYS_LOADED_PREFIXES: readonly string[] = ["minimax-web-search-"];

/** 校验并规整用户配置；非法字段回落默认值。 */
export function normalizeToolDeferralSettings(raw: unknown): ToolDeferralSettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const result: ToolDeferralSettings = {};
  if (typeof input.enabled === "boolean") result.enabled = input.enabled;
  const threshold = typeof input.threshold === "number" ? input.threshold : Number.NaN;
  if (Number.isFinite(threshold) && threshold >= 0) result.threshold = Math.trunc(threshold);
  if (Array.isArray(input.alwaysLoadToolIds)) {
    const ids = input.alwaysLoadToolIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length) result.alwaysLoadToolIds = [...new Set(ids)];
  }
  return result;
}

function isAlwaysLoaded(tool: ToolDefinition, extra: ReadonlySet<string>): boolean {
  // 浏览器控制工具按控制阶段逐轮切换可见性，不能再叠加一层加载状态。
  if (tool.browserControlPhase) return true;
  if (extra.has(tool.id) || DEFAULT_ALWAYS_LOADED_TOOL_IDS.includes(tool.id)) return true;
  return DEFAULT_ALWAYS_LOADED_PREFIXES.some((prefix) => tool.id.startsWith(prefix));
}

/**
 * 计算本次运行需要延迟加载的工具 ID（保持原工具顺序）。
 * 工具数不超过阈值或开关关闭时返回空数组，行为与未引入延迟时完全一致。
 */
export function resolveDeferredToolIds(
  tools: ReadonlyArray<ToolDefinition>,
  settings?: ToolDeferralSettings,
): string[] {
  if (settings?.enabled === false) return [];
  const threshold = settings?.threshold ?? DEFAULT_TOOL_DEFERRAL_THRESHOLD;
  if (tools.length <= threshold) return [];
  const extra = new Set(settings?.alwaysLoadToolIds ?? []);
  return tools.filter((tool) => !isAlwaysLoaded(tool, extra)).map((tool) => tool.id);
}
