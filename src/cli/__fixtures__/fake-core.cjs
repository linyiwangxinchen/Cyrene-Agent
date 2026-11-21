/**
 * Test double for dist/headless/core.cjs. Speaks the same IPC protocol as
 * src/server/core/worker.ts but never calls a model. Every invoke is logged
 * to <CYRENE_DATA_DIR>/fake-core-log.jsonl so tests can assert what the CLI
 * sent. The prompt text selects the scripted run:
 *   "fail ..."  -> streams a little, then RUN_ERROR
 *   "hang ..."  -> streams a little, then waits for agui:cancel
 *   otherwise   -> candidate text, a tool call, final text, RUN_FINISHED success
 */
const fs = require("node:fs");
const path = require("node:path");

const dataDir = process.env.CYRENE_DATA_DIR;
const logFile = path.join(dataDir, "fake-core-log.jsonl");
const sessions = new Map();
const runs = new Map();
let sessionCounter = 0;
let runCounter = 0;

sessions.set("seed-chat", {
  id: "seed-chat", mode: "chat", title: "旧的聊天", updatedAt: 2000, messages: [
    { role: "user", content: "上次聊到哪了？" },
    { role: "model", content: "聊到了花园里的玫瑰。" },
  ],
});
sessions.set("seed-old", { id: "seed-old", mode: "work", title: "更早的工作", updatedAt: 1000, messages: [], workspaceBinding: { workspaceRoot: dataDir } });

function log(entry) { fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`); }
function emit(clientId, event) { process.send({ type: "event", channel: "agui:event", args: [event], ...(clientId ? { clientId } : {}) }); }
function later(ms, fn) { setTimeout(fn, ms); }

function script(clientId, runId, session, text) {
  const round = "round-1";
  const steps = [];
  const push = (event) => steps.push({ ...event, runId });
  push({ type: "CUSTOM", name: "cyrene.round", value: { action: "start", roundId: round } });
  if (text.startsWith("fail")) {
    push({ type: "CUSTOM", name: "cyrene.candidate_text", value: { action: "delta", roundId: round, delta: "我试试" } });
    push({ type: "RUN_ERROR", message: "模型请求失败：401 invalid key", code: "MODEL_REQUEST_FAILED" });
  } else if (text.startsWith("hang")) {
    push({ type: "CUSTOM", name: "cyrene.candidate_text", value: { action: "delta", roundId: round, delta: "正在思考" } });
  } else {
    push({ type: "CUSTOM", name: "cyrene.candidate_text", value: { action: "delta", roundId: round, delta: "你好，" } });
    push({ type: "CUSTOM", name: "cyrene.candidate_text", value: { action: "delta", roundId: round, delta: "我是昔涟。" } });
    push({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "read_file", toolCallDisplayName: "读取文件" });
    push({ type: "TOOL_CALL_RESULT", toolCallId: "t1", status: "success", content: "ok" });
    push({ type: "TOOL_CALL_END", toolCallId: "t1" });
    push({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" });
    push({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: `你好，我是昔涟。收到：${text}` });
    push({ type: "TEXT_MESSAGE_END", messageId: "a1" });
    push({ type: "RUN_FINISHED", result: { status: "success", externalEffectsMayContinue: false } });
  }
  steps.forEach((event, index) => later(10 * (index + 1), () => {
    if (runs.get(runId)?.done) return;
    if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") runs.get(runId).done = true;
    if (event.type === "TEXT_MESSAGE_CONTENT") session.messages.push({ role: "model", content: event.delta });
    emit(clientId, event);
  }));
}

function handleInvoke(message) {
  const [input] = message.args;
  switch (message.channel) {
    case "settings:get-general": return { currentStyleId: "style-1" };
    case "settings:model-profiles:list":
      return { profiles: [{ id: "p1", apiKey: "sk-fixture-secret" }, { id: "p2", apiKey: "sk-fixture-secret-2" }], defaultModelProfileId: "p1" };
    case "chats:create": {
      const session = { id: `s-${++sessionCounter}`, mode: input?.mode ?? "chat", title: "新对话", updatedAt: Date.now(), messages: [] };
      sessions.set(session.id, session);
      return session;
    }
    case "chats:list":
      return [...sessions.values()].filter((s) => !input?.mode || s.mode === input.mode).map(({ messages, ...meta }) => ({ ...meta, messageCount: messages.length }));
    case "chats:get": return sessions.get(input) ?? null;
    case "chats:delete": return sessions.delete(input);
    case "chats:set-workspace": {
      const session = sessions.get(input.sessionId);
      if (!session) return { ok: false, error: "session not found" };
      session.workspaceBinding = { workspaceRoot: input.workspaceRoot };
      return { ok: true };
    }
    case "chats:set-model-profile": {
      const session = sessions.get(input.id);
      if (!session) return null;
      session.modelProfileId = input.modelProfileId;
      return session;
    }
    case "agui:run": {
      const session = sessions.get(input.sessionId);
      if (!session) throw new Error(`AGUI_RUN 会话不存在: ${input.sessionId}`);
      if ((session.mode === "work" || session.mode === "code") && !session.workspaceBinding) throw new Error(`${session.mode} 模式需要先绑定项目工作区`);
      const runId = `run-${++runCounter}`;
      session.messages.push({ role: "user", content: input.currentUser.text });
      session.updatedAt = Date.now();
      runs.set(runId, { clientId: message.clientId, done: false });
      // Published before the acknowledgement on purpose: the CLI must buffer it.
      emit(message.clientId, { type: "RUN_STARTED", runId });
      script(message.clientId, runId, session, input.currentUser.text);
      return { success: true, runId };
    }
    case "agui:cancel": {
      const run = runs.get(input);
      if (run && !run.done) {
        run.done = true;
        later(5, () => emit(run.clientId, { type: "RUN_FINISHED", runId: input, result: { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true } }));
      }
      return true;
    }
    default: throw new Error(`CORE_API_UNAVAILABLE: ${message.channel}`);
  }
}

process.on("message", (message) => {
  if (message.type === "shutdown") process.exit(0);
  if (message.type === "disconnect") return;
  const reply = (value, error) => process.send({ type: "response", requestId: message.requestId, ...(error ? { error } : { value }) });
  if (message.type === "readiness") return reply({ ready: true });
  if (message.type === "capabilities") return reply({});
  if (message.type !== "invoke") return reply(undefined, "UNSUPPORTED");
  log({ channel: message.channel, args: message.args, clientId: message.clientId });
  try { reply(handleInvoke(message)); }
  catch (error) { reply(undefined, error.message); }
});
process.on("disconnect", () => process.exit(0));
process.send({ type: "ready", capabilities: {} });
