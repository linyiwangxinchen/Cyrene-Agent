import type { ToolDefinition } from "../orchestrator/tools/registry/tool-registry";
import type { ScheduledTask } from "./types";

export function filterToolsForTask(task: ScheduledTask, allTools: ToolDefinition[]): ToolDefinition[] {
  const enabledTools = allTools.filter(tool => tool.enabled && !tool.deprecated);
  if (task.toolMode === "all-enabled") return enabledTools;
  const allowed = new Set(task.allowedToolIds);
  return enabledTools.filter(tool => allowed.has(tool.id));
}
