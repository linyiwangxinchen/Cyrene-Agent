import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createLarkChannel, CTenantAccessToken, Domain, LarkChannelError, LoggerLevel, type LarkChannel } from "@larksuiteoapi/node-sdk";
import { FeishuAdapter, transcodeAudioFileToFeishuOpus } from "./index";
import { formatFeishuConnectionError, silentFeishuSdkLogger } from "./connection-error";

vi.mock("@larksuiteoapi/node-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@larksuiteoapi/node-sdk")>()),
  createLarkChannel: vi.fn(),
}));
vi.mock("../../settings-store", () => ({
  loadChannelsSettings: () => ({ feishu: { enabled: true, appId: "cli_fixture", appSecret: "fixture-secret" } }),
}));

const temporaryFiles: string[] = [];

afterEach(() => {
  for (const filePath of temporaryFiles.splice(0)) {
    fs.rmSync(filePath, { force: true });
  }
});

const identityFailure = "could not resolve bot identity via /open-apis/bot/v3/info — required for channel to function";
const sdkIdentityFailure = (cause?: Error) => new LarkChannelError("not_connected", identityFailure, { cause });

function stubConnection(connect: () => Promise<void>) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const disconnect = vi.fn(async () => {});
  const channel = {
    connect: vi.fn(connect),
    disconnect,
    on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
  } as unknown as LarkChannel;
  return { channel, disconnect, emit: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args) };
}

