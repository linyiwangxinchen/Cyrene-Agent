import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSettings } from "../settings/model-settings";
import type { MomentsAgentDeps } from "../moments/moments-agent";
import type { ToolDefinition } from "../orchestrator/tools/registry/tool-registry";
import { jsonResponse, responseBody } from "../orchestrator/vendors/sdk-stream/model-fixtures";

const mocks = vi.hoisted(() => ({
  root: "",
  loadModelSettings: vi.fn(),
  loadGeneralSettings: vi.fn(),
  momentsAgentDeps: undefined as MomentsAgentDeps | undefined,
  tools: new Map<string, ToolDefinition>(),
}));

// 所有设置、日志、媒体和存储边界均隔离；模型解析、业务入口和厂商请求保持真实。
vi.mock("electron", () => ({ app: { getPath: () => mocks.root, getAppPath: () => mocks.root } }));
vi.mock("../settings/model-settings", async (original) => ({
  ...await original<typeof import("../settings/model-settings")>(),
  loadModelSettings: mocks.loadModelSettings,
}));
vi.mock("../settings/settings-facade", () => ({ loadGeneralSettings: mocks.loadGeneralSettings }));
vi.mock("../prompts/prompt-loader", () => ({ loadPromptFile: () => "" }));
vi.mock("../token-usage-store", () => ({ recordRequest: vi.fn(), recordUsage: vi.fn() }));
vi.mock("../chat-api-utils", () => ({ appendApiLog: vi.fn() }));
vi.mock("../agent-log", () => ({ debugLog: vi.fn() }));
vi.mock("../llm-queue", () => ({ enqueueLLMTask: vi.fn() }));
vi.mock("../rag", () => ({ getPermanentWorldbookEntries: () => [], getKeywordMatchedWorldbookEntries: () => [] }));
vi.mock("../moments/moments-store", () => ({ getMomentsMediaRootDir: () => path.join(mocks.root, "media") }));
vi.mock("../moments/moments-agent", async (original) => {
  const actual = await original<typeof import("../moments/moments-agent")>();
  return {
    ...actual,
    createMomentsAgent: (deps: MomentsAgentDeps) => {
      mocks.momentsAgentDeps = deps;
      return actual.createMomentsAgent(deps);
    },
  };
});
vi.mock("../chat/image-caption", () => ({ validateCaptionImagePath: vi.fn() }));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({
  toolRegistry: {
    register: (tool: ToolDefinition) => mocks.tools.set(tool.id, tool),
    getById: (id: string) => mocks.tools.get(id),
    setEnabled: vi.fn(),
  },
}));
vi.mock("../orchestrator/tools/built-in-tools", () => ({ currentUserTimezone: () => "Asia/Shanghai" }));
vi.mock("../orchestrator/tools/fs-tools", () => ({}));
vi.mock("../orchestrator/tools/lsp-tool", () => ({ registerLspTool: vi.fn() }));
vi.mock("../orchestrator/tools/search-text-tools", () => ({ registerSearchTextTool: vi.fn() }));
vi.mock("../orchestrator/tools/ast-grep-tools", () => ({ registerAstGrepTools: vi.fn() }));
vi.mock("../orchestrator/tools/history-tools", () => ({ registerRecallHistoryTool: vi.fn() }));
vi.mock("../orchestrator/tools/wiki-memory-tools", () => ({ registerWikiMemoryTools: vi.fn() }));
vi.mock("../orchestrator/tools/knowledge-base-tools", () => ({ registerKnowledgeBaseTools: vi.fn() }));
vi.mock("../orchestrator/tools/document-tools", () => ({ registerDocumentTools: vi.fn() }));
vi.mock("../orchestrator/tools/zcode-file-tools", () => ({ registerZCodeFileTools: vi.fn() }));
vi.mock("../orchestrator/tools/moments-tools", () => ({ registerMomentsTools: vi.fn() }));
vi.mock("../orchestrator/tools/reminder-tool", () => ({ registerReminderTool: vi.fn() }));
vi.mock("../orchestrator/tools/channel-file-tool", () => ({ registerChannelFileTool: vi.fn() }));
vi.mock("../orchestrator/tools/travel-tools", () => ({ registerTravelTools: vi.fn() }));
vi.mock("../orchestrator/tools/email-tools", () => ({ registerEmailTools: vi.fn() }));
vi.mock("../orchestrator/tools/gmail-tools", () => ({ registerGmailTools: vi.fn() }));

