// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanionSettingsPanel } from "./CompanionSettingsPanel";
import { createDefaultAffectState, createDefaultRelationshipState } from "../../../../main/persona/persona-spec";
import type { CompanionCommand, CompanionSnapshot } from "../../../../shared/companion";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
let root: Root | undefined;
function mediaAt(width: number) {
  return vi.fn((query: string) => {
    const min = /min-width:\s*(\d+)/.exec(query), max = /max-width:\s*(\d+)/.exec(query);
    return { matches: (!min || width >= Number(min[1])) && (!max || width <= Number(max[1])), media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} };
  });
}
beforeEach(() => {
  Object.assign(window, { matchMedia: mediaAt(1280) });
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => computedStyle(element));
});
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; document.body.innerHTML = ""; vi.restoreAllMocks(); });

it("shows a bound concrete followup and sends revisioned completion / rescheduling commands", async () => {
  let snapshot: CompanionSnapshot = { revision: 7, relationship: createDefaultRelationshipState(), affect: createDefaultAffectState(), permissions: { preset: "inherit", paused: false, deniedTools: [], confirmTools: [] }, records: [],
    followups: [{ id: "f1", topic: "论文答辩", conversationId: "chat-1", nextEligibleAt: Date.now() + 60_000, status: "awaiting_reply", createdAt: 1, updatedAt: 1, lastAskedAt: Date.now() - 1000 }],
  };
  const update = vi.fn(async (command: CompanionCommand) => {
    snapshot = { ...snapshot, revision: snapshot.revision + 1, followups: snapshot.followups!.map(item => ({ ...item, status: command.type === "followup_status" ? command.status : "active" })) };
    return snapshot;
  });
  Object.assign(window, { companion: { get: async () => snapshot, update, export: async () => "{}" }, settings: { getToolCatalog: async () => [] }, chatStore: { list: async () => [{ id: "chat-1", title: "微信绑定对话" }] } });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(CompanionSettingsPanel)));
  const followupTab = Array.from(host.querySelectorAll<HTMLElement>("[role=tab]")).find(item => item.textContent === "具体跟进")!;
  await act(async () => followupTab.click());
  expect(host.textContent).toContain("微信绑定对话");
  expect(host.textContent).toContain("已关心，等待回复");
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find(item => item.textContent?.replace(/\s/g, "") === label.replace(/\s/g, ""))!;
  await act(async () => button("完成").click());
  expect(update).toHaveBeenLastCalledWith({ type: "followup_status", id: "f1", conversationId: "chat-1", status: "completed", expectedRevision: 7 });
  await act(async () => button("编辑 / 再约时间").click());
  expect((host.querySelector('[aria-label="跟进事项名称"]') as HTMLInputElement).value).toBe("论文答辩");
  await act(async () => button("保存并重新约时间").click());
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ type: "followup_save", id: "f1", topic: "论文答辩", conversationId: "chat-1", expectedRevision: 8, nextEligibleAt: expect.any(Number) }));
});

it("uses a visible mobile group selector to navigate all four panels", async () => {
  Object.assign(window, {
    matchMedia: mediaAt(390),
    companion: { get: async () => ({ revision: 1, relationship: createDefaultRelationshipState(), affect: createDefaultAffectState(), permissions: { preset: "inherit", paused: false, deniedTools: [], confirmTools: [] }, records: [], followups: [] }), update: vi.fn(), export: async () => "{}" },
    settings: { getToolCatalog: async () => [] }, chatStore: { list: async () => [] },
  });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(CompanionSettingsPanel)));
  expect(host.querySelectorAll("[role=tab]")).toHaveLength(0);
  async function select(label: string) {
    const input = host.querySelector('[aria-label="昔涟设置分组"]')!;
    await act(async () => input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    const option = [...document.querySelectorAll<HTMLElement>(".ant-select-dropdown .ant-select-item-option-content")].find(element => element.textContent === label)!;
    expect(option).toBeDefined();
    await act(async () => option.click());
  }
  await select("记录与修复"); expect(host.querySelector('[aria-label="新的修复约定"]')).not.toBeNull();
  await select("具体跟进"); expect(host.querySelector('[aria-label="跟进事项名称"]')).not.toBeNull();
  await select("能力与权限"); expect(host.querySelector('[aria-label="暂停新工具调用"]')).not.toBeNull();
  await select("相处与形象"); expect(host.querySelector('[aria-label="对你的称呼"]')).not.toBeNull();
});

