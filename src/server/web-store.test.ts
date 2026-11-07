import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { WebStore } from "./web-store";

it("folds original renderer checkpoint deltas into stored messages and survives reload and replay", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "cyrene-checkpoint-"));
  try {
    const store = new WebStore(dataDir);
    const session = await store.create({ mode: "chat", identityId: null });
    const patch = { delta: {
      reasoningBlockUpserts: [{ id: "r", content: "分析", afterToolCount: 0 }],
      processMessageUpserts: [{ id: "p", content: "模型请求失败：", afterToolCount: 0 }],
    } };
    expect(await store.checkpointPresentation(session.id, "answer", "1", patch)).toEqual({ ok: true });
    await store.checkpointPresentation(session.id, "answer", "2", { delta: {
      reasoningBlockAppends: [{ id: "r", content: "完成" }],
      processMessageAppends: [{ id: "p", content: "测试错误" }],
    } });
    const restarted = new WebStore(dataDir);
    await restarted.checkpointPresentation(session.id, "answer", "2", { delta: { processMessageAppends: [{ id: "p", content: "重复" }] } });
    const answer = (await restarted.get(session.id))!.messages[0];
    expect(answer.reasoningBlocks?.[0].content).toBe("分析完成");
    expect(answer.reasoning).toBe("分析完成");
    expect(answer.processMessages?.[0].content).toBe("模型请求失败：测试错误");
    expect(answer).not.toHaveProperty("delta");
    await expect(restarted.checkpointPresentation(session.id, "answer", "bad", { role: "user" })).rejects.toThrow("INVALID_PRESENTATION_PATCH");
    await expect(restarted.checkpointPresentation(session.id, "answer", "bad", { delta: { processMessageAppends: "invalid" } })).rejects.toThrow();
    const file = path.join(dataDir, "web-data.json");
    const legacy = JSON.parse(await readFile(file, "utf8"));
    legacy.sessions[0].messages.push({ id: "legacy-error", role: "model", content: "", delta: { processMessageUpserts: [{ id: "old-error", content: "模型请求失败：旧网关中断", afterToolCount: 0 }] } });
    await writeFile(file, JSON.stringify(legacy));
    const recovered = (await new WebStore(dataDir).get(session.id))!.messages[1];
    expect(recovered.processMessages?.[0].content).toContain("旧网关中断");
    expect(recovered).not.toHaveProperty("delta");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

it("recovers after a rejected snapshot write and keeps returned sessions detached", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "cyrene-store-write-chain-"));
  try {
    const store = new WebStore(dataDir);
    const rejected = Promise.reject(new Error("transient"));
    rejected.catch(() => undefined);
    (store as unknown as { writeChain: Promise<void> }).writeChain = rejected;
    const created = await store.create({ mode: "chat", identityId: null, title: "原始标题" });
    created.title = "外部修改";
    expect((await store.get(created.id))?.title).toBe("原始标题");
    await store.rename(created.id, "持久化标题");
    await store.setPinned(created.id, true);
    expect(await store.get(created.id)).toMatchObject({ title: "持久化标题", pinned: true });
    expect(await new WebStore(dataDir).get(created.id)).toMatchObject({ title: "持久化标题", pinned: true });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

it("limits pending queue growth and deep-clones settings", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "cyrene-store-limits-"));
  try {
    const store = new WebStore(dataDir);
    const session = await store.create({ mode: "chat", identityId: null });
    for (let index = 0; index < 100; index += 1) {
      expect((await store.enqueue(session.id, { id: `q-${index}`, rawContent: "x", visibleContent: "x" })).ok).toBe(true);
    }
    expect(await store.enqueue(session.id, { id: "q-overflow", rawContent: "x", visibleContent: "x" })).toEqual({ ok: false, error: "PENDING_QUEUE_LIMIT_REACHED" });
    const settings = await store.getSettings();
    (settings.config as Record<string, unknown>).nested = { changed: true };
    expect((await store.getSettings()).config).not.toHaveProperty("nested");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

it("redacts model credentials while allowing blank browser edits to retain them", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "cyrene-store-secrets-"));
  try {
    const store = new WebStore(dataDir);
    await store.setModelProfiles([{ id: "p", model: "m", apiKey: "sk-secret" }], "p");
    expect((await store.getPublicModelProfiles())[0]).toMatchObject({ apiKey: "", hasApiKey: true });
    expect(JSON.stringify(await store.getPublicSettings())).not.toContain("sk-secret");
    await store.setModelProfiles([{ id: "p", model: "m2", apiKey: "" }], "p");
    expect((await store.getSettings()).modelProfiles[0]?.apiKey).toBe("sk-secret");
    await store.setModelProfiles([{ id: "p", model: "m2", apiKey: "", clearApiKey: true }], "p");
    expect((await store.getSettings()).modelProfiles[0]?.apiKey).toBe("");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
