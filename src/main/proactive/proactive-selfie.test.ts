import { describe, expect, it, vi } from "vitest";
import { buildProactiveSelfieMessages, generateProactiveSelfie, selfieOpportunity, selfieSlot } from "./proactive-selfie";

const config = { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-test", apiKey: "k", explicitTransport: "responses" as const };

describe("selfie opportunity", () => {
  it("only opens in daytime slots", () => {
    expect(selfieSlot(8)).toBeUndefined();
    expect(selfieSlot(11)).toBe("morning");
    expect(selfieSlot(14)).toBeUndefined();
    expect(selfieSlot(16)).toBe("afternoon");
    expect(selfieSlot(20)).toBe("evening");
    expect(selfieSlot(23)).toBeUndefined();
  });

  it("uses one stable source per date and slot", () => {
    const opportunity = selfieOpportunity({ now: 1, localDate: "2026-11-22", localHour: 16, conversationId: "wx", location: "序页城", activity: "整理花束" });
    expect(opportunity).toMatchObject({ id: "selfie:2026-11-22:afternoon", source: "selfie", sourceEventId: "selfie:2026-11-22:afternoon",
      evidenceVersion: "afternoon", conversationId: "wx", replyBurden: "none" });
    expect(opportunity?.summary).toContain("序页城，整理花束");
    expect(selfieOpportunity({ now: 1, localDate: "2026-11-22", localHour: 3, conversationId: "wx" })).toBeUndefined();
  });
});

describe("generateProactiveSelfie", () => {
  it("asks for a medium quality image and saves the first result", async () => {
    const image = { id: "img", toolCallId: "img", base64: "AA==", mime: "image/png" as const };
    const generate = vi.fn(async () => ({ text: "", toolCalls: [], generatedImages: [image] }) as never);
    const save = vi.fn(async () => ({ id: "a", kind: "image", source: "model", status: "done", name: "x.png", filePath: "/x.png", byteLength: 1 }) as never);
    const saved = await generateProactiveSelfie({ config, imageModel: "gpt-image-2", scene: "在花园里", referencePaths: [], conversationId: "wx",
      store: { save }, generate });
    expect(saved).toMatchObject({ filePath: "/x.png" });
    expect(save).toHaveBeenCalledWith({ conversationId: "wx", image });
    const request = (generate.mock.calls[0] as unknown as [{ request: { imageGeneration: unknown } }])[0].request;
    expect(request.imageGeneration).toEqual({ enabled: true, model: "gpt-image-2", quality: "medium" });
  });

  it("returns nothing when the model produced no image", async () => {
    const generate = vi.fn(async () => ({ text: "好呀", toolCalls: [] }) as never);
    const save = vi.fn();
    expect(await generateProactiveSelfie({ config, imageModel: "gpt-image-2", scene: "x", referencePaths: [], conversationId: "wx", store: { save }, generate })).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });

  it("skips providers without the Responses protocol", async () => {
    const generate = vi.fn();
    expect(await generateProactiveSelfie({ config: { ...config, explicitTransport: "anthropic" as const, provider: "anthropic" }, imageModel: "gpt-image-2",
      scene: "x", referencePaths: [], conversationId: "wx", store: { save: vi.fn() }, generate })).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps the appearance constraints and ignores unreadable references", () => {
    const messages = buildProactiveSelfieMessages("在花园里", ["/missing/ref.png"]);
    expect(String(messages[0].content)).toContain("精灵耳");
    expect(JSON.stringify(messages[1].content)).toContain("在花园里");
    expect(JSON.stringify(messages[1].content)).not.toContain("image_url");
  });
});
