/**
 * 按需加载工具（deferred tools）的运行期状态与 tool_search 内置工具。
 *
 * - 延迟工具在系统提示的目录里只列名字和一句话用途；完整 JSON Schema 不随请求发送。
 * - 模型调用 tool_search（select:精确选择 / 关键词搜索）把工具加入本次运行的已加载集合，
 *   下一次模型请求起这些工具的完整规格会附在工具清单末尾，之后即可直接调用。
 * - 已加载集合挂在 HarnessRun 上，压缩只替换消息、不影响它；新运行（含中断恢复）
 *   从历史中的 tool_search 结果和既往工具调用重建，保证续跑时不丢失。
 * - tool_search 只在本次运行 capabilities 允许的工具中检索，不能扩大权限；
 *   加载后的执行仍走原有权限检查、计划只读限制与模式过滤。
 */

import type { ChatMessage, ToolCall, ToolSpec } from "../vendors/types";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import type { ToolObservation } from "./types";
import { parseToolCallArgs } from "./types";

export const TOOL_SEARCH_TOOL_ID = "tool_search";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 20;

export const toolSearchToolSpec: ToolSpec = {
  name: TOOL_SEARCH_TOOL_ID,
  description: [
    "加载「按需加载的工具」的完整参数定义。系统提示里「按需加载的工具」一节的工具只列出了名称和用途，必须先用本工具加载才能调用。",
    "query 两种写法：",
    "- `select:工具名,工具名`：按名称精确加载（已知道要用哪个工具时优先使用）；",
    "- 关键词（如 `邮件 发送`、`music playlist`）：按名称和用途搜索，加载最相关的若干个工具。",
    "加载结果在本次运行内持续有效；从下一次请求起即可直接调用这些工具，不要在加载的同一轮里调用它们。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "`select:名称,名称` 精确选择，或用空格分隔的关键词" },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RESULTS_LIMIT,
        default: DEFAULT_MAX_RESULTS,
        description: `关键词搜索时最多加载几个工具，默认 ${DEFAULT_MAX_RESULTS}`,
      },
    },
    required: ["query"],
  },
};

/**
 * 单次运行的延迟工具状态。
 * visible 是"当前这次模型请求能看到完整规格的已加载工具"快照：
 * 同一轮里先 tool_search 再调用目标工具时，模型发起调用时并没有看到参数定义，
 * 因此按请求时的快照拒绝，要求下一轮再调用。
 */
export class DeferredToolState {
  private readonly deferred: ReadonlySet<string>;
  private readonly loaded: string[] = [];
  private visible = new Set<string>();

  constructor(deferredToolIds: Iterable<string>) {
    this.deferred = new Set(deferredToolIds);
  }

  get active(): boolean {
    return this.deferred.size > 0;
  }

  isDeferred(toolId: string): boolean {
    return this.deferred.has(toolId);
  }

  isLoaded(toolId: string): boolean {
    return this.loaded.includes(toolId);
  }

  /** 按加载顺序返回已加载的延迟工具。 */
  loadedIds(): readonly string[] {
    return this.loaded;
  }

  /** 加载工具；只接受延迟集合内的 ID，返回本次新增的 ID。 */
  load(toolIds: Iterable<string>): string[] {
    const added: string[] = [];
    for (const id of toolIds) {
      if (!this.deferred.has(id) || this.loaded.includes(id)) continue;
      this.loaded.push(id);
      added.push(id);
    }
    return added;
  }

  /** 每次模型请求前固化本次请求可见的已加载集合。 */
  commitVisible(): void {
    this.visible = new Set(this.loaded);
  }

  /** 非延迟工具总是可调用；延迟工具必须在本次请求发出前已加载。 */
  isCallable(toolId: string): boolean {
    return !this.deferred.has(toolId) || this.visible.has(toolId);
  }
}

/**
 * 从历史消息重建已加载集合：成功的 tool_search 结果与既往对延迟工具的调用。
 * 只返回延迟集合内的 ID，按首次出现顺序排列。
 */
export function collectLoadedToolIdsFromHistory(
  messages: readonly ChatMessage[],
  deferredToolIds: ReadonlySet<string>,
): string[] {
  const found: string[] = [];
  const add = (id: unknown) => {
    if (typeof id === "string" && deferredToolIds.has(id) && !found.includes(id)) found.push(id);
  };
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        if (call.name !== TOOL_SEARCH_TOOL_ID) add(call.name);
      }
      continue;
    }
    if (message.role !== "tool" || message.name !== TOOL_SEARCH_TOOL_ID) continue;
    for (const id of parseLoadedIdsFromResult(message.content)) add(id);
  }
  return found;
}

