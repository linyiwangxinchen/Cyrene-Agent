import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PythonRuntime } from "../../extensions/bili-garden/lib/python.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)),
  data = await mkdtemp(path.join(os.tmpdir(), "cyrene-garden-runtime-"));
const runtime = new PythonRuntime(
  data,
  path.join(root, "extensions/bili-garden"),
  {
    config: () => ({
      pythonPath: process.env.CYRENE_BILI_TEST_PYTHON || "",
      asrModel: "small",
    }),
    credentials: async () => ({}),
  },
);
try {
  await runtime.install();
  assert.equal(runtime.status().installed, true);
  const qr = await runtime.request("qr", {
    url: "https://example.invalid/garden-acceptance",
  });
  assert.match(qr.image, /^data:image\/png;base64,/);
  await assert.rejects(() => runtime.request("bili_send_dynamic", {}), /允许/);
  await assert.rejects(
    () => runtime.request("video", { bvid: "BV1JcnW6pEFT" }),
    /登录/,
  );
  await writeFile(
    path.join(data, "verification.json"),
    JSON.stringify({
      installed: true,
      qr: true,
      unlistedOperationRejected: true,
      missingCredentialRejected: true,
    }),
  );
  console.log(`PASS Python installation, QR and operation boundaries: ${data}`);
} finally {
  await runtime.close();
}