it("forgets only the selected chat preference and saves an opt-out at the latest revision", async () => {
  const relationship = createDefaultRelationshipState();
  delete relationship.learnConversationStyle;
  let snapshot: CompanionSnapshot = {
    revision: 5,
    relationship,
    affect: createDefaultAffectState(),
    permissions: { preset: "inherit", paused: false, deniedTools: [], confirmTools: [] },
    records: [],
    learnedPreferences: [
      { conversationId: "chat-1", topic: "questions", updatedAt: Date.now() },
      { conversationId: "chat-2", topic: "questions", updatedAt: Date.now() },
    ],
  };
  const update = vi.fn(async (command: CompanionCommand) => {
    if (command.type === "forget_learned_preference") {
      snapshot = { ...snapshot, learnedPreferences: snapshot.learnedPreferences?.filter(item =>
        item.conversationId !== command.conversationId || item.topic !== command.topic) };
    } else if (command.type === "preferences") {
      snapshot = { ...snapshot, relationship: { ...snapshot.relationship, ...command.patch } };
    }
    snapshot = { ...snapshot, revision: snapshot.revision + 1 };
    return snapshot;
  });
  Object.assign(window, {
    companion: { get: async () => snapshot, update, export: async () => "{}" },
    settings: { getToolCatalog: async () => [] },
    chatStore: { list: async () => [{ id: "chat-1", title: "微信私聊" }, { id: "chat-2", title: "桌面私聊" }] },
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(CompanionSettingsPanel)));

  const preferenceSwitch = host.querySelector<HTMLButtonElement>('[aria-label="记住聊天偏好"]')!;
  expect(preferenceSwitch.getAttribute("aria-checked")).toBe("true");
  await act(async () => preferenceSwitch.click());
  const forgetFirst = host.querySelector<HTMLButtonElement>('[aria-label="忘记微信私聊中的“少用问句收尾”偏好"]')!;
  await act(async () => forgetFirst.click());
  expect(update).not.toHaveBeenCalled();
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find(button => button.textContent?.replace(/\s/g, "") === "确认")!;
  await act(async () => confirm.click());
  expect(update).toHaveBeenLastCalledWith({ type: "forget_learned_preference", conversationId: "chat-1", topic: "questions", expectedRevision: 5 });
  expect(host.contains(forgetFirst)).toBe(false);
  expect(host.querySelector('[aria-label="忘记桌面私聊中的“少用问句收尾”偏好"]')).not.toBeNull();
  expect(preferenceSwitch.getAttribute("aria-checked")).toBe("false");

  const save = [...host.querySelectorAll("button")].find(button => button.textContent === "保存相处偏好")!;
  await act(async () => save.click());
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
    type: "preferences",
    patch: expect.objectContaining({ learnConversationStyle: false }),
    expectedRevision: 6,
  }));
});

it("preserves unsaved capability learning settings when forgetting one workspace method", async () => {
  const relationship = createDefaultRelationshipState();
  delete relationship.learnTaskMethods;
  const firstWorkspace = "a".repeat(64);
  const secondWorkspace = "b".repeat(64);
  let snapshot: CompanionSnapshot = {
    revision: 12,
    relationship,
    affect: createDefaultAffectState(),
    permissions: { preset: "inherit", paused: false, deniedTools: [], confirmTools: [] },
    records: [],
    taskLessons: [firstWorkspace, secondWorkspace].map(workspaceKey => ({
      workspaceKey,
      task: "find-content",
      method: "search-then-read",
      confirmations: 2,
      updatedAt: Date.now(),
    })),
  };
  const update = vi.fn(async (command: CompanionCommand) => {
    if (command.type === "forget_task_method") {
      snapshot = { ...snapshot, taskLessons: snapshot.taskLessons?.filter(item =>
        item.workspaceKey !== command.workspaceKey || item.task !== command.task || item.method !== command.method) };
    } else if (command.type === "preferences") {
      snapshot = { ...snapshot, relationship: { ...snapshot.relationship, ...command.patch } };
    }
    snapshot = { ...snapshot, revision: snapshot.revision + 1 };
    return snapshot;
  });
  Object.assign(window, {
    companion: { get: async () => snapshot, update, export: async () => "{}" },
    settings: { getToolCatalog: async () => [] },
    chatStore: { list: async () => [] },
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(CompanionSettingsPanel)));
  const permissionsTab = [...host.querySelectorAll<HTMLElement>("[role=tab]")].find(item => item.textContent === "能力与权限")!;
  await act(async () => permissionsTab.click());
  expect(host.textContent).toContain("已验证 2 次");
  expect(host.textContent).not.toContain(firstWorkspace);

  const learningSwitch = host.querySelector<HTMLButtonElement>('[aria-label="从办事结果学习"]')!;
  expect(learningSwitch.getAttribute("aria-checked")).toBe("true");
  await act(async () => learningSwitch.click());
  const firstForget = host.querySelector<HTMLButtonElement>('[aria-label^="忘记工作区 aaaaaaaa"]')!;
  await act(async () => firstForget.click());
  expect(update).not.toHaveBeenCalled();
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find(button => button.textContent?.replace(/\s/g, "") === "确认")!;
  await act(async () => confirm.click());
  expect(update).toHaveBeenLastCalledWith({
    type: "forget_task_method",
    workspaceKey: firstWorkspace,
    task: "find-content",
    method: "search-then-read",
    expectedRevision: 12,
  });
  expect(host.contains(firstForget)).toBe(false);
  expect(host.querySelector('[aria-label^="忘记工作区 bbbbbbbb"]')).not.toBeNull();
  expect(learningSwitch.getAttribute("aria-checked")).toBe("false");

  const save = [...host.querySelectorAll("button")].find(button => button.textContent === "保存学习设置")!;
  await act(async () => save.click());
  expect(update).toHaveBeenLastCalledWith({
    type: "preferences",
    patch: { learnTaskMethods: false },
    expectedRevision: 13,
  });
  expect(learningSwitch.getAttribute("aria-checked")).toBe("false");
  expect(save.disabled).toBe(true);
});
