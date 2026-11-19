// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDefaultAffectState, createDefaultRelationshipState } from "../../../../../main/persona/persona-spec";
import type { CompanionCommand, CompanionSnapshot } from "../../../../../shared/companion";
import { setUiLocale } from "../../../i18n";
import { ChatCompanionFollowups } from "./ChatCompanionFollowups";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
let root: Root;

beforeEach(() => {
  setUiLocale("zh-CN");
  Object.assign(window, {
    matchMedia: vi.fn((media: string) => ({ media, matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })),
    settings: { getGeneral: vi.fn(async () => ({ proactiveChatMode: "off" })) },
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function fixtures(): CompanionSnapshot {
  const now = Date.now();
  return {
    revision: 17,
    relationship: { ...createDefaultRelationshipState(), proactiveLifeEnabled: true },
    affect: createDefaultAffectState(),
    permissions: { preset: "inherit", paused: false, deniedTools: [], confirmTools: [] },
    records: [],
    followups: [
      { id: "a1", conversationId: "chat-a", topic: "论文答辩", nextEligibleAt: now + 60_000, status: "active", createdAt: now, updatedAt: now },
      { id: "b1", conversationId: "chat-b", topic: "异地旅行", nextEligibleAt: now + 60_000, status: "active", createdAt: now, updatedAt: now },
    ],
  };
}

function button(label: string): HTMLButtonElement {
  const element = [...document.querySelectorAll("button")].find(item => item.textContent?.replace(/\s/g, "") === label.replace(/\s/g, ""));
  if (!element) throw new Error(`Button not rendered: ${label}`);
  return element;
}

async function inputTopic(topic: string) {
  const input = document.querySelector<HTMLInputElement>('input[placeholder="例如：论文答辩"]')!;
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, topic);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("asks for explicit confirmation and manages only the current conversation's follow-ups", async () => {
  let snapshot = fixtures();
  const update = vi.fn(async (command: CompanionCommand) => {
    const items = snapshot.followups!;
    if (command.type === "followup_save") {
      const now = Date.now();
      const id = command.id ?? "new";
      snapshot = { ...snapshot, followups: [...items.filter(item => item.id !== id), { ...command, id, status: "active", createdAt: now, updatedAt: now }] };
    } else if (command.type === "followup_status") {
      snapshot = { ...snapshot, followups: items.map(item => item.id === command.id ? { ...item, status: command.status } : item) };
    }
    snapshot.revision++;
    return snapshot;
  });
  Object.assign(window, { companion: { get: vi.fn(async () => snapshot), update } });
  await act(async () => root.render(<ChatCompanionFollowups conversationId="chat-a" conversationTitle="周末闲聊" />));
  await act(async () => button("约个时间再聊").click());
  expect(document.body.textContent).toContain("周末闲聊");
  expect(document.body.textContent).toContain("论文答辩");
  expect(document.body.textContent).not.toContain("异地旅行");
  expect(document.body.textContent).toContain("跟进需要开启主动聊天");
  expect(button("确认跟进").disabled).toBe(true);
  await inputTopic("  项目验收  ");
  expect(update).not.toHaveBeenCalled();

  await act(async () => button("确认跟进").click());
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ type: "followup_save", conversationId: "chat-a", topic: "项目验收", expectedRevision: 17, nextEligibleAt: expect.any(Number) }));
  const created = [...document.querySelectorAll("article")].find(item => item.textContent?.includes("项目验收"))!;
  const cancel = [...created.querySelectorAll("button")].find(item => item.textContent === "以后别问")!;
  await act(async () => cancel.click());
  expect(update).toHaveBeenLastCalledWith({ type: "followup_status", id: "new", conversationId: "chat-a", status: "cancelled", expectedRevision: 18 });
  expect(created.textContent).toContain("已取消");
  expect(document.body.textContent).not.toContain("异地旅行");
  const reschedule = [...created.querySelectorAll("button")].find(item => item.textContent === "重新约时间")!;
  await act(async () => reschedule.click());
  expect(document.activeElement?.getAttribute("type")).toBe("datetime-local");
  expect(update).toHaveBeenCalledTimes(2);
  await act(async () => button("确认新时间").click());
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ type: "followup_save", id: "new", conversationId: "chat-a", expectedRevision: 19 }));

  await act(async () => root.render(<ChatCompanionFollowups conversationId="chat-b" />));
  expect(document.body.textContent).not.toContain("项目验收");
  await act(async () => button("约个时间再聊").click());
  expect(document.body.textContent).toContain("异地旅行");
  expect(document.body.textContent).not.toContain("论文答辩");
});

it("keeps the unsubmitted draft when a concurrent change rejects the save", async () => {
  const snapshot = fixtures();
  const get = vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValue({ ...snapshot, revision: 18 });
  const update = vi.fn().mockRejectedValueOnce(new Error("revision conflict")).mockResolvedValue({ ...snapshot, revision: 19 });
  Object.assign(window, { companion: { get, update } });
  await act(async () => root.render(<ChatCompanionFollowups conversationId="chat-a" />));
  await act(async () => button("约个时间再聊").click());
  await inputTopic("项目验收");
  await act(async () => button("确认跟进").click());
  expect(document.body.textContent).toContain("未能保存跟进");
  expect(document.querySelector<HTMLInputElement>('input[placeholder="例如：论文答辩"]')?.value).toBe("项目验收");
  await act(async () => button("重新加载").click());
  expect(update).toHaveBeenCalledTimes(1);
  await act(async () => button("确认跟进").click());
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ type: "followup_save", topic: "项目验收", expectedRevision: 18 }));
});

it("updates the visible labels when the interface language changes", async () => {
  Object.assign(window, { companion: { get: async () => fixtures(), update: vi.fn() } });
  await act(async () => root.render(<ChatCompanionFollowups conversationId="chat-a" />));
  await act(async () => button("约个时间再聊").click());
  await act(async () => setUiLocale("en"));
  expect(document.body.textContent).toContain("Earliest follow-up time (local time)");
  await act(async () => setUiLocale("ja-JP"));
  expect(document.body.textContent).toContain("あとで話す約束");
  expect(document.body.textContent).not.toContain("Earliest follow-up time (local time)");
});
