// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CompanionWorldSuggestion } from "../../../../../shared/companion";
import { setUiLocale } from "../../../i18n";
import { ChatCompanionWorldSuggestions } from "./ChatCompanionWorldSuggestions";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
let root: Root;

beforeEach(() => {
  setUiLocale("zh-CN");
  Object.assign(window, {
    matchMedia: vi.fn((media: string) => ({ media, matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })),
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

function button(label: string): HTMLButtonElement {
  const element = [...document.querySelectorAll("button")].find(item => item.textContent?.replace(/\s/g, "") === label.replace(/\s/g, ""));
  if (!element) throw new Error(`Button not rendered: ${label}`);
  return element;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

async function fillInvitation(title: string, intent: string) {
  const input = document.querySelector<HTMLInputElement>(".cy-chat-world-suggestions input")!;
  const textarea = document.querySelector<HTMLTextAreaElement>(".cy-chat-world-suggestions textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, title);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, intent);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const planned: CompanionWorldSuggestion = {
  id: "world-action:1",
  title: "观星笔记",
  status: "planned",
  startsAt: Date.UTC(2026, 10, 18, 15),
  endsAt: Date.UTC(2026, 10, 18, 15, 45),
};

it("requires confirmation and shows a simulated outcome after refreshing progress", async () => {
  const getWorldSuggestions = vi.fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ ...planned, status: "completed", outcome: "留下了一页观星笔记。" }]);
  const suggestWorldAction = vi.fn().mockResolvedValue({ action: planned });
  Object.assign(window, { companion: { getWorldSuggestions, suggestWorldAction, withdrawWorldSuggestion: vi.fn() } });
  await act(async () => root.render(<ChatCompanionWorldSuggestions conversationId="chat-a" conversationTitle="晚上闲谈" />));
  await click("邀昔涟做件小事");
  expect(getWorldSuggestions).toHaveBeenCalledWith("chat-a");
  expect(document.body.textContent).toContain("晚上闲谈");
  expect(document.body.textContent).toContain("翁法罗斯里的虚构建议");
  expect(button("确认邀请").disabled).toBe(true);
  await fillInvitation("  观星笔记  ", "  观星后写下一句感想。  ");
  expect(suggestWorldAction).not.toHaveBeenCalled();

  await click("确认邀请");
  expect(suggestWorldAction).toHaveBeenCalledWith({
    id: expect.any(String),
    conversationId: "chat-a",
    title: "观星笔记",
    intent: "观星后写下一句感想。",
  });
  expect(document.body.textContent).toContain("已安排");
  expect(document.body.textContent).not.toContain("留下了一页观星笔记。");
  await click("刷新进展");
  expect(document.body.textContent).toContain("已完成");
  expect(document.body.textContent).toContain("留下了一页观星笔记。");
});

it("retains the draft and uses a stable invitation ID when a result is unavailable or lost", async () => {
  const getWorldSuggestions = vi.fn().mockResolvedValue([]);
  const suggestWorldAction = vi.fn()
    .mockRejectedValueOnce(new Error("response lost"))
    .mockResolvedValueOnce({ reason: "unavailable" })
    .mockResolvedValueOnce({ action: planned });
  Object.assign(window, { companion: { getWorldSuggestions, suggestWorldAction, withdrawWorldSuggestion: vi.fn() } });
  await act(async () => root.render(<ChatCompanionWorldSuggestions conversationId="chat-a" />));
  await click("邀昔涟做件小事");
  await fillInvitation("观星笔记", "观星后写下一句感想。");
  await click("确认邀请");
  expect(document.body.textContent).toContain("暂时无法确认记录结果");
  expect(document.querySelector<HTMLInputElement>(".cy-chat-world-suggestions input")?.value).toBe("观星笔记");
  await click("重试邀请");
  expect(document.body.textContent).toContain("暂时没有合适的安排");
  expect(document.querySelector<HTMLTextAreaElement>(".cy-chat-world-suggestions textarea")?.value).toBe("观星后写下一句感想。");
  await click("重试邀请");
  expect(suggestWorldAction.mock.calls).toEqual(Array.from({ length: 3 }, () => suggestWorldAction.mock.calls[0]));
  expect(document.body.textContent).toContain("已记录这次邀请");
  expect(document.querySelectorAll(".cy-chat-world-suggestions article")).toHaveLength(1);
});

it("reseats the modal when the chat changes and keeps late submissions in the original chat", async () => {
  const getWorldSuggestions = vi.fn(async (conversationId: string) =>
    conversationId === "chat-b" ? [{ ...planned, id: "chat-b-action", title: "给朋友写信" }] : []);
  let finish: (value: { action: CompanionWorldSuggestion }) => void = () => {};
  const suggestWorldAction = vi.fn(() => new Promise<{ action: CompanionWorldSuggestion }>(resolve => { finish = resolve; }));
  Object.assign(window, { companion: { getWorldSuggestions, suggestWorldAction, withdrawWorldSuggestion: vi.fn() } });
  await act(async () => root.render(<ChatCompanionWorldSuggestions conversationId="chat-a" />));
  await click("邀昔涟做件小事");
  await fillInvitation("观星笔记", "观星后写下一句感想。");
  await click("确认邀请");
  expect(suggestWorldAction).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "chat-a" }));

  await act(async () => root.render(<ChatCompanionWorldSuggestions conversationId="chat-b" />));
  await click("邀昔涟做件小事");
  await act(async () => finish({ action: planned }));
  expect(getWorldSuggestions.mock.calls).toEqual([["chat-a"], ["chat-b"]]);
  expect(document.body.textContent).toContain("给朋友写信");
  expect(document.body.textContent).not.toContain("观星笔记");
  expect(suggestWorldAction).toHaveBeenCalledTimes(1);
  expect(button("确认邀请").disabled).toBe(true);
});

it("withdraws a planned invitation and shows a stale response as the actual progress", async () => {
  const another = { ...planned, id: "world-action:2", title: "做一枚书签" };
  const withdrawWorldSuggestion = vi.fn()
    .mockResolvedValueOnce({ ...planned, status: "interrupted", reason: "用户撤回了邀请。" })
    .mockResolvedValueOnce({ ...another, status: "active" });
  Object.assign(window, { companion: {
    getWorldSuggestions: vi.fn().mockResolvedValue([planned, another]),
    suggestWorldAction: vi.fn(),
    withdrawWorldSuggestion,
  } });
  await act(async () => root.render(<ChatCompanionWorldSuggestions conversationId="chat-a" />));
  await click("邀昔涟做件小事");
  await click("撤回邀请");
  expect(withdrawWorldSuggestion).toHaveBeenLastCalledWith("chat-a", planned.id);
  expect(document.body.textContent).toContain("已中断");
  expect(document.body.textContent).toContain("用户撤回了邀请。");
  await click("撤回邀请");
  expect(withdrawWorldSuggestion).toHaveBeenLastCalledWith("chat-a", another.id);
  expect(document.body.textContent).toContain("进行中");
  expect(document.body.textContent).toContain("这件小事的进展已变");
});
