/**
 * 按需加载工具（tool_search）真实行为边界：
 * - 首次请求只带常驻工具与 tool_search，延迟工具不带完整规格
 * - select / 关键词加载只在本次运行允许的工具中检索
 * - 未加载直接调用被拒且不执行；同轮"先加载再调用"同样被拒
 * - 加载后下一次请求带规格、可调用，仍走权限检查
 * - 压缩后与中断恢复（新运行读历史）后已加载集合仍有效
 * - 无 deferredToolIds（阈值以下）时请求与原行为一致
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { requests, responses } = vi.hoisted(() => ({
  requests: [] as Array<{ tools?: Array<{ name: string }>; messages: unknown[] }>,
  responses: [] as unknown[],
}));

vi.mock("../vendors", () => ({
  getAdapterForConfig: vi.fn(() => ({ id: "fake", transport: "openai" })),
  streamChatWithSdk: vi.fn(async (input: { request: { tools?: Array<{ name: string }>; messages: unknown[] } }) => {
    requests.push(JSON.parse(JSON.stringify(input.request)));
    const next = responses.shift();
    if (!next) throw new Error("test: response sequence exhausted");
    return next;
  }),
  generateChatWithAiSdk: vi.fn(async () => { throw new Error("test: non-streaming not expected"); }),
  resolveTransport: vi.fn(() => "openai"),
}));
vi.mock("../../token-usage-store", () => ({ recordUsage: vi.fn(), recordRequest: vi.fn() }));

import { runCyreneHarness } from "./cyrene-harness";
import type { HarnessInput } from "./types";
import type { ChatMessage, ChatResponse, ToolCall } from "../vendors/types";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import type { TranscriptSink } from "../transcript-sink";
import { DeferredToolState, executeToolSearch } from "./tool-search";

const vendorConfig = {
  provider: "fake",
  baseUrl: "https://fake.local",
  model: "fake-model",
  apiKey: "fake-key",
} as unknown as HarnessInput["vendorConfig"];

function reply(toolCalls: ToolCall[] = [], text = ""): ChatResponse {
  return {
    assistantMessage: { role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) },
    text,
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop",
    raw: {},
  };
}

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

function tool(id: string, description: string, execute = vi.fn(async () => `${id}-ok`)): ToolDefinition {
  return {
    id,
    name: id,
    description,
    enabled: true,
    effectKind: "read",
    inputSchema: { type: "object", properties: { q: { type: "string", description: `${id} 参数` } } },
    execute,
  };
}

function toolNames(index: number): string[] {
  return (requests[index]?.tools ?? []).map((spec) => spec.name);
}

function toolResults(messages: readonly ChatMessage[]): Array<{ name?: string; content: Record<string, unknown> }> {
  return messages
    .filter((message) => message.role === "tool")
    .map((message) => ({ name: message.name, content: JSON.parse(String(message.content)) as Record<string, unknown> }));
}

function recordingSink() {
  const results: ChatMessage[] = [];
  const sink: TranscriptSink = {
    appendAssistant: vi.fn(async () => `entry-${results.length}`),
    appendToolResult: vi.fn(async (input: { message: ChatMessage }) => { results.push(input.message); }),
    closeInterruption: vi.fn(async () => undefined),
  } as unknown as TranscriptSink;
  return { sink, results };
}

function baseInput(overrides: Partial<HarnessInput> & { tools: ToolDefinition[] }): HarnessInput {
  return {
    systemPrompt: "test system prompt",
    messages: [{ role: "user", content: "帮我处理一下" }],
    vendorConfig,
    includeInteractiveTools: false,
    ...overrides,
  };
}

beforeEach(() => {
  requests.length = 0;
  responses.length = 0;
});

describe("按需加载工具：harness 运行边界", () => {
  it("首次请求不带延迟工具规格；未加载直接调用被拒且不执行；加载后下一轮可调用并经权限检查", async () => {
    const mailExecute = vi.fn(async () => "mail-sent");
    const tools = [tool("Read", "读取文件"), tool("gmail_send_message", "发送 Gmail 邮件", mailExecute)];
    const checkPermission = vi.fn(async () => true);
    const { sink, results } = recordingSink();
    responses.push(
      reply([call("c1", "gmail_send_message", { q: "x" })]),
      reply([call("c2", "tool_search", { query: "select:gmail_send_message" })]),
      reply([call("c3", "gmail_send_message", { q: "x" })]),
      reply([], "完成"),
    );

    const result = await runCyreneHarness(baseInput({
      tools, deferredToolIds: ["gmail_send_message"], checkPermission, transcriptSink: sink,
    }));

    expect(result.finalAnswer).toBe("完成");
    expect(toolNames(0)).toContain("Read");
    expect(toolNames(0)).toContain("tool_search");
    expect(toolNames(0)).not.toContain("gmail_send_message");
    expect(toolNames(1)).not.toContain("gmail_send_message");
    expect(toolNames(2)).toContain("gmail_send_message");

    const [rejected, searched, executed] = toolResults(results);
    expect(rejected.content).toMatchObject({ outcome: "not_executed" });
    expect(String(rejected.content.message)).toContain("tool_search");
    expect(searched.name).toBe("tool_search");
    expect(JSON.parse(String(searched.content.output))).toMatchObject({ loaded: ["gmail_send_message"] });
    expect(executed.content).toMatchObject({ outcome: "success" });
    expect(mailExecute).toHaveBeenCalledTimes(1);
    expect(checkPermission).toHaveBeenCalledWith("gmail_send_message", { q: "x" });
  });

  it("同一轮里先 tool_search 再调用目标工具会被拒，下一轮才可调用", async () => {
    const execute = vi.fn(async () => "ok");
    const { sink, results } = recordingSink();
    responses.push(
      reply([
        call("c1", "tool_search", { query: "select:music_search" }),
        call("c2", "music_search", { q: "歌" }),
      ]),
      reply([call("c3", "music_search", { q: "歌" })]),
      reply([], "好了"),
    );

    await runCyreneHarness(baseInput({
      tools: [tool("Read", "读取文件"), tool("music_search", "搜索歌曲", execute)],
      deferredToolIds: ["music_search"],
      transcriptSink: sink,
    }));

    const [, sameRound, nextRound] = toolResults(results);
    expect(sameRound.content).toMatchObject({ outcome: "not_executed" });
    expect(String(sameRound.content.message)).toContain("下一次回复");
    expect(nextRound.content).toMatchObject({ outcome: "success" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("加载不绕过权限：权限系统拒绝时仍返回 permission_denied", async () => {
    const execute = vi.fn(async () => "pushed");
    const { sink, results } = recordingSink();
    responses.push(
      reply([call("c1", "tool_search", { query: "select:git_push" })]),
      reply([call("c2", "git_push")]),
      reply([], "没推上去"),
    );

    await runCyreneHarness(baseInput({
      tools: [tool("Read", "读取文件"), tool("git_push", "推送提交", execute)],
      deferredToolIds: ["git_push"],
      checkPermission: async (toolId) => toolId !== "git_push",
      transcriptSink: sink,
    }));

    expect(toolResults(results)[1]?.content).toMatchObject({ outcome: "failure", category: "permission_denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("tool_search 只返回本次运行允许的工具：deferredToolIds 里不在 tools 中的名称不可加载", async () => {
    const { sink, results } = recordingSink();
    responses.push(
      reply([call("c1", "tool_search", { query: "select:outside_tool,music_search" })]),
      reply([call("c2", "outside_tool")]),
      reply([], "结束"),
    );

    await runCyreneHarness(baseInput({
      tools: [tool("Read", "读取文件"), tool("music_search", "搜索歌曲")],
      deferredToolIds: ["music_search", "outside_tool"],
      transcriptSink: sink,
    }));

    const [searched, outside] = toolResults(results);
    expect(JSON.parse(String(searched.content.output))).toEqual({
      loaded: ["music_search"], alreadyAvailable: [], notFound: ["outside_tool"],
    });
    expect(toolNames(1)).not.toContain("outside_tool");
    expect(outside.content).toMatchObject({ outcome: "failure", category: "not_found" });
  });

  it("压缩后已加载工具仍在请求中且可调用", async () => {
    const execute = vi.fn(async () => "大".repeat(6000));
    const { sink, results } = recordingSink();
    const compactTranscript = vi.fn(async ({ transientMessages }: { transientMessages: ChatMessage[] }) => [
      { role: "user" as const, content: "<cyrene_compaction_checkpoint>摘要</cyrene_compaction_checkpoint>" },
      ...transientMessages,
    ]);
    responses.push(
      reply([call("c1", "tool_search", { query: "select:big_report" })]),
      reply([call("c2", "big_report")]),
      reply([call("c3", "big_report")]),
      reply([], "压缩后完成"),
    );

    const result = await runCyreneHarness(baseInput({
      tools: [tool("Read", "读取文件"), tool("big_report", "生成大报告", execute)],
      deferredToolIds: ["big_report"],
      transcriptSink: sink,
      compactTranscript,
      config: {
        contextWindowTokens: 40000,
        reservedOutputTokens: 20,
        safetyMarginTokens: 0,
        compactionThreshold: 0.25,
        compactionRetainRatio: 0.1,
      },
    }));

    expect(result.finalAnswer).toBe("压缩后完成");
    expect(compactTranscript).toHaveBeenCalled();
    expect(toolNames(2)).toContain("big_report");
    expect(toolResults(results)[2]?.content).toMatchObject({ outcome: "success" });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("中断恢复：新运行从历史中的 tool_search 结果重建已加载集合，首个请求即带规格", async () => {
    const first = recordingSink();
    responses.push(
      reply([call("c1", "tool_search", { query: "select:music_search" })]),
      reply([], "已加载"),
    );
    const tools = [tool("Read", "读取文件"), tool("music_search", "搜索歌曲"), tool("music_play_track", "播放歌曲")];
    await runCyreneHarness(baseInput({ tools, deferredToolIds: ["music_search", "music_play_track"], transcriptSink: first.sink }));

    requests.length = 0;
    const execute = vi.fn(async () => "found");
    responses.push(reply([call("c2", "music_search", { q: "歌" })]), reply([], "续跑完成"));
    const second = recordingSink();
    await runCyreneHarness(baseInput({
      tools: [tools[0], tool("music_search", "搜索歌曲", execute), tools[2]],
      deferredToolIds: ["music_search", "music_play_track"],
      transcriptSink: second.sink,
      messages: [
        { role: "user", content: "放首歌" },
        { role: "assistant", content: "", toolCalls: [call("c1", "tool_search", { query: "select:music_search" })] },
        first.results[0]!,
        { role: "user", content: "继续" },
      ],
    }));

    expect(toolNames(0)).toContain("music_search");
    expect(toolNames(0)).not.toContain("music_play_track");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("没有 deferredToolIds（工具数在阈值以下）时请求工具清单与原行为一致，不出现 tool_search", async () => {
    responses.push(reply([call("c1", "gmail_send_message")]), reply([], "完成"));
    const execute = vi.fn(async () => "sent");
    await runCyreneHarness(baseInput({
      tools: [tool("Read", "读取文件"), tool("gmail_send_message", "发送邮件", execute)],
    }));

    expect(toolNames(0)).toEqual(["Read", "gmail_send_message", "read_tool_result", "update_todo"].sort((a, b) => a.localeCompare(b)));
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("tool_search 检索", () => {
  const tools = [
    tool("Read", "读取文件"),
    tool("music_search", "搜索网易云歌曲"),
    tool("music_play_track", "播放指定歌曲"),
    tool("music_create_playlist", "创建歌单"),
    tool("gmail_send_message", "发送 Gmail 邮件"),
    tool("record_expense", "记一笔账"),
  ];
  const deferredIds = tools.slice(1).map((entry) => entry.id);

  function search(query: string, extra: Record<string, unknown> = {}, state = new DeferredToolState(deferredIds)) {
    const observation = executeToolSearch(call("s", "tool_search", { query, ...extra }), state, tools);
    return { observation, output: JSON.parse(observation.output ?? "{}") as Record<string, string[]>, state };
  }

  it("关键词按名称与用途检索，名称命中优先，受 max_results 限制", () => {
    const { output, state } = search("music", { max_results: 2 });
    expect(output.loaded).toHaveLength(2);
    expect(output.loaded.every((id) => id.startsWith("music_"))).toBe(true);
    expect(state.loadedIds()).toEqual(output.loaded);
    expect(search("邮件").output.loaded).toEqual(["gmail_send_message"]);
  });

  it("select 精确加载；常驻工具报告为已可用，未知名称报告为不可用", () => {
    const { output } = search("select:record_expense, Read ,nope");
    expect(output).toEqual({ loaded: ["record_expense"], alreadyAvailable: ["Read"], notFound: ["nope"] });
  });

  it("没有命中时成功返回提示，不加载任何工具", () => {
    const { observation, output, state } = search("天气预报");
    expect(observation.outcome).toBe("success");
    expect(output.loaded).toEqual([]);
    expect(state.loadedIds()).toEqual([]);
  });

  it("运行没有延迟工具或 query 为空时返回失败", () => {
    expect(executeToolSearch(call("s", "tool_search", { query: "music" }), new DeferredToolState([]), tools).outcome).toBe("failure");
    expect(search("  ").observation).toMatchObject({ outcome: "failure", category: "invalid_arguments" });
  });
});
