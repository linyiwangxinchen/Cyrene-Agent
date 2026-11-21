import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { CyreneAgent, type CyreneRunOptions } from "./cyrene-agent";
import { runHarnessWithAdapter } from "./harness-adapter";
import { runChatLoop } from "./chat-loop";
import { __setHookRunnerForTest, type HookRunner } from "../hooks/hook-runner";

vi.mock("./vendors", () => ({ getAdapterForConfig: vi.fn(() => ({ id: "fake-adapter" })) }));
vi.mock("./tools/registry/tool-registry", () => ({
  toolRegistry: { getEnabledTools: vi.fn(() => []), getById: vi.fn() },
  resolveEffectKind: vi.fn(() => "read"),
}));
vi.mock("../permission", () => ({ checkPermission: vi.fn() }));
vi.mock("../user-choice", () => ({ requestUserClarification: vi.fn() }));
vi.mock("./chat-loop", () => ({
  runChatLoop: vi.fn(async () => ({ reply: "chat-reply", toolResults: [], completionReason: "no_tool" as const })),
}));
vi.mock("./harness-adapter", () => ({
  runHarnessWithAdapter: vi.fn(async () => ({ reply: "work-reply", toolResults: [], completionReason: "no_tool" as const })),
}));

const mockedChat = vi.mocked(runChatLoop);
const mockedHarness = vi.mocked(runHarnessWithAdapter);

type FakeHooks = {
  [K in "hasHooks" | "runSessionStart" | "runUserPromptSubmit" | "runStop"]: ReturnType<typeof vi.fn>;
};

function fakeHooks(overrides: Partial<FakeHooks> = {}): FakeHooks {
  return {
    hasHooks: vi.fn(() => true),
    runSessionStart: vi.fn(async () => "会话开始上下文"),
    runUserPromptSubmit: vi.fn(async () => ({ decision: "allow", additionalContext: "提交上下文" })),
    runStop: vi.fn(async () => {}),
    ...overrides,
  };
}

function options(extra: Partial<CyreneRunOptions> = {}): CyreneRunOptions {
  return {
    settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 } as never,
    messages: [{ role: "user", content: "hi" }] as never,
    timeoutMs: 60000,
    toolSystemContent: "",
    soulSystemBaseContent: "",
    executionMode: "work",
    runId: "run-hooks-1",
    conversationId: "conv-1",
    ...extra,
  };
}

function collect(agent: CyreneAgent, input: CyreneRunOptions): Promise<BaseEvent[]> {
  const events: BaseEvent[] = [];
  return new Promise((resolve, reject) => {
    agent.runWithEvents(input).subscribe({
      next: (event) => events.push(event),
      complete: () => resolve(events),
      error: reject,
    });
  });
}

beforeEach(() => {
  mockedChat.mockClear();
  mockedHarness.mockClear();
});

afterEach(() => {
  __setHookRunnerForTest(null);
});

describe("CyreneAgent 用户 Hooks", () => {
  it("未初始化 Hooks 时不注入上下文", async () => {
    await collect(new CyreneAgent({ threadId: "t" }), options({ hookUserPrompt: "你好" }));
    expect((mockedHarness.mock.calls[0]?.[0] as CyreneRunOptions).hookContext).toBeUndefined();
  });

  it("SessionStart 与 UserPromptSubmit 上下文进入 Harness 运行", async () => {
    const hooks = fakeHooks();
    __setHookRunnerForTest(hooks as unknown as HookRunner);
    await collect(new CyreneAgent({ threadId: "t" }), options({
      hookUserPrompt: "你好",
      channelContext: { channel: "feishu", targetId: "c", sessionId: "feishu:c" },
    }));
    expect(hooks.runUserPromptSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "你好", channel: "feishu", sessionId: "conv-1", runId: "run-hooks-1",
    }));
    expect((mockedHarness.mock.calls[0]?.[0] as CyreneRunOptions).hookContext).toBe("会话开始上下文\n\n提交上下文");
    await vi.waitFor(() => expect(hooks.runStop).toHaveBeenCalledWith(expect.objectContaining({ status: "success" })));
  });

  it("无工具 Chat 路径同样收到 Hook 上下文", async () => {
    __setHookRunnerForTest(fakeHooks() as unknown as HookRunner);
    await collect(new CyreneAgent({ threadId: "t" }), options({ executionMode: "chat", hookUserPrompt: "在吗" }));
    const runtimeContext = (mockedChat.mock.calls[0]?.[0] as { runtimeContext: string }).runtimeContext;
    expect(runtimeContext).toContain("[HOOK_CONTEXT]");
    expect(runtimeContext).toContain("提交上下文");
  });

  it("没有用户输入（后台续跑）时不触发 UserPromptSubmit", async () => {
    const hooks = fakeHooks();
    __setHookRunnerForTest(hooks as unknown as HookRunner);
    await collect(new CyreneAgent({ threadId: "t" }), options());
    expect(hooks.runUserPromptSubmit).not.toHaveBeenCalled();
    expect(hooks.runSessionStart).toHaveBeenCalledOnce();
  });

  it("UserPromptSubmit 拒绝时不进入模型，以失败终态携带原因结束", async () => {
    const hooks = fakeHooks({
      runUserPromptSubmit: vi.fn(async () => ({ decision: "deny", reason: "工作时间外不接单" })),
    });
    __setHookRunnerForTest(hooks as unknown as HookRunner);
    const closeInterruption = vi.fn(async () => {});
    const agent = new CyreneAgent({ threadId: "t" });
    const events = await collect(agent, options({
      hookUserPrompt: "帮我部署",
      transcriptSink: { closeInterruption } as never,
    }));
    expect(mockedHarness).not.toHaveBeenCalled();
    const finished = events.find((event) => event.type === EventType.RUN_FINISHED) as { result?: { status: string; reason: string } };
    expect(finished.result).toMatchObject({ status: "runtime_error" });
    expect(finished.result?.reason).toContain("工作时间外不接单");
    expect(agent.lastResult?.reply).toContain("工作时间外不接单");
    expect(closeInterruption).toHaveBeenCalledWith({ reason: "runtime_error", runSession: null });
    await vi.waitFor(() => expect(hooks.runStop).toHaveBeenCalledWith(expect.objectContaining({ status: "runtime_error" })));
  });

  it("Stop Hook 失败不影响运行结果", async () => {
    __setHookRunnerForTest(fakeHooks({ runStop: vi.fn(async () => { throw new Error("stop boom"); }) }) as unknown as HookRunner);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = await collect(new CyreneAgent({ threadId: "t" }), options());
    expect(events.find((event) => event.type === EventType.RUN_FINISHED)).toMatchObject({ result: { status: "success" } });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});
