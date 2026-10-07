import { client, disconnect, ipcMain, invocation, resolveDialog, touchActivity, protocol } from "./platform";
import { migrateWebData } from "./migrate-web-data";
import { IPC } from "../../shared/ipc-channels";

void (async () => {
  migrateWebData(process.env.CYRENE_DATA_DIR!);
  const { examSource, revokeExamGrants } = await import("./browser.js");
  const { startHeadlessCore } = await import("./runtime.js");
  const core = await startHeadlessCore();
  process.once("disconnect", () => { void core.close().finally(() => process.exit(0)); });
  process.on("message", async (message: any) => {
    if (message.type === "disconnect") { disconnect(message.clientId); revokeExamGrants(message.clientId); return; }
    if (message.type === "shutdown") { await core.close(); process.exit(0); }
    const sender = message.pageToken ? examSource(message.clientId, message.pageToken) : client(message.clientId);
    if (!sender) { process.send?.({ type: "response", requestId: message.requestId, error: "E_LEARN_EXAM_PAGE_FORBIDDEN" }); return; }
    if (message.pageToken && ![IPC.LEARN_EXAM_PAGE_GET, IPC.LEARN_EXAM_PAGE_SAVE_ANSWER, IPC.LEARN_EXAM_PAGE_SAVE_NAVIGATION, IPC.LEARN_EXAM_PAGE_SUBMIT, IPC.LEARN_EXAM_PAGE_RETRY].includes(message.channel)) { process.send?.({ type: "response", requestId: message.requestId, error: "E_LEARN_EXAM_PAGE_FORBIDDEN" }); return; }
    if (message.channel === IPC.AGUI_RUN || message.type === "dialog" || message.channel?.startsWith("web:browser-input")) touchActivity();
    try {
      const value = await invocation.run(sender, async () => {
        if (message.type === "capabilities") return core.capabilities();
        if (message.type === "resource") {
          const url = new URL(message.url);
          const handler = protocol.handlers.get(url.protocol.slice(0, -1));
          if (!handler || !["local-sticker:", "moment-media:", "cyrene-plugin:"].includes(url.protocol)) throw new Error("RESOURCE_NOT_FOUND");
          const response: Response = await handler(new Request(message.url));
          return { status: response.status, contentType: response.headers.get("content-type"), base64: Buffer.from(await response.arrayBuffer()).toString("base64") };
        }
        if (message.type === "dialog") return resolveDialog(sender.id, message.dialogId, message.value);
        if (message.type === "send") { ipcMain.emit(message.channel, { sender }, ...message.args); return null; }
        const handler = ipcMain.handlers.get(message.channel);
        if (!handler) throw new Error(`CORE_API_UNAVAILABLE: ${message.channel}`);
        return handler({ sender }, ...message.args);
      });
      process.send?.({ type: "response", requestId: message.requestId, value });
    } catch (error) {
      process.send?.({ type: "response", requestId: message.requestId, error: error instanceof Error ? error.message : String(error) });
    }
  });
  process.send?.({ type: "ready", capabilities: core.capabilities() });
})().catch(error => { console.error("[HeadlessCore] startup failed", error); process.send?.({ type: "failed", error: error.message }); process.exit(1); });
