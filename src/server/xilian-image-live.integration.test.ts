import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createWebServer, type WebServerHandle } from "./index";

const live = process.env.CYRENE_RUN_LIVE_IMAGE_TEST === "1";
const liveUpstream = process.env.CYRENE_LIVE_IMAGE_UPSTREAM;
const liveApiKey = process.env.CYRENE_LIVE_IMAGE_API_KEY;
const LIVE_IMAGE = "给昔涟生成一张自拍图片，请实际调用图片生成工具并把图片返回到当前会话。";
const ORDINARY_IMAGE = "请生成一张普通的海边日落风景图片，请实际调用图片生成工具并把图片返回到当前会话。";
const resources: Array<{ close: () => Promise<void> }> = [];

interface ProxyTrace {
  request?: { url?: string; model?: unknown; stream?: unknown; tools?: unknown; inputType?: unknown };
  response?: { status: number; body: string };
}

function summarizeUpstreamResponse(raw: string): string {
  const lines = raw.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const candidates = [...lines.filter(line => line.startsWith("data:")), raw];
  for (const candidate of candidates) {
    const payload = candidate.startsWith("data:") ? candidate.slice(5).trim() : candidate;
    if (!payload || payload === "[DONE]") continue;
    try {
      const value = JSON.parse(payload) as Record<string, any>;
      const response = value.response && typeof value.response === "object" ? value.response : value;
      const error = response.error && typeof response.error === "object" ? response.error : undefined;
      if (error || response.status === "failed" || response.status === "incomplete") {
        return JSON.stringify({
          type: value.type,
          status: response.status,
          error: error ? {
            type: error.type,
            code: error.code,
            message: error.message,
            param: error.param,
          } : undefined,
        });
      }
    } catch {
      // The proxy may receive a partial SSE frame. Keep searching without
      // retaining the provider response body in the trace.
    }
  }
  return "stream completed";
}

async function startForwarder(upstreamBase: string): Promise<{ base: string; trace: ProxyTrace; server: Server }> {
  const trace: ProxyTrace = {};
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* response will expose the upstream failure */ }
    trace.request = {
      url: request.url,
      model: body.model,
      stream: body.stream,
      tools: Array.isArray(body.tools) ? body.tools.map((tool: any) => ({ type: tool?.type, name: tool?.name, model: tool?.model, size: tool?.size, quality: tool?.quality, partialImages: tool?.partialImages })) : body.tools,
      inputType: Array.isArray(body.input) ? "array" : typeof body.input,
    };
    const target = `${upstreamBase.replace(/\/$/u, "")}${String(request.url ?? "").replace(/^\/v1/u, "")}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (["host", "content-length", "connection"].includes(key)) continue;
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(","));
    }
    try {
      const upstream = await fetch(target, { method: request.method, headers, body: raw || undefined });
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, key) => { if (!['content-length', 'content-encoding', 'transfer-encoding'].includes(key)) responseHeaders[key] = value; });
      response.writeHead(upstream.status, responseHeaders);
      let responseBody = "";
      if (upstream.body) {
        const reader = upstream.body.getReader();
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          const bytes = Buffer.from(part.value);
          if (responseBody.length < 40_000) responseBody += bytes.toString("utf8").slice(0, 40_000 - responseBody.length);
          response.write(bytes);
        }
      }
      response.end();
      trace.response = { status: upstream.status, body: summarizeUpstreamResponse(responseBody) };
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
      trace.response = { status: 502, body: String(error) };
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("live image forwarder did not bind");
  return { base: `http://127.0.0.1:${address.port}/v1`, trace, server };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function json(response: Response): Promise<any> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const testLive = live && liveUpstream && liveApiKey ? it : it.skip;

