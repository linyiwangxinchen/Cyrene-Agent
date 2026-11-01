import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PythonRuntime } from "../../extensions/bili-garden/lib/python.mjs";

// Real dependency installation in disposable data. No account, media upload or model download.
const root = await mkdtemp(path.join(tmpdir(), "cyrene-garden-asr-install-"));
const runtime = new PythonRuntime(root, fileURLToPath(new URL("../../extensions/bili-garden", import.meta.url)), {
  config: () => ({ pythonPath: process.env.CYRENE_BILI_TEST_PYTHON || "", asrModel: "tiny" }),
  credentials: async () => ({}),
});
const evidence = process.argv[2] || path.join(root, "verification.json");
let lastLog = "";
const progress = setInterval(() => {
  const recent = runtime.installLog.at(-1);
  if (recent && recent !== lastLog) { console.log(recent.trim()); lastLog = recent; }
}, 3000);
try {
  await runtime.install();
  await runtime.installAsrPackages();
  const packages = JSON.parse(await runtime.run(runtime.executable(), ["-c",
    "import json,platform; from importlib.metadata import version; print(json.dumps({'python':platform.python_version(),'arch':platform.machine(),'packages':{p:version(p) for p in ['pip','faster-whisper','ctranslate2','av','yt-dlp']}}))",
  ]));
  assert.equal(runtime.status().installed, true);
  // Importable dependencies alone must not claim a model is installed.
  assert.equal(runtime.status().asr, false);
  await assert.rejects(readFile(path.join(root, "asr-ready.json")), { code: "ENOENT" });
  const result = { ok: true, data: root, ...packages, index: runtime.pipSource?.index, modelDownloaded: false };
  await writeFile(evidence, JSON.stringify(result, null, 2));
  console.log(`PASS real ASR dependency install/import; ${evidence}`);
} finally {
  clearInterval(progress);
  await runtime.close();
}
