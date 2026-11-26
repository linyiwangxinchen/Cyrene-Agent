import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSettings } from "../settings/model-settings";
import type { LlmClient } from "../services/llm/llm-client";
import { AMPHOREUS_REQUEST_TIMEOUT_MS } from "../../shared/amphoreus-world";

const mocks = vi.hoisted(() => ({
  root: "",
  loadModelSettings: vi.fn(),
  chatNonStream: vi.fn<LlmClient["chatNonStream"]>(),
}));

vi.mock("../settings-store", () => ({
  getSettingsPath: () => path.join(mocks.root, "model-settings.json"),
  loadUserProfile: () => ({ timezone: "UTC" }),
}));
vi.mock("../settings/model-settings", async (original) => ({
  ...await original<typeof import("../settings/model-settings")>(),
  loadModelSettings: mocks.loadModelSettings,
}));
vi.mock("../services/llm/llm-client", () => ({
  createLlmClient: () => ({ chatNonStream: mocks.chatNonStream }),
}));

import { XilianWorldStore } from "../xilian-world/world-store";
import { createAmphoreusRuntime } from "./runtime";
import { plan, resolutionOutput, reviewOutput } from "./test-fixtures";

let now: number, store: XilianWorldStore;
const runtimes: ReturnType<typeof createAmphoreusRuntime>[] = [];
const at = (time: string, date = "2026-11-17") => Date.parse(`${date}T${time}:00Z`);
const response = (text: string) => ({ text, finishReason: "stop" });

function conflictingSettings(): ModelSettings {
  return {
    provider: "chatgpt", baseUrl: "https://stale.example.test/v1", model: "gpt-6-astra",
    apiKey: "", explicitTransport: "openai", reasoning: { mode: "off" },
    defaultModelProfileId: "selected",
    modelProfiles: [{
      id: "selected", provider: "chatgpt", baseUrl: "https://selected.example.test/v1",
      model: "gpt-6.1-sol", apiKey: "fixture-only", explicitTransport: "responses", reasoning: { mode: "on", effort: "high" },
    }],
  } as ModelSettings;
}

function runtime() {
  const value = createAmphoreusRuntime(store);
  runtimes.push(value);
  return value;
}

beforeEach(() => {
  mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), "amphoreus-runtime-"));
  now = at("08:00");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  store = new XilianWorldStore(path.join(mocks.root, "amphoreus-world.json"), () => now);
  mocks.loadModelSettings.mockReset().mockReturnValue(conflictingSettings());
  mocks.chatNonStream.mockReset().mockResolvedValue(response(JSON.stringify(plan("2026-11-17"))));
});

afterEach(() => {
  for (const value of runtimes.splice(0)) value.stop();
  vi.restoreAllMocks();
  fs.rmSync(mocks.root, { recursive: true, force: true });
});

describe("shared Amphoreus model runtime", () => {
  it("plans with the saved default profile despite an unusable stale top-level mirror", async () => {
    await runtime().tick();
    expect(mocks.chatNonStream).toHaveBeenCalledTimes(1);
    const [settings, messages, , timeout, label, , options, signal] = mocks.chatNonStream.mock.calls[0];
    expect(settings).toMatchObject({
      model: "gpt-6.1-sol", baseUrl: "https://selected.example.test/v1", apiKey: "fixture-only",
      explicitTransport: "responses", reasoning: { mode: "on", effort: "high" },
    });
    expect(JSON.parse(messages[1].content)).toMatchObject({ date: "2026-11-17", purpose: "plan", timezone: "UTC" });
    expect(timeout).toBe(180_000);
    expect(timeout).toBe(AMPHOREUS_REQUEST_TIMEOUT_MS);
    expect(label).toBe("amphoreus-plan");
    expect(options).toEqual({ maxTokens: 6000 });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    expect(store.readDataSnapshot().amphoreus!.days[0].date).toBe("2026-11-17");
  });

  it("reads a changed default profile when a later daily request begins", async () => {
    const value = runtime();
    await value.tick();
    const settings = conflictingSettings();
    settings.modelProfiles![0].model = "gpt-6-luna";
    mocks.loadModelSettings.mockReturnValue(settings);
    now = at("08:00", "2026-11-18");
    mocks.chatNonStream.mockImplementation(async (_settings, messages) => response(
      JSON.parse(messages[1].content).purpose === "resolve" ? resolutionOutput(store.readDataSnapshot().amphoreus!) : JSON.stringify(plan("2026-11-18")),
    ));
    // Yesterday's pending events settle before a new daily plan is permitted.
    await value.tick();
    await value.tick();
    expect(mocks.chatNonStream.mock.calls.slice(1).every(([config]) => config.model === "gpt-6-luna")).toBe(true);
    expect(store.readDataSnapshot().amphoreus!.days.at(-1)?.date).toBe("2026-11-18");
  });

  it("propagates cancellation to the live model request without accepting late output", async () => {
    let observed: AbortSignal | undefined;
    mocks.chatNonStream.mockImplementation((_settings, _messages, _temperature, _timeout, _label, _reasoning, _options, signal) => {
      observed = signal;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    const value = runtime(), pending = value.tick();
    value.stop();
    await pending;
    expect(observed?.aborted).toBe(true);
    expect(store.readDataSnapshot().amphoreus!.days).toHaveLength(0);
    expect(store.readDataSnapshot().amphoreus!.attempts[0]).toMatchObject({ status: "cancelled", error: "interrupted" });
  });

  it("labels settlement and canon review separately while keeping the same timeout and model", async () => {
    const daily = plan("2026-11-17");
    daily.events[0].severity = "major";
    mocks.chatNonStream.mockResolvedValueOnce(response(JSON.stringify(daily)));
    const value = runtime();
    await value.tick();
    now = at("10:30");
    mocks.chatNonStream.mockImplementation(async (_settings, messages) => response(
      JSON.parse(messages[1].content).purpose === "review"
        ? reviewOutput(messages[1].content)
        : resolutionOutput(store.readDataSnapshot().amphoreus!),
    ));
    await value.tick();
    expect(mocks.chatNonStream.mock.calls.map((call) => call[4])).toEqual(["amphoreus-plan", "amphoreus-resolve", "amphoreus-review"]);
    expect(mocks.chatNonStream.mock.calls.every(([config, , , timeout]) => config.model === "gpt-6.1-sol" && timeout === AMPHOREUS_REQUEST_TIMEOUT_MS)).toBe(true);
    expect(store.readDataSnapshot().amphoreus!.days[0].events[0].status).toBe("completed");
  });
});
