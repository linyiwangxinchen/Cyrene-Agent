// Run with Electron after build:main. QFCA_ROOT is a reviewed, locally built candidate.
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { mkdtempSync } = require("node:fs");
const { createServer } = require("node:net");
const { tmpdir } = require("node:os");
const { isAbsolute, join } = require("node:path");
const { app } = require("electron");
app.setPath("userData", mkdtempSync(join(tmpdir(), "cyrene-qq-electron-")));
const { WebSocket } = require("ws");
const { QqModuleManager } = require("../../../dist/main/main/qq-modules/manager.js");
const { createQqUtilityProcess } = require("../../../dist/main/main/qq-modules/utility-process.js");
const { QqModuleAdapter } = require("../../../dist/main/main/channels/adapters/qq-module-adapter.js");

const root = process.env.QFCA_ROOT;
assert.ok(root && isAbsolute(root), "QFCA_ROOT must identify a reviewed local build");
const entry = join(root, "dist", "runtime", "entry.js");

async function until(predicate, message) {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

async function verify() {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  reservation.close();
  await once(reservation, "close");

  const accessToken = "fixture-only-qq-token";
  const configuration = {
    config: { configRevision: 1, listen: { host: "127.0.0.1", port }, expectedSelfId: "10000",
      allowedPrivateUserIds: ["30000"], allowedGroupIds: [], groupRequireMention: true },
    credentials: { accessToken },
  };
  const manager = new QqModuleManager({ getConfiguration: () => configuration,
    createTransport: () => createQqUtilityProcess(root, entry), requestTimeoutMs: 2000 });
  const adapter = new QqModuleAdapter(manager);
  let received;
  let reply;
  let finishTurn;
  const model = new Promise(resolve => { finishTurn = resolve; });
  let socket;
  let wrongToken;
  const actions = [];
  adapter.onMessageAccepted = async (message, trackWork) => {
    received = message;
    reply = model.then(() => {
      assert.equal(adapter.getMemoryAccountId(), "10000");
      return adapter.send({ channel: "qq", chatType: "private", targetId: message.chatId,
        parts: [{ kind: "text", text: "isolated reply" }] });
    });
    trackWork(reply.then(() => null));
  };
  try {
    await adapter.start();
    assert.equal(manager.getState().phase, "waiting-backend");
    const endpoint = `ws://127.0.0.1:${port}/onebot/v11/ws`;
    wrongToken = new WebSocket(endpoint, { headers: { Authorization: "Bearer rejected" } });
    const [error] = await once(wrongToken, "error");
    assert.match(error.message, /401/);
    socket = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${accessToken}`, "X-Self-ID": "10000" } });
    socket.on("message", raw => {
      const request = JSON.parse(raw.toString("utf8"));
      actions.push(request);
      socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo,
        data: request.action === "get_login_info" ? { user_id: "10000" } : { message_id: "99" } }));
    });
    await once(socket, "open");
    await until(() => adapter.getMemoryAccountId() === "10000", "real utility process never authenticated");
    socket.send(JSON.stringify({ self_id: 10000, post_type: "message", message_type: "private", message_id: 23,
      user_id: 30000, time: 1700000000, message: [{ type: "text", data: { text: "isolated input" } }] }));
    await until(() => received, "no inbound message reached the host");
    assert.equal(received.accountId, "10000");
    assert.equal(received.chatId, "30000");
    assert.equal(received.text, "isolated input");
    assert.ok(actions.every(request => request.action !== "send_private_msg"));
    finishTurn();
    assert.deepEqual(await reply, { ok: true });
    assert.equal(actions.filter(request => request.action === "send_private_msg").length, 1);
    await adapter.stop();
    assert.equal(manager.getState().phase, "stopped");
    assert.equal(adapter.getMemoryAccountId(), undefined);
    console.log("PASS: Windows Electron utility process, loopback authentication, QQ acceptance, delivery, and stop");
  } finally {
    wrongToken?.terminate();
    socket?.terminate();
    await adapter.stop();
  }
}

const watchdog = setTimeout(() => {
  console.error("QQ Electron fixture exceeded its test deadline");
  app.exit(1);
}, 25_000);
app.whenReady().then(verify).then(() => {
  clearTimeout(watchdog);
  app.exit(0);
}, error => {
  clearTimeout(watchdog);
  console.error(error);
  app.exit(1);
});
