import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callSummarizeModel } from "./context-manager";
import type { AgentLoopSettings } from "./cyrene-agent";
import { getAdapterForConfig } from "./vendors";
import { generateChatWithAiSdk } from "./vendors/model-runtime";
import { responseBody, sseResponse, streamEvents } from "./vendors/sdk-stream/model-fixtures";

const usage = vi.hoisted(() => ({ recordRequest: vi.fn(), recordUsage: vi.fn() }));
vi.mock("../timeout-manager", () => ({ getTimeoutSettings: () => ({ chatRequestTimeout: 2_000 }) }));
vi.mock("../token-usage-store", () => usage);

const settings: AgentLoopSettings = {
  provider: "自定义端点", model: "gpt-6.1-sol", baseUrl: "https://relay.test/v1", apiKey: "fixture-key",
  explicitTransport: "responses", contextWindowTokens: 4096,
};
const adapter = getAdapterForConfig(settings);
const history = [{ role: "user" as const, content: "请保留已确认的 Linux 路径 /storage 和后续待办。" }];

describe("Responses 摘要的真实 SDK 中转兼容", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("仅支持流式的中转会拒绝旧非流式调用，摘要直接流式聚合并记账一次", async () => {
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      sent.push(body);
      if (body.stream !== true) return new Response(JSON.stringify({ error: {
        message: "stream must be true", type: "invalid_request_error", code: "unsupported_value",
      } }), { status: 400, headers: { "content-type": "application/json" } });
      return sseResponse(streamEvents("responses", { text: "已确认 /storage，继续完成待办。", reasoning: true }));
    }));

    await expect(generateChatWithAiSdk({ adapter, config: settings, timeoutMs: 2_000,
      request: { model: settings.model, messages: history, stream: false } }))
      .rejects.toMatchObject({ code: "E_MODEL_REQUEST_FAILED", modelFailure: { status: 400 } });
    expect(sent).toHaveLength(1);
    sent.length = 0;

    await expect(callSummarizeModel(history, adapter, settings)).resolves.toBe("已确认 /storage，继续完成待办。");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ model: "gpt-6.1-sol", stream: true, store: false, max_output_tokens: 819 });
    expect(sent[0]!.include).toContain("reasoning.encrypted_content");
    expect(JSON.stringify(sent[0]!.input)).toContain("/storage");
    expect(usage.recordRequest).toHaveBeenCalledExactlyOnceWith("gpt-6.1-sol");
    expect(usage.recordUsage).toHaveBeenCalledExactlyOnceWith(3, 2, 1, 1, "gpt-6.1-sol", undefined);
  });

  it("中转统一返回 SSE 时仍能完成摘要，不要求非流式 JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(streamEvents("responses", { text: "保留会话事实。" }))));
    await expect(callSummarizeModel(history, adapter, settings)).resolves.toBe("保留会话事实。");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("完整流的空正文不会变成可归档摘要", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(streamEvents("responses", { text: "" }))));
    await expect(callSummarizeModel(history, adapter, settings))
      .rejects.toMatchObject({ message: "TRANSCRIPT_COMPACTION_REQUIRED", reason: "invalid_summary" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("只有正文增量而没有终态的截断流不会提交半份摘要", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(
      streamEvents("responses", { text: "尚未完成的摘要" }).filter(event => event.type !== "response.completed"),
    )));
    await expect(callSummarizeModel(history, adapter, settings))
      .rejects.toMatchObject({ code: "E_MODEL_RESPONSE_PARSE_FAILED" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(usage.recordRequest).not.toHaveBeenCalled();
  });

  it("拒绝认证的中转不会因改成流式而重复请求", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: {
      message: "invalid API key", type: "authentication_error", code: "invalid_api_key",
    } }), { status: 401, headers: { "content-type": "application/json" } })));
    await expect(callSummarizeModel(history, adapter, settings))
      .rejects.toMatchObject({ code: "E_MODEL_REQUEST_FAILED", modelFailure: { status: 401 } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(usage.recordRequest).not.toHaveBeenCalled();
  });

  it("incomplete 终态不能被当成成功压缩", async () => {
    const terminal = { ...responseBody("responses", { text: "预算截断的摘要" }), status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" } };
    const events = streamEvents("responses", { text: "预算截断的摘要" }).filter(event => event.type !== "response.completed");
    events.push({ type: "response.incomplete", response: terminal });
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(events)));
    await expect(callSummarizeModel(history, adapter, settings)).rejects.toMatchObject({ reason: "invalid_summary" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
