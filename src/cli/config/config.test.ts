import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyConfig,
  createTemplate,
  loadConfigFile,
  redactDocument,
  resolveConfigDocument,
  writeTemplate,
} from "./config";

const tempRoots: string[] = [];
const originalKey = process.env.CYRENE_CONFIG_TEST_KEY;
const originalWechatToken = process.env.CYRENE_CONFIG_TEST_WECHAT_TOKEN;

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalKey === undefined) delete process.env.CYRENE_CONFIG_TEST_KEY;
  else process.env.CYRENE_CONFIG_TEST_KEY = originalKey;
  if (originalWechatToken === undefined) delete process.env.CYRENE_CONFIG_TEST_WECHAT_TOKEN;
  else process.env.CYRENE_CONFIG_TEST_WECHAT_TOKEN = originalWechatToken;
});

function temp(): string {
  const root = mkdtempSync(path.join(tmpdir(), "cyrene-config-test-"));
  tempRoots.push(root);
  return root;
}

describe("CLI config file", () => {
  it("creates a template without inline secrets", () => {
    const template = createTemplate("web");
    expect(template.target).toBe("web");
    expect(template.model?.apiKey).toBeUndefined();
    expect(template.model?.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(template.wechat?.credentials?.botToken).toBeUndefined();
    expect(template.wechat?.credentials?.botTokenEnv).toBe("CYRENE_WECHAT_BOT_TOKEN");
  });

  it("resolves environment-backed secrets and redacts them for display", () => {
    process.env.CYRENE_CONFIG_TEST_KEY = "model-secret";
    process.env.CYRENE_CONFIG_TEST_WECHAT_TOKEN = "wechat-secret";
    const document = {
      version: 1 as const,
      target: "web" as const,
      model: { provider: "Test", baseUrl: "http://127.0.0.1:8000/v1", model: "test-model", apiKeyEnv: "CYRENE_CONFIG_TEST_KEY" },
      wechat: {
        enabled: true,
        credentials: { botTokenEnv: "CYRENE_CONFIG_TEST_WECHAT_TOKEN", ilinkBotId: "bot-1" },
      },
    };
    const resolved = resolveConfigDocument(document, "inline.json");
    expect(resolved.model?.apiKey).toBe("model-secret");
    expect(resolved.wechat?.credentials?.botToken).toBe("wechat-secret");
    const redacted = redactDocument(document);
    expect(JSON.stringify(redacted)).not.toContain("model-secret");
    expect(JSON.stringify(redacted)).not.toContain("wechat-secret");
  });

  it("applies desktop model, channel and WeChat credentials", () => {
    process.env.CYRENE_CONFIG_TEST_KEY = "model-secret";
    process.env.CYRENE_CONFIG_TEST_WECHAT_TOKEN = "wechat-secret";
    const root = temp();
    const resolved = resolveConfigDocument({
      version: 1,
      target: "desktop",
      model: { provider: "Test", baseUrl: "http://127.0.0.1:8000/v1", model: "test-model", apiKeyEnv: "CYRENE_CONFIG_TEST_KEY" },
      wechat: {
        enabled: true,
        toolSandbox: "off",
        allowedUserIds: ["wx-user"],
        credentials: { botTokenEnv: "CYRENE_CONFIG_TEST_WECHAT_TOKEN", ilinkBotId: "bot-1", ilinkUserId: "user-1" },
      },
    }, "inline.json");
    const result = applyConfig(resolved, "desktop", root);
    expect(result.target).toBe("desktop");
    const model = JSON.parse(readFileSync(path.join(root, "model-settings.json"), "utf8"));
    expect(model.defaultModelProfileId).toBe(resolved.model?.profileId);
    expect(model.modelProfiles[0].apiKey).toBe("model-secret");
    const channels = JSON.parse(readFileSync(path.join(root, "channels-settings.json"), "utf8"));
    expect(channels.wechat).toMatchObject({ enabled: true, toolSandbox: "off", allowedUserIds: ["wx-user"] });
    const credentials = JSON.parse(readFileSync(path.join(root, "weixin", "credentials.json"), "utf8"));
    expect(credentials).toMatchObject({ botToken: "wechat-secret", ilinkBotId: "bot-1", ilinkUserId: "user-1" });
  });

  it("applies Web data while preserving existing sessions", () => {
    process.env.CYRENE_CONFIG_TEST_KEY = "model-secret";
    const root = temp();
    writeFileSync(path.join(root, "web-data.json"), JSON.stringify({ version: 1, sessions: [{ id: "keep" }], settings: { general: { language: "zh-CN" } } }));
    const file = path.join(root, "cyrene.config.json");
    writeTemplate(file, "web", true);
    const document = {
      version: 1 as const,
      target: "web" as const,
      model: { provider: "Test", baseUrl: "https://example.test/v1", model: "test", apiKeyEnv: "CYRENE_CONFIG_TEST_KEY" },
      wechat: { enabled: false },
    };
    writeFileSync(file, JSON.stringify(document, null, 2));
    const loaded = loadConfigFile(file);
    applyConfig(loaded.resolved, "web", root);
    const saved = JSON.parse(readFileSync(path.join(root, "web-data.json"), "utf8"));
    expect(saved.sessions).toEqual([{ id: "keep" }]);
    expect(saved.settings.defaultModelProfileId).toBe(loaded.resolved.model?.profileId);
    const features = JSON.parse(readFileSync(path.join(root, "web-features.json"), "utf8"));
    expect(features.channels.wechat.enabled).toBe(false);
  });

  it("does not erase an existing API key when a patch omits the key", () => {
    const root = temp();
    writeFileSync(path.join(root, "model-settings.json"), JSON.stringify({
      provider: "Existing",
      apiKey: "keep-me",
      model: "old",
      baseUrl: "https://old.example/v1",
      perProvider: { Existing: { apiKey: "keep-me", model: "old", baseUrl: "https://old.example/v1" } },
      modelProfiles: [{ id: "cli-existing-old", provider: "Existing", apiKey: "keep-me", model: "old", baseUrl: "https://old.example/v1", explicitTransport: "openai" }],
      defaultModelProfileId: "cli-existing-old",
    }));
    const resolved = resolveConfigDocument({
      target: "desktop",
      model: { profileId: "cli-existing-old", provider: "Existing", baseUrl: "https://new.example/v1", model: "new" },
    });
    applyConfig(resolved, "desktop", root);
    const saved = JSON.parse(readFileSync(path.join(root, "model-settings.json"), "utf8"));
    expect(saved.apiKey).toBe("keep-me");
    expect(saved.modelProfiles.find((item: { id: string }) => item.id === resolved.model?.profileId).apiKey).toBe("keep-me");
  });
});
