import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export async function verifyDesktop(profile, captured, { seedTiebaLearning, liveThreadQuote, styleHeader, browserFixtureUrl }) {
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
    language: "zh-CN",
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
    const check = await page.evaluate(async ({ browserFixtureUrl, temporaryWorkspace }) => {
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
      async function ask(text, mode = "chat", existing) {
        const session = existing ?? await window.chatStore.create({
          mode,
          title: "desktop fixture",
        });
        if (mode === "work") {
          const binding = await window.chatStore.setWorkspace(session.id, temporaryWorkspace);
          if (!binding.ok) throw Error(JSON.stringify(binding));
        }
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
      const everyday = await ask("周末准备做点什么？ DESKTOP_STYLE_CHECK");
      const explicit = await ask("你最近在贴吧看了什么？ DESKTOP_READING_CHECK");
      await window.browserPanel.setBounds({ x: 0, y: 0, width: 500, height: 440 });
      const navigation = await window.browserPanel.navigate(browserFixtureUrl);
      if (!navigation.ok) throw Error(JSON.stringify(navigation));
      const browser = await ask("查看已打开的本地测试页截图。DESKTOP_BROWSER_IMAGE_CHECK", "work");
      const oldChat = await window.chatStore.create({ mode: "chat", title: "桌面引用来源" });
      const oldAnswer = await ask("接力备忘 DESKTOP_OLD_REFERENCE_TEXT", "chat", oldChat);
      await window.chatStore.rename(oldChat.id, "桌面引用来源");
      await window.settings.saveConfig({ memoryMode: "summary" });
      const toolChat = await window.chatStore.create({ mode: "chat", title: "桌面自主查阅" });
      const toolAnswer = await ask("查查我们之前聊的接力备忘。DESKTOP_HISTORY_TOOL_CHECK", "chat", toolChat);
      const toolHistory = await window.chatStore.get(toolChat.id);
      const toolReference = toolHistory.messages.some(message => message.companionReferences?.some(reference =>
        reference.kind === "chat-history" && reference.conversationId === oldChat.id));
      await window.settings.saveConfig({ memoryMode: "off" });
      const target = await window.chatStore.create({ mode: "chat", title: "桌面引用目标" });
      await window.chatStore.openInReactChatWindow(target.id);
      return { source: graph.nodes.some((n) => n.label === "气泡锚点"), everyday, explicit, browser, oldAnswer, toolAnswer, toolReference, targetId: target.id };
    }, { browserFixtureUrl, temporaryWorkspace: paths.documents });
    const { targetId, ...outcomes } = check;
    assert.deepEqual(outcomes, { source: true, everyday: "RUN_FINISHED", explicit: "RUN_FINISHED", browser: "RUN_FINISHED", oldAnswer: "RUN_FINISHED", toolAnswer: "RUN_FINISHED", toolReference: true });
    const toolResults = captured.flatMap(body => Array.isArray(body.input) ? body.input.filter(item =>
      item.type === "function_call_output" && item.call_id?.startsWith("call_desktop_history_")) : []);
    assert.ok(toolResults.some(result => result.call_id === "call_desktop_history_search" && result.output.includes("桌面引用来源")));
    assert.ok(toolResults.some(result => result.call_id === "call_desktop_history_read" && result.output.includes("DESKTOP_OLD_REFERENCE_TEXT")),
      JSON.stringify(toolResults.map(({ call_id, output }) => ({ call_id, output: String(output).slice(0, 900) }))));
    console.log("PASS Windows Electron model independently searches and reads an earlier Chat through Responses tools");
    await page.getByRole("button", { name: "引用会话", exact: true }).click();
    await page.getByRole("textbox", { name: "搜索聊天会话标题" }).fill("桌面引用来源");
    await page.getByRole("button", { name: "查看会话", exact: true }).click();
    const original = page.getByText(/DESKTOP_OLD_REFERENCE_TEXT/).first();
    try { await original.waitFor({ timeout: 10_000 }); }
    catch (error) {
      const dispatcher = await application.evaluate(({ app }) => {
        const appRequire = process.getBuiltinModule("module").createRequire(app.getAppPath() + "/package.json");
        const { reactChatSession } = appRequire("./dist/main/main/windows/window-state.js");
        return { ready: reactChatSession.isReady(), pending: reactChatSession.getPending() };
      });
      throw new Error(`Earlier Chat did not open. Dispatcher ${JSON.stringify(dispatcher)}. Rendered fixture: ${(await page.locator("body").innerText()).slice(-2500)}`, { cause: error });
    }
    assert.equal(await page.evaluate(id => window.chatStore.openInReactChatWindow(id), targetId), true);
    await original.waitFor({ state: "hidden" });
    console.log("PASS Windows Electron reference picker opens the earlier Chat and displays its original text");
    await page.getByRole("button", { name: "引用会话", exact: true }).click();
    await page.getByRole("textbox", { name: "搜索聊天会话标题" }).fill("桌面引用来源");
    await page.getByRole("button", { name: /桌面引用来源/ }).click();
    const input = page.locator(".cy-composer textarea");
    await input.fill("请接着聊 DESKTOP_MANUAL_REFERENCE_CHECK");
    await input.press("Enter");
    await page.getByText("本轮参考了什么", { exact: true }).waitFor({ timeout: 30_000 });
    const quotedChat = await page.evaluate(id => window.chatStore.get(id), targetId);
    assert.ok(quotedChat.messages.some(message => message.companionReferences?.some(reference =>
      reference.kind === "conversation" && reference.title === "桌面引用来源")));
    assert.equal(quotedChat.messages.find(message => message.role === "user")?.content, "请接着聊 DESKTOP_MANUAL_REFERENCE_CHECK");
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
    const referencedChat = inputs("DESKTOP_MANUAL_REFERENCE_CHECK");
    assert.match(referencedChat, /DESKTOP_OLD_REFERENCE_TEXT/);
    assert.match(referencedChat, /selected_conversation_excerpt/);
    assert.doesNotMatch(referencedChat, /DESKTOP_STYLE_CHECK|DESKTOP_READING_CHECK/);
    console.log("PASS Windows Electron composer quotes only the selected historical Chat in the Responses request");
    const screenshot = captured.filter(body => JSON.stringify(body.input).includes("DESKTOP_BROWSER_IMAGE_CHECK"))
      .flatMap(body => (body.input ?? []).filter(item => item.type === "function_call_output" && item.call_id === "call_browser_screenshot"))
      .flatMap(item => Array.isArray(item.output) ? item.output : [])
      .find(part => part.type === "input_image" && part.image_url?.startsWith("data:image/png;base64,"));
    assert.ok(screenshot, "Windows browser viewport reaches the Responses model as an actual tool image");
    assert.ok(Buffer.from(screenshot.image_url.split(",")[1], "base64").subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    console.log("PASS Windows Electron browser screenshot reaches the Responses tool result");
    console.log(
      "PASS Windows Electron main, plugin panel IPC, graph and real Responses request",
    );
  } finally {
    await application.close();
  }
}
