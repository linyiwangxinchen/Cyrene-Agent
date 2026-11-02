import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
const require = createRequire(import.meta.url),
  { createWebServer } = require("../../dist/server/server/index.js");
const data = await mkdtemp(path.join(os.tmpdir(), "cyrene-garden-agent-")),
  requests = [];
const model = createServer(async (req, res) => {
  let text = "";
  for await (const c of req) text += c;
  const body = JSON.parse(text);
  requests.push(body);
  const names = body.tools?.map((t) => t.function.name) ?? [],
    toolMessages = body.messages.filter((m) => m.role === "tool");
  const guard = JSON.stringify(body.messages).includes("本轮是评论守护");
  let name, args;
  if (toolMessages.length === 0) {
    name = names.find((n) => n.endsWith("_read_video"));
    args = { bvid: guard ? "BV17x411w7KC" : "BV1JcnW6pEFT" };
  } else if (guard && toolMessages.length === 1) {
    name = names.find((n) => n.endsWith("_propose_interaction"));
    args = { kind: "reply", bvid: "BV17x411w7KC", rpid: "100", reason: "回应白名单用户的直接提问",
      text: "我是昔涟，我在呀。这条视频暂时没有可读字幕，你想聊哪一段？" };
  } else if (guard && toolMessages.length === 2) {
    name = names.find((n) => n.endsWith("_finish_report"));
    args = { items: [], summary: "已回复原评论并说明无法读取视频" };
  } else if (toolMessages.length === 1) {
    name = names.find((n) => n.endsWith("_finish_report"));
    args = {
      items: [
        {
          bvid: "BV1JcnW6pEFT",
          summary: "花需要合适的阳光",
          reason: "很适合我们一起照顾阳台的小花",
          citations: [0],
        },
      ],
      summary: "发现了养花方法",
      diary: "想和你一起等花开。",
      say: "把这点春天留给你。",
      memories: ["喜欢阳台园艺"],
    };
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({ id: "fixture", model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  chunk({ role: "assistant" });
  if (name) {
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call-" + requests.length,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    chunk({}, "tool_calls");
  } else {
    chunk({ content: "春天的一点小发现，留给你。" });
    chunk({}, "stop");
  }
  res.end(
    `data: ${JSON.stringify({ id: "fixture", choices: [], usage: { prompt_tokens: 100, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 80 } } })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
const id = "bili-garden-fixture",
  dir = path.join(data, "plugins", id);
await mkdir(dir, { recursive: true });
await mkdir(path.join(data, "prompts"));
await writeFile(
  path.join(data, "prompts/chat_identity.md"),
  (await readFile("prompts/chat_identity.md", "utf8")) +
    "\nGARDEN_CUSTOM_PERSONA_MARKER",
);
await writeFile(
  path.join(dir, "manifest.json"),
  JSON.stringify({
    apiVersion: 1,
    id,
    name: "Garden test",
    version: "0.1.0",
    description: "Isolated fixture",
    author: "Fixture",
    entry: "index.mjs",
    defaultEnabled: false,
    deps: ["llm", "secrets"],
  }),
);
await writeFile(
  path.join(dir, "index.mjs"),
  `import { GardenService } from ${JSON.stringify(pathToFileURL(path.resolve("extensions/bili-garden/lib/service.mjs")).href)};
export function register(ctx){const client={account:async()=>({loggedIn:true,uid:'123',name:'Fixture'}),info:async(bvid)=>({bvid,title:'养花',owner:'UP',duration:300}),subtitle:async(bvid)=>bvid==='BV17x411w7KC'?{bvid,text:'',segments:[]}:{bvid,text:'花需要合适的阳光',segments:[{from:12,text:'花需要合适的阳光'}]},
call:async(name)=>{if(name==='bili_user_videos')return {videos:[]};if(name==='bili_guard_scan')return {at:[{bvid:'BV17x411w7KC',rpid:'100',uid:'456',root_id:0,text:'@昔涟 你在吗？'}],comments:[],at_cursor:{id:1,time:1},at_resume:null};if(name==='bili_reply')return {success:true,rpid:'200'};throw new Error('Unexpected fixture call: '+name)}};
const runtime={status:()=>({installed:true}),stopWorker(){},async close(){}};
const s=new GardenService(ctx,${JSON.stringify(path.resolve("extensions/bili-garden"))},{client,runtime,schedule:false});ctx.registerIpc('garden',(c,a)=>s.dispatch(c,a));ctx.onDispose(()=>s.close());}`,
);
await writeFile(
  path.join(data, "web-data.json"),
  JSON.stringify({
    version: 1,
    sessions: [],
    recentProjects: [],
    settings: {
      general: { proactiveChatMode: "off", momentsEnabled: false },
      config: { memoryMode: "summary", runtimeSync: "off" },
      modelProfiles: [
        {
          id: "fixture",
          provider: "ChatGPT（OpenAI）",
          apiKey: "fixture-local-only",
          baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
          explicitTransport: "openai",
          model: "fixture-model",
          models: ["fixture-model"],
        },
      ],
      defaultModelProfileId: "fixture",
    },
  }),
);
const logs = [],
  handle = createWebServer({
    dataDir: data,
    secureCookies: false,
    setupToken: "fixture",
    sharedCore: true,
    logger: {
      info: (x) => logs.push(String(x)),
      warn: (x) => logs.push(String(x)),
      error: (x) => logs.push(String(x)),
    },
  });
await new Promise((r) => handle.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${handle.server.address().port}`;
let cookie = "",
  token = "",
  socket;
async function http(route, body, headers = {}) {
  const r = await fetch(base + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const value = await r.json();
  assert.ok(r.ok, JSON.stringify(value));
  return { r, value };
}
async function invoke(channel, ...args) {
  return (
    await http(
      "/api/core/invoke",
      { channel, args },
      { "X-Cyrene-Client": token },
    )
  ).value;
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await http(
    "/api/auth/bootstrap",
    { username: "fixture", password: "Fixture-12345" },
    { "X-Cyrene-Setup-Token": "fixture" },
  );
  const login = await http("/api/auth/login", {
    username: "fixture",
    password: "Fixture-12345",
  });
  cookie = login.r.headers.get("set-cookie").split(";")[0];
  socket = new WebSocket(base.replace("http:", "ws:") + "/ws", {
    headers: { Cookie: cookie },
  });
  socket.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === "ready") token = m.clientToken;
  });
  for (let i = 0; i < 100 && !token; i++) await delay(50);
  await handle.startChannels();
  const enabled = await invoke("plugins:set-enabled", id, true);
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  const call = (command, args = {}) =>
    invoke(`plugin:${id}:garden`, command, args);
  const started = await call("run", { bvid: "BV1JcnW6pEFT" });
  assert.equal(started.started, true);
  let snapshot;
  for (let i = 0; i < 200; i++) {
    snapshot = await call("snapshot");
    if (!snapshot.run) break;
    await delay(100);
  }
  const run = snapshot.runs.find((r) => r.id === started.runId);
  assert.equal(run.status, "success", JSON.stringify({ run, logs }));
  assert.equal(snapshot.reports.length, 1);
  assert.ok(snapshot.memories.some((m) => m.text === "喜欢阳台园艺"));
  assert.ok(
    requests.some((r) =>
      JSON.stringify(r.messages).includes("GARDEN_CUSTOM_PERSONA_MARKER"),
    ),
    "custom Chat persona missing",
  );
  assert.ok(
    requests.every(
      (r) => !JSON.stringify(r.messages).includes("你是 Minecraft"),
    ),
  );
  assert.ok(run.usage.input > 0);
  assert.ok(run.usage.cachedInput > 0);
  assert.equal(snapshot.profiles[0].id, "fixture");
  assert.ok(!JSON.stringify(snapshot.profiles).includes("fixture-local-only"));
  await call("config", { guardOn: true, autoSend: true, guardWhitelist: ["456"], quietStart: "00:00", quietEnd: "00:00" });
  const guardStarted = await call("guard");
  assert.equal(guardStarted.started, true);
  for (let i = 0; i < 200; i++) {
    snapshot = await call("snapshot");
    if (!snapshot.run) break;
    await delay(100);
  }
  const guardRun = snapshot.runs.find(item => item.id === guardStarted.runId);
  assert.equal(guardRun.status, "success", JSON.stringify({ guardRun, logs }));
  assert.equal(snapshot.guard.lastScan.allowedAt, 1);
  assert.equal(snapshot.actions.length, 1);
  assert.equal(snapshot.actions[0].status, "sent");
  assert.equal(snapshot.actions[0].rpid, "100");
  assert.equal(snapshot.actions[0].evidenceSource, "comment");
  assert.ok(requests.some(request => JSON.stringify(request.messages).includes("没有可读字幕/语音")));
  const beforeDuplicate = requests.length;
  assert.equal((await call("guard")).started, false);
  assert.equal(requests.length, beforeDuplicate);
  await invoke("plugins:set-enabled", id, false);
  console.log(
    `PASS real headless Agent, persona, mention reply without subtitles, replay suppression, report, memory, usage and shutdown: ${data}`,
  );
} catch (e) {
  console.error(logs.slice(-35).join("\n"));
  throw e;
} finally {
  socket?.close();
  await handle.close();
  await new Promise((r) => model.close(r));
}
