import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createWebServer, type WebServerHandle } from "./index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function startFixture(): Promise<{ handle: WebServerHandle; base: string; dataDir: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "cyrene-web-"));
  const staticRoot = await mkdtemp(path.join(os.tmpdir(), "cyrene-web-static-"));
  temporaryDirectories.push(dataDir, staticRoot);
  await mkdir(path.join(staticRoot, "web"), { recursive: true });
  await writeFile(path.join(staticRoot, "web", "index.html"), "<main id=cyrene-web-root></main>");
  await writeFile(path.join(staticRoot, "asset.txt"), "asset");
  await writeFile(path.join(staticRoot, "animation.gif"), "GIF89a");

  const handle = createWebServer({
    sharedCore: false, // Migration regression fixture; shared runtime is exercised by verify:shared-core.
    dataDir,
    staticRoot,
    setupToken: "fixture-setup-token",
    secureCookies: false,
    logger: { info() {}, warn() {}, error() {} },
  });
  await new Promise<void>((resolve) => handle.server.listen(0, "127.0.0.1", resolve));
  const address = handle.server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind a TCP port");
  return { handle, base: `http://127.0.0.1:${address.port}`, dataDir };
}

async function closeFixture(handle: WebServerHandle): Promise<void> {
  await handle.close();
}

