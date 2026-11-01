import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { PythonRuntime } from "../lib/python.mjs";

function fixture(t, index = "https://mirror.example/simple") {
  const root = mkdtempSync(path.join(tmpdir(), "garden-install-"));
  const config = { asrModel: "tiny" };
  const runtime = new PythonRuntime(root, root, { config: () => config, credentials: async () => ({}) });
  mkdirSync(path.dirname(runtime.executable()), { recursive: true });
  writeFileSync(runtime.executable(), "fixture");
  const saved = Object.fromEntries(["CYRENE_BILI_PIP_INDEX", "PIP_INDEX_URL"].map(k => [k, process.env[k]]));
  process.env.CYRENE_BILI_PIP_INDEX = index;
  delete process.env.PIP_INDEX_URL;
  const calls = [];
  runtime.run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "-c" && args[1].includes("struct.calcsize"))
      return JSON.stringify({ version: [3, 11, 9], platform: "linux", arch: "x86_64", bits: 64 });
    return "";
  };
  t.after(async () => {
    await runtime.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, runtime, config, calls };
}
const pipCalls = calls => calls.filter(c => c.args.includes("pip"));
const indexOf = call => call.args[call.args.indexOf("--index-url") + 1];
const missing = () => Object.assign(new Error("No matching distribution found for faster-whisper"), {
  output: "ERROR: Could not find a version that satisfies the requirement faster-whisper (from versions: none)",
});

test("基础与转写依赖共用显式镜像，隔离系统配置并记录解释器", async t => {
  const { runtime, calls, root } = fixture(t);
  await runtime.install({ asr: true });
  assert.deepEqual(pipCalls(calls).map(indexOf), ["https://mirror.example/simple/", "https://mirror.example/simple/"]);
  for (const call of pipCalls(calls)) {
    assert.ok(call.args.includes("--isolated"));
    assert.equal(call.options.env.PIP_CONFIG_FILE, devNull);
    assert.ok(!call.args.includes("--extra-index-url"));
  }
  assert.ok(runtime.installLog.some(line => line.includes("3.11.9") && line.includes("x86_64")));
  assert.ok(existsSync(path.join(root, "asr-ready.json")));
  assert.equal(runtime.installing, false);
});

test("转写镜像找不到包时只重试一次官方源，通过导入与模型加载后才就绪", async t => {
  const { runtime, calls, root } = fixture(t);
  const run = runtime.run;
  runtime.run = async (...args) => {
    const result = await run(...args);
    if (args[1].includes("faster-whisper>=1.2.1,<2") && args[1].includes("https://mirror.example/simple/")) throw missing();
    if (args[1][0] === "-c" && args[1][1].includes("WhisperModel"))
      assert.equal(existsSync(path.join(root, "asr-ready.json")), false);
    return result;
  };
  await runtime.install({ asr: true });
  assert.deepEqual(pipCalls(calls).map(indexOf), ["https://mirror.example/simple/", "https://mirror.example/simple/", "https://pypi.org/simple/"]);
  assert.ok(runtime.installLog.some(line => line.includes("重试一次")));
  assert.equal(runtime.status().asr, true);
});

test("官方源也失败时保留基础环境，不伪报转写就绪并显示错误", async t => {
  const { runtime, calls, root } = fixture(t);
  const run = runtime.run;
  runtime.run = async (...args) => {
    const result = await run(...args);
    if (args[1].includes("faster-whisper>=1.2.1,<2")) throw missing();
    return result;
  };
  await assert.rejects(runtime.install({ asr: true }), /No matching distribution/);
  assert.equal(pipCalls(calls).length, 3);
  assert.equal(runtime.status().installed, true);
  assert.equal(existsSync(path.join(root, "asr-ready.json")), false);
  assert.equal(runtime.installing, false);
  assert.match(runtime.installLog.at(-1), /安装未完成/);
});

test("取消安装不会切换源重试", async t => {
  const { runtime, calls } = fixture(t);
  const controller = new AbortController();
  const run = runtime.run;
  runtime.run = async (...args) => {
    await run(...args);
    controller.abort();
    throw missing();
  };
  await assert.rejects(runtime.installPackages(["faster-whisper"], { signal: controller.signal }), { name: "AbortError" });
  assert.equal(pipCalls(calls).length, 1);
});

test("权限错误不当作镜像故障；无效镜像在启动 pip 前拒绝", async t => {
  const { runtime, calls } = fixture(t);
  const run = runtime.run;
  runtime.run = async (...args) => { await run(...args); throw new Error("Permission denied"); };
  await assert.rejects(runtime.installPackages(["faster-whisper"]), /Permission denied/);
  assert.equal(pipCalls(calls).length, 1);
  for (const value of ["http://mirror.example/simple", "https://user:secret@mirror.example/simple", "bad index"]) {
    process.env.CYRENE_BILI_PIP_INDEX = value;
    await assert.rejects(runtime.installPackages(["faster-whisper"]), /HTTPS/);
  }
  assert.equal(pipCalls(calls).length, 1);
});

test("官方默认源不受 pip.ini 指定的镜像影响，模型就绪标记对应实际加载模型", async t => {
  const { runtime, calls, config, root } = fixture(t, "");
  const run = runtime.run;
  runtime.run = async (...args) => {
    const result = await run(...args);
    if (args[1][0] === "-c" && args[1][1].includes("WhisperModel")) {
      assert.equal(args[1][2], "tiny");
      config.asrModel = "small";
    }
    return result;
  };
  await runtime.install({ asr: true });
  assert.ok(pipCalls(calls).every(call => indexOf(call) === "https://pypi.org/simple/"));
  assert.equal(JSON.parse(readFileSync(path.join(root, "asr-ready.json"))).model, "tiny");
  assert.equal(runtime.status().asr, false);
});
