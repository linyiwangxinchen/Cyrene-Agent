import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginPromptRegistry,
  MAX_PLUGIN_PROMPT_CHARS,
  MAX_PLUGIN_PROMPT_TOTAL_CHARS,
  PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS,
} from "./prompts";
import type { PluginExpressionEvidence, PluginPromptSource } from "./types";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PluginPromptRegistry", () => {
  const privateChat = { source: "conversation", mode: "chat", privateCompanion: true, userText: "聊聊阳台浇水" } as const;
  const subtitle: PluginExpressionEvidence = {
    id: "original", quote: "花盆加班", at: 100,
    source: { kind: "video_subtitle", id: "BV1JcnW6pEFT:subtitle:1:9:11", unit: "BV1JcnW6pEFT", url: "https://www.bilibili.com/video/BV1JcnW6pEFT?t=9" },
    topics: ["阳台浇水"],
  };

  it("以经宿主验证的结构化 B 站证据取代旧提示词，不把用户查询交给证据接口", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    const list = vi.fn(() => [subtitle]);
    const provide = vi.fn(() => "旧提示词");
    registry.register("bili-garden", { id: "expressions", privateCompanionOnly: true, provide, listExpressionEvidence: list }, signal, "builtin");
    expect(await registry.build(privateChat)).toContain('"原话":"花盆加班"');
    expect(provide).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith({ limit: 100, signal: expect.any(AbortSignal) });
    expect(await registry.build(privateChat, ["花盆，加班"])).toBe("");
    expect(await registry.build(privateChat, [], [])).toBe("");
    expect(await registry.build({ ...privateChat, privateCompanion: undefined })).toBe("");
    expect(await registry.buildExpressionContext({ use: "proactive", userText: privateChat.userText })).toBe("");
    expect(await registry.buildExpressionContext({ use: "proactive", userText: privateChat.userText, allowedOwners: ["bili-garden"] })).toBe("");
  });

  it("已授权的用户插件只能贡献经过归纳的策略，重复转载不能提供两份证据", async () => {
    const registry = createPluginPromptRegistry();
    const controller = new AbortController();
    const initial = { ...subtitle, strategy: "detail" } as const;
    let rows: PluginExpressionEvidence[] = [initial, { ...initial, id: "copy", quote: "花盆，加班。",
      source: { ...initial.source, id: "copied", unit: "different" } }];
    registry.register("community", { id: "style", provide: () => "", listExpressionEvidence: () => rows }, controller.signal, "user");
    expect(await registry.build(privateChat)).toBe("");
    expect(await registry.build(privateChat, [], ["community"])).toBe("");
    rows = [initial, { ...rows[1], quote: "土里藏着天气" }];
    const active = { use: "proactive", userText: privateChat.userText, allowedOwners: ["community"] } as const;
    const first = await registry.selectExpressionContext(active);
    expect(first?.text).toContain("顺着对方刚提到的一个具体细节接话");
    expect(first?.text).not.toMatch(/花盆|土里|bilibili/);
    expect(first?.sourceOwners).toEqual(["community"]);
    rows[1] = { ...rows[1], source: { ...rows[1].source, version: "revised" } };
    expect((await registry.selectExpressionContext(active))?.evidenceKey).not.toEqual(first?.evidenceKey);
    controller.abort();
    expect(await registry.selectExpressionContext(active)).toBeUndefined();
  });

  it("普通私聊优先使用 B 站和贴吧支持的接话方式，只把适用策略交给模型", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.register("bili-garden", {
      id: "expressions", provide: () => "",
      listExpressionEvidence: () => [{ ...subtitle, strategy: "pacing" as const }],
    }, signal, "builtin");
    registry.register("tieba-garden", {
      id: "expressions", provide: () => "",
      listExpressionEvidence: () => [{
        id: "floor", quote: "那你歇会儿再浇呗", at: 101, strategy: "pacing" as const, topics: ["阳台浇水"],
        source: { kind: "forum_authenticated" as const, unit: "1234", id: "1234:post:1", url: "https://tieba.baidu.com/p/1234#post_content_1" },
      }],
    }, signal, "builtin");
    const input = { use: "conversation", userText: privateChat.userText, allowedOwners: ["bili-garden", "tieba-garden"] } as const;
    const selected = await registry.selectExpressionContext(input);
    expect(selected?.sourceOwners).toEqual(input.allowedOwners);
    expect(selected?.text).toContain("用短句回应重点");
    expect(selected?.text).not.toMatch(/花盆加班|歇会儿|bilibili\.com|baidu\.com/);
    expect(await registry.selectExpressionContext({ ...input, userText: "我难受，先听我说" })).toBeUndefined();
  });

  it("普通私聊里的正式写作交给当前任务，同话题的日常提及仍可取用", async () => {
    const registry = createPluginPromptRegistry();
    const list = vi.fn(() => [subtitle]);
    registry.register("bili-garden", { id: "expressions", privateCompanionOnly: true, provide: () => "", listExpressionEvidence: list }, new AbortController().signal, "builtin");
    for (const userText of ["请帮我写一段正式公告，内容是阳台浇水。", "阳台浇水的安排确实变了。把刚才的内容改成物业书面通知。"]) {
      expect(await registry.build({ ...privateChat, userText })).toBe("");
    }
    expect(list).not.toHaveBeenCalled();
    expect(await registry.build({ ...privateChat, userText: "小区出了个阳台浇水公告，你怎么看？" })).toContain("花盆加班");
  });

  it("注销正在异步读取的来源后，已读回的证据不会进入本次请求", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    let resolveRows!: (rows: PluginExpressionEvidence[]) => void;
    registry.register("bili-garden", { id: "expressions", provide: () => "", privateCompanionOnly: true,
      listExpressionEvidence: () => new Promise(resolve => { resolveRows = resolve; }) }, signal, "builtin");
    const result = registry.build(privateChat);
    registry.unregister("bili-garden", "expressions");
    resolveRows([subtitle]);
    expect(await result).toBe("");
  });

  it("让内置贴吧表达在归纳前排除用户纠正过的样本", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    const input = { source: "conversation", mode: "chat", privateCompanion: true, userText: "我回来了" } as const;
    const provide = vi.fn<import("./types").PluginPromptProvider["provide"]>(({ isExpressionBlocked }) => {
      return isExpressionBlocked?.("月亮补给已经到了") ? "" : "接话时把眼前的事情说具体";
    });
    registry.register("tieba-garden", { id: "expressions", privateCompanionOnly: true, provide }, signal);
    const unrelated = vi.fn<import("./types").PluginPromptProvider["provide"]>(({ isExpressionBlocked }) => {
      expect(isExpressionBlocked).toBeUndefined();
      return "";
    });
    registry.register("elsewhere", { id: "expressions", privateCompanionOnly: true, provide: unrelated }, signal);

    expect(await registry.build(input)).toContain("接话时把眼前的事情说具体");
    expect(await registry.build(input, ["月亮补给"])).toBe("");
    expect(unrelated).toHaveBeenCalledTimes(2);
    expect(await registry.build({ ...input, privateCompanion: undefined }, ["月亮补给"])).toBe("");
    expect(provide).toHaveBeenCalledTimes(2);
  });

  it("按注册顺序拼接命名空间内容，并按模式过滤", async () => {
    const registry = createPluginPromptRegistry();
    const first = new AbortController();
    const second = new AbortController();
    registry.register("alpha", {
      id: "shared",
      modes: ["chat"],
      provide: ({ userText }) => `A:${userText}`,
    }, first.signal);
    registry.register("beta", {
      id: "shared",
      modes: ["work"],
      provide: async ({ source }) => `B:${source}`,
    }, second.signal);

    expect(await registry.build({
      source: "conversation",
      mode: "chat",
      userText: "你好",
    })).toBe("[插件上下文：plugin:alpha:shared]\nA:你好");
    expect(await registry.build({
      source: "scheduler",
      mode: "work",
      userText: "检查任务",
    })).toBe("[插件上下文：plugin:beta:shared]\nB:scheduler");
  });

  it("插件完成激活后才调用已注册的 Provider", async () => {
    const registry = createPluginPromptRegistry();
    const provide = vi.fn(() => "READY");
    let running = false;
    registry.register("demo", { id: "context", provide }, new AbortController().signal, "user", () => running);
    const input = { source: "conversation", mode: "chat", userText: "hi" } as const;

    expect(await registry.build(input)).toBe("");
    expect(provide).not.toHaveBeenCalled();
    running = true;
    expect(await registry.build(input)).toContain("READY");
    expect(provide).toHaveBeenCalledOnce();
  });

  it("同一插件拒绝重复和非法 id，不同插件可使用相同短 id", () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    const provider = { id: "context", provide: () => "ok" };
    registry.register("alpha", provider, signal);
    expect(() => registry.register("alpha", provider, signal)).toThrow(/已注册/);
    expect(() => registry.register("beta", provider, signal)).not.toThrow();
    expect(() => registry.register("alpha", { id: "../bad", provide: () => "bad" }, signal)).toThrow(/非法/);
  });

  it("单个 Provider 失败不阻止其他内容", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.register("broken", { id: "context", provide: () => { throw new Error("failed"); } }, signal);
    registry.register("kept", { id: "context", provide: () => "KEPT" }, signal);

    const result = await registry.build({ source: "conversation", mode: "chat", userText: "hi" });

    expect(result).toContain("KEPT");
    expect(result).not.toContain("broken:context]");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("Provider 超时后跳过且不阻塞其他内容", async () => {
    vi.useFakeTimers();
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.register("slow", { id: "context", provide: () => new Promise<string>(() => {}) }, signal);
    registry.register("fast", { id: "context", provide: () => "FAST" }, signal);

    const building = registry.build({ source: "conversation", mode: "chat", userText: "hi" });
    await vi.advanceTimersByTimeAsync(PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS);

    await expect(building).resolves.toContain("FAST");
  });

  it("停止信号、所有者注销和单项长度上限均生效", async () => {
    const registry = createPluginPromptRegistry();
    const owner = new AbortController();
    const removed = new AbortController();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.register("active", { id: "long", provide: () => "x".repeat(MAX_PLUGIN_PROMPT_CHARS + 10) }, owner.signal);
    registry.register("removed", { id: "context", provide: () => "REMOVED" }, removed.signal);
    expect(registry.unregister("other", "context")).toBe(false);
    expect(registry.unregister("removed", "context")).toBe(true);

    const active = await registry.build({ source: "conversation", mode: "chat", userText: "hi" });
    expect(active).toContain("x".repeat(MAX_PLUGIN_PROMPT_CHARS));
    expect(active).not.toContain("REMOVED");

    owner.abort();
    expect(await registry.build({ source: "conversation", mode: "chat", userText: "hi" })).toBe("");
  });

  it("总长度上限包含标题和分隔符", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let index = 0; index < 3; index += 1) {
      registry.register("demo", {
        id: `context-${index}`,
        provide: () => "x".repeat(MAX_PLUGIN_PROMPT_CHARS),
      }, signal);
    }

    const result = await registry.build({ source: "conversation", mode: "chat", userText: "hi" });

    expect(result.length).toBe(MAX_PLUGIN_PROMPT_TOTAL_CHARS);
    expect(result).toContain("plugin:demo:context-0");
    expect(result).toContain("plugin:demo:context-1");
    expect(result).not.toContain("plugin:demo:context-2");
  });
});

