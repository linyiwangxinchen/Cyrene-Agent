import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSocialAtomStore, type SocialAtomStore } from "../../social-context/store";
import { buildPersonMemoryContext } from "../../social-context/context";
import type { ToolContext } from "./registry/tool-context";
import type { ToolDefinition } from "./registry/tool-registry";
import { createPersonMemoryTools } from "./person-memory-tools";

const NOW = Date.parse("2026-11-21T08:00:00Z");
const DAY = 86_400_000;

let dir: string;
let file: string;
let store: SocialAtomStore;
let clock: number;
let tools: Map<string, ToolDefinition>;

function load(): void {
  store = createSocialAtomStore(file);
  tools = new Map(createPersonMemoryTools(store, () => clock).map((tool) => [tool.id, tool]));
}

function ctx(conversationId = "conv-a", extra: Partial<ToolContext> = {}): ToolContext {
  return { userQuery: "记住我的生日是5月3日", conversationId, runId: "run-1", ...extra };
}

async function call(id: string, args: Record<string, unknown>, context = ctx()): Promise<string> {
  return tools.get(id)!.execute(args, context);
}

function idOf(output: string): string {
  const match = output.match(/id: ([0-9a-f-]{36})/);
  if (!match) throw new Error(`no id in: ${output}`);
  return match[1];
}

