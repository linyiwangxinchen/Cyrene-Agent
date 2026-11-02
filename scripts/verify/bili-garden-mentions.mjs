// Local UI fixture; no real account, model request or Bilibili publication.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { GardenService } from "../../extensions/bili-garden/lib/service.mjs";

const root = fileURLToPath(new URL("../../extensions/bili-garden/", import.meta.url));
const data = await mkdtemp(path.join(os.tmpdir(), "cyrene-mention-panel-"));
const evidence = process.argv[2] || path.join(data, "evidence");
await mkdir(evidence, { recursive: true });
const service = new GardenService({ id: "bili-garden", signal: new AbortController().signal,
  storage: { rootDir: () => data }, deps: { llm: {} } }, root, {
  schedule: false, runtime: { status: () => ({ installed: true }), stopWorker() {}, async close() {} },
  client: { account: async () => ({ loggedIn: true, uid: "123", name: "测试账号" }),
    call: async name => {
      if (name === "bili_user_videos") throw new Error("fixture unavailable");
      assert.equal(name, "bili_guard_scan");
      return { at: [
        { bvid: "BV17x411w7KC", rpid: "10", uid: "456", text: "@昔涟 你怎么看？" },
        { bvid: "BV17x411w7KC", rpid: "11", uid: "999", text: "不在白名单的用户" },
      ], comments: [], at_cursor: { id: 10, time: 10 }, at_resume: null,
      at_stats: { received: 3, unsupported: 1 } };
    } },
});
service.store.saveConfig({ guardOn: true, autoSend: true, guardWhitelist: ["456"], quietStart: "00:00", quietEnd: "00:00" });
await service.scanGuard();
service.store.put("guard", "123:12", { kind: "at", bvid: "BV17x411w7KC", rpid: "12", uid: "456",
  accountUid: "123", status: "pending", attempts: 3, text: "上次没有成功回复的 @" });
const snapshot = await service.snapshot();
const assets = new Map(await Promise.all(["panel.html", "panel.js", "panel.css"].map(async file => ["/" + file, await readFile(path.join(root, file))])));
const server = createServer((request, response) => {
  if (request.url === "/.cyrene/panel-bridge.js") {
    response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    response.end(`window.CyrenePanel = { invoke: async (_namespace, command) => command === 'snapshot' ? ${JSON.stringify(snapshot)} : {message:'扫描完成：这是隔离验收结果'}, onTheme() {} };`);
    return;
  }
  const body = assets.get(request.url);
  if (!body) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "Content-Type": request.url.endsWith(".css") ? "text/css; charset=utf-8"
    : request.url.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" }).end(body);
});
let browser;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/panel.html`);
  await page.getByRole("button", { name: "互动", exact: true }).click();
  const status = page.getByRole("region", { name: "评论守护扫描状态" });
  await status.getByText(/白名单通过 1 条，白名单外 1 条，新入队 1 条/).waitFor();
  await status.getByText(/UP 视频列表读取失败/).waitFor();
  await page.getByRole("button", { name: "重试未回复的 @" }).waitFor();
  for (const [name, width, height] of [["desktop", 1280, 850], ["mobile", 390, 844]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
    await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true });
  }
  await page.getByRole("button", { name: "扫描 @ 与评论" }).click();
  await page.getByRole("status").getByText("扫描完成：这是隔离验收结果").waitFor();
  assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, "result.json"), JSON.stringify({ ok: true, realAccountUsed: false,
    checks: ["scan-counts", "partial-failure", "retry-control", "scan-result", "desktop", "mobile"], pageErrors: errors }, null, 2));
  console.log(`PASS mention diagnostics and responsive panel: ${evidence}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await service.close();
}
