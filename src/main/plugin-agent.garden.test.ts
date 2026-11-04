import { describe, expect, it, vi } from "vitest";
import { createPluginAgentRunner } from "./plugin-agent";
vi.mock("./permission", () => ({ checkPermission: vi.fn(async () => ({ allowed: true })) }));

describe("原生内容插件的共享人格与工具策略", () => {
  it("沿用 Chat 人格、档案和动态上下文，不注入 Minecraft 或原全局工具清单", async () => {
    const buildOptions = vi.fn(async () => ({ options: {
      settings: { provider: "fixture", model: "fixture", baseUrl: "https://example.test", apiKey: "test" },
      soulSystemBaseContent: "用户修改过的昔涟人格", soulRuntimeContext: "共享关系上下文", messages: [],
    } }));
    const runHarness = vi.fn(async (input: any) => {
      expect(await input.checkPermission("bili-garden_send", {})).toBe(false);
      expect(await input.checkPermission("bili-garden_read", {})).toBe(true);
      input.onModelUsage({ input: 100, output: 8, cachedInput: 80 });
      input.onModelUsage({ input: 120, output: 9 });
      return { finalAnswer: "一起看吧", rounds: 2, finalState: { uncertainEffects: [] } };
    });
    const run = createPluginAgentRunner({ pluginId: "bili-garden", pluginSignal: new AbortController().signal,
      userDataPath: "unused", agentRuntime: { buildOptions } as never, runHarness: runHarness as never });
    const result = await run({ runId: "garden-1", goal: "挑一条视频", personaMode: "chat", modelProfileId: "saved-profile",
      context: "这次想看园艺；上次喜欢短片", checkTool: async id => id.endsWith("_read"),
      tools: [{ id: "bili-garden_read", name: "读视频", description: "只读字幕", enabled: true,
        inputSchema: { type: "object", properties: {} }, effectKind: "read", execute: async () => "字幕" }] });
    expect(buildOptions).toHaveBeenCalledWith(expect.objectContaining({ mode: "chat", executionMode: "chat",
      modelProfileId: "saved-profile", promptSource: "plugin-agent", promptChannel: "plugin:bili-garden" }));
    const input = runHarness.mock.calls[0][0];
    expect(input.promptLayers.stablePrefix).toContain("用户修改过的昔涟人格");
    expect(input.promptLayers.stablePrefix).not.toContain("这次想看园艺");
    expect(input.promptLayers.runtimeContext).toContain("共享关系上下文");
    expect(input.promptLayers.runtimeContext).toContain("这次想看园艺");
    expect(result.usage).toEqual({ input: 220, output: 17, cachedInput: 80 });
  });
  it("取消与策略异常都拒绝工具执行", async () => {
    const controller = new AbortController();
    const runHarness = vi.fn(async (input: any) => {
      expect(await input.checkPermission("bili-garden_read", {})).toBe(false);
      controller.abort();
      expect(await input.checkPermission("bili-garden_read", {})).toBe(false);
      return { finalAnswer: "", rounds: 0, finalState: { uncertainEffects: [] } };
    });
    const run = createPluginAgentRunner({ pluginId: "bili-garden", pluginSignal: controller.signal, userDataPath: "unused",
      agentRuntime: { buildOptions: async () => ({ options: { settings: {}, messages: [] } }) } as never, runHarness: runHarness as never });
    await run({ runId: "garden-2", goal: "读取", checkTool: async () => { throw new Error("配置已改变"); },
      tools: [{ id: "bili-garden_read", name: "读视频", description: "", enabled: true, effectKind: "read", inputSchema: { type: "object", properties: {} }, execute: async () => "" }] });
  });
});
