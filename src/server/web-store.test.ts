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