import { createLlmClient } from "./llm/llm-client";
import { createCitaService } from "./cita/cita-service";
import { createSocialContextService } from "./social-context/social-context-service";
import "../moments/moments-service";
import { registerAllTools } from "../orchestrator/tools/registry/tool-registration";

function conflictingSettings(): ModelSettings {
  return {
    provider: "chatgpt", baseUrl: "https://stale.example.test/v1", model: "gpt-6-astra",
    apiKey: "", explicitTransport: "openai", reasoning: { mode: "off" },
    defaultModelProfileId: "selected",
    modelProfiles: [{
      id: "selected", provider: "chatgpt", baseUrl: "https://selected.example.test/v1",
      model: "gpt-6.1-sol", apiKey: "fixture-only", explicitTransport: "openai", reasoning: { mode: "off" },
    }],
  } as ModelSettings;
}

function installApi(text: string) {
  const network = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonResponse(responseBody("openai", { text })));
  vi.stubGlobal("fetch", network);
  return network;
}

function assertSelectedRequest(network: ReturnType<typeof installApi>, model = "gpt-6.1-sol") {
  expect(network).toHaveBeenCalledTimes(1);
  expect(String(network.mock.calls[0][0])).toBe("https://selected.example.test/v1/chat/completions");
  const body = JSON.parse(network.mock.calls[0][1]?.body as string);
  expect(body.model).toBe(model);
  expect(body.stream).not.toBe(true);
}

beforeEach(() => {
  mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), "default-model-consumers-"));
  mocks.loadModelSettings.mockReturnValue(conflictingSettings());
  mocks.loadGeneralSettings.mockReturnValue({ citaEnabled: true, citaSemanticEngine: "remote" });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(mocks.root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("默认模型消费者实际请求的档案归属", () => {
  it("CITA 使用默认档案，即使顶层仍为旧模型且没有 key", async () => {
    const network = installApi(JSON.stringify({
      resolvedReferences: [], focusedEntityRefs: [], contextualizedQuery: "你好", rewriteStatus: "unchanged",
    }));
    const result = await createCitaService({ llmClient: createLlmClient() }).prepareTurn({
      conversationId: "fixture", turnId: "turn-1", originalQuery: "你好", recentDialogue: [],
    });
    expect(result.contextPackage?.semanticStatus).toBe("ready");
    assertSelectedRequest(network);
  });

  it("社会记忆异步提取使用执行时的默认档案", async () => {
    const network = installApi('{"operations":[]}');
    let queued: (() => Promise<void>) | undefined;
    const service = createSocialContextService({
      llmClient: createLlmClient(),
      enqueueLLMTask: async (_label, task) => { queued = task; },
    });
    service.scheduler.schedule({
      conversationId: "fixture", userTurn: { id: "u1", role: "user", text: "我喜欢海边。" },
      assistantTurn: { id: "a1", role: "assistant", text: "海风很舒服。" }, retrievedAtoms: [], now: 100,
    });
    expect(network).not.toHaveBeenCalled();
    const settings = conflictingSettings();
    settings.modelProfiles![0].model = "gpt-6-luna";
    mocks.loadModelSettings.mockReturnValue(settings);
    await queued!();
    assertSelectedRequest(network, "gpt-6-luna");
  });

  it("朋友圈单例实际调用默认档案，并实时跟随默认模型变化", async () => {
    const network = installApi("fixture response");
    expect(await mocks.momentsAgentDeps!.runModel([{ role: "user", content: "fixture" }]))
      .toEqual({ kind: "text", text: "fixture response" });
    assertSelectedRequest(network);
    network.mockClear();
    const settings = conflictingSettings();
    settings.modelProfiles![0].model = "gpt-6-luna";
    mocks.loadModelSettings.mockReturnValue(settings);
    await mocks.momentsAgentDeps!.runModel([{ role: "user", content: "fixture" }]);
    assertSelectedRequest(network, "gpt-6-luna");
  });

  it("翻译工具真实注册与执行使用默认档案，不被顶层空 key 阻断", async () => {
    const network = installApi("你好");
    registerAllTools({ lspManager: {} as never });
    expect(await mocks.tools.get("translate")!.execute({ text: "hello", to: "中文" }))
      .toBe("[translate] 你好");
    assertSelectedRequest(network);
  });
});
