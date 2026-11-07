import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebChannelRuntime } from "./web-channel-runtime";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("WebChannelRuntime multimodal delivery", () => {
  it("keeps generated image parts as OneBot image segments", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "cyrene-web-channel-"));
    dirs.push(dataDir);
    const runtime = new WebChannelRuntime(dataDir, { channels: {}, patchChannels: async patch => patch });
    const encodeOutbound = vi.fn(async () => "/tmp/generated.png");
    (runtime as any).qqMedia = { encodeOutbound };
    (runtime as any).qqSupportsStream = false;
    const call = vi.fn(async () => ({}));
    await (runtime as any).sendQq({ channel: "qq", chatType: "private", targetId: "user-1", parts: [{ kind: "image", filePath: "/tmp/generated.png", caption: "生成图片" }] }, { call });
    expect(encodeOutbound).toHaveBeenCalledWith("/tmp/generated.png", "image", false);
    expect(call).toHaveBeenCalledWith("send_private_msg", {
      user_id: "user-1",
      message: [{ type: "image", data: { file: "/tmp/generated.png" } }],
    });
  });

  it("rejects QQ Bot attachment URLs outside the official HTTPS media domains", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "cyrene-web-channel-url-"));
    dirs.push(dataDir);
    const runtime = new WebChannelRuntime(dataDir, { channels: {}, patchChannels: async patch => patch });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await (runtime as any).downloadRemoteAttachments({
      channel: "qqbot", chatType: "private", messageId: "m1", senderId: "u1", chatId: "u1", text: "图片",
      attachments: [{ kind: "image", url: "http://127.0.0.1:4317/private.png", mime: "image/png" }],
    }, "qqbot");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
