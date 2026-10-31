import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatResponse, ChatVendorAdapter, ModelMessageOrigin } from "../vendors/types";
import type { HarnessInput } from "./types";
import type { TranscriptSink } from "../transcript-sink";

const mocks = vi.hoisted(() => ({
  adapter: { id: "fixture", transport: "openai" },
  stream: vi.fn(),
}));
vi.mock("../vendors", () => ({
  getAdapterForConfig: () => mocks.adapter,
  streamChatWithSdk: mocks.stream,
  generateChatWithAiSdk: vi.fn(),
  resolveTransport: () => "openai",
}));
vi.mock("../../token-usage-store", () => ({ recordUsage: vi.fn(), recordRequest: vi.fn() }));

import { runCyreneHarness } from "./cyrene-harness";
import { findSafeCutPointForRetainedTokens, resolveCompactionRetainTokens } from "./compaction";
import { modelMessageOrigin } from "../vendors/model-history";

const vendorConfig: HarnessInput["vendorConfig"] = {
  provider: "fixture", baseUrl: "https://fixture.test/v1", model: "source-model", apiKey: "fixture-key",
};
const origin = modelMessageOrigin(mocks.adapter as ChatVendorAdapter, vendorConfig);
const otherOrigin: ModelMessageOrigin = { ...origin, model: "other-model" };

function userMessage(tokens: number): ChatMessage {
  return { role: "user", content: "u".repeat((tokens - 4) * 4) };
}

function reasoningMessage(tokens: number): ChatMessage {
  return {
    role: "assistant", content: "done",
    providerReplay: { version: 1, origin, content: [
      { type: "reasoning", text: "r".repeat(tokens * 4) },
      { type: "text", text: "done" },
    ] },
  };
}

function sink(): TranscriptSink {
  return {
    appendAssistant: vi.fn(async () => "assistant-entry"),
    appendToolResult: vi.fn(async () => undefined),
    closeInterruption: vi.fn(async () => undefined),
    checkpoint: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stream.mockResolvedValue({
    assistantMessage: { role: "assistant", content: "继续完成" },
    text: "继续完成", toolCalls: [], finishReason: "stop", raw: {},
  } satisfies ChatResponse);
});

describe("持久化压缩按实际请求来源保留尾窗", () => {
  it("同源 reasoning 挤占尾窗时缩短完整尾部，异源只计便携内容", () => {
    const messages = [userMessage(1_000), userMessage(1_000), reasoningMessage(2_000), userMessage(100)];
    const before = structuredClone(messages);
    const base = { messages, defaultRetainTokens: 1_500, usableInputBudget: 4_000,
      fixedInputTokens: 1_000, transientTokens: 0 };

    const same = resolveCompactionRetainTokens({ ...base, messageOrigin: origin });
    const other = resolveCompactionRetainTokens({ ...base, messageOrigin: otherOrigin });

    expect(same).toBe(100);
    expect(findSafeCutPointForRetainedTokens(messages, same, origin)).toBe(3);
    expect(other).toBe(1_105);
    expect(findSafeCutPointForRetainedTokens(messages, other, otherOrigin)).toBe(1);
    expect(messages).toEqual(before);
  });

  it("最新完整消息的同源重放已超过容量时拒绝切分，异源仍可保留", () => {
    const messages = [userMessage(1_000), reasoningMessage(2_000)];
    const before = structuredClone(messages);
    const base = { messages, defaultRetainTokens: 500, usableInputBudget: 2_500,
      fixedInputTokens: 1_000, transientTokens: 0 };

    expect(() => resolveCompactionRetainTokens({ ...base, messageOrigin: origin }))
      .toThrow("最新一组消息或工具结果已占满");
    expect(resolveCompactionRetainTokens({ ...base, messageOrigin: otherOrigin })).toBe(5);
    expect(messages).toEqual(before);
  });
});

describe("Harness 持久化压缩保持计量来源一致", () => {
  it.each(["source-model", "other-model"])(
    "%s 的历史重放开销不会被差额误判成不可压缩的固定提示词", async (model) => {
      const latest = userMessage(100);
      const messages = [reasoningMessage(6_000), latest];
      const before = structuredClone(messages);
      const compactTranscript = vi.fn(async () => [{ role: "system" as const, content: "old summary" }, latest]);

      const result = await runCyreneHarness({
        systemPrompt: "s".repeat(16_000), messages, tools: [], vendorConfig: { ...vendorConfig, model },
        allowedBuiltinToolIds: new Set(), includeInteractiveTools: false,
        transcriptSink: sink(), compactTranscript,
        config: { contextWindowTokens: 10_000, reservedOutputTokens: 500, safetyMarginTokens: 0,
          compactionThreshold: 0.4 },
      });

      expect(result.finalAnswer).toBe("继续完成");
      expect(compactTranscript).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ retainTokens: 100 }));
      expect(mocks.stream).toHaveBeenCalledOnce();
      const request = mocks.stream.mock.calls[0][0].request;
      expect(request.messages.some((message: ChatMessage) => message === latest || message.content === latest.content)).toBe(true);
      expect(request.messages.some((message: ChatMessage) => message.providerReplay)).toBe(false);
      expect(messages).toEqual(before);
    },
  );

  it.each([
    { model: "source-model", allowed: false },
    { model: "other-model", allowed: true },
  ])("压缩后 $model 的私有重放决定是否满足硬输入预算：$allowed", async ({ model, allowed }) => {
    const replay = reasoningMessage(2_000);
    const latest = userMessage(100);
    const messages = [userMessage(5_000), replay, latest];
    const before = structuredClone(messages);
    // 摘要比原来的 5000-token 旧前缀更短，但同源 retained reasoning 仍会挤占输入容量。
    const compactTranscript = vi.fn(async () => [
      { role: "system" as const, content: "s".repeat((4_000 - 4) * 4) }, replay, latest,
    ]);

    const result = await runCyreneHarness({
      systemPrompt: "s".repeat(16_000), messages, tools: [], vendorConfig: { ...vendorConfig, model },
      allowedBuiltinToolIds: new Set(), includeInteractiveTools: false,
      transcriptSink: sink(), compactTranscript,
      config: { contextWindowTokens: 10_000, reservedOutputTokens: 500, safetyMarginTokens: 0 },
    });

    expect(compactTranscript).toHaveBeenCalledOnce();
    expect(mocks.stream).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(result.finalAnswer).toContain(allowed ? "继续完成" : "最新消息仍超过模型输入容量");
    expect(messages).toEqual(before);
  });
});