describe("legacy web data migration regression", () => {
  it("resolves thinking from the chosen model profile, saves it, and emits only scoped changes", async () => {
    const fixture = await startFixture();
    let socket: WebSocket | undefined;
    try {
      const credentials = JSON.stringify({ username: "admin", password: "123456" });
      await fetch(`${fixture.base}/api/auth/bootstrap`, { method: "POST", headers: { "Content-Type": "application/json", "X-Cyrene-Setup-Token": "fixture-setup-token" }, body: credentials });
      const login = await fetch(`${fixture.base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: credentials });
      const headers = { "Content-Type": "application/json", cookie: login.headers.get("set-cookie")!.split(";", 1)[0] };
      const request = async (route: string, method: string, body: unknown) => {
        const response = await fetch(`${fixture.base}${route}`, { method, headers, body: JSON.stringify(body) });
        expect(response.status).toBeLessThan(300); return response.json();
      };
      const events: any[] = [];
      socket = new WebSocket(`${fixture.base.replace("http", "ws")}/ws`, { headers });
      await new Promise<void>((resolve, reject) => { socket!.once("message", () => resolve()); socket!.once("error", reject); });
      socket.on("message", value => events.push(JSON.parse(String(value))));
      const profile = { id: "gpt", provider: "ChatGPT（OpenAI）", baseUrl: "https://example.com/v1", model: "gpt-4o", models: ["gpt-4o", "gpt-6.1-sol"], explicitTransport: "responses" };
      await request("/api/model-profiles", "PUT", { profiles: [profile], defaultModelProfileId: "gpt" });
      await request("/api/settings/config", "PATCH", { thinkingOverride: -1 });
      const state = await request("/api/models/reasoning", "POST", { modelProfileId: "gpt", model: "gpt-6.1-sol" });
      expect(state).toMatchObject({ providerId: "chatgpt", model: "gpt-6.1-sol", thinkingOverride: 0, modelProfileId: "gpt" });
      await request("/api/models/reasoning", "PATCH", { modelProfileId: "gpt", providerKey: profile.provider, preference: { mode: "on", effort: "high" } });
      expect(await request("/api/models/reasoning", "POST", { modelProfileId: "gpt", model: "gpt-6.1-sol" })).toMatchObject({ preference: { mode: "on", effort: "high" } });
      const settings = await (await fetch(`${fixture.base}/api/model-profiles`, { headers })).json() as any;
      const preview = await request("/api/models/preview", "POST", { ...settings.profiles[0], model: "gpt-6.1-sol" });
      expect(preview.reasoning).toMatchObject({ effort: "high" });
      const session = await request("/api/chat/sessions", "POST", { mode: "chat" });
      await request(`/api/chat/sessions/${session.id}`, "PATCH", { modelProfileId: "gpt", model: "gpt-6.1-sol" });
      expect(await request("/api/models/reasoning", "POST", { sessionId: session.id })).toMatchObject({ model: "gpt-6.1-sol", thinkingOverride: 0 });
      await vi.waitFor(() => expect(events.filter(event => event.type === "CHAT_SESSIONS_CHANGED")).toHaveLength(2));
      expect(events.filter(event => event.type === "SETTINGS_CHANGED")).toHaveLength(3);
      expect(events.filter(event => event.type === "SIDEBAR_CHANGED")).toHaveLength(0);
    } finally { socket?.terminate(); await closeFixture(fixture.handle); }
  });
  it("protects bootstrap with the setup token and authenticates with a cookie", async () => {
    const fixture = await startFixture();
    try {
      const jsonHeaders = { "Content-Type": "application/json" };
      const body = JSON.stringify({ username: "admin", password: "a sufficiently long password" });
      expect((await fetch(`${fixture.base}/api/auth/bootstrap`, { method: "POST", headers: jsonHeaders, body })).status).toBe(403);
      expect((await fetch(`${fixture.base}/api/auth/bootstrap`, { method: "POST", headers: { ...jsonHeaders, "X-Cyrene-Setup-Token": "fixture-setup-token" }, body })).status).toBe(201);

      const login = await fetch(`${fixture.base}/api/auth/login`, { method: "POST", headers: jsonHeaders, body });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
      expect(cookie).toBeTruthy();
      const me = await fetch(`${fixture.base}/api/auth/me`, { headers: { cookie: cookie! } });
      expect(await me.json()).toEqual({ ok: true, username: "admin" });
      expect((await fetch(`${fixture.base}/api/private`)).status).toBe(401);
    } finally {
      await closeFixture(fixture.handle);
    }
  });

  it("serves the Web SPA and falls back for extensionless routes", async () => {
    const fixture = await startFixture();
    try {
      expect((await fetch(`${fixture.base}/`)).status).toBe(200);
      expect(await (await fetch(`${fixture.base}/`)).text()).toContain("cyrene-web-root");
      expect(await (await fetch(`${fixture.base}/asset.txt`)).text()).toBe("asset");
      expect((await fetch(`${fixture.base}/chat/session-1`)).status).toBe(200);
      expect((await fetch(`${fixture.base}/avatars/missing.png`)).status).toBe(404);
      expect((await fetch(`${fixture.base}/animation.gif`)).headers.get("content-type")).toContain("image/gif");
      expect((await fetch(`${fixture.base}/asset.txt`)).headers.get("cache-control")).toBe("no-cache");
    } finally {
      await closeFixture(fixture.handle);
    }
  });

  it("only upgrades authenticated WebSocket clients", async () => {
    const fixture = await startFixture();
    try {
      const jsonHeaders = { "Content-Type": "application/json" };
      const body = JSON.stringify({ username: "admin", password: "a sufficiently long password" });
      await fetch(`${fixture.base}/api/auth/bootstrap`, { method: "POST", headers: { ...jsonHeaders, "X-Cyrene-Setup-Token": "fixture-setup-token" }, body });
      const login = await fetch(`${fixture.base}/api/auth/login`, { method: "POST", headers: jsonHeaders, body });
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
      const message = await new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(`${fixture.base.replace("http", "ws")}/ws`, { headers: { cookie } });
        const timer = setTimeout(() => reject(new Error("websocket timeout")), 3_000);
        socket.on("message", (data) => { clearTimeout(timer); socket.close(); resolve(data.toString()); });
        socket.on("error", reject);
      });
      expect(JSON.parse(message)).toMatchObject({ type: "ready", authenticated: true, clientToken: expect.any(String) });
    } finally {
      await closeFixture(fixture.handle);
    }
  });

  it("persists sessions, pending messages, settings, and an AG-UI response", async () => {
    const fixture = await startFixture();
    try {
      const jsonHeaders = { "Content-Type": "application/json" };
      const credentials = JSON.stringify({ username: "admin", password: "123456" });
      await fetch(`${fixture.base}/api/auth/bootstrap`, { method: "POST", headers: { ...jsonHeaders, "X-Cyrene-Setup-Token": "fixture-setup-token" }, body: credentials });
      const login = await fetch(`${fixture.base}/api/auth/login`, { method: "POST", headers: jsonHeaders, body: credentials });
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
      const auth = { ...jsonHeaders, cookie: cookie! };
      const created = await fetch(`${fixture.base}/api/chat/sessions`, { method: "POST", headers: auth, body: JSON.stringify({ mode: "work" }) });
      const session = await created.json() as { id: string };
      await fetch(`${fixture.base}/api/chat/sessions/${session.id}/pending`, { method: "POST", headers: auth, body: JSON.stringify({ id: "user-1", rawContent: "hello", visibleContent: "hello" }) });
      const claim = await fetch(`${fixture.base}/api/chat/sessions/${session.id}/claim`, { method: "POST", headers: auth });
      expect((await claim.json()).claimed).toBe(true);
      const run = await fetch(`${fixture.base}/api/agui/run`, { method: "POST", headers: auth, body: JSON.stringify({ sessionId: session.id, assistantTurnId: "assistant-1", currentUser: { text: "hello" } }) });
      expect((await run.json()).success).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const read = await fetch(`${fixture.base}/api/chat/sessions/${session.id}`, { headers: auth });
      const persisted = await read.json() as { messages: Array<{ content: string }> };
      expect(persisted.messages.some((message) => message.content.includes("尚未配置模型"))).toBe(true);
      expect(persisted.messages.some((message) => message.content.includes("Linux Web 运行时已接管"))).toBe(false);
      const settings = await fetch(`${fixture.base}/api/settings/general`, { method: "PATCH", headers: auth, body: JSON.stringify({ language: "en" }) });
      expect((await settings.json()).general.language).toBe("en");
    } finally {
      await closeFixture(fixture.handle);
    }
  });

  it("persists Linux feature state and exposes workspace feature contracts", async () => {
    const fixture = await startFixture();
    try {
      const jsonHeaders = { "Content-Type": "application/json" };
      const credentials = JSON.stringify({ username: "admin", password: "123456" });
      await fetch(`${fixture.base}/api/auth/bootstrap`, { method: "POST", headers: { ...jsonHeaders, "X-Cyrene-Setup-Token": "fixture-setup-token" }, body: credentials });
      const login = await fetch(`${fixture.base}/api/auth/login`, { method: "POST", headers: jsonHeaders, body: credentials });
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
      const auth = { ...jsonHeaders, cookie: cookie! };
      const memory = await fetch(`${fixture.base}/api/memory`, { method: "PATCH", headers: auth, body: JSON.stringify({ l0: { preferredName: "验收" } }) });
      expect((await memory.json()).l0.preferredName).toBe("验收");
      const collectionResponse = await fetch(`${fixture.base}/api/knowledge/collections`, { method: "POST", headers: auth, body: JSON.stringify({ name: "fixture" }) });
      const collection = await collectionResponse.json() as { id: string };
      const collectionPatch = await fetch(`${fixture.base}/api/knowledge/collections/${collection.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ enabled: true, paths: [{ path: fixture.dataDir, addedAt: Date.now() }] }) });
      expect((await collectionPatch.json()).enabled).toBe(true);
      const schedule = await fetch(`${fixture.base}/api/scheduler`, { method: "POST", headers: auth, body: JSON.stringify({ title: "fixture task", prompt: "test", schedule: { kind: "daily", timeOfDay: "08:00" } }) });
      expect((await schedule.json()).ok).toBe(true);
      const schedules = await fetch(`${fixture.base}/api/scheduler`, { headers: { cookie: cookie! } });
      expect((await schedules.json()).value.length).toBe(1);
      const channels = await fetch(`${fixture.base}/api/channels/config`, { method: "PATCH", headers: auth, body: JSON.stringify({ rateLimitPerUser: 7 }) });
      expect((await channels.json()).rateLimitPerUser).toBe(7);
      const skills = await fetch(`${fixture.base}/api/skills`, { headers: { cookie: cookie! } });
      expect(Array.isArray(await skills.json())).toBe(true);
    } finally {
      await closeFixture(fixture.handle);
    }
  });
});
