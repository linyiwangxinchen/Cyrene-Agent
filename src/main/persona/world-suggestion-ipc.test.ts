import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionWorldSuggestion, CompanionWorldSuggestionResult } from "../../shared/companion";
import { IPC } from "../../shared/ipc-channels";
import { RelationshipLogStore } from "../relationship/relationship-log-core";
import { XilianWorldStore } from "../xilian-world/world-store";
import { registerCompanionIpc } from "./companion-ipc";

const mocks = vi.hoisted(() => ({ dataDir: "" }));
vi.mock("electron", () => ({ app: { getPath: () => mocks.dataDir } }));
vi.mock("../channels/conversation-binding-store", () => ({
  isGroupBoundConversation: (id: string) => id === "bound-group",
}));
vi.mock("../chats/chats-store", () => ({
  getSession: async (id: string) => {
    if (id === "missing") return null;
    return {
      id,
      mode: id === "work" ? "work" : "chat",
      purpose: id === "proactive" ? "proactive-chat" : undefined,
      messages: id === "group-history" ? [{ channelSource: { chatType: "group" } }] : [],
    };
  },
  getSessionRecord: vi.fn(),
}));

describe("private world suggestions over companion IPC", () => {
  let handlers: Map<string, (...args: any[]) => unknown>;
  const input = { conversationId: "chat-a", id: "first-suggestion", title: "挑一个画面", intent: "挑一处想画的角落，记下光线和颜色" };
  const invoke = <T>(channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) as Promise<T>;
  const add = (value: unknown = input) => invoke<CompanionWorldSuggestionResult>(IPC.COMPANION_WORLD_SUGGESTION_ADD, value);
  const list = (conversationId: string) => invoke<CompanionWorldSuggestion[]>(IPC.COMPANION_WORLD_SUGGESTIONS_GET, conversationId);
  const withdraw = (conversationId: string, id: string) => invoke<CompanionWorldSuggestion | null>(IPC.COMPANION_WORLD_SUGGESTION_WITHDRAW, conversationId, id);
  const worldFile = () => path.join(mocks.dataDir, "amphoreus-world.json");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T08:00:00Z"));
    mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-world-suggestion-"));
    handlers = new Map();
    registerCompanionIpc({
      handle: (id, handler) => { handlers.set(id, handler); },
      on() {},
      removeHandler() {},
      dispose() {},
    }, new RelationshipLogStore(path.join(mocks.dataDir, "relationship-log.json")));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(mocks.dataDir, { recursive: true, force: true });
  });

  it("validates data and rejects unavailable, group-bound, historical group and non-Chat sessions", async () => {
    for (const conversationId of ["missing", "bound-group", "group-history", "work", "proactive"]) {
      await expect(add({ ...input, conversationId })).rejects.toThrow("只有普通私聊");
      await expect(list(conversationId)).rejects.toThrow("只有普通私聊");
    }
    await expect(add({ ...input, title: "  " })).rejects.toThrow("有效的小事");
    await expect(add({ ...input, intent: "a".repeat(301) })).rejects.toThrow("有效的小事");
    await expect(withdraw("chat-a", "../../fake")).rejects.toThrow("无效的小事标识");
    expect(fs.existsSync(worldFile())).toBe(false);
  });

  it("makes retry and withdrawal idempotent and keeps each action bound to the original chat", async () => {
    const created = await add();
    if (!("action" in created)) throw new Error("Expected a planned action");
    expect(created.action).toMatchObject({ title: input.title, status: "planned" });
    expect(created.action).not.toHaveProperty("intent");
    expect(created.action).not.toHaveProperty("conversationId");
    expect(created.action).not.toHaveProperty("outcome");
    await expect(add()).resolves.toEqual(created);
    await expect(list(input.conversationId)).resolves.toEqual([created.action]);
    await expect(list("chat-b")).resolves.toEqual([]);
    await expect(withdraw("chat-b", created.action.id)).resolves.toBeNull();

    const withdrawn = await withdraw(input.conversationId, created.action.id);
    expect(withdrawn).toMatchObject({ id: created.action.id, status: "interrupted", reason: "建议已撤回，没有开始这件小事。" });
    await expect(withdraw(input.conversationId, created.action.id)).resolves.toEqual(withdrawn);
    await expect(add()).resolves.toEqual({ action: withdrawn });
    const persisted = new XilianWorldStore(worldFile()).listPersonalSuggestions(input.conversationId);
    expect(persisted.map(({ id, status }) => ({ id, status }))).toEqual([{ id: created.action.id, status: "interrupted" }]);
    expect(new XilianWorldStore(worldFile()).readDataSnapshot().amphoreus!.changes.some((change) => change.eventId === created.action.id)).toBe(false);
  });

  it("reports the committed state when a planned withdrawal races the beginning of the action", async () => {
    const created = await add();
    if (!("action" in created)) throw new Error("Expected a planned action");
    vi.setSystemTime(created.action.startsAt);
    await expect(withdraw(input.conversationId, created.action.id)).resolves.toMatchObject({ status: "active" });
    vi.setSystemTime(created.action.endsAt);
    const [completed] = await list(input.conversationId);
    expect(completed).toMatchObject({ status: "completed", outcome: expect.stringContaining(input.title) });
    expect(completed.outcome).toContain("笔记");
    await expect(withdraw(input.conversationId, created.action.id)).resolves.toEqual(completed);
    expect(new XilianWorldStore(worldFile()).readDataSnapshot().amphoreus!.changes.find((change) => change.eventId === created.action.id))
      .toMatchObject({ conversationId: input.conversationId, text: completed.outcome });
  });

  it("reports unavailable when she cannot take on an action", async () => {
    const store = new XilianWorldStore(worldFile());
    store.advance();
    store.updateAmphoreus((state) => {
      for (const goal of state.residents.find((resident) => resident.id === "cyrene")!.goals) goal.status = "completed";
      return true;
    });
    await expect(add()).resolves.toEqual({ reason: "unavailable" });
    await expect(list(input.conversationId)).resolves.toEqual([]);
  });
});
