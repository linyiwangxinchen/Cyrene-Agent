import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("./plugin-panel/panel-bridge.js", import.meta.url), "utf8");
function fixture() {
  const messages: any[] = [], listeners = new Map<string, (event: any) => void>();
  const parent = { postMessage: (value: unknown) => messages.push(value) };
  const window: any = { parent, addEventListener: (name: string, callback: any) => listeners.set(name, callback) };
  vm.runInNewContext(source, { window, document: { documentElement: { scrollHeight: 200, style: { setProperty() {} } } }, Map, Promise, Error, setTimeout, clearTimeout });
  return { messages, panel: window.CyrenePanel, send: (data: object, from = parent) => listeners.get("message")!({ data: { protocol: "cyrene-panel/1", ...data }, source: from }) };
}
afterEach(() => vi.useRealTimers());
describe("panel bridge initialization race", () => {
  it("queues requests until the owning parent registers the frame and sends init", async () => {
    vi.useFakeTimers(); const f = fixture();
    const result = f.panel.invoke("garden", "snapshot");
    expect(f.messages).toEqual([]);
    f.send({ kind: "init" }, {} as never); expect(f.messages).toEqual([]);
    f.send({ kind: "init", theme: { name: "default", tokens: {} } });
    expect(f.messages.filter(m => m.kind === "invoke")).toHaveLength(1);
    const id = f.messages.find(m => m.kind === "invoke").seq;
    f.send({ kind: "invoke-result", seq: id, ok: true, data: { ready: true } });
    await expect(result).resolves.toEqual({ ready: true });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects lost handshakes and does not replay expired actions after late init", async () => {
    vi.useFakeTimers(); const f = fixture();
    const result = expect(f.panel.invoke("garden", "send")).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(30000); await result;
    f.send({ kind: "init" }); expect(f.messages.filter(m => m.kind === "invoke")).toEqual([]);
  });
});
