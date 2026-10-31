import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHeadlessRequestProxy } from "./network-proxy";

describe("headless request proxy", () => {
  const servers: http.Server[] = [];
  const sockets = new Set<net.Socket>();
  let restoreProxy: (() => void) | undefined;

  afterEach(async () => {
    restoreProxy?.();
    restoreProxy = undefined;
    vi.restoreAllMocks();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });

  async function listen(server: http.Server): Promise<number> {
    servers.push(server);
    server.on("connection", socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  }

  it("leaves direct hosts unchanged without requiring an Electron session", async () => {
    const apply = vi.spyOn(http, "setGlobalProxyFromEnv");
    const log = { info: vi.fn(), warn: vi.fn() };
    await configureHeadlessRequestProxy({ env: {}, log });
    expect(apply).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("uses the configured proxy for external fetch while local services stay direct", async () => {
    const directPort = await listen(http.createServer((_request, response) => response.end("local-model")));
    const requests: string[] = [];
    const proxy = http.createServer((_request, response) => response.end("proxied-model"));
    proxy.on("connect", (request, socket) => {
      requests.push(request.url ?? "");
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nproxied-model"));
    });
    const proxyPort = await listen(proxy);
    const originalApply = http.setGlobalProxyFromEnv.bind(http);
    vi.spyOn(http, "setGlobalProxyFromEnv").mockImplementation(env => {
      restoreProxy = originalApply(env);
      return restoreProxy;
    });
    const log = { info: vi.fn(), warn: vi.fn() };
    await configureHeadlessRequestProxy({ env: { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` }, log });
    const external = await fetch("http://model.invalid/v1/models", { signal: AbortSignal.timeout(3000) });
    expect(await external.text()).toBe("proxied-model");
    const local = await fetch(`http://127.0.0.1:${directPort}/v1/models`, { signal: AbortSignal.timeout(3000) });
    expect(await local.text()).toBe("local-model");
    expect(requests).toEqual(["model.invalid:80"]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("preserves existing bypasses and never logs proxy credentials", async () => {
    const apply = vi.spyOn(http, "setGlobalProxyFromEnv").mockReturnValue(() => {});
    const log = { info: vi.fn(), warn: vi.fn() };
    await configureHeadlessRequestProxy({ env: {
      https_proxy: "http://secret-user:secret-password@proxy.invalid:8080",
      no_proxy: "internal.example",
      NO_PROXY: "intranet.example",
    }, log });
    const applied = apply.mock.calls[0][0];
    expect(applied.no_proxy).toBe(applied.NO_PROXY);
    expect(applied.no_proxy?.split(",")).toEqual(expect.arrayContaining(["internal.example", "intranet.example", "localhost", "127.0.0.1", "[::1]"]));
    expect(JSON.stringify(log.info.mock.calls)).not.toMatch(/secret-user|secret-password/);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("keeps startup available when the host rejects proxy configuration", async () => {
    vi.spyOn(http, "setGlobalProxyFromEnv").mockImplementation(() => {
      throw Object.assign(new Error("invalid http://user:secret@proxy.invalid"), { code: "ERR_PROXY_INVALID_CONFIG" });
    });
    const log = { info: vi.fn(), warn: vi.fn() };
    await expect(configureHeadlessRequestProxy({ env: { HTTP_PROXY: "invalid" }, log })).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("ERR_PROXY_INVALID_CONFIG"));
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/user|secret/);
  });
});
