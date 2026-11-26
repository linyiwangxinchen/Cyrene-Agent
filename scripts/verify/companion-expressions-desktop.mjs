import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export async function verifyDesktop(profile, captured, { seedTiebaLearning, liveThreadQuote, styleHeader }) {
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
  await seedTiebaLearning(paths.userData);
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
      const auth = await panel("auth-save", {
        cookie: "BDUSS=desktop_tieba_fixture_session; STOKEN=desktop_tieba_fixture_token",
      });
      if (!auth.ok || !auth.data.auth?.hasCookie || JSON.stringify(auth).includes("desktop_tieba_fixture")) {
        throw Error(auth.error || "桌面贴吧登录态保存失败");
      }
      const read = await panel("read", {
        url: "https://tieba.baidu.com/p/54321",
        excerpt: "断网了，气泡锚点",
      });
      if (!read.ok) throw Error(read.error);
      if (read.data.reading?.analysisStatus !== "complete") {
        throw Error(read.data.reading?.analysisError || "桌面读帖手记未生成");
      }
      const graph = await window.memoryPanel.getGraph();
      async function ask(text) {
        const session = await window.chatStore.create({
          mode: "chat",
          title: "desktop fixture",
        });
        let stopListening;
        let timeout;
        const outcome = new Promise((resolve) => {
          stopListening = window.agui.onEvent((e) => {
            if (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR") resolve(e.type);
          });
          timeout = setTimeout(() => resolve("timeout"), 25000);
        });
        try {
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
          return await outcome;
        } finally {
          clearTimeout(timeout);
          stopListening();
        }
      }
      return {
        source: graph.nodes.some((n) => n.label === "气泡锚点"),
        everyday: await ask("周末准备做点什么？ DESKTOP_STYLE_CHECK"),
        explicit: await ask("你最近在贴吧看了什么？ DESKTOP_READING_CHECK"),
      };
    });
    assert.deepEqual(check, { source: true, everyday: "RUN_FINISHED", explicit: "RUN_FINISHED" });
    const secretsDir = path.join(paths.userData, "plugin-data", "tieba-garden", "secrets");
    const secretFiles = await readdir(secretsDir);
    assert.equal(secretFiles.length, 1);
    assert.match(secretFiles[0], /\.enc$/);
    assert.ok(!(await readFile(path.join(secretsDir, secretFiles[0]))).includes("desktop_tieba_fixture"));
    assert.ok(await page.evaluate(async () => {
      const result = await window.pluginPanel.invoke("tieba-garden", "forum", ["auth-clear"]);
      return result.ok && result.data.auth?.hasCookie === false;
    }));
    assert.deepEqual(await readdir(secretsDir), []);
    assert.ok(!JSON.stringify(captured).includes("desktop_tieba_fixture"));
    const inputs = (marker) => {
      const body = captured.find((request) => JSON.stringify(request).includes(marker));
      assert.ok(body, "missing desktop model request: " + marker);
      return JSON.stringify([body.instructions, body.input ?? body.messages]);
    };
    const everyday = inputs("DESKTOP_STYLE_CHECK");
    assert.match(everyday, /plugin:tieba-garden:expressions/);
    assert.ok(everyday.includes(styleHeader));
    assert.doesNotMatch(everyday, /气泡锚点|tieba\.baidu\.com/);
    assert.ok(!everyday.includes(liveThreadQuote));
    const explicit = inputs("DESKTOP_READING_CHECK");
    assert.match(explicit, /plugin:tieba-garden:readings/);
    assert.ok(explicit.includes("https://tieba.baidu.com/p/54321"));
    console.log(
      "PASS Windows Electron main, plugin panel IPC, graph and real Responses request",
    );
  } finally {
    await application.close();
  }
}
