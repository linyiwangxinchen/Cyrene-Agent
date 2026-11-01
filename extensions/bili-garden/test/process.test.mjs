import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { PythonRuntime } from "../lib/python.mjs";

test("取消和停用终止本插件启动的进程树", { timeout: 10000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "garden-process-"));
  const runtime = new PythonRuntime(root, root, {
    config: () => ({}),
    credentials: async () => ({}),
  });
  try {
    const controller = new AbortController();
    const running = runtime.run(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { signal: controller.signal },
    );
    const assertion = assert.rejects(running, /取消|退出/);
    await new Promise((r) => setTimeout(r, 80));
    controller.abort();
    await assertion;
    await runtime.close();
    assert.equal(runtime.children.size, 0);
    await assert.rejects(
      () => runtime.run(process.execPath, ["--version"]),
      /停止/,
    );
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
