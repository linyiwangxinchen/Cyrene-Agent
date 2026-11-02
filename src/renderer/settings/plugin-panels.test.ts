// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountPluginPanels } from "./plugin-panels";

const plugin = { id: "fixture", name: "Fixture", version: "1.0.0", settingsPanel: "panel.html", enabled: true };
let invoke: ReturnType<typeof vi.fn>;
const disposers: Array<() => void> = [];

beforeEach(() => {
  invoke = vi.fn();
  (window as any).__cyreneWeb = true;
  (window as any).plugins = { list: async () => [plugin] };
  (window as any).pluginPanel = { invoke };
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.innerHTML = "";
  delete (window as any).__cyreneWeb;
  delete (window as any).plugins;
  delete (window as any).pluginPanel;
  vi.restoreAllMocks();
});
async function mount() {
  const container = document.createElement("div");
  container.className = "plugin-panels";
  document.body.append(container);
  const dispose = await mountPluginPanels({ containers: { plugins: container } });
  disposers.push(dispose);
  const iframe = container.querySelector("iframe")!;
  const content = iframe.contentWindow!;
  const post = vi.spyOn(content, "postMessage");
  iframe.dispatchEvent(new Event("load"));
  post.mockClear();
  return { container, dispose, content, post };
}
function send(content: Window, seq: number) {
  window.dispatchEvent(new MessageEvent("message", { source: content, origin: "null",
    data: { protocol: "cyrene-panel/1", kind: "invoke", seq, channel: "garden", args: ["snapshot"] } }));
}

it("drops late replies to detached frames and sends new replies to their owning frame", async () => {
  let finishOld!: (value: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockResolvedValueOnce({ ok: true, data: "new snapshot" });
  const old = await mount();
  send(old.content, 1);
  old.container.remove();
  old.dispose();
  const current = await mount();
  finishOld({ ok: true, data: "old snapshot" });
  await Promise.resolve(); await Promise.resolve();
  expect(current.post).not.toHaveBeenCalled();
  send(current.content, 2);
  await vi.waitFor(() => expect(current.post).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "invoke-result", seq: 2, ok: true, data: "new snapshot" }), "*"));
  expect(old.post).not.toHaveBeenCalled();
});
