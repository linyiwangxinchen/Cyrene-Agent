import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../vendors/types";
import {
  computeTokenBudget,
  compressForAgentLoop,
  findSafeCutPointForRetainedTokens,
  isToolPairSafeBoundary,
  resolveCompactionRetainTokens,
} from "./compaction";

function message(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content };
}

function tokenMessage(tokens: number): ChatMessage {
  return message("user", "a".repeat((tokens - 4) * 4));
}

describe("durable compaction tail budget", () => {
  const base = { defaultRetainTokens: 1_600, usableInputBudget: 10_000, fixedInputTokens: 1_000, transientTokens: 0 };

  it("预算充足时保持默认尾窗并原样保留完整消息", () => {
    const messages = Array.from({ length: 10 }, () => tokenMessage(1_000));
    expect(resolveCompactionRetainTokens({ ...base, messages })).toBe(2_000);
  });

  it("固定提示词和临时环境挤占容量时只缩小到可容纳的完整尾部", () => {
    const messages = Array.from({ length: 10 }, () => tokenMessage(1_000));
    expect(resolveCompactionRetainTokens({ ...base, messages, fixedInputTokens: 6_500, transientTokens: 1_000 })).toBe(1_000);
  });

  it("整段历史短于默认尾窗时仍能压缩旧前缀，而不会永久 cut=0", () => {
    const messages = [tokenMessage(1_000), tokenMessage(200)];
    const retain = resolveCompactionRetainTokens({ ...base, messages, defaultRetainTokens: 40_960 });
    expect(retain).toBe(200);
    expect(findSafeCutPointForRetainedTokens(messages, retain)).toBe(1);
  });

  it("缩小尾窗也完整保留最新的工具调用和结果", () => {
    const messages: ChatMessage[] = [tokenMessage(2_000),
      { ...tokenMessage(100), role: "assistant", toolCalls: [{ id: "read", name: "read_file", arguments: "{}" }] },
      { ...tokenMessage(400), role: "tool", toolCallId: "read", name: "read_file" }];
    const retain = resolveCompactionRetainTokens({ ...base, messages, defaultRetainTokens: 100 });
    // 请求投影还包含 read + read_file + {} 的 4 个工具参数词元。
    expect(retain).toBe(504);
    expect(findSafeCutPointForRetainedTokens(messages, retain)).toBe(1);
  });

  it("固定上下文或最新完整组已占满预算时给出明确错误，不改消息", () => {
    const messages = [tokenMessage(2_000), tokenMessage(2_000)];
    const original = structuredClone(messages);
    expect(() => resolveCompactionRetainTokens({ ...base, messages, fixedInputTokens: 10_000 }))
      .toThrow("系统提示词、工具定义和本轮运行环境已占满");
    expect(() => resolveCompactionRetainTokens({ ...base, messages, fixedInputTokens: 8_500 }))
      .toThrow("最新一组消息或工具结果已占满");
    expect(messages).toEqual(original);
  });

  it("仅有一个不可拆分工具组时不会为生成摘要拆开配对", () => {
    const messages: ChatMessage[] = [
      { ...tokenMessage(100), role: "assistant", toolCalls: [{ id: "read", name: "read_file", arguments: "{}" }] },
      { ...tokenMessage(400), role: "tool", toolCallId: "read", name: "read_file" }];
    expect(() => resolveCompactionRetainTokens({ ...base, messages })).toThrow("只有一组不可拆分");
  });
});

describe("compaction trigger budget", () => {
  it.each([
    { tokens: 217_599, expected: false },
    { tokens: 217_600, expected: true },
  ])("256K 上下文在 $tokens 个词元时压缩判定为 $expected", ({ tokens, expected }) => {
    // 英文内容按 4 字符/词元，加上消息格式的 4 个词元。
    const messages = [message("user", "a".repeat((tokens - 4) * 4))];
    const budget = computeTokenBudget("", [], messages, 256_000, 8_192, 512);

    expect(budget.estimatedInput).toBe(tokens);
    expect(budget.needsCompaction).toBe(expected);
  });

  it("小窗口输入挤占输出预留时仍触发安全压缩", () => {
    const messages = [message("user", "a".repeat((1_296 - 4) * 4))];
    const budget = computeTokenBudget("", [], messages, 10_000, 8_192, 512);

    expect(budget.needsCompaction).toBe(true);
  });
});

describe("Harness context compaction v2", () => {
  it("keeps a tool call and its result in the retained token-budgeted tail", () => {
    const messages: ChatMessage[] = [
      message("user", "旧任务"),
      {
        role: "assistant",
        content: "我先读取文件。",
        toolCalls: [{ id: "call-read", name: "read_file", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "call-read", name: "read_file", content: "文件内容".repeat(30) },
      message("user", "请根据结果继续".repeat(20)),
    ];

    const cutIndex = findSafeCutPointForRetainedTokens(messages, 100);

    expect(cutIndex).toBe(1);
    expect(messages.slice(cutIndex).map((entry) => entry.role)).toEqual([
      "assistant", "tool", "user",
    ]);
  });

  it("cannot split an assistant with two tool calls and only one result", () => {
    const messages: ChatMessage[] = [
      message("user", "查询"),
      {
        role: "assistant",
        content: "并行读取两个文件。",
        toolCalls: [
          { id: "call-a", name: "read_file", arguments: "{}" },
          { id: "call-b", name: "read_file", arguments: "{}" },
        ],
      },
      { role: "tool", toolCallId: "call-a", name: "read_file", content: "文件 A 内容" },
    ];

    // 声明与已有结果之间不得切开（结果在右、声明在左 → 跨界）
    expect(isToolPairSafeBoundary(messages, 2)).toBe(false);
    // 声明之前切开：整组（声明 + 结果）保留在右侧 → 安全
    expect(isToolPairSafeBoundary(messages, 1)).toBe(true);
    // 全部保留 → 安全
    expect(isToolPairSafeBoundary(messages, 0)).toBe(true);
  });

  it("keeps the original transcript when summary generation fails", async () => {
    const messages: ChatMessage[] = [
      message("user", "旧任务".repeat(30)),
      message("assistant", "旧结论".repeat(30)),
      message("user", "最新任务".repeat(30)),
    ];

    const result = await compressForAgentLoop({
      messages,
      retainTokens: 20,
      summarize: async () => { throw new Error("summary unavailable"); },
    });

    expect(result).toBe(messages);
  });

  it("keeps the original transcript when the summary is not smaller", async () => {
    const messages: ChatMessage[] = [
      message("user", "旧任务".repeat(30)),
      message("assistant", "旧结论".repeat(30)),
      message("user", "最新任务".repeat(30)),
    ];

    const result = await compressForAgentLoop({
      messages,
      retainTokens: 20,
      summarize: async () => "摘要".repeat(200),
    });

    expect(result).toBe(messages);
  });
});
