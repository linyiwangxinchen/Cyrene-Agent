import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "", isPackaged: false } }));

import type { ToolDefinition } from "./tool-registry";
import {
  DEFAULT_TOOL_DEFERRAL_THRESHOLD,
  normalizeToolDeferralSettings,
  resolveDeferredToolIds,
} from "./tool-deferral";
import { buildToolSystemPrompt } from "../../system-prompt-builder";

function tool(id: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id,
    name: id,
    description: `${id} 的用途\n第二行详细说明`,
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    execute: async () => "",
    ...extra,
  };
}

const core = ["Read", "Write", "Edit", "Glob", "Grep", "run_shell", "git_status", "web_search", "invoke_skill"].map((id) => tool(id));
const extras = Array.from({ length: 30 }, (_, index) => tool(`mcp_extra_${String(index).padStart(2, "0")}`));

describe("resolveDeferredToolIds", () => {
  it("工具数不超过阈值时不启用延迟", () => {
    const tools = [...core, ...extras].slice(0, DEFAULT_TOOL_DEFERRAL_THRESHOLD);
    expect(resolveDeferredToolIds(tools)).toEqual([]);
  });

  it("超过阈值时常驻工具、搜索后端工具与浏览器控制工具不延迟，其余按原顺序延迟", () => {
    const tools = [
      ...core,
      tool("minimax-web-search-search"),
      tool("browser_control_start", { browserControlPhase: "entry" }),
      ...extras,
    ];
    expect(resolveDeferredToolIds(tools)).toEqual(extras.map((entry) => entry.id));
  });

  it("可配置：关闭、调整阈值与追加常驻工具", () => {
    const tools = [...core, ...extras];
    expect(resolveDeferredToolIds(tools, { enabled: false })).toEqual([]);
    expect(resolveDeferredToolIds(tools, { threshold: 100 })).toEqual([]);
    expect(resolveDeferredToolIds(tools, { alwaysLoadToolIds: ["mcp_extra_00"] })).not.toContain("mcp_extra_00");
  });

  it("规整用户配置时丢弃非法字段", () => {
    expect(normalizeToolDeferralSettings(undefined)).toBeUndefined();
    expect(normalizeToolDeferralSettings({ enabled: "yes", threshold: -1, alwaysLoadToolIds: [" a ", 3, "", "a"] }))
      .toEqual({ alwaysLoadToolIds: ["a"] });
    expect(normalizeToolDeferralSettings({ enabled: false, threshold: 12.7 })).toEqual({ enabled: false, threshold: 12 });
  });
});

describe("buildToolSystemPrompt 的按需加载目录", () => {
  const tools = [...core, ...extras];

  it("未传延迟划分时与原目录一致", () => {
    expect(buildToolSystemPrompt("work", tools, [])).toBe(buildToolSystemPrompt("work", tools));
    expect(buildToolSystemPrompt("work", tools)).not.toContain("按需加载的工具");
  });

  it("延迟工具只列名称和一句话用途，常驻工具保留完整目录条目", () => {
    const deferred = resolveDeferredToolIds(tools);
    const prompt = buildToolSystemPrompt("work", tools, deferred);
    const [loadedSection, deferredSection] = prompt.split("## 按需加载的工具");
    expect(loadedSection).toContain("- Read\n  用途：Read 的用途\n  风险：safe");
    expect(loadedSection).not.toContain("mcp_extra_00");
    expect(deferredSection).toContain("tool_search");
    expect(deferredSection).toContain("- mcp_extra_00：mcp_extra_00 的用途");
    expect(deferredSection).not.toContain("第二行详细说明");
    expect(deferredSection).not.toContain("风险：");
  });
});
