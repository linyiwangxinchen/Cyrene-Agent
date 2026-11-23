import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export async function verifyDesktop(profile, captured) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "cyrene-expression-desktop-"),
  );
  const paths = Object.fromEntries(
    [
      "home",
      "appData",
      "userData",
      "logs",
      "sessionData",
      "desktop",
      "documents",
      "downloads",
      "pictures",
      "music",
      "videos",
      "temp",
    ].map((k) => [k, path.join(root, k)]),
  );
  for (const dir of Object.values(paths)) await mkdir(dir);
  const seed = (name, obj) =>
    writeFile(path.join(paths.userData, name), JSON.stringify(obj));
  await seed("app-settings.json", {
    petVisible: false,
    launchAtLogin: false,
    proactiveChatMode: "off",
    momentsEnabled: false,
    disclaimerAcceptedVersion: require("../../dist/server/shared/disclaimer.js")
      .CURRENT_DISCLAIMER_VERSION,
  });
  await seed("model-settings.json", {
    ...profile,
    modelProfiles: [profile],
    defaultModelProfileId: profile.id,
    memoryMode: "off",
    runtimeSync: "off",
  });
  await writeFile(path.join(paths.userData, "gpu-acl-ok"), "fixture");
  const entry = path.join(root, "main.cjs");
  await writeFile(
    entry,
    `const {app,globalShortcut}=require("electron");
    for(const [key,value] of Object.entries(${JSON.stringify(paths)}))app.setPath(key,value);
    app.setAppPath(${JSON.stringify(process.cwd())});
    app.setLoginItemSettings=()=>{};globalShortcut.register=()=>true;
    app.on("browser-window-created",(_,w)=>{w.show=w.showInactive=w.focus=()=>{};});
    require(${JSON.stringify(path.resolve("dist/main/main/index.js"))});`,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) =>
      /^(path|systemroot|windir|comspec|pathext|systemdrive|number_of_processors|processor_architecture)$/i.test(
        k,
      ),
    ),
  );
  Object.assign(env, {
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.appData,
    USERPROFILE: paths.home,
    HOME: paths.home,
    TEMP: paths.temp,
    TMP: paths.temp,
  });
  const application = await electron.launch({
    executablePath: require("electron"),
    args: [entry, "--user-data-dir=" + paths.userData],
    env,
    timeout: 30000,
  });
  try {
    let page;
    const deadline = Date.now() + 30000;
    while (!page && Date.now() < deadline) {
      page = application
        .windows()
        .find((w) => w.url().includes("/react/index.html"));
      if (!page) await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(page, "desktop chat window");
    await page.waitForFunction(() => !!window.pluginPanel);
    const check = await page.evaluate(async () => {
      await window.plugins.setEnabled("tieba-garden", true);
      const panel = (...args) =>
        window.pluginPanel.invoke("tieba-garden", "forum", args);
      const cfg = await panel("save", { learn: true, bar: "摄影" });
      if (!cfg.ok) throw Error(cfg.error);
      const read = await panel("read", {
        url: "https://tieba.baidu.com/p/54321",
        excerpt: "断网了，气泡锚点",
      });
      if (!read.ok) throw Error(read.error);
      const graph = await window.memoryPanel.getGraph();
      const session = await window.chatStore.create({
        mode: "chat",
        title: "desktop fixture",
      });
      const text = "网络断线修复 DESKTOP_GATEWAY_CHECK";
      const outcome = new Promise((resolve) => {
        const off = window.agui.onEvent((e) => {
          if (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR") {
            off();
            resolve(e.type);
          }
        });
      });
      const ack = await window.agui.run({
        sessionId: session.id,
        currentUser: {
          turnId: crypto.randomUUID(),
          text,
          visibleContent: text,
        },
        assistantTurnId: crypto.randomUUID(),
      });
      if (!ack.success) throw Error(JSON.stringify(ack));
      return {
        source: graph.nodes.some((n) => n.label === "气泡锚点"),
        terminal: await Promise.race([
          outcome,
          new Promise((resolve) => setTimeout(() => resolve("timeout"), 25000)),
        ]),
      };
    });
    assert.deepEqual(check, { source: true, terminal: "RUN_FINISHED" });
    const body = captured.find((b) =>
      JSON.stringify(b).includes("DESKTOP_GATEWAY_CHECK"),
    );
    assert.match(JSON.stringify(body) ?? "", /气泡锚点/);
    console.log(
      "PASS Windows Electron main, plugin panel IPC, graph and real Responses request",
    );
  } finally {
    await application.close();
  }
}
