import { describe, expect, it } from "vitest";
import { companionToolPolicy } from "./capability-policy";
import type { CompanionPermissions } from "../../shared/companion";
const base: CompanionPermissions = { preset: "inherit", paused: false, deniedTools: [], confirmTools: [] };
describe("companion capability restriction", () => {
  it("never treats intimacy or full access as authorization", () => {
    expect(companionToolPolicy({ ...base, preset: "full" }, { toolId: "read_file", risk: "fs-read", effect: "read" })).toBe("inherit");
    expect(companionToolPolicy({ ...base, paused: true }, { toolId: "safe", risk: "safe", effect: "read" })).toBe("deny");
    expect(companionToolPolicy({ ...base, deniedTools: ["send"] }, { toolId: "send", risk: "network", effect: "external_side_effect" })).toBe("deny");
  });
  it("uses effects rather than misleading safe risk tags", () => {
    for (const preset of ["companion", "basic"] as const) {
      for (const effect of ["mutation", "unknown", "external_side_effect", "verification"] as const)
        expect(companionToolPolicy({ ...base, preset }, { toolId: "test", risk: "safe", effect })).toBe("deny");
    }
    expect(companionToolPolicy({ ...base, preset: "basic" }, { toolId: "read", risk: "fs-read", effect: "read" })).toBe("inherit");
    expect(companionToolPolicy({ ...base, preset: "shared_life" }, { toolId: "send", risk: "network", effect: "external_side_effect" })).toBe("ask");
    expect(companionToolPolicy({ ...base, confirmTools: ["read"] }, { toolId: "read", risk: "safe", effect: "read" })).toBe("ask");
  });
});
