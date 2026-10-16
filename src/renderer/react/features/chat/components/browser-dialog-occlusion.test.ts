// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeDialogOcclusion } from "./browser-dialog-occlusion";

const stops: Array<() => void> = [];
function dialog(role = "dialog") {
  const node = document.createElement("div");
  node.setAttribute("role", role);
  vi.spyOn(node, "getClientRects").mockImplementation(() => {
    const hidden = !node.isConnected || node.closest('[hidden], [style*="display: none"]');
    return (hidden ? [] : [{}]) as unknown as DOMRectList;
  });
  return node;
}
async function mutations() { await Promise.resolve(); }
function observe() {
  const changes = vi.fn();
  stops.push(observeDialogOcclusion(changes));
  return changes;
}
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("native browser dialog occlusion", () => {
  it("ignores an explicitly non-modal card while still hiding for a modal", async () => {
    const changes = observe();
    const card = dialog();
    card.setAttribute("aria-modal", "false");
    document.body.append(card);
    await mutations();
    expect(changes.mock.calls).toEqual([[false]]);
    const modal = dialog();
    document.body.append(modal);
    await mutations();
    modal.remove();
    await mutations();
    expect(changes.mock.calls).toEqual([[false], [true], [false]]);
    expect(card.isConnected).toBe(true);
  });
  it("updates when an open dialog changes its modal semantics", async () => {
    const card = dialog();
    document.body.append(card);
    const changes = observe();
    card.setAttribute("aria-modal", "false");
    await mutations();
    card.removeAttribute("aria-modal");
    await mutations();
    expect(changes.mock.calls).toEqual([[true], [false], [true]]);
  });
  it("detects a dialog already open before the browser mounts", () => {
    document.body.append(dialog());
    expect(observe().mock.calls).toEqual([[true]]);
  });
  it("hides for a portal and restores after removal", async () => {
    const changes = observe();
    const popup = dialog();
    document.body.append(popup);
    await mutations();
    popup.remove();
    await mutations();
    expect(changes.mock.calls).toEqual([[false], [true], [false]]);
  });
  it("restores when a retained element loses its dialog role", async () => {
    const popup = dialog();
    document.body.append(popup);
    const changes = observe();
    popup.removeAttribute("role");
    await mutations();
    expect(changes.mock.calls).toEqual([[true], [false]]);
  });
  it("keeps the browser hidden until the last stacked dialog closes", async () => {
    const changes = observe();
    const first = dialog(), second = dialog("alertdialog");
    document.body.append(first, second);
    await mutations();
    first.remove();
    await mutations();
    expect(changes.mock.calls).toEqual([[false], [true]]);
    second.remove();
    await mutations();
    expect(changes.mock.calls).toEqual([[false], [true], [false]]);
  });
  it("tracks retained AntD wrappers through their exit animation and reopening", async () => {
    const wrapper = document.createElement("div");
    wrapper.style.display = "none";
    wrapper.append(dialog());
    document.body.append(wrapper);
    const changes = observe();
    wrapper.style.display = "block";
    await mutations();
    wrapper.className = "ant-modal-wrap ant-modal-leave";
    await mutations();
    expect(changes.mock.calls).toEqual([[false], [true]]);
    wrapper.style.display = "none";
    await mutations();
    wrapper.style.display = "block";
    await mutations();
    expect(changes.mock.calls).toEqual([[false], [true], [false], [true]]);
  });
  it("ignores unrelated streaming mutations without scanning dialogs or reading layout", async () => {
    const changes = observe();
    const scan = vi.spyOn(document, "querySelectorAll");
    const stream = document.createElement("div");
    document.body.append(stream);
    for (let i = 0; i < 100; i++) {
      const line = document.createElement("span");
      line.textContent = `chunk ${i}`;
      stream.append(line);
      await mutations();
    }
    expect(scan).not.toHaveBeenCalled();
    expect(changes.mock.calls).toEqual([[false]]);
  });
  it("disconnects without restoring a browser tab that has become inactive", async () => {
    const changes = observe();
    const popup = dialog();
    document.body.append(popup);
    await mutations();
    stops.pop()!();
    popup.remove();
    await mutations();
    expect(changes.mock.calls).toEqual([[false], [true]]);
  });
});
