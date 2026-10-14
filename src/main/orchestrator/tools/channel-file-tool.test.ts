import { createDecipheriv } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", level: "read-only", bindings: { externalChats: [] as any[], bindings: [] as any[] }, logs: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => state.root } }));
vi.mock("../../permission", async () => ({
  getCurrentLevel: () => state.level,
  ACCESS_LEVEL_LABEL: { "project-read-only": "完全只读" },
  ...(await import("../../permission-policy")),
}));
vi.mock("../../channels/conversation-binding-store", () => ({ getChannelConversationBindingStore: () => ({ list: () => state.bindings }) }));
vi.mock("../../channels/message-log", () => ({ appendLog: state.logs }));
import { channelFileTool, registerChannelFileTool } from "./channel-file-tool";
import { channelManager } from "../../channels/manager";
import { ILinkBotAdapter } from "../../channels/adapters/wechat/ilink-bot-adapter";
import { ILinkClient } from "../../channels/adapters/wechat/ilink-protocol-client";
import { encryptAesEcb } from "../../channels/adapters/wechat/wechat-media-upload";
import type { ToolContext } from "./registry/tool-context";

const ctx: ToolContext = { userQuery: "把报告微信发给我", permissionMode: "allow_all", channelContext: { channel: "wechat", targetId: "wx-user", chatType: "private", sessionId: "channel:wechat:test" } };
let adapter: ILinkBotAdapter;
let sent: any[];
let uploads: Array<{ request: any; bytes: Buffer }>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), "cyrene-channel-file-"));
  state.level = "read-only";
  state.bindings = { externalChats: [], bindings: [] };
  state.logs.mockClear();
  sent = []; uploads = [];
  adapter = new ILinkBotAdapter();
  adapter.status = { enabled: true, phase: "running" };
  (adapter as any).client = new ILinkClient({ botToken: "test-token", ilinkBotId: "test-bot", baseUrl: "https://ilinkai.weixin.qq.com", ilinkUserId: "" });
  (adapter as any).replyContextByTarget.set("wx-user", "ctx-test");
  vi.spyOn(channelManager, "getAdapter").mockReturnValue(adapter);
  let uploadRequest: any;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/getuploadurl")) {
      uploadRequest = JSON.parse(String(init?.body));
      return Response.json({ ret: 0, upload_param: "upload", upload_full_url: "https://novac2c.cdn.weixin.qq.com/c2c/upload" });
    }
    if (url.endsWith("/upload")) {
      uploads.push({ request: uploadRequest, bytes: Buffer.from(init?.body as Uint8Array) });
      return new Response(null, { headers: { "x-encrypted-param": "download-param" } });
    }
    if (url.endsWith("/sendmessage")) {
      sent.push(JSON.parse(String(init?.body)).msg);
      return Response.json({ ret: 0 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await fs.rm(state.root, { recursive: true, force: true });
});

describe("channel_send_file with the real iLink upload and adapter", () => {
  it("registers the tool for Windows and headless shared core", () => {
    const registry = { register: vi.fn() };
    registerChannelFileTool(registry as any);
    expect(registry.register).toHaveBeenCalledWith(channelFileTool);
    expect(channelFileTool.effectKind).toBe("external_side_effect");
  });
  it("sends an existing Unicode document as an encrypted attachment with its name and byte length", async () => {
    const source = Buffer.from("报告内容：你好微信\n");
    const filePath = path.join(state.root, "测试报告.docx");
    await fs.writeFile(filePath, source);
    const result = JSON.parse(await channelFileTool.execute({ filePath }, ctx));
    expect(result).toMatchObject({ success: true, name: "测试报告.docx", kind: "file", size: source.length });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to_user_id: "wx-user", context_token: "ctx-test", item_list: [{ type: 4, file_item: { file_name: "测试报告.docx", len: String(source.length), media: { encrypt_query_param: "download-param", encrypt_type: 1 } } }] });
    expect(Object.keys(sent[0].item_list[0].file_item.media).sort()).toEqual(["aes_key", "encrypt_query_param", "encrypt_type"]);
    const decipher = createDecipheriv("aes-128-ecb", Buffer.from(uploads[0].request.aeskey, "hex"), null);
    expect(Buffer.concat([decipher.update(uploads[0].bytes), decipher.final()])).toEqual(source);
    expect(state.logs).toHaveBeenCalledWith(expect.objectContaining({ dir: "outgoing", hasAttachments: true }));
  });
  it.each([["photo.png", 1, 2, "image_item", "mid_size"], ["demo.mp4", 2, 5, "video_item", "video_size"]])("sends %s with ciphertext size metadata", async (name, mediaType, itemType, key, sizeKey) => {
    const filePath = path.join(state.root, String(name));
    await fs.writeFile(filePath, "media-fixture");
    expect(JSON.parse(await channelFileTool.execute({ filePath }, ctx)).success).toBe(true);
    expect(uploads[0].request.media_type).toBe(mediaType);
    expect(sent[0].item_list[0].type).toBe(itemType);
    expect(sent[0].item_list[0][key][sizeKey]).toBe(uploads[0].bytes.length);
  });
  it("supports forcing an image to a named file and trusted relative workspace paths", async () => {
    await fs.writeFile(path.join(state.root, "photo.png"), "image");
    const result = JSON.parse(await channelFileTool.execute({ filePath: "photo.png", kind: "file", name: "original.png" }, { ...ctx, resolvedWorkspaceRoot: state.root }));
    expect(result).toMatchObject({ success: true, kind: "file", name: "original.png" });
    expect(sent[0].item_list[0].type).toBe(4);
  });
  it("downloads an incoming encrypted document and can send its bytes back as a real file", async () => {
    const source = Buffer.from("微信发来的文档，完整往返");
    const key = Buffer.alloc(16, 9);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.includes("/download?") ? new Response(new Uint8Array(encryptAesEcb(source, key))) : original(url, init));
    adapter.onMessage = vi.fn(async message => {
      const attachment = message.attachments![0];
      expect(await fs.readFile(attachment.filePath!)).toEqual(source);
      expect(JSON.parse(await channelFileTool.execute({ filePath: attachment.filePath, name: "原文.txt" }, ctx)).success).toBe(true);
      return null;
    });
    await (adapter as any).dispatchInbound({ msgId: "incoming-file", fromUserId: "wx-user", content: "把这个文件发回给我", items: [{ type: 4, file_item: { file_name: "原文.txt", media: { encrypt_query_param: "incoming", aes_key: key.toString("base64"), encrypt_type: 1 } } }], contextToken: "ctx-incoming" });
    expect(adapter.onMessage).toHaveBeenCalledOnce();
    await vi.mocked(adapter.onMessage!).mock.results[0].value;
    expect(sent[0]).toMatchObject({ context_token: "ctx-incoming", item_list: [{ type: 4, file_item: { file_name: "原文.txt", len: String(source.length) } }] });
    const decipher = createDecipheriv("aes-128-ecb", Buffer.from(uploads[0].request.aeskey, "hex"), null);
    expect(Buffer.concat([decipher.update(uploads[0].bytes), decipher.final()])).toEqual(source);
  });
  it("can send from a Web conversation only to its uniquely bound private chat", async () => {
    state.bindings = { externalChats: [{ sessionId: "s", channel: "wechat", chatId: "wx-user", chatType: "private" }], bindings: [{ sessionId: "s", conversationId: "web-chat" }] };
    const filePath = path.join(state.root, "report.pdf");
    await fs.writeFile(filePath, "pdf");
    const webCtx = { userQuery: "发到微信", conversationId: "web-chat" };
    expect(JSON.parse(await channelFileTool.execute({ filePath, channel: "wechat" }, webCtx)).success).toBe(true);
    expect(JSON.parse(await channelFileTool.execute({ filePath, channel: "wechat" }, { ...webCtx, conversationId: "other-chat" })).success).toBe(false);
    state.bindings.externalChats.push({ sessionId: "second", channel: "wechat", chatId: "other-user", chatType: "private" });
    state.bindings.bindings.push({ sessionId: "second", conversationId: "web-chat" });
    expect(JSON.parse(await channelFileTool.execute({ filePath, channel: "wechat" }, webCtx)).success).toBe(false);
    expect(sent).toHaveLength(1);
  });
  it("never guesses a different channel or group recipient", async () => {
    expect(JSON.parse(await channelFileTool.execute({ filePath: "unused", channel: "qq" }, ctx)).success).toBe(false);
    expect(JSON.parse(await channelFileTool.execute({ filePath: "unused" }, { ...ctx, channelContext: { ...ctx.channelContext!, chatType: "group" } })).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("honors disabled channels, read-only subtasks and file scope before networking", async () => {
    const filePath = path.join(state.root, "report.txt"); await fs.writeFile(filePath, "report");
    adapter.status.enabled = false;
    expect(JSON.parse(await channelFileTool.execute({ filePath }, ctx)).success).toBe(false);
    adapter.status.enabled = true;
    expect(JSON.parse(await channelFileTool.execute({ filePath }, { ...ctx, readOnly: true })).success).toBe(false);
    state.level = "project-read-only";
    expect(JSON.parse(await channelFileTool.execute({ filePath }, { ...ctx, permissionMode: "normal", resolvedWorkspaceRoot: path.join(state.root, "project") })).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects missing, empty and oversized files before upload", async () => {
    const empty = path.join(state.root, "empty.txt"); await fs.writeFile(empty, "");
    const large = path.join(state.root, "large.bin"); await fs.writeFile(large, ""); await fs.truncate(large, 64 * 1024 * 1024 + 1);
    for (const filePath of [path.join(state.root, "missing"), empty, large, state.root]) {
      expect(JSON.parse(await channelFileTool.execute({ filePath }, ctx)).success).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("reports API rejection as failure instead of claiming an attachment was sent", async () => {
    const filePath = path.join(state.root, "report.txt"); await fs.writeFile(filePath, "report");
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.endsWith("/sendmessage") ? Response.json({ ret: -2 }) : original(url, init));
    const result = JSON.parse(await channelFileTool.execute({ filePath }, ctx));
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("ret=-2");
    expect(state.logs).toHaveBeenCalledWith(expect.objectContaining({ dir: "error" }));
  });
  it("cancels an in-flight CDN upload without sending the attachment", async () => {
    const filePath = path.join(state.root, "report.txt"); await fs.writeFile(filePath, "report");
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.endsWith("/upload") ? new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })) : original(url, init));
    const abort = new AbortController();
    const run = channelFileTool.execute({ filePath }, { ...ctx, signal: abort.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    abort.abort(new Error("用户取消发送"));
    expect(JSON.parse(await run)).toMatchObject({ success: false, error: "用户取消发送" });
    expect(sent).toHaveLength(0);
  });
});