describe("FeishuAdapter connection diagnosis", () => {
  it("shows the exact stage and safe codes when the SDK wraps a credential failure", async () => {
    const raw = Object.assign(new Error("failed to get tenant_access_token, code: 10014, msg: fixture-secret"), {
      config: { data: "fixture-secret", headers: { Authorization: "fixture-token" } },
    });
    vi.mocked(createLarkChannel).mockReturnValue({
      on: vi.fn(),
      connect: vi.fn().mockRejectedValue(sdkIdentityFailure(raw)),
      disconnect: vi.fn(),
    } as unknown as LarkChannel);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const adapter = new FeishuAdapter();
    try {
      await adapter.start();
      const message = "获取飞书租户访问凭证失败（飞书错误码 10014）。请核对同一应用的 App ID、App Secret 和应用状态。";
      expect(adapter.getStatus()).toMatchObject({ phase: "error", message });
      expect(consoleError).toHaveBeenCalledWith("[FeishuAdapter]", "connect() failed:", message);
      expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(/fixture-secret|fixture-token/);
    } finally {
      await adapter.stop();
      consoleError.mockRestore();
    }
  });

  it("distinguishes bot information failures from handshake failures without forwarding bodies", () => {
    const denied = Object.assign(new Error("private-response"), {
      config: { url: "https://open.feishu.cn/open-apis/bot/v3/info", headers: { Authorization: "fixture-token" } },
      response: { status: 403, data: { code: 99991400, msg: "private-response" } },
    });
    expect(formatFeishuConnectionError(sdkIdentityFailure(denied))).toBe("获取飞书机器人身份失败（HTTP 403，飞书错误码 99991400）");
    expect(formatFeishuConnectionError(sdkIdentityFailure(new Error(
      'bot/v3/info response missing open_id: {"code":99991400,"msg":"private-response"}',
    )))).toBe("获取飞书机器人身份失败（飞书错误码 99991400）");
    expect(formatFeishuConnectionError(sdkIdentityFailure(new Error(
      'bot/v3/info response missing open_id: {"code":0,"msg":"private-response"}',
    )))).toContain("响应没有机器人 Open ID");
    const socketError = Object.assign(new Error("private-proxy-url"), { code: "ECONNRESET" });
    expect(formatFeishuConnectionError(new LarkChannelError("not_connected", "WebSocket connect failed: private-proxy-url", {
      cause: socketError,
    }))).toBe("飞书 WebSocket 握手失败（ECONNRESET）");
    expect(formatFeishuConnectionError(sdkIdentityFailure())).toBe(identityFailure);
    expect(formatFeishuConnectionError(new Error("unknown-secret"))).toBe("飞书连接失败");
  });

  it("uses a fresh SDK token cache on every rebuild and disables raw SDK logging", async () => {
    vi.mocked(createLarkChannel).mockClear().mockImplementation(() => ({
      on: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as LarkChannel));
    const adapter = new FeishuAdapter();
    try {
      await adapter.start();
      const first = vi.mocked(createLarkChannel).mock.calls[0]![0];
      expect(first).toMatchObject({ domain: Domain.Feishu, logger: silentFeishuSdkLogger, loggerLevel: LoggerLevel.fatal, transport: "websocket" });
      await first.cache!.set(CTenantAccessToken, "fixture-old-token", undefined, { namespace: "cli_fixture" });
      await adapter.rebuild();
      const second = vi.mocked(createLarkChannel).mock.calls[1]![0];
      expect(second.cache).not.toBe(first.cache);
      expect(await second.cache!.get(CTenantAccessToken, { namespace: "cli_fixture" })).toBeUndefined();
    } finally { await adapter.stop(); }
  });
});

describe("FeishuAdapter connection lifecycle", () => {
  it("notifies the settings page when an automatic retry recovers without a manual refresh", async () => {
    vi.useFakeTimers();
    const failed = stubConnection(async () => { throw sdkIdentityFailure(); });
    const recovered = stubConnection(async () => {});
    vi.mocked(createLarkChannel).mockReset()
      .mockReturnValueOnce(failed.channel)
      .mockReturnValueOnce(recovered.channel);
    const phases: string[] = [];
    const adapter = new FeishuAdapter(() => phases.push(adapter.getStatus().phase));
    try {
      await adapter.start();
      expect(phases).toEqual(["starting", "error"]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(phases).toEqual(["starting", "error", "starting", "running"]);
    } finally {
      await adapter.stop();
      vi.useRealTimers();
    }
  });

  it("ignores a delayed retry failure and old events after a fresh connection succeeds", async () => {
    vi.useFakeTimers();
    const failed = stubConnection(async () => { throw sdkIdentityFailure(); });
    const retry = Promise.withResolvers<void>();
    const old = stubConnection(() => retry.promise);
    const fresh = stubConnection(async () => {});
    vi.mocked(createLarkChannel).mockReset()
      .mockReturnValueOnce(failed.channel)
      .mockReturnValueOnce(old.channel)
      .mockReturnValueOnce(fresh.channel);
    const observer = vi.fn();
    const adapter = new FeishuAdapter(observer);
    try {
      await adapter.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(old.channel.connect).toHaveBeenCalledOnce();
      await adapter.stop();
      await adapter.start();
      expect(adapter.getStatus().phase).toBe("running");
      observer.mockClear();
      old.emit("reconnecting");
      old.emit("reconnected");
      old.emit("error", sdkIdentityFailure());
      retry.reject(sdkIdentityFailure());
      await vi.advanceTimersByTimeAsync(30_000);
      expect(adapter.getStatus().phase).toBe("running");
      expect(observer).not.toHaveBeenCalled();
      expect(createLarkChannel).toHaveBeenCalledTimes(3);
    } finally {
      await adapter.stop();
      vi.useRealTimers();
    }
  });

  it("releases a cancelled startup and closes its late socket without reviving the adapter", async () => {
    const connected = Promise.withResolvers<void>();
    const pending = stubConnection(() => connected.promise);
    const socket = {
      getConnectionStatus: vi.fn(() => ({ state: "connecting" })),
      close: vi.fn(() => { socket.getConnectionStatus.mockReturnValue({ state: "idle" }); }),
    };
    pending.channel.rawWsClient = socket as unknown as LarkChannel["rawWsClient"];
    vi.mocked(createLarkChannel).mockReset().mockReturnValueOnce(pending.channel);
    const observer = vi.fn();
    const adapter = new FeishuAdapter(observer);
    const stop = new AbortController();
    try {
      const starting = adapter.start(stop.signal);
      stop.abort();
      await starting;
      await adapter.stop();
      expect(socket.close).toHaveBeenCalledOnce();
      expect(pending.disconnect).toHaveBeenCalledOnce();
      expect(adapter.getStatus().phase).toBe("offline");
      observer.mockClear();
      connected.resolve();
      await vi.waitFor(() => expect(pending.disconnect).toHaveBeenCalledTimes(2));
      expect(adapter.getStatus().phase).toBe("offline");
      expect(observer).not.toHaveBeenCalled();
    } finally {
      connected.resolve();
      await adapter.stop();
    }
  });
});

describe("FeishuAdapter outgoing media", () => {
  it("uploads a local sticker through the SDK image input", async () => {
    const send = vi.fn(async () => ({ messageId: "om_1" }));
    const adapter = new FeishuAdapter();
    (adapter as any).channel = { send };
    (adapter as any).status = { enabled: true, phase: "running" };

    const result = await adapter.send({
      channel: "feishu",
      targetId: "oc_chat",
      parts: [{
        kind: "sticker",
        stickerId: "hello",
        imagePath: "C:/stickers/hello.jpg",
      }],
    });

    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith("oc_chat", {
      image: { source: "C:/stickers/hello.jpg" },
    });
  });

  it("transcodes an audio file to Ogg Opus with mpv", async () => {
    const inputPath = path.join(os.tmpdir(), `cyrene-feishu-input-${Date.now()}.wav`);
    fs.writeFileSync(inputPath, Buffer.from("RIFF-test-audio"));
    temporaryFiles.push(inputPath);

    const calls: Array<{ executable: string; args: string[] }> = [];
    const outputPath = await transcodeAudioFileToFeishuOpus(inputPath, {
      resolveMpvBinary: () => "C:/Cyrene/mpv.exe",
      runMpv: async (executable: string, args: string[]) => {
        calls.push({ executable, args });
        const outputArg = args.find((arg) => arg.startsWith("--o="));
        if (!outputArg) throw new Error("missing output argument");
        fs.writeFileSync(outputArg.slice("--o=".length), Buffer.from("OggS-opus-audio"));
      },
    });
    temporaryFiles.push(outputPath);

    expect(fs.readFileSync(outputPath).subarray(0, 4).toString("ascii")).toBe("OggS");
    expect(path.extname(outputPath)).toBe(".opus");
    expect(calls).toEqual([{
      executable: "C:/Cyrene/mpv.exe",
      args: expect.arrayContaining([
        "--no-config",
        "--no-video",
        "--of=opus",
        "--oac=libopus",
        inputPath,
      ]),
    }]);
  });

  it("rejects and removes output when mpv does not produce Ogg Opus", async () => {
    const inputPath = path.join(os.tmpdir(), `cyrene-feishu-invalid-${Date.now()}.wav`);
    fs.writeFileSync(inputPath, Buffer.from("RIFF-test-audio"));
    temporaryFiles.push(inputPath);
    let generatedPath = "";

    await expect(transcodeAudioFileToFeishuOpus(inputPath, {
      resolveMpvBinary: () => "C:/Cyrene/mpv.exe",
      runMpv: async (_executable: string, args: string[]) => {
        const outputArg = args.find((arg) => arg.startsWith("--o="));
        if (!outputArg) throw new Error("missing output argument");
        generatedPath = outputArg.slice("--o=".length);
        fs.writeFileSync(generatedPath, Buffer.from("not-opus"));
      },
    })).rejects.toThrow("不是有效的 Ogg Opus 音频");

    expect(fs.existsSync(generatedPath)).toBe(false);
  });

  it("lets the SDK resolve duration from the converted Opus file", async () => {
    const opusPath = path.join(os.tmpdir(), `cyrene-feishu-${Date.now()}.opus`);
    fs.writeFileSync(opusPath, Buffer.from("OggS-opus-audio"));
    temporaryFiles.push(opusPath);
    const send = vi.fn(async () => ({ messageId: "om_audio" }));
    const adapter = new FeishuAdapter();
    (adapter as any).channel = { send };
    (adapter as any).status = { enabled: true, phase: "running" };

    const result = await adapter.send({
      channel: "feishu",
      targetId: "oc_chat",
      parts: [{ kind: "audio", filePath: opusPath, mime: "audio/ogg" }],
    });

    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith("oc_chat", {
      audio: { source: opusPath },
    });
  });
  it("does not report full delivery after a later part fails", async () => {
    const send = vi.fn().mockResolvedValueOnce({ messageId: "text" }).mockRejectedValueOnce(new Error("upload rejected"));
    const adapter = new FeishuAdapter();
    (adapter as any).channel = { send }; (adapter as any).status = { enabled: true, phase: "running" };
    expect(await adapter.send({ channel: "feishu", targetId: "chat", parts: [{ kind: "text", text: "正文" }, { kind: "image", filePath: "image.png" }] })).toEqual({ ok: false, error: "upload rejected" });
  });
});
