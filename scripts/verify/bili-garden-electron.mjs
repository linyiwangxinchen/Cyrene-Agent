import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = mkdtempSync(path.join(os.tmpdir(), "cyrene-garden-electron-"));
const entry = path.resolve("dist/main/plugins/bili-garden/index.mjs");
const manifest = JSON.parse(
  readFileSync(path.join(path.dirname(entry), "manifest.json"), "utf8"),
);
assert.equal(manifest.defaultEnabled, false);
const plugin = await import(pathToFileURL(entry).href),
  ipc = new Map(),
  cleanups = [];
const controller = new AbortController();
try {
  await plugin.register({
    id: "bili-garden",
    signal: controller.signal,
    storage: { rootDir: () => root },
    deps: {
      llm: {
        runGoal: async () => {
          throw new Error("unused fixture");
        },
        listProfiles: async () => [],
      },
      secrets: { get: async () => undefined },
    },
    onDispose: (fn) => cleanups.push(fn),
    registerIpc: (name, fn) => ipc.set(name, fn),
    registerTool: () => {},
  });
  await ipc.get("garden")("config", { interests: "Electron 真实运行时" });
  const state = await ipc.get("garden")("snapshot");
  assert.equal(state.config.interests, "Electron 真实运行时");
  assert.equal(state.account.loggedIn, false);
  console.log(
    `PASS Electron ${process.versions.electron} / Node ${process.versions.node}: packaged ESM plugin, SQLite, IPC, settings and shutdown`,
  );
  if (process.argv[2])
    writeFileSync(
      process.argv[2],
      JSON.stringify(
        {
          ok: true,
          electron: process.versions.electron,
          node: process.versions.node,
          checks: ["ESM plugin", "SQLite", "IPC", "settings", "shutdown"],
        },
        null,
        2,
      ),
    );
} finally {
  controller.abort();
  for (const cleanup of cleanups) await cleanup();
  await plugin.unregister();
  rmSync(root, { recursive: true, force: true });
}
