import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationMode } from "../shared/chat-types";
import { STYLE_IDS } from "../shared/style-sampling";
import { MODE_PROMPT_FILES } from "../main/orchestrator/mode-prompt-profile-core";
import { formatToneRules } from "../main/orchestrator/tone-rules-core";
import { resolveSummaryMemoryPaths } from "../main/memory/summary-memory-paths";
import { WebStore } from "./web-store";
import { WebFeatureStore } from "./web-feature-store";
import { modelConfig } from "./web-model-service";
import { WebPersonaRuntime, cleanWebHistory, isLegacyWebAssistantReply, resolveWebStyle, shippedPromptRoot } from "./web-persona-runtime";

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture(mode: ConversationMode = "chat") {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "cyrene-persona-")); directories.push(dataDir);
  const store = new WebStore(dataDir);
  const features = new WebFeatureStore(dataDir);
  const runtime = new WebPersonaRuntime(dataDir, { features });
  const session = await store.create({ mode, identityId: null });
  await store.patchMessage(session.id, "user", { role: "user", content: "你好", at: Date.now() });
  const config = modelConfig({ provider: "ChatGPT（OpenAI）", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", reasoning: { mode: "off" } });
  const build = async (options: Record<string, unknown> = {}) => runtime.build({ session: (await store.get(session.id))!, settings: await store.getSettings(), config, prompt: "你好", ...options });
  return { dataDir, store, features, runtime, session, config, build };
}

describe("Web persona parity and continuity", () => {
  it.each(["chat", "work", "code", "learn"] as const)("loads the exact original %s files, with mode isolation", async mode => {
    const f = await fixture(mode);
    const built = await f.build();
    const expected = (await Promise.all(MODE_PROMPT_FILES[mode].map(file => readFile(path.join(shippedPromptRoot(), file), "utf8")))).map(text => text.trim()).join("\n\n---\n\n");
    expect(built.metadata.stablePrefix.startsWith(expected)).toBe(true);
    expect(built.promptFiles).toEqual(MODE_PROMPT_FILES[mode]);
    const soul = (await readFile(path.join(shippedPromptRoot(), "soul.md"), "utf8")).trim();
    expect(built.metadata.stablePrefix.includes(soul)).toBe(mode === "chat");
    expect(built.metadata.stablePrefix).not.toContain("可委托的黄金裔");
    expect(built.metadata.stablePrefix).toContain("不得声称已操作文件");
  });

  it.each(STYLE_IDS)("uses %s style without changing core identity", async styleId => {
    const f = await fixture();
    const baseline = await f.build();
    const styled = await f.build({ styleId });
    expect(styled.metadata.stablePrefix).toBe(baseline.metadata.stablePrefix);
    const context = String(styled.messages.at(-2)?.content);
    expect(context.includes("[表达风格]")).toBe(styleId !== "native" && styleId !== "custom"); // Empty shipped custom template.
    if (styleId === "native" || styleId === "default" || styleId === "custom") expect(styled.sampling).toEqual({});
    if (styleId === "lively") expect(styled.sampling).toMatchObject({ temperature: 0.9, frequencyPenalty: 0.2 });
  });

  it.each(["work", "code"] as const)("does not apply chat styles or sampling to %s", async mode => {
    const f = await fixture(mode);
    const built = await f.build({ styleId: "sweet" });
    expect(String(built.messages.at(-2)?.content)).not.toContain("[表达风格]");
    expect(built.sampling).toEqual({});
  });

  it("keeps saved style precedence and gates unsupported model sampling", async () => {
    const f = await fixture();
    const settings = await f.store.getSettings(); settings.general.currentStyleId = "sweet";
    expect(resolveWebStyle(settings, "native", "02_lively.md")).toBe("native");
    expect(resolveWebStyle(settings, "invalid", "02_lively.md")).toBe("lively");
    expect(resolveWebStyle(settings, "invalid")).toBe("sweet");
    const unknown = modelConfig({ provider: "自定义端点", baseUrl: "https://example.com/v1", model: "unregistered" });
    const built = await f.build({ config: unknown, styleId: "lively" });
    expect(built.sampling).toEqual({});
    expect(String(built.messages.at(-2)?.content)).toContain("[表达风格]");
  });

  it("reads user overrides/custom style and reports missing required assets instead of degrading silently", async () => {
    const f = await fixture();
    await mkdir(path.join(f.dataDir, "prompts"), { recursive: true });
    await writeFile(path.join(f.dataDir, "prompts", "chat_identity.md"), "角色身份覆盖：昔涟");
    await writeFile(path.join(f.dataDir, "prompts", "tone-rules.md"), "---\nversion: 1\n---\n保持清楚、活泼。");
    await mkdir(path.join(f.dataDir, "styles", "custom"), { recursive: true });
    await writeFile(path.join(f.dataDir, "styles", "custom", "custom.md"), "自定义：爱用短句。");
    const built = await f.build({ styleId: "custom" });
    expect(built.metadata.stablePrefix).toContain("角色身份覆盖：昔涟");
    expect(String(built.messages.at(-2)?.content)).toContain("自定义：爱用短句。");
    expect(String(built.messages.at(-2)?.content)).toContain("## 语气规则\n\n保持清楚、活泼。");
    expect(formatToneRules("---\r\nversion: 1\r\n---\r\n规则")).toBe("## 语气规则\n\n规则");
    await writeFile(path.join(f.dataDir, "prompts", "chat_identity.md"), "");
    await expect(f.build()).rejects.toThrow(/chat_identity.md/);
    const empty = new WebPersonaRuntime(f.dataDir, { promptRoot: path.join(f.dataDir, "empty") });
    await expect(empty.build({ session: f.session, settings: await f.store.getSettings(), config: f.config, prompt: "你好" })).rejects.toThrow(/chat_system.md/);
  });

  it("injects persistent profile/memory on every request and respects memory off", async () => {
    const f = await fixture();
    await f.features.patchProfile({ nickname: "小夏", callPreference: "夏夏", gender: "", timezone: "invalid/timezone", replyLanguage: "ja-JP" });
    await f.features.patchMemory({ l0: { preferredName: "旧称呼", permanentNote: "不喜欢被叫宝宝" }, l1: { currentProject: "菜园项目" } });
    await f.runtime.recordTurn("今天好累，别叫我宝宝", "那就慢慢来呀。");
    const built = await f.build();
    const context = String(built.messages.at(-2)?.content);
    expect(context).toContain("称呼偏好：夏夏"); expect(context).toContain("不喜欢被叫宝宝");
    expect(context).toContain("菜园项目"); expect(context).toContain("【近期关系线索】");
    expect(context).toContain("ja-JP"); expect(context).not.toContain("invalid/timezone");
    const reloaded = new WebPersonaRuntime(f.dataDir);
    expect(String((await f.build({ config: { ...f.config, model: "different-model" } })).metadata.stablePrefix)).toBe(built.metadata.stablePrefix);
    const fresh = await reloaded.build({ session: (await f.store.get(f.session.id))!, settings: await f.store.getSettings(), config: f.config, prompt: "你好" });
    expect(String(fresh.messages.at(-2)?.content)).toContain("菜园项目");
    const settings = await f.store.getSettings(); settings.config.memoryMode = "off";
    const off = String((await f.build({ settings })).messages.at(-2)?.content);
    expect(off).toContain("称呼偏好：夏夏");
    expect(off).not.toContain("菜园项目"); expect(off).not.toContain("【近期关系线索】");
  });

  it("loads original session/workspace summary files without advertising nonexistent write tools", async () => {
    const f = await fixture();
    const paths = resolveSummaryMemoryPaths({ conversationId: f.session.id, userDataRoot: f.dataDir, session: f.session });
    await mkdir(path.dirname(paths.sessionPath), { recursive: true });
    await writeFile(paths.sessionPath, "用户正在养一盆薄荷。");
    const built = await f.build();
    expect(String(built.messages.at(-2)?.content)).toContain("用户正在养一盆薄荷");
    expect(built.metadata.stablePrefix).not.toContain("先用 read_file");
  });

  it("activates WorldBook on relevant turns only, and isolates sessions", async () => {
    const f = await fixture();
    const plain = await f.build();
    expect(String(plain.messages.at(-2)?.content)).not.toContain("【已激活的世界知识】");
    const relevant = await f.build({ prompt: "PHILIA093，你从哪来？" });
    expect(String(relevant.messages.at(-2)?.content)).toContain("【已激活的世界知识】");
    expect(String(relevant.messages.at(-2)?.content)).toContain("翁法罗斯之心");
    const nextSession = await f.store.create({ mode: "chat", identityId: null });
    const independent = await f.build({ session: nextSession, prompt: "你好" });
    expect(String(independent.messages.at(-2)?.content)).not.toContain("【已激活的世界知识】");
  });

  it.each(["wechat", "feishu", "qq", "qqbot"] as const)("keeps identity with the original %s channel overlay", async channel => {
    const f = await fixture();
    expect((await f.build({ channel })).metadata.stablePrefix).toContain("【渠道回复方式】");
  });

  it("excludes known migration pollution/errors but preserves stored history and legitimate model/user content", async () => {
    const f = await fixture();
    const placeholder = "已收到：111\n\nLinux Web 运行时已接管本轮请求。你可以继续在当前工作区中提问、创建文件或切换模式。";
    const leaked = "我是 MiniMax-M3。不过本轮系统提示里显示当前是 Linux Web 运行时模式，正在帮你模拟一个终端/编辑器环境。";
    expect(isLegacyWebAssistantReply(placeholder)).toBe(true); expect(isLegacyWebAssistantReply(leaked)).toBe(true);
    expect(isLegacyWebAssistantReply("我是 MiniMax-M3，我可以解释这个模型。")).toBe(false);
    await f.store.patchMessage(f.session.id, "old", { role: "model", content: placeholder });
    await f.store.patchMessage(f.session.id, "leaked", { role: "model", content: leaked });
    await f.store.patchMessage(f.session.id, "genuine", { role: "model", content: "<think>内部推理</think>人家是昔涟呀♪" });
    await f.store.patchMessage(f.session.id, "error", { role: "model", content: "请求失败", runSnapshot: { status: "terminal", terminalStatus: "runtime_error", updatedAt: Date.now() } });
    await f.store.patchMessage(f.session.id, "quoted", { role: "user", content: placeholder, modelContext: `附件说明\n${placeholder}` });
    const session = (await f.store.get(f.session.id))!;
    const history = cleanWebHistory(session, placeholder);
    expect(history.filter(message => message.role === "assistant")).toEqual([expect.objectContaining({ content: "人家是昔涟呀♪" })]);
    expect(history.filter(message => message.role === "user")).toHaveLength(2);
    expect((await f.store.get(f.session.id))!.messages.some(message => message.content === leaked)).toBe(true);
    expect(cleanWebHistory(session, "新的直接请求").at(-1)?.content).toBe("新的直接请求");
  });

  it("waits for first-load data when profile, memory, model and sessions are read concurrently", async () => {
    const f = await fixture();
    await f.features.patchProfile({ nickname: "并发读取用户" });
    await f.features.patchMemory({ l1: { currentProject: "不能丢失" } });
    await f.store.setModelProfiles([{ id: "model", model: "chosen" }], "model");
    const freshFeatures = new WebFeatureStore(f.dataDir);
    const freshStore = new WebStore(f.dataDir);
    const [profile, memory, settings, session] = await Promise.all([freshFeatures.getProfile(), freshFeatures.getMemory(), freshStore.getSettings(), freshStore.get(f.session.id)]);
    expect(profile.nickname).toBe("并发读取用户"); expect(memory.l1.currentProject).toBe("不能丢失");
    expect(settings.defaultModelProfileId).toBe("model"); expect(session?.id).toBe(f.session.id);
  });
});
