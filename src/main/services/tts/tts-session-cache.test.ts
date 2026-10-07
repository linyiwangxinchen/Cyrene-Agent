import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTtsSynthesisService } from "./tts-synthesis-service";
import type { StartTtsRequest } from "../../../shared/tts-session";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(), record: vi.fn(), projection: vi.fn(), cache: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: () => "tts-test-data" } }));
vi.mock("../../settings/settings-facade", () => ({ loadGeneralSettings: mocks.settings }));
vi.mock("../../chats/chats-store", () => ({ getSessionRecord: mocks.record }));
vi.mock("../../orchestrator/conversation-transcript-store", () => ({ getConversationTranscriptStore: () => ({}) }));
vi.mock("../../orchestrator/conversation-journal-service", () => ({
  ConversationJournalService: class { readProjection = mocks.projection; },
}));
vi.mock("../../tts/tts-cache", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../tts/tts-cache")>(), readTtsCacheByKey: mocks.cache,
}));

const request: StartTtsRequest = {
  requestId: "read-1", conversationId: "chat-1", messageId: "assistant-1",
  speechText: "你好", converterVersion: "markdown-v2",
};
const message = {
  id: request.messageId, role: "model", ttsCacheKey: "saved-audio", ttsCacheVersion: request.converterVersion,
};

describe("historical TTS cache across conversation formats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.mockReturnValue({ ttsEngine: "off", ttsAutoRead: false });
    mocks.record.mockReturnValue({ schemaVersion: 2 });
    mocks.projection.mockResolvedValue({ messages: [message] });
    mocks.cache.mockReturnValue({ audio: Buffer.from("saved-wave"), format: "wav" });
  });

  it("reuses the v2 presentation cache with its provider disabled", async () => {
    const result = await createTtsSynthesisService().synthesizeSession(request, new AbortController().signal, vi.fn());
    expect(result).toMatchObject({ status: "ready", cached: true, cacheKey: "saved-audio", base64: Buffer.from("saved-wave").toString("base64") });
    expect(mocks.projection).toHaveBeenCalledWith(request.conversationId);
  });

  it("keeps legacy v1 cache playback without reading a transcript", async () => {
    mocks.record.mockReturnValue({ schemaVersion: 1, messages: [message] });
    expect(await createTtsSynthesisService().synthesizeSession(request, new AbortController().signal, vi.fn())).toMatchObject({ cached: true });
    expect(mocks.projection).not.toHaveBeenCalled();
  });

  it("refuses stale converter versions instead of playing obsolete audio", async () => {
    mocks.projection.mockResolvedValue({ messages: [{ ...message, ttsCacheVersion: "old-v1" }] });
    await expect(createTtsSynthesisService().synthesizeSession(request, new AbortController().signal, vi.fn())).rejects.toThrow("启用 TTS");
    expect(mocks.cache).not.toHaveBeenCalled();
  });

  it("continues honoring the automatic reading switch even when audio is cached", async () => {
    expect(await createTtsSynthesisService().synthesizeSession({ ...request, automatic: true }, new AbortController().signal, vi.fn())).toMatchObject({ status: "skipped" });
    expect(mocks.projection).not.toHaveBeenCalled();
  });

  it("does not return cached audio when cancellation happens during projection loading", async () => {
    const controller = new AbortController();
    mocks.projection.mockImplementation(async () => { controller.abort(); return { messages: [message] }; });
    expect(await createTtsSynthesisService().synthesizeSession(request, controller.signal, vi.fn())).toMatchObject({ status: "cancelled" });
    expect(mocks.cache).not.toHaveBeenCalled();
  });
});
