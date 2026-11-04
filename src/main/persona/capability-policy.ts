import type { CompanionPermissions } from "../../shared/companion";
import type { ToolRiskLevel } from "../../shared/permission-approval";
import type { ToolEffectKind } from "../orchestrator/tools/registry/tool-registry";

/** An additional restriction, never an elevation of existing filesystem/OS grants. */
export function companionToolPolicy(profile: CompanionPermissions, input: {
  toolId: string; risk: ToolRiskLevel; effect?: ToolEffectKind;
}): "inherit" | "deny" | "ask" {
  if (profile.paused || profile.deniedTools.includes(input.toolId)) return "deny";
  const read = input.effect === "read";
  if (profile.preset === "companion" && !(read && input.risk === "safe")) return "deny";
  if (profile.preset === "basic" && !(read && ["safe", "fs-read", "network"].includes(input.risk))) return "deny";
  if (profile.preset === "shared_life" && (!read && !(input.effect === "mutation" && input.risk === "fs-write"))) return "ask";
  if (profile.preset === "full" && !read) return "ask";
  if (profile.confirmTools.includes(input.toolId)) return "ask";
  return "inherit";
}
