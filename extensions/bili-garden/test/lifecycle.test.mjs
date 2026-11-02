import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { register, unregister } from "../index.mjs";

test("卸载后执行宿主清理不会访问已释放的插件实例", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "garden-lifecycle-"));
  const cleanups = [];
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await register({
    id: "bili-garden",
    signal: new AbortController().signal,
    storage: { rootDir: () => root },
    deps: { llm: { runGoal: async () => {}, listProfiles: async () => [] }, secrets: {} },
    onDispose: cleanup => cleanups.push(cleanup),
    registerIpc: () => {},
    registerTool: () => {},
  });
  await unregister();
  for (const cleanup of cleanups) await cleanup();
});