function parseLoadedIdsFromResult(content: ChatMessage["content"]): string[] {
  if (typeof content !== "string") return [];
  try {
    const observation = JSON.parse(content) as { outcome?: unknown; output?: unknown };
    if (observation.outcome !== "success" || typeof observation.output !== "string") return [];
    const output = JSON.parse(observation.output) as { loaded?: unknown };
    return Array.isArray(output.loaded) ? output.loaded.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function toolHint(tool: ToolDefinition): string {
  const hint = tool.catalogHint?.trim() || (tool.description ?? "").split("\n")[0]?.trim() || tool.description || "";
  return hint.length > 120 ? `${hint.slice(0, 120)}…` : hint;
}

/** 关键词打分：名称命中权重高于用途/描述命中；无命中返回 0。 */
function scoreTool(tool: ToolDefinition, terms: readonly string[]): number {
  const id = tool.id.toLowerCase();
  const idParts = id.split(/[_\-.]+/);
  const name = (tool.name ?? "").toLowerCase();
  const hint = (tool.catalogHint ?? "").toLowerCase();
  const description = (tool.description ?? "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (id === term) score += 12;
    else if (idParts.includes(term)) score += 8;
    else if (id.includes(term)) score += 5;
    if (name.includes(term)) score += 4;
    if (hint.includes(term)) score += 3;
    if (description.includes(term)) score += 2;
  }
  return score;
}

/**
 * 执行 tool_search。
 * 候选集合 = 本次运行允许的工具（tools）∩ 延迟集合；不在 tools 中的名称一律视为不可用，
 * 不透露其是否存在于全局注册表。
 */
export function executeToolSearch(
  call: ToolCall,
  state: DeferredToolState | undefined,
  tools: readonly ToolDefinition[],
): ToolObservation {
  if (!state?.active) {
    return {
      outcome: "failure",
      category: "not_found",
      tool: TOOL_SEARCH_TOOL_ID,
      message: "当前运行的所有工具都已完整加载，可以直接调用，无需 tool_search。",
    };
  }
  const args = parseToolCallArgs(call);
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return {
      outcome: "failure",
      category: "invalid_arguments",
      tool: TOOL_SEARCH_TOOL_ID,
      message: "tool_search 需要非空 query：`select:名称,名称` 或关键词。",
    };
  }
  const rawMax = args.max_results;
  const maxResults = typeof rawMax === "number" && Number.isInteger(rawMax)
    ? Math.max(1, Math.min(MAX_RESULTS_LIMIT, rawMax))
    : DEFAULT_MAX_RESULTS;

  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const selected: ToolDefinition[] = [];
  const alreadyAvailable: string[] = [];
  const notFound: string[] = [];

  const selectMatch = /^select\s*:/i.exec(query);
  if (selectMatch) {
    const names = [...new Set(query.slice(selectMatch[0].length).split(/[,，、\s]+/).map((name) => name.trim()).filter(Boolean))];
    for (const name of names) {
      const tool = byId.get(name);
      if (!tool) notFound.push(name);
      else if (!state.isDeferred(name)) alreadyAvailable.push(name);
      else selected.push(tool);
    }
  } else {
    const terms = [...new Set(query.toLowerCase().split(/[\s,，、]+/).filter(Boolean))];
    const ranked = tools
      .filter((tool) => state.isDeferred(tool.id))
      .map((tool) => ({ tool, score: scoreTool(tool, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.tool.id.localeCompare(right.tool.id))
      .slice(0, maxResults);
    selected.push(...ranked.map((entry) => entry.tool));
    for (const term of terms) {
      if (byId.has(term) && !state.isDeferred(term)) alreadyAvailable.push(term);
    }
  }

  const newlyLoaded = state.load(selected.map((tool) => tool.id));
  const loaded = selected.map((tool) => tool.id);
  const lines: string[] = [];
  if (loaded.length > 0) {
    lines.push(`已加载 ${loaded.length} 个工具，从下一次请求起可直接调用：`);
    for (const tool of selected) {
      lines.push(`- ${tool.id}：${toolHint(tool)}${newlyLoaded.includes(tool.id) ? "" : "（此前已加载）"}`);
    }
  } else {
    lines.push(selectMatch
      ? "没有加载任何工具。"
      : "没有找到匹配的按需加载工具。可以换用其他关键词，或按目录中的名称使用 `select:名称`。");
  }
  if (alreadyAvailable.length > 0) lines.push(`以下工具本来就已完整加载，可直接调用：${alreadyAvailable.join("、")}`);
  if (notFound.length > 0) lines.push(`以下名称不在本次运行可用的工具中：${notFound.join("、")}`);

  return {
    outcome: "success",
    tool: TOOL_SEARCH_TOOL_ID,
    message: lines.join("\n"),
    output: JSON.stringify({ loaded, alreadyAvailable, notFound }),
  };
}
