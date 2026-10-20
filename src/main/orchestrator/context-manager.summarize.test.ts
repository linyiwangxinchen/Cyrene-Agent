import { beforeEach, describe, expect, it, vi } from "vitest";
import { callSummarizeModel, estimateMessageTokens } from "./context-manager";
import type { AgentLoopSettings } from "./cyrene-agent";
import type { ChatRequest, ChatResponse, ChatVendorAdapter } from "./vendors/types";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), recordRequest: vi.fn(), recordUsage: vi.fn() }));
vi.mock("./vendors/model-runtime", () => ({ generateChatWithAiSdk: mocks.generate }));
vi.mock("../timeout-manager", () => ({ getTimeoutSettings: () => ({ chatRequestTimeout: 60_000 }) }));
vi.mock("../token-usage-store", () => ({ recordRequest: mocks.recordRequest, recordUsage: mocks.recordUsage }));

const adapter = { id: "chatgpt", transport: "responses" } as ChatVendorAdapter;
const settings: AgentLoopSettings = {
  provider: "chatgpt", model: "session-model", baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture-key",
  explicitTransport: "responses", contextWindowTokens: 4096,
};
const response = (text = "保留用户约束及已完成事项"): ChatResponse => ({
  text, finishReason: "stop", assistantMessage: { role: "assistant", content: text }, toolCalls: [], raw: {},
  usage: { input: 12, output: 8, cachedInput: 4 },
});

describe("callSummarizeModel 长会话恢复", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generate.mockResolvedValue(response());
  });

  it("图片仅保留标记和文件引用，摘要包含工具调用参数、结果及生成文件", async () => {
    await callSummarizeModel([
      { role: "user", content: [{ type: "text", text: "按原照片制作，保留字面 $& 和 $`" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(1_000_000)}` } }],
      userAttachments: [{ kind: "image", name: "原照.png", filePath: "/storage/原照.png" }] },
      { role: "assistant", toolCalls: [{ id: "call-1", name: "write_file", arguments: '{"path":"/storage/result.txt"}' }] },
      { role: "tool", toolCallId: "call-1", name: "write_file", content: "已保存，tool-result://result-1" },
    ], adapter, settings);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    const input = mocks.generate.mock.calls[0]![0];
    const prompt = input.request.messages[0].content as string;
    expect(prompt).not.toContain("AAAA");
    expect(prompt).not.toContain("base64");
    expect(prompt).toContain("/storage/原照.png");
    expect(prompt).toContain("write_file（call-1）");
    expect(prompt).toContain('{"path":"/storage/result.txt"}');
    expect(prompt).toContain("tool-result://result-1");
    expect(prompt).toContain("保留字面 $& 和 $`");
    expect(input.config.model).toBe("session-model");
    expect(input.config.explicitTransport).toBe("responses");
  });

  it("单条超长输出按预算分片再合并，末尾约束不会被截掉", async () => {
    const end = "END_CONSTRAINT_保留根目录";
    const history = `BEGIN_TASK\n${"旧工具输出，保持原始顺序。".repeat(3000)}\n${end}`;
    mocks.generate.mockImplementation(async ({ request }: { request: ChatRequest }) => {
      const prompt = String(request.messages[0]!.content);
      return response(`分片中已确认的事实${prompt.includes(end) ? `；${end}` : ""}`);
    });
    const summary = await callSummarizeModel([{ role: "tool", name: "read_file", content: history }], adapter, settings);
    expect(summary).toContain(end);
    expect(mocks.generate.mock.calls.length).toBeGreaterThan(2);
    for (const [input] of mocks.generate.mock.calls) {
      expect(estimateMessageTokens(input.request.messages) + input.request.maxTokens).toBeLessThan(settings.contextWindowTokens!);
    }
    expect(String(mocks.generate.mock.calls.at(-1)![0].request.messages[0].content)).toContain("第 1 段摘要");
  });

  it.each(["", "   "])("空摘要 %j 会失败，不产生可归档的占位文本", async text => {
    mocks.generate.mockResolvedValue(response(text));
    await expect(callSummarizeModel([{ role: "user", content: "重要事实" }], adapter, settings))
      .rejects.toMatchObject({ message: "TRANSCRIPT_COMPACTION_REQUIRED", reason: "invalid_summary" });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it("输出被截断时不提交不完整的摘要", async () => {
    mocks.generate.mockResolvedValue({ ...response(), finishReason: "length" });
    await expect(callSummarizeModel([{ role: "user", content: "重要事实" }], adapter, settings))
      .rejects.toMatchObject({ reason: "invalid_summary" });
  });

  it("暂时性服务错误可重试，认证失败立即保留原错误", async () => {
    const temporary = Object.assign(new Error("provider unavailable"), {
      modelFailure: { provider: "chatgpt", model: settings.model, category: "SERVER_ERROR", status: 503 }, retryAfterMs: 0,
    });
    mocks.generate.mockRejectedValueOnce(temporary).mockResolvedValueOnce(response());
    await expect(callSummarizeModel([{ role: "user", content: "重要事实" }], adapter, settings)).resolves.toBeTruthy();
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    const unauthorized = Object.assign(new Error("unauthorized"), {
      modelFailure: { provider: "chatgpt", model: settings.model, category: "AUTH", status: 401 },
    });
    mocks.generate.mockReset().mockRejectedValue(unauthorized);
    await expect(callSummarizeModel([{ role: "user", content: "重要事实" }], adapter, settings)).rejects.toBe(unauthorized);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it("持续服务错误最多重试两次，取消后不继续摘要", async () => {
    const temporary = Object.assign(new Error("provider unavailable"), {
      modelFailure: { provider: "chatgpt", model: settings.model, category: "SERVER_ERROR", status: 503 }, retryAfterMs: 0,
    });
    mocks.generate.mockRejectedValue(temporary);
    await expect(callSummarizeModel([{ role: "user", content: "重要事实" }], adapter, settings)).rejects.toBe(temporary);
    expect(mocks.generate).toHaveBeenCalledTimes(3);
    const controller = new AbortController(); controller.abort();
    mocks.generate.mockClear();
    await expect(callSummarizeModel([{ role: "user", content: "重要事实" }], adapter, settings, controller.signal)).rejects.toThrow();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