describe("Linux Web real Xilian image request", () => {
  afterEach(async () => {
    for (const resource of resources.splice(0).reverse()) await resource.close();
  });

  testLive("runs ordinary image generation and Xilian selfie through the same isolated Responses upstream", async () => {
    // These variables are test-only inputs. The Web runtime receives its model
    // profile through /api/model-profiles and never reads the host Codex config.
    const upstreamBase = liveUpstream!;
    const apiKey = liveApiKey!;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "cyrene-live-image-web-"));
    resources.push({ close: () => rm(dataDir, { recursive: true, force: true }) });
    const forwarder = await startForwarder(upstreamBase);
    resources.push({ close: () => closeServer(forwarder.server) });
    const handle: WebServerHandle = createWebServer({
      sharedCore: false,
      dataDir,
      setupToken: "live-image-setup",
      secureCookies: false,
      logger: { info() {}, warn() {}, error() {} },
    });
    await new Promise<void>((resolve) => handle.server.listen(0, "127.0.0.1", resolve));
    resources.push({ close: handle.close });
    const address = handle.server.address();
    if (!address || typeof address === "string") throw new Error("live Web server did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "content-type": "application/json" };
    const credentials = JSON.stringify({ username: "admin", password: "a sufficiently long live password" });
    expect((await fetch(`${base}/api/auth/bootstrap`, { method: "POST", headers: { ...headers, "x-cyrene-setup-token": "live-image-setup" }, body: credentials })).status).toBe(201);
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers, body: credentials });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Web login did not return a cookie");
    const auth = { ...headers, cookie };
    const profile = {
      id: "live-image-profile",
      provider: "ChatGPT（OpenAI）",
      baseUrl: forwarder.base,
      model: "gpt-6-astra",
      models: ["gpt-6-astra"],
      apiKey,
      explicitTransport: "responses",
      imageGeneration: { enabled: true, model: "gpt-image-2.5-flare" },
    };
    const profileResponse = await fetch(`${base}/api/model-profiles`, { method: "PUT", headers: auth, body: JSON.stringify({ profiles: [profile], defaultModelProfileId: profile.id }) });
    expect(profileResponse.status).toBeLessThan(300);
    const sessionResponse = await fetch(`${base}/api/chat/sessions`, { method: "POST", headers: auth, body: JSON.stringify({ mode: "chat" }) });
    const session = await json(sessionResponse) as { id: string };
    expect(session.id).toBeTruthy();
    const patch = await fetch(`${base}/api/chat/sessions/${session.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ modelProfileId: profile.id, model: profile.model }) });
    expect(patch.status).toBeLessThan(300);

    const events: any[] = [];
    const socket = new WebSocket(`${base.replace(/^http/u, "ws")}/ws`, { headers: { cookie } });
    resources.push({ close: async () => socket.terminate() });
    await new Promise<void>((resolve, reject) => { socket.once("message", () => resolve()); socket.once("error", reject); });
    socket.on("message", value => events.push(JSON.parse(String(value))));
    for (const [index, prompt] of [ORDINARY_IMAGE, LIVE_IMAGE].entries()) {
      const start = events.length;
      const runResponse = await fetch(`${base}/api/agui/run`, { method: "POST", headers: auth, body: JSON.stringify({ sessionId: session.id, assistantTurnId: `live-assistant-${index}`, currentUser: { text: prompt } }) });
      expect((await json(runResponse)).success).toBe(true);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`live image timed out; trace=${JSON.stringify(forwarder.trace)}`)), 240_000);
        const check = () => {
          if (events.slice(start).some(event => event.type === "RUN_FINISHED" || event.type === "RUN_ERROR")) { clearTimeout(timer); resolve(); return; }
          setTimeout(check, 100);
        };
        check();
      });
      const error = events.slice(start).find(event => event.type === "RUN_ERROR");
      if (error) throw new Error(`真实 Web 生图失败：${JSON.stringify({ prompt, error, trace: forwarder.trace })}`);
      const persisted = await json(await fetch(`${base}/api/chat/sessions/${session.id}`, { headers: { cookie } })) as { messages?: Array<{ id?: string; attachments?: unknown[] }> };
      const assistant = persisted.messages?.find(message => message.id === `live-assistant-${index}`);
      expect(assistant?.attachments?.length, `场景未产生图片附件：${prompt}`).toBeGreaterThan(0);
    }
  }, 300_000);
});
