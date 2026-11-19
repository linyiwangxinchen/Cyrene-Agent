// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatCompanionCorrection } from "./ChatCompanionCorrection";

let root: Root;
let host: HTMLDivElement;
const onCorrectionChange = vi.fn();

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  onCorrectionChange.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(conversationId: string | null, correction = "") {
  await act(async () => root.render(createElement(ChatCompanionCorrection, {
    conversationId, correction, onCorrectionChange,
  })));
}

async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

function textarea() {
  return document.querySelector<HTMLTextAreaElement>('[aria-label="希望怎样调整回应"]')!;
}

async function typeCorrection(note: string) {
  await act(async () => {
    const input = textarea();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, note);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("sets and clears a next-reply correction without calling the relationship store", async () => {
  const update = vi.fn();
  vi.stubGlobal("companion", { update });
  await render(null);
  await click("纠正回应");
  await typeCorrection("  先听我说完  ");
  await click("仅下次回复");
  expect(onCorrectionChange).toHaveBeenCalledWith("先听我说完");
  expect(update).not.toHaveBeenCalled();

  await render(null, "先听我说完");
  await click("已设下次纠正");
  expect(textarea().value).toBe("先听我说完");
  await click("取消下次纠正");
  expect(onCorrectionChange).toHaveBeenLastCalledWith("");
  expect(update).not.toHaveBeenCalled();
});

it("retains the correction after a revision conflict and saves only to the bound session", async () => {
  const get = vi.fn().mockResolvedValueOnce({ revision: 7 }).mockResolvedValueOnce({ revision: 8 });
  const update = vi.fn().mockRejectedValueOnce(new Error("conflict")).mockResolvedValueOnce({ revision: 9 });
  vi.stubGlobal("companion", { get, update });

  await render("chat-a");
  await click("纠正回应");
  await typeCorrection("先复述我的问题");
  await click("在此会话记住");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("可以重试");
  expect(textarea().value).toBe("先复述我的问题");
  await click("在此会话记住");
  expect(update).toHaveBeenLastCalledWith({
    type: "repair", conversationId: "chat-a", expectedRevision: 8, note: "先复述我的问题",
  });
  expect(document.querySelector('[role="status"]')?.textContent).toContain("已保存到此会话");
});

it("discards a pending save before it can write when the conversation changes", async () => {
  const get = vi.fn();
  const update = vi.fn();
  const snapshot = Promise.withResolvers<{ revision: number }>();
  get.mockReturnValue(snapshot.promise);
  vi.stubGlobal("companion", { get, update });

  await render("chat-a");
  await click("纠正回应");
  await typeCorrection("这个话题请别再问");
  await click("在此会话记住");
  expect(get).toHaveBeenCalledOnce();
  await render("chat-b");
  await act(async () => snapshot.resolve({ revision: 7 }));
  expect(update).not.toHaveBeenCalled();
  await click("纠正回应");
  expect(textarea().value).toBe("");
});