function injected(conversationId = "conv-a"): string {
  return buildPersonMemoryContext(store.listActive(conversationId, clock), "", { now: clock, timezone: "Asia/Shanghai" }).contextBlock;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "person-memory-tools-"));
  file = path.join(dir, "chat-social-atoms.json");
  clock = NOW;
  load();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("显式记忆工具", () => {
  it("工具元数据：私聊专属、Chat 内置，记忆写入走 mutation", () => {
    for (const tool of tools.values()) {
      expect(tool).toMatchObject({ chatBuiltin: true, privateContextOnly: true, needsContext: true });
      expect(tool.modes).toEqual(expect.arrayContaining(["chat", "work", "code", "learn"]));
    }
    expect(tools.get("memory_remember")!.effectKind).toBe("mutation");
    expect(tools.get("memory_forget")!.effectKind).toBe("mutation");
    expect(tools.get("memory_recall")!.effectKind).toBe("read");
  });

  it("写入的数据与提取器格式一致，evidenceQuote 取本轮用户原话，取不到时用 content", async () => {
    const first = idOf(await call("memory_remember", { content: "对方的生日是5月3日" }));
    const second = idOf(await call("memory_remember", { content: "对方喜欢猫" }, ctx("conv-a", { userQuery: "" })));
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { schemaVersion: number; atoms: Array<Record<string, unknown>> };
    expect(saved.schemaVersion).toBe(1);
    expect(saved.atoms.find((atom) => atom.id === first)).toEqual({
      id: first,
      conversationId: "conv-a",
      type: "long_term",
      content: "对方的生日是5月3日",
      evidenceTurnId: "memory_tool:run-1",
      evidenceQuote: "记住我的生日是5月3日",
      createdAt: NOW,
      status: "active",
    });
    expect(saved.atoms.find((atom) => atom.id === second)?.evidenceQuote).toBe("对方喜欢猫");
    expect(injected()).toContain("对方的生日是5月3日");
  });

  it("按会话隔离：其他会话查不到、也不能按 id 删除", async () => {
    const id = idOf(await call("memory_remember", { content: "对方在杭州工作" }));
    expect(await call("memory_recall", { query: "杭州" })).toContain("对方在杭州工作");
    expect(await call("memory_recall", {}, ctx("conv-b"))).toContain("还没有记着的事");
    expect(await call("memory_forget", { id }, ctx("conv-b"))).toContain("找不到记忆条目");
    expect(store.getById(id)?.status).toBe("active");
    expect(injected("conv-b")).toBe("");
  });

  it("群聊渠道与缺少会话时拒绝，且不写入", async () => {
    const group = ctx("conv-a", { channelContext: { channel: "qq", targetId: "g1", chatType: "group", sessionId: "s" } });
    expect(await call("memory_remember", { content: "群里有人说的事" }, group)).toContain("群聊里不使用个人记忆");
    expect(await call("memory_recall", {}, group)).toContain("群聊里不使用个人记忆");
    expect(await call("memory_remember", { content: "x" }, { userQuery: "" })).toContain("没有会话上下文");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("forget 删除后不再注入私聊背景，重启后仍然生效", async () => {
    const id = idOf(await call("memory_remember", { content: "对方养了一只叫团子的猫" }));
    expect(injected()).toContain("团子");
    expect(await call("memory_forget", { id })).toContain("已删除");
    expect(injected()).not.toContain("团子");
    load();
    expect(store.getById(id)).toBeUndefined();
    expect(injected()).not.toContain("团子");
  });

  it("outdated 与 resolve 让条目退出注入；resolve 只接受待跟进类型", async () => {
    const fact = idOf(await call("memory_remember", { content: "对方在减肥" }));
    const loop = idOf(await call("memory_remember", { content: "对方11月26日答辩", type: "open_loop", expires_at: "2026-11-27" }));
    expect(await call("memory_forget", { id: fact, action: "resolve" })).toContain("只有待跟进");
    expect(await call("memory_forget", { id: fact, action: "outdated" })).toContain("已标记为过时");
    expect(await call("memory_forget", { id: loop, action: "resolve" })).toContain("已标记为已解决");
    expect(injected()).toBe("");
    load();
    expect(store.getById(fact)?.status).toBe("superseded");
    expect(store.getById(loop)?.status).toBe("resolved");
  });

  it("replaces_id 纠正旧事实；重复内容不重复写入", async () => {
    const old = idOf(await call("memory_remember", { content: "对方喜欢喝咖啡" }));
    expect(await call("memory_remember", { content: "对方喜欢喝咖啡" })).toContain("已经记着了");
    const next = idOf(await call("memory_remember", { content: "对方不喝咖啡，喜欢喝茶", replaces_id: old }));
    expect(store.getById(old)).toMatchObject({ status: "superseded", supersededByAtomId: next });
    expect(injected()).toContain("喜欢喝茶");
    expect(injected()).not.toContain("对方喜欢喝咖啡");
    expect(await call("memory_remember", { content: "x", replaces_id: "missing" })).toContain("找不到要替换的条目");
  });

  it("到期规则与提取器一致：short_term 默认一周，open_loop 默认三天、最长 21 天，过期后不再召回", async () => {
    const shortId = idOf(await call("memory_remember", { content: "对方这周在赶论文", type: "short_term" }));
    const loopId = idOf(await call("memory_remember", { content: "对方要去面试", type: "open_loop" }));
    const farId = idOf(await call("memory_remember", { content: "对方明年考研", type: "open_loop", expires_at: "2027-12-01" }));
    expect(store.getById(shortId)?.expiresAt).toBe(NOW + 7 * DAY);
    expect(store.getById(loopId)?.expiresAt).toBe(NOW + 3 * DAY);
    expect(store.getById(farId)?.expiresAt).toBe(NOW + 21 * DAY);
    expect(await call("memory_remember", { content: "x", type: "short_term", expires_at: "2020-01-01" })).toContain("已经过去");
    clock = NOW + 8 * DAY;
    const recalled = await call("memory_recall", {});
    expect(recalled).not.toContain("赶论文");
    expect(recalled).not.toContain("要去面试");
    expect(recalled).toContain("明年考研");
  });

  it("recall 空查询按时间倒序列出，带关键词时只返回相关条目", async () => {
    await call("memory_remember", { content: "对方叫小林" });
    clock += 1000;
    await call("memory_remember", { content: "对方喜欢爬山" });
    const listed = await call("memory_recall", {});
    expect(listed.indexOf("爬山")).toBeLessThan(listed.indexOf("小林"));
    const searched = await call("memory_recall", { query: "爬山" });
    expect(searched).toContain("对方喜欢爬山");
    expect(searched).not.toContain("小林");
  });
});
