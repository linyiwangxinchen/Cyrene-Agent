import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../app";
import { checkDataDir, checkModel, checkNode, checkWechat, checkWebService, checkSqlite } from "./doctor";

let dir: string;
let home: string;
let stdout = "";
const spies: Array<{ mockRestore(): void }> = [];

function write(name: string, value: unknown): void {
  const file = path.join(dir, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

async function stubServer(ready: boolean): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/healthz") { response.end(JSON.stringify({ ok: true, service: "cyrene-web", initialized: true })); return; }
    if (request.url === "/readyz") { response.statusCode = ready ? 200 : 503; response.end(JSON.stringify({ ready })); return; }
    response.statusCode = 401; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cyrene-doctor-"));
  home = mkdtempSync(path.join(tmpdir(), "cyrene-doctor-home-"));
  process.env.CYRENE_HOME = home;
  stdout = "";
  spies.push(vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; }));
  spies.push(vi.spyOn(process.stderr, "write").mockImplementation(() => true));
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  delete process.env.CYRENE_HOME;
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("doctor checks", () => {
  it("node version", () => {
    expect(checkNode("24.1.0").status).toBe("ok");
    expect(checkNode("22.9.0").status).toBe("fail");
  });

  it("data directory: writable, missing, and missing parent is creatable", () => {
    expect(checkDataDir(dir).status).toBe("ok");
    expect(checkDataDir(path.join(dir, "a", "b")).status).toBe("warn");
  });

  it("model: reports the default profile and only whether an apiKey exists", () => {
    write("model-settings.json", { modelProfiles: [{ id: "p1", provider: "OpenAI", model: "gpt", baseUrl: "https://api.example.test/v1", apiKey: "sk-very-secret" }], defaultModelProfileId: "p1" });
    const results = checkModel(dir);
    expect(results.map((item) => item.status)).toEqual(["ok", "ok"]);
    expect(JSON.stringify(results)).not.toContain("sk-very-secret");
  });

  it("model: missing apiKey fails unless the model is on loopback", () => {
    write("model-settings.json", { modelProfiles: [{ id: "p1", provider: "X", model: "m", baseUrl: "https://api.example.test" }], defaultModelProfileId: "p1" });
    expect(checkModel(dir)[1].status).toBe("fail");
    write("model-settings.json", { modelProfiles: [{ id: "p1", provider: "Ollama", model: "m", baseUrl: "http://127.0.0.1:11434/v1" }], defaultModelProfileId: "p1" });
    expect(checkModel(dir)[1].status).toBe("ok");
  });

  it("model: falls back to legacy web-data.json, and fails without profiles or with corrupt JSON", () => {
    write("web-data.json", { settings: { modelProfiles: [{ id: "w", provider: "P", model: "m", baseUrl: "https://x.test", apiKey: "k" }], defaultModelProfileId: "w" } });
    expect(checkModel(dir)[0].detail).toContain("默认档案 w");
    rmSync(path.join(dir, "web-data.json"));
    expect(checkModel(dir)[0].status).toBe("fail");
    write("model-settings.json", "{broken");
    expect(checkModel(dir)[0].status).toBe("fail");
  });

  it("wechat: disabled is fine, enabled needs credentials, token never shown", () => {
    expect(checkWechat(dir).status).toBe("ok");
    write("channels-settings.json", { wechat: { enabled: true, allowedUserIds: ["a"] } });
    expect(checkWechat(dir).status).toBe("fail");
    write("weixin/credentials.json", { botToken: "bot-secret", ilinkBotId: "bot" });
    const result = checkWechat(dir);
    expect(result.status).toBe("ok");
    expect(JSON.stringify(result)).not.toContain("bot-secret");
  });

  it("sqlite is available on Node 24", async () => {
    expect((await checkSqlite()).status).toBe("ok");
  });

  it("web service: ready, not ready, and unreachable", async () => {
    const good = await stubServer(true);
    const bad = await stubServer(false);
    try {
      const okResults = await checkWebService(good.url, true);
      expect(okResults.find((item) => item.id === "web")?.status).toBe("ok");
      expect(okResults.find((item) => item.id === "web-ready")?.status).toBe("ok");
      expect((await checkWebService(bad.url, true)).find((item) => item.id === "web-ready")?.status).toBe("fail");
    } finally {
      good.server.close();
      bad.server.close();
    }
    expect((await checkWebService("http://127.0.0.1:1", true))[0].status).toBe("fail");
    expect((await checkWebService("http://127.0.0.1:1", false))[0].status).toBe("warn");
  });
});

describe("cyrene doctor command", () => {
  it("exits 0 on a healthy fixture and prints ✓ lines", async () => {
    write("model-settings.json", { modelProfiles: [{ id: "p1", provider: "P", model: "m", baseUrl: "https://x.test", apiKey: "secret-key" }], defaultModelProfileId: "p1" });
    const stub = await stubServer(true);
    try {
      expect(await main(["doctor", "--target", "web", "--data-dir", dir, "--server", stub.url])).toBe(0);
    } finally {
      stub.server.close();
    }
    expect(stdout).toContain("✓ 模型配置");
    expect(stdout).not.toContain("secret-key");
  });

  it("exits 1 with fix hints when checks fail, and --json reports ok=false", async () => {
    expect(await main(["doctor", "--target", "web", "--data-dir", dir, "--server", "http://127.0.0.1:1"])).toBe(1);
    expect(stdout).toContain("✗ 模型配置");
    expect(stdout).toContain("修复：");
    stdout = "";
    expect(await main(["doctor", "--data-dir", dir, "--server", "http://127.0.0.1:1", "--json"])).toBe(1);
    expect(JSON.parse(stdout).ok).toBe(false);
  });

  it("rejects an invalid target with exit 2", async () => {
    expect(await main(["doctor", "--target", "mobile"])).toBe(2);
  });
});
