import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ file: "" }));
vi.mock("../settings-store", () => ({ getSettingsPath: () => fixture.file }));
vi.mock("electron", () => ({ app: { getPath: () => path.dirname(fixture.file) } }));

const provider = "ChatGPT（OpenAI）";
const astra = "gpt-6-astra";
const sol = "gpt-6.1-sol";
const original = {
  id: "default", provider, model: astra, models: [astra, sol],
  apiKey: "fixture-old", baseUrl: "https://old.invalid/v1", explicitTransport: "responses" as const,
};
let directory: string;
let settings: typeof import("./model-settings");

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-model-profile-"));
  fixture.file = path.join(directory, "model-settings.json");
  fs.writeFileSync(fixture.file, JSON.stringify({
    ...original, schemaVersion: 5,
    perProvider: { [provider]: original },
    modelProfiles: [original, { ...original, id: "secondary", model: sol }],
    defaultModelProfileId: original.id,
  }));
  settings = await import("./model-settings");
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe("default model profile persistence", () => {
  it("editing the default updates legacy consumers immediately and after restart", async () => {
    expect(settings.loadModelSettings().model).toBe(astra);
    settings.saveModelProfile({ ...original, model: sol, apiKey: "fixture-new", baseUrl: "https://new.invalid/v1" });
    const current = settings.loadModelSettings();
    expect(current).toMatchObject({ model: sol, apiKey: "fixture-new", baseUrl: "https://new.invalid/v1" });
    expect(current.perProvider[provider]).toMatchObject({ model: sol, models: [astra, sol] });
    expect(settings.resolveModelSettingsProfile(current).model).toBe(sol);
    vi.resetModules();
    const restarted = await import("./model-settings");
    expect(restarted.loadModelSettings().model).toBe(sol);
  });

  it("editing a secondary profile preserves the default and explicit session choices", () => {
    settings.saveModelProfile({ ...original, id: "secondary", model: sol });
    const current = settings.loadModelSettings();
    expect(current.model).toBe(astra);
    expect(settings.resolveModelSettingsProfile(current).model).toBe(astra);
    expect(settings.resolveSessionModelSettings(current, { modelProfileId: "secondary", model: sol }).model).toBe(sol);
    settings.saveModelProfile({ ...original, model: sol });
    expect(settings.resolveSessionModelSettings(settings.loadModelSettings(), { modelProfileId: "default", model: astra }).model).toBe(astra);
  });

  it("retains per-model options and generation settings when changing defaults and saving unrelated settings", () => {
    const manualReasoning = { style: "openai-effort" as const, supportedEfforts: ["high"], defaultEffort: "high", supportsDisable: false };
    settings.saveModelProfile({ ...original, id: "secondary", model: sol,
      modelOptions: { [sol]: { multimodal: false, contextWindowTokens: 128000, manualReasoning } },
      imageGeneration: { enabled: true, model: "fixture-image" },
    });
    settings.setDefaultModelProfile("secondary");
    settings.saveModelSettings({ stickerEnabled: false });
    const mirrored = settings.loadModelSettings().perProvider[provider];
    expect(mirrored.models).toEqual([astra, sol]);
    expect(mirrored.modelOptions?.[sol]).toMatchObject({ multimodal: false, contextWindowTokens: 128000, manualReasoning });
    expect(mirrored.imageGeneration).toEqual({ enabled: true, model: "fixture-image" });
  });

  it("reports the effective default even when a legacy mirror is stale", () => {
    const current = settings.normalizeModelSettings({ ...settings.loadModelSettings(),
      modelProfiles: [{ ...original, model: sol }],
    });
    expect(current.model).toBe(astra);
    expect(settings.getPublicModelConfig(current).model).toBe(sol);
  });
});