describe("场景作用域（sources）", () => {
  it("无 Provider 参与时 moments-post 构建返回空串（mode 缺省合法）", async () => {
    const registry = createPluginPromptRegistry();

    expect(await registry.build({ source: "moments-post", userText: "x" })).toBe("");
  });

  it("未声明 sources 的 Provider 只参与既有场景（向后兼容）", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.register("legacy", { id: "context", provide: () => "LEGACY" }, signal);

    expect(await registry.build({ source: "moments-post", userText: "hi" })).toBe("");
    expect(await registry.build({ source: "conversation", mode: "chat", userText: "hi" }))
      .toBe("[插件上下文：plugin:legacy:context]\nLEGACY");
    expect(await registry.build({ source: "scheduler", mode: "work", userText: "hi" }))
      .toBe("[插件上下文：plugin:legacy:context]\nLEGACY");
  });

  it("显式 sources: [\"moments-post\"] 后完全按声明生效", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.register("moments", {
      id: "context",
      sources: ["moments-post"],
      provide: ({ source }) => `POST:${source}`,
    }, signal);

    expect(await registry.build({ source: "moments-post", userText: "hi" }))
      .toBe("[插件上下文：plugin:moments:context]\nPOST:moments-post");
    expect(await registry.build({ source: "conversation", mode: "chat", userText: "hi" })).toBe("");
  });

  it("plugin-agent 场景只调用显式声明该来源的 Provider", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.register("minecraft", {
      id: "goal-context",
      sources: ["plugin-agent"] as unknown as PluginPromptSource[],
      provide: ({ source }) => `GOAL:${source}`,
    }, signal);
    registry.register("legacy", {
      id: "conversation-context",
      provide: () => "LEGACY",
    }, signal);

    expect(await registry.build({
      source: "plugin-agent",
      mode: "work",
      userText: "收集木头",
    } as never)).toBe("[插件上下文：plugin:minecraft:goal-context]\nGOAL:plugin-agent");
  });

  it("moments-post 场景下 Provider 抛错时降级为空串", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.register("broken", {
      id: "context",
      sources: ["moments-post"],
      provide: () => { throw new Error("failed"); },
    }, signal);

    expect(await registry.build({ source: "moments-post", userText: "hi" })).toBe("");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("声明 modes 的 Provider 在 moments-post 场景仅由 sources 决定生效（绕过 modes 过滤）", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    let calls = 0;
    registry.register("moments", {
      id: "context",
      sources: ["moments-post"],
      modes: ["chat"],
      provide: () => { calls += 1; return "POSTED"; },
    }, signal);

    // moments-post 不携带 mode：即使声明了 modes 也参与，是否生效仅由 sources 决定。
    expect(await registry.build({ source: "moments-post", userText: "hi" }))
      .toBe("[插件上下文：plugin:moments:context]\nPOSTED");
    expect(calls).toBe(1);
    // 会话场景被 sources 排除：无论 mode 是否匹配都不参与。
    expect(await registry.build({ source: "conversation", mode: "chat", userText: "hi" })).toBe("");
    expect(await registry.build({ source: "conversation", mode: "work", userText: "hi" })).toBe("");
    expect(calls).toBe(1);
  });

  it("同时声明 moments-post 与 conversation 时，会话场景仍受 modes 约束", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.register("hybrid", {
      id: "context",
      sources: ["moments-post", "conversation"],
      modes: ["chat"],
      provide: ({ source }) => `HYBRID:${source}`,
    }, signal);

    expect(await registry.build({ source: "moments-post", userText: "hi" }))
      .toBe("[插件上下文：plugin:hybrid:context]\nHYBRID:moments-post");
    expect(await registry.build({ source: "conversation", mode: "work", userText: "hi" })).toBe("");
    expect(await registry.build({ source: "conversation", mode: "chat", userText: "hi" }))
      .toBe("[插件上下文：plugin:hybrid:context]\nHYBRID:conversation");
  });

  it("moments-post 构建只输出声明该场景的 Provider（与仅会话 Provider 混合）", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.register("chat", {
      id: "context",
      sources: ["conversation"],
      provide: () => "CHAT-ONLY",
    }, signal);
    registry.register("moments", {
      id: "context",
      sources: ["moments-post"],
      provide: () => "POST-ONLY",
    }, signal);

    expect(await registry.build({ source: "moments-post", userText: "hi" }))
      .toBe("[插件上下文：plugin:moments:context]\nPOST-ONLY");
    expect(await registry.build({ source: "conversation", mode: "chat", userText: "hi" }))
      .toBe("[插件上下文：plugin:chat:context]\nCHAT-ONLY");
  });

  it("register 拒绝空数组或含未知场景的 sources", () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    expect(() => registry.register("alpha", { id: "context", sources: [], provide: () => "ok" }, signal))
      .toThrow(/sources 非法/);
    const unknownSource = ["moments"] as unknown as PluginPromptSource[];
    expect(() => registry.register("alpha", { id: "context", sources: unknownSource, provide: () => "ok" }, signal))
      .toThrow(/sources 非法/);
  });

  it("register 拒绝假值或非数组形式的 sources，且不影响后续合法注册", async () => {
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    const invalidSources = [false, 0, "moments-post", [], ["bogus"]];
    for (const sources of invalidSources) {
      expect(() => registry.register("alpha", {
        id: "context",
        sources: sources as unknown as PluginPromptSource[],
        provide: () => "ok",
      }, signal)).toThrow(/sources 非法/);
    }

    // 只拒绝坏的 Provider：之后合法注册与构建不受影响。
    registry.register("alpha", { id: "context", sources: ["moments-post"], provide: () => "STILL-OK" }, signal);
    expect(await registry.build({ source: "moments-post", userText: "hi" }))
      .toBe("[插件上下文：plugin:alpha:context]\nSTILL-OK");
  });

  it("旧式参数解构写法在升级后保持编译与运行兼容", async () => {
    // 既有 TypeScript 插件常见写法：provide 参数一次解构 source/mode/userText。
    // moments-post 的 mode 类型为 never（可选），升级 SDK 后旧解构必须仍能编译，
    // 且运行时 moments-post 场景不携带 mode（undefined），会话场景照常传值。
    const registry = createPluginPromptRegistry();
    const signal = new AbortController().signal;
    registry.register("alpha", {
      id: "legacy-destructure",
      sources: ["moments-post", "conversation"],
      provide: ({ source, mode, userText }) => `${source}|${String(mode)}|${userText}`,
    }, signal);

    // 编译期兼容即本文件可通过 tsc：这里同时验证运行时语义。
    expect(await registry.build({ source: "moments-post", userText: "hi" }))
      .toBe("[插件上下文：plugin:alpha:legacy-destructure]\nmoments-post|undefined|hi");
    expect(await registry.build({ source: "conversation", mode: "chat", userText: "yo" }))
      .toBe("[插件上下文：plugin:alpha:legacy-destructure]\nconversation|chat|yo");
  });
});
