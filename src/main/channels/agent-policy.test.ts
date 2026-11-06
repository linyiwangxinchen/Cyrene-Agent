import { describe, expect, it, vi } from "vitest";
import type { CyreneRunOptions } from "../orchestrator/cyrene-agent";
import { enforceChannelAgentPolicy, resolveChannelAgentPolicy } from "./agent-policy";

describe("mobile channel agent policy", () => {
  it("routes off through ChatLoop without tools", () => {
    expect(resolveChannelAgentPolicy("off")).toEqual({
      executionMode: "chat",
      exposeTools: false,
      includeInteractiveTools: false,
      permissionMode: "normal",
      allowPermissionPrompt: false,
      bypassCompanionApproval: false,
    });
  });

  it("routes all through CyreneHarness without Ask or approval", () => {
    expect(resolveChannelAgentPolicy("all")).toEqual({
      executionMode: "work",
      exposeTools: true,
      includeInteractiveTools: false,
      permissionMode: "allow_all",
      allowPermissionPrompt: false,
      bypassCompanionApproval: true,
    });
  });

  it("always disables tools for QQ group chats", () => {
    const policy = resolveChannelAgentPolicy("all", { channel: "qq", chatType: "group" });
    expect(policy).toEqual({
      executionMode: "chat",
      exposeTools: false,
      includeInteractiveTools: false,
      permissionMode: "normal",
      allowPermissionPrompt: false,
      bypassCompanionApproval: false,
    });

    const options = {
      tools: [{ id: "shell" }],
      toolSystemContent: "TOOL CATALOG",
      skillLayerContent: "SKILL CATALOG",
      capabilities: {
        mode: "chat",
        tools: [{ id: "shell" }],
        toolIds: new Set(["shell"]),
        skills: [],
        skillIds: new Set<string>(),
      },
    } as unknown as CyreneRunOptions;
    enforceChannelAgentPolicy(options, policy);
    expect(options.tools).toEqual([]);
    expect(options.toolSystemContent).toBe("");
    expect(options.skillLayerContent).toBe("");
    expect(options.capabilities?.tools).toEqual([]);
    expect(options.capabilities?.toolIds.size).toBe(0);
  });

  it("removes the Web approval callback for background channel execution", () => {
    const options = {
      requestUserClarification: vi.fn(),
      harnessInteractiveTools: true,
      permissionMode: "normal",
      allowPermissionPrompt: true,
      bypassCompanionApproval: false,
    } as unknown as CyreneRunOptions;
    enforceChannelAgentPolicy(options, resolveChannelAgentPolicy("all", { channel: "wechat", chatType: "private" }));
    expect(options).toMatchObject({
      harnessInteractiveTools: false,
      permissionMode: "allow_all",
      allowPermissionPrompt: false,
      bypassCompanionApproval: true,
    });
    expect(options.requestUserClarification).toBeUndefined();
  });
});
