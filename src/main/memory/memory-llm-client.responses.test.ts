import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeMemoryLlm, invokeMemoryStructuredOutput } from "./memory-llm-client";
import { formatMemoryLlmError } from "./memory-llm-errors";
import { parseWikiExtractionResult, validateWikiExtractionBusiness, WIKI_MEMORY_JSON_SCHEMA } from "./memory-schemas";
import { recordRequest, recordUsage } from "../token-usage-store";
import { jsonResponse, responseBody, sseResponse, streamEvents } from "../orchestrator/vendors/sdk-stream/model-fixtures";

vi.mock("../token-usage-store", () => ({ recordRequest: vi.fn(), recordUsage: vi.fn() }));
vi.mock("./memory-llm-shared", () => ({ loadMemoryModelConfig: vi.fn(), stripThinkBlocks: (text: string) => text }));
vi.mock("../runtime-policy", () => ({ resolveTimeoutPolicy: () => ({ totalMs: 2_000 }), resolveMaxOutputTokens: () => 500 }));
vi.mock("../timeout-manager", () => ({ getTimeoutSettings: () => ({}) }));

const config = { source: "inherited-main" as const, provider: "ChatGPT（OpenAI）", model: "gpt-6.1-sol",
  baseUrl: "https://relay.test/v1", apiKey: "fixture-secret", explicitTransport: "responses" as const };
const options = { operation: "wiki" as const, systemPrompt: "只保存有依据的知识。", userPrompt: "用户确认 /storage。",
  maxOutputTokens: 5000, parseSchema: parseWikiExtractionResult, validateBusiness: validateWikiExtractionBusiness, config };

describe("Memory Responses 的实际 SDK 兼容", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("仅流式中转可以完成 Wiki 提取，并且保留预算、原始提示和一次用量", async () => {
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      sent.push(body);
      if (body.stream !== true) return new Response('{"error":{"message":"stream must be true"}}', { status: 400 });
      return sseResponse(streamEvents("responses", { text: '{"candidates":[]}', reasoning: true }));
    }));
    await expect(invokeMemoryStructuredOutput(options)).resolves.toEqual({ candidates: [] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ stream: true, store: false, max_output_tokens: 5000 });
    expect(JSON.stringify(sent[0]!.input)).toContain("/storage");
    expect(JSON.stringify(sent[0])).toContain(options.systemPrompt);
    expect(recordRequest).toHaveBeenCalledExactlyOnceWith("gpt-6.1-sol");
    expect(recordUsage).toHaveBeenCalledExactlyOnceWith(3, 2, 1, 1, "gpt-6.1-sol", undefined);
  });

  it("仅流式中转的无效 JSON 仍进入现有 repair，而不是绕过 schema 校验", async () => {
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      sent.push(JSON.parse(init.body as string));
      return sseResponse(streamEvents("responses", { text: sent.length === 1 ? "not JSON" : '{"candidates":[]}' }));
    }));
    await expect(invokeMemoryStructuredOutput(options)).resolves.toEqual({ candidates: [] });
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1]!.input)).toContain("NO_JSON_OBJECT");
    expect(sent.every(body => body.stream === true)).toBe(true);
  });

  it("官方端点尊重显式 Responses profile，不借用 Chat Completions 的 JSON schema 规则", async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      sent = JSON.parse(init.body as string);
      return sseResponse(streamEvents("responses", { text: '{"candidates":[]}' }));
    }));
    await expect(invokeMemoryStructuredOutput({ ...options, config: { ...config, baseUrl: "https://api.openai.com/v1" } }))
      .resolves.toEqual({ candidates: [] });
    expect(sent).not.toHaveProperty("text.format");
    expect(sent.stream).toBe(true);
  });

  it("显式 Chat Completions 仍使用非流式 JSON schema 和相同预算", async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      sent = JSON.parse(init.body as string);
      return jsonResponse(responseBody("openai", { text: '{"candidates":[]}' }));
    }));
    await expect(invokeMemoryStructuredOutput({ ...options, config: { ...config, model: "gpt-5-sol",
      baseUrl: "https://api.openai.com/v1", explicitTransport: "openai" } })).resolves.toEqual({ candidates: [] });
    expect(sent).toMatchObject({ stream: false, max_tokens: 5000,
      response_format: { type: "json_schema", json_schema: { name: "memory_wiki", strict: true, schema: WIKI_MEMORY_JSON_SCHEMA } } });
  });

  it("缺少终态的流不会成为可保存记忆或计入成功用量", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(streamEvents("responses", { text: '{"candidates":[]}' })
      .filter(event => event.type !== "response.completed"))));
    await expect(invokeMemoryStructuredOutput(options)).rejects.toMatchObject({ failureCode: "MODEL_RESPONSE_PARSE_FAILED",
      diagnostics: { runtimeCode: "E_MODEL_RESPONSE_PARSE_FAILED" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(recordRequest).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("认证失败保留 HTTP 诊断且不重复请求或把私密正文写入日志", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: {
      message: "fixture-secret private-prompt", code: "invalid_api_key", type: "authentication_error",
    } }), { status: 401, headers: { "content-type": "application/json" } })));
    const error = await invokeMemoryStructuredOutput(options).catch(error => error);
    expect(error).toMatchObject({ failureCode: "MODEL_HTTP_ERROR", diagnostics: { category: "AUTH", httpStatus: 401 } });
    expect(formatMemoryLlmError(error)).toContain("HTTP 401");
    expect(formatMemoryLlmError(error)).not.toContain("fixture-secret");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private-prompt");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(recordRequest).not.toHaveBeenCalled();
  });

  it("提前取消不会发送网络请求", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const controller = new AbortController();
    controller.abort();
    await expect(invokeMemoryStructuredOutput({ ...options, signal: controller.signal })).rejects.toMatchObject({ failureCode: "CANCELLED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("旧 Memory 文本入口同样聚合 Responses 流并拒绝半份结果", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(streamEvents("responses", { text: "legacy complete" }))));
    await expect(invokeMemoryLlm({ operation: "compress", config, messages: [{ role: "user", content: "test" }], maxOutputTokens: 500 }))
      .resolves.toMatchObject({ text: "legacy complete" });
    expect(recordRequest).toHaveBeenCalledTimes(1);
    vi.mocked(fetch).mockImplementation(async () => sseResponse([
      ...streamEvents("responses", { text: "partial" }).filter(event => event.type !== "response.completed"),
      { type: "response.incomplete", response: { ...responseBody("responses", { text: "partial" }), status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" } } },
    ]));
    // legacy 没有结构化 repair，也不能把截断正文交给记忆写入方。
    await expect(invokeMemoryLlm({ operation: "compress", config, messages: [{ role: "user", content: "test" }], maxOutputTokens: 500 }))
      .rejects.toMatchObject({ failureCode: "TRUNCATED_OUTPUT" });
    expect(recordRequest).toHaveBeenCalledTimes(1);
  });
});
