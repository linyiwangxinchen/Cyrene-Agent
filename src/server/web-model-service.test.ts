import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebStore } from "./web-store";
import { modelConfig, requestSessionModel, testModel } from "./web-model-service";
import { responseBody, streamEvents } from "../main/orchestrator/vendors/sdk-stream/model-fixtures";
import { WebFeatureStore } from "./web-feature-store";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(transport: "openai" | "anthropic" | "responses", options: { delay?: number; status?: number } = {}) {
  const requests: Array<{ url?: string; body: any }> = [];
  const server: Server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); requests.push({ url: req.url, body });
    if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
    if (res.destroyed) return;
    if (options.status) { res.writeHead(options.status); res.end(JSON.stringify({ error: { message: "upstream rejected", type: "invalid_request_error" } })); return; }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of streamEvents(transport, { text: "真实的模型回复" })) res.write(`event: ${event.type ?? "data"}\ndata: ${JSON.stringify(event)}\n\n`);
      if (transport === "openai") res.write("data: [DONE]\n\n"); res.end();
    } else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(responseBody(transport, { text: "真实的模型回复" }))); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address() as { port: number };
  const data = await mkdtemp(path.join(os.tmpdir(), "cyrene-model-test-")); cleanup.push(() => rm(data, { recursive: true, force: true }));
  const store = new WebStore(data);
  const profile = { id: "chosen", provider: "自定义端点", model: "default-model", models: ["default-model", "session-model"], baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "test-only-key", explicitTransport: transport };
  await store.setModelProfiles([{ ...profile, id: "other", baseUrl: "http://127.0.0.1:1", model: "wrong" }, profile], "other");
  const session = await store.create({ mode: "chat", identityId: null });
  await store.updateSession(session.id, { modelProfileId: "chosen", model: "session-model" });
  await store.patchMessage(session.id, "user", { role: "user", content: "你好", modelContext: "你好" });
  await store.patchMessage(session.id, "assistant", { content: "", runSnapshot: { status: "running", updatedAt: Date.now() } });
  return { store, session, profile, requests, data };
}

describe("headless model service", () => {
  it("sends the saved thinking effort through the real SDK wire request", async () => {
    const f = await fixture("responses");
    await f.store.setModelProfiles([{ ...f.profile, provider: "ChatGPT（OpenAI）", model: "gpt-6.1-sol", models: ["gpt-6.1-sol"], reasoning: { mode: "on", effort: "high" } }], "chosen");
    await f.store.updateSession(f.session.id, { model: "gpt-6.1-sol" });
    await requestSessionModel(f.store, f.session.id, "你好", { onDelta() {} });
    expect(f.requests[0].body.reasoning).toMatchObject({ effort: "high" });
  });
  it.each(["openai", "anthropic", "responses"] as const)("uses the %s protocol, selected profile/model, and one copy of the user turn", async transport => {
    const f = await fixture(transport);
    const deltas: string[] = [];
    const result = await requestSessionModel(f.store, f.session.id, "你好", { onDelta: delta => { if (delta.type === "text_delta") deltas.push(delta.delta); } });
    expect(result.text).toBe("真实的模型回复"); expect(deltas.join("")).toBe(result.text);
    expect(f.requests[0].body.model).toBe("session-model");
    expect(f.requests[0].url).toBe(transport === "openai" ? "/v1/chat/completions" : transport === "anthropic" ? "/v1/messages" : "/v1/responses");
    const history = f.requests[0].body.messages ?? f.requests[0].body.input;
    const userTextBlocks = history.filter((message: any) => message.role === "user").flatMap((message: any) => typeof message.content === "string" ? [message.content] : message.content.map((block: any) => block.text ?? ""));
    expect(userTextBlocks.filter((text: string) => /(?:^|\n\n)你好$/.test(text))).toHaveLength(1);
    expect(userTextBlocks.some((text: string) => text.includes("<runtime_context>"))).toBe(true);
    expect(userTextBlocks.at(-1)).toMatch(/(?:^|\n\n)你好$/);
    const payload = JSON.stringify(f.requests[0].body);
    expect(payload).toContain("更换底层模型不等于更换昔涟");
    expect(payload).toContain("不要主动讲解模型");
    expect(history.some((message: any) => message.role === "assistant")).toBe(false);
  });
  it("sends saved persona style and user context to the provider and records a successful turn", async () => {
    const f = await fixture("openai");
    const features = new WebFeatureStore(f.data);
    await features.patchProfile({ callPreference: "小夏" });
    await features.patchMemory({ l1: { currentProject: "小夏的菜园" } });
    await requestSessionModel(f.store, f.session.id, "你好", { styleId: "healing" });
    const payload = JSON.stringify(f.requests[0].body);
    expect(payload).toContain("小夏的菜园");
    expect(payload).toContain("称呼偏好：小夏");
    expect(payload).toContain("[表达风格]");
    const { readFile } = await import("node:fs/promises");
    expect(JSON.parse(await readFile(path.join(f.data, "relationship-log.json"), "utf8")).entries).toHaveLength(1);
  });
  it("does not replace delayed replies with a local fallback", async () => {
    const f = await fixture("openai", { delay: 1800 });
    expect((await requestSessionModel(f.store, f.session.id, "你好")).text).toBe("真实的模型回复");
  });
  it("reports provider errors and aborts active requests", async () => {
    const failed = await fixture("openai", { status: 401 });
    expect(await testModel(failed.profile, 5000)).toMatchObject({ ok: false });
    await expect(requestSessionModel(failed.store, failed.session.id, "你好")).rejects.toThrow();
    const delayed = await fixture("openai", { delay: 5000 });
    const controller = new AbortController(); const request = requestSessionModel(delayed.store, delayed.session.id, "你好", { signal: controller.signal });
    setTimeout(() => controller.abort(), 50); await expect(request).rejects.toThrow(/取消|超时/);
  });
  it("aligns known MiniMax bases while preserving custom gateways and explicit protocols", () => {
    expect(modelConfig({ provider: "MiniMax（稀宇科技）", model: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1", explicitTransport: "anthropic" }).baseUrl).toBe("https://api.minimaxi.com/anthropic");
    expect(modelConfig({ model: "custom", baseUrl: "https://example.com/custom/v1", explicitTransport: "anthropic" }).baseUrl).toBe("https://example.com/custom/v1");
  });
});
