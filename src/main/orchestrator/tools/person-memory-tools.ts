// 显式记忆工具 —— 昔涟按对方要求记下、查找、忘掉关于“这个人”的事。
//
// 存储复用私聊长期记忆的社交原子库（social-context/store.ts，chat-social-atoms.json）：
// - 写入的数据格式与后台提取器一致（SocialAtom），buildPersonMemoryContext 会照常注入；
// - 一律按当前会话 conversationId 隔离，按 id 操作时其他会话的条目视为不存在；
// - privateContextOnly：群聊、插件运行在组装本轮工具时就被移除；执行时再拦一次群聊渠道。
// - chatBuiltin：Chat 模式不需要打开工具增强即可使用（这是昔涟人格的一部分）。
//
// store 由组合根（default-dependencies.ts / server runtime.ts）经 registerAllTools 注入。

import { randomUUID } from "node:crypto";
import type { ToolContext } from "./registry/tool-context";
import type { ToolDefinition, ToolRegistry } from "./registry/tool-registry";
import type { SocialAtomStore } from "../../social-context/store";
import type { SocialAtom, SocialAtomType } from "../../social-context/types";
import { rankSocialAtoms } from "../../social-context/retrieval";
import { getMemoryModeVersion, isPersonalMemoryEnabled } from "../../memory/memory-mode";
import { resolvePersonalMemoryScope } from "../../memory/memory-scope";
import { activeMemoryUserEntry, filterActiveSocialAtoms } from "../../memory/memory-owner-recall";
import { socialAtomDisplayText } from "../../social-context/context";
import { memoryStore } from "../../memory/memory-store";

const DAY_MS = 86_400_000;
/** 与提取器一致：open_loop 默认三天，最长 21 天。 */
const OPEN_LOOP_DEFAULT_TTL_MS = 3 * DAY_MS;
const OPEN_LOOP_MAX_TTL_MS = 21 * DAY_MS;
/** 提取器要求 short_term 带到期时间；工具调用没给时按一周处理。 */
const SHORT_TERM_DEFAULT_TTL_MS = 7 * DAY_MS;
const MAX_CONTENT_CHARS = 500;
const MAX_QUOTE_CHARS = 500;
const DEFAULT_RECALL_LIMIT = 10;
const MAX_RECALL_LIMIT = 30;

const TYPE_LABEL: Record<SocialAtomType, string> = {
  long_term: "长期",
  short_term: "近期",
  open_loop: "待跟进",
};

/** 本轮附加给模型的文件/图片上下文不属于用户原话，截掉后再作为证据引文。 */
const MODEL_CONTEXT_MARKERS = ["【本轮文件】", "【本轮附件路径】", "【文档内容】", "【图片视觉信息】", "【图片附件】"];

function userQuote(ctx: ToolContext | undefined, fallback: string): string {
  let text = ctx?.userQuery ?? "";
  for (const marker of MODEL_CONTEXT_MARKERS) {
    const index = text.indexOf(marker);
    if (index >= 0) text = text.slice(0, index);
  }
  text = text.trim();
  return (text || fallback).slice(0, MAX_QUOTE_CHARS);
}

type Scope = { ok: true; conversationId: string; memoryScope: string } | { ok: false; message: string };

function resolveScope(ctx: ToolContext | undefined, toolId: string): Scope {
  if (ctx?.channelContext?.chatType === "group") {
    return { ok: false, message: `[错误] 群聊里不使用个人记忆。` };
  }
  const conversationId = ctx?.conversationId?.trim();
  if (!conversationId) return { ok: false, message: `[错误] 当前没有会话上下文，无法使用记忆。` };
  if (!isPersonalMemoryEnabled()) return { ok: false, message: "[错误] 个人记忆已关闭。" };
  const memoryScope = ctx?.memoryScope && resolvePersonalMemoryScope({ ...ctx, channel: ctx.channelContext?.channel });
  if (!memoryScope || memoryScope !== ctx?.memoryScope) return { ok: false, message: `[错误] ${toolId} 缺少可信的记忆主体。` };
  return { ok: true, conversationId, memoryScope };
}

function formatDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function formatAtom(atom: SocialAtom): string {
  const expiry = typeof atom.expiresAt === "number" ? ` · 到期 ${formatDate(atom.expiresAt)}` : "";
  return `- [${atom.id}] (${TYPE_LABEL[atom.type]} · 记于 ${formatDate(atom.createdAt)}${expiry}) ${socialAtomDisplayText(atom)}`;
}

/** 接受毫秒时间戳、ISO 日期或日期时间；无法解析返回 null，未提供返回 undefined。 */
function parseExpiresAt(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (/^\d{10,}$/.test(text)) return Number(text);
  // 只给日期时按当天结束计算，避免“到 5 月 3 日”在当天零点就失效
  const value = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T23:59:59`) : Date.parse(text);
  return Number.isFinite(value) ? value : null;
}

function atomType(raw: unknown): SocialAtomType | null {
  if (raw === undefined || raw === null || raw === "") return "long_term";
  return raw === "long_term" || raw === "short_term" || raw === "open_loop" ? raw : null;
}

export function createPersonMemoryTools(store: SocialAtomStore, now: () => number = Date.now, requireCanonicalSources = false): ToolDefinition[] {
  async function retractLinkedFact(atom: SocialAtom): Promise<void> {
    if (!requireCanonicalSources || !atom.sourceEntryId) return;
    await memoryStore.retractFact({ conversationId: atom.conversationId, messageId: atom.sourceEntryId }, atom.content);
  }
  const remember: ToolDefinition = {
    id: "memory_remember",
    name: "记住这件事",
    description:
      "把对方明确告诉你、希望你记住的一件事记下来，以后私聊时会自然想起。\n\n" +
      "何时用：\n" +
      "- 对方说「记住……」「别忘了……」「你要记得……」\n" +
      "- 对方纠正你记错的事（「不是 X，是 Y」）：先 memory_recall 找到旧条目，再带 replaces_id 记新的\n" +
      "- 对方交代之后要问起的事（「下周三我答辩，到时候问问我」）→ type=open_loop\n\n" +
      "不要用于：\n" +
      "- 普通聊天里你自己觉得值得记的事（后台会自动整理，不需要调用）\n" +
      "- 撒娇、角色扮演动作、对你的设定、工具任务本身\n" +
      "- 群聊里的事（群聊不可用）\n\n" +
      "type：long_term（稳定的事实：称呼、生日、工作、喜好、身边的人，默认）；" +
      "short_term（最近在发生的事，带 expires_at，不给则一周后过期）；" +
      "open_loop（之后可以问起的事，expires_at 不给则三天，最长 21 天）。\n" +
      "content 写成一句完整独立的话，用「对方」指代用户，时间写成具体日期，不要写「明天」「这周」。\n" +
      "参数：content（必填），type（可选），expires_at（可选，YYYY-MM-DD 或 ISO 时间），replaces_id（可选，被纠正的旧条目 id）。",
    enabled: true,
    risk: "safe",
    modes: ["chat", "learn", "code", "work"],
    chatBuiltin: true,
    privateContextOnly: true,
    needsContext: true,
    effectKind: "mutation",
    verificationPolicy: "none",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "要记住的事，一句完整的话，用「对方」指代用户" },
        type: { type: "string", enum: ["long_term", "short_term", "open_loop"], description: "记忆类型，默认 long_term" },
        expires_at: { type: "string", description: "到期时间（short_term / open_loop 可用），YYYY-MM-DD 或 ISO 时间" },
        replaces_id: { type: "string", description: "要被这条纠正替换的旧条目 id（来自 memory_recall）" },
      },
      required: ["content"],
    },
    execute: async (args, ctx) => {
      const scope = resolveScope(ctx, "memory_remember");
      if (!scope.ok) return scope.message;
      const version = getMemoryModeVersion();
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!content) return "[错误] content 不能为空";
      if (content.length > MAX_CONTENT_CHARS) return `[错误] content 太长（${content.length} 字），请概括到 ${MAX_CONTENT_CHARS} 字以内`;
      const type = atomType(args.type);
      if (!type) return `[错误] type 只能是 long_term、short_term 或 open_loop，收到 ${JSON.stringify(args.type)}`;
      const at = now();

      const sourceEntryId = ctx?.memoryUserTurnId && requireCanonicalSources
        ? await activeMemoryUserEntry(scope.conversationId, ctx.memoryUserTurnId) : undefined;
      if ((requireCanonicalSources && !sourceEntryId) || getMemoryModeVersion() !== version) {
        return "[错误] 无法核对当前用户消息，记忆没有写入。";
      }

      const requestedExpiry = parseExpiresAt(args.expires_at);
      if (requestedExpiry === null) return `[错误] expires_at 无法解析：${JSON.stringify(args.expires_at)}，请用 YYYY-MM-DD 或 ISO 时间`;
      let expiresAt: number | undefined;
      if (type === "open_loop") {
        expiresAt = requestedExpiry && requestedExpiry > at
          ? Math.min(requestedExpiry, at + OPEN_LOOP_MAX_TTL_MS)
          : at + OPEN_LOOP_DEFAULT_TTL_MS;
      } else if (type === "short_term") {
        if (requestedExpiry !== undefined && requestedExpiry <= at) return "[错误] expires_at 已经过去，近期的事需要一个将来的到期时间";
        expiresAt = requestedExpiry ?? at + SHORT_TERM_DEFAULT_TTL_MS;
      }

      const active = store.listActive(scope.conversationId, at, scope.memoryScope);
      const existing = active.find((atom) => atom.type === type && atom.content.trim() === content);

      const replacesId = typeof args.replaces_id === "string" ? args.replaces_id.trim() : "";
      const replaced = replacesId ? active.find(atom => atom.id === replacesId) : undefined;
      if (replacesId && !replaced) {
        return `[错误] 找不到要替换的条目 ${replacesId}（可能已过期或已删除），先用 memory_recall 确认 id`;
      }
      if (existing) {
        if (replaced && existing.id !== replacesId) {
          await retractLinkedFact(replaced);
          store.applyOperations(scope.conversationId, [{ operation: "retire", targetAtomId: replacesId }], at, scope.memoryScope);
        }
        return `[memory_remember] 这件事已经记着了（id: ${existing.id}）`;
      }

      const atom: SocialAtom = {
        id: randomUUID(),
        conversationId: scope.conversationId,
        memoryScope: scope.memoryScope,
        type,
        content,
        evidenceTurnId: `memory_tool:${ctx?.runId ?? at}`,
        ...(sourceEntryId ? { sourceEntryId } : {}),
        evidenceQuote: userQuote(ctx, content),
        createdAt: at,
        ...(expiresAt ? { expiresAt } : {}),
        status: "active",
      };
      store.applyOperations(scope.conversationId, [replacesId
        ? { operation: "supersede", atom, targetAtomId: replacesId }
        : { operation: "add", atom }], at, scope.memoryScope);
      if (!store.getById(atom.id)) return "[错误] 记忆未写入，原消息可能已被遗忘。";
      if (replaced) await retractLinkedFact(replaced);
      const expiryNote = expiresAt ? `，${formatDate(expiresAt)} 到期` : "";
      return `[memory_remember] 记下了（id: ${atom.id}，${TYPE_LABEL[type]}${expiryNote}）${replacesId ? `，旧条目 ${replacesId} 已标记为过时` : ""}：${content}`;
    },
  };

  const recall: ToolDefinition = {
    id: "memory_recall",
    name: "想想记得什么",
    description:
      "查找你记得的关于对方的事（只限当前这段私聊），返回条目 id、类型、记下的日期和内容。\n\n" +
      "何时用：\n" +
      "- 对方问「你还记得我……吗」「我跟你说过……」，而本轮背景里没有\n" +
      "- 要纠正或忘掉某件事之前，先找到它的 id\n" +
      "- 对方问「你都记得我什么」→ query 留空，列出最近记下的\n\n" +
      "不要用于：\n" +
      "- 本轮背景「你记得的关于对方的事」里已经有的内容\n" +
      "- 查文件、网页或工作资料\n\n" +
      "参数：query（可选，关键词；留空列出最近的），type（可选，只看某一类），limit（可选，默认 10，最多 30）。",
    enabled: true,
    risk: "safe",
    modes: ["chat", "learn", "code", "work"],
    chatBuiltin: true,
    privateContextOnly: true,
    needsContext: true,
    effectKind: "read",
    verificationPolicy: "none",
    isConcurrencySafe: () => true,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，留空则列出最近记下的" },
        type: { type: "string", enum: ["long_term", "short_term", "open_loop"], description: "只看某一类" },
        limit: { type: "number", description: "返回条数，默认 10，最多 30" },
      },
    },
    execute: async (args, ctx) => {
      const scope = resolveScope(ctx, "memory_recall");
      if (!scope.ok) return scope.message;
      const version = getMemoryModeVersion();
      const at = now();
      const rawLimit = Math.trunc(Number(args.limit));
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_RECALL_LIMIT) : DEFAULT_RECALL_LIMIT;
      const typeFilter = args.type === "long_term" || args.type === "short_term" || args.type === "open_loop" ? args.type : undefined;
      const scoped = store.listActive(scope.conversationId, at, scope.memoryScope);
      const active = (requireCanonicalSources ? await filterActiveSocialAtoms(scoped) : scoped)
        .filter((atom) => !typeFilter || atom.type === typeFilter);
      if (getMemoryModeVersion() !== version) return "[错误] 记忆模式已变更，未读取记忆。";
      if (active.length === 0) return "[memory_recall] 关于对方，现在还没有记着的事";

      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        const recent = [...active].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
        return `[memory_recall] 最近记下的 ${recent.length} 条（共 ${active.length} 条）：\n${recent.map(formatAtom).join("\n")}`;
      }
      // 分词检索在前；分词漏掉的字面命中补在后面
      const ranked = rankSocialAtoms(query, active, { now: at, limit });
      const needle = query.toLowerCase();
      const literal = active.filter((atom) => !ranked.includes(atom) && atom.content.toLowerCase().includes(needle));
      const hits = [...ranked, ...literal].slice(0, limit);
      if (hits.length === 0) return `[memory_recall] 没找到和「${query}」有关的记忆（共记着 ${active.length} 条，可以留空 query 看最近的）`;
      return `[memory_recall] 和「${query}」有关的 ${hits.length} 条：\n${hits.map(formatAtom).join("\n")}`;
    },
  };

  const forget: ToolDefinition = {
    id: "memory_forget",
    name: "忘掉这件事",
    description:
      "按 id 处理一条关于对方的记忆：删除、标记为已解决，或标记为过时。处理后不会再出现在私聊背景里。\n\n" +
      "何时用：\n" +
      "- 对方说「忘了这件事」「别记这个」「删掉」→ action=delete\n" +
      "- 待跟进的事已经有了结果（答辩结束了、面试问过了）→ action=resolve\n" +
      "- 事情不再成立但对方没给新说法（「我不在那家公司了」）→ action=outdated；有新说法时改用 memory_remember 带 replaces_id\n\n" +
      "不要用于：\n" +
      "- 不知道 id 时猜一个（先用 memory_recall 查）\n" +
      "- 对方只是随口提到旧事，并没有要求忘掉\n\n" +
      "参数：id（必填，来自 memory_recall），action（可选，delete 默认 / resolve / outdated）。",
    enabled: true,
    risk: "safe",
    modes: ["chat", "learn", "code", "work"],
    chatBuiltin: true,
    privateContextOnly: true,
    needsContext: true,
    effectKind: "mutation",
    verificationPolicy: "none",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "记忆条目 id（来自 memory_recall）" },
        action: { type: "string", enum: ["delete", "resolve", "outdated"], description: "delete 删除（默认）/ resolve 已解决 / outdated 过时" },
      },
      required: ["id"],
    },
    execute: async (args, ctx) => {
      const scope = resolveScope(ctx, "memory_forget");
      if (!scope.ok) return scope.message;
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return "[错误] id 不能为空，先用 memory_recall 查到条目 id";
      const action = args.action === undefined || args.action === "" ? "delete" : args.action;
      if (action !== "delete" && action !== "resolve" && action !== "outdated") {
        return `[错误] action 只能是 delete、resolve 或 outdated，收到 ${JSON.stringify(args.action)}`;
      }
      const at = now();
      const atom = store.getById(id);
      // 其他会话的条目对本会话不可见，按“找不到”处理
      if (!atom || atom.conversationId !== scope.conversationId || atom.memoryScope !== scope.memoryScope) {
        return `[错误] 找不到记忆条目 ${id}，先用 memory_recall 确认 id`;
      }
      if (action === "delete") {
        await retractLinkedFact(atom);
        store.applyOperations(scope.conversationId, [{ operation: "delete", targetAtomId: id }], at, scope.memoryScope);
        return `[memory_forget] 已删除：${atom.content}`;
      }
      const active = atom.status === "active" && (typeof atom.expiresAt !== "number" || atom.expiresAt > at);
      if (!active) return `[memory_forget] 这条已经不在生效中（${atom.status === "resolved" ? "已解决" : atom.status === "superseded" ? "已过时" : "已过期"}），不需要再处理；要彻底删除请用 action=delete`;
      if (action === "resolve") {
        if (atom.type !== "open_loop") return "[错误] 只有待跟进（open_loop）的事能标记为已解决；其他类型请用 outdated 或 delete";
        const evidenceQuote = userQuote(ctx, atom.content);
        store.applyOperations(scope.conversationId, [{
          operation: "resolve",
          targetAtomId: id,
          evidenceTurnId: `memory_tool:${ctx?.runId ?? at}`,
          evidenceQuote,
        }], at, scope.memoryScope);
        return `[memory_forget] 已标记为已解决：${atom.content}`;
      }
      await retractLinkedFact(atom);
      store.applyOperations(scope.conversationId, [{ operation: "retire", targetAtomId: id }], at, scope.memoryScope);
      return `[memory_forget] 已标记为过时：${atom.content}`;
    },
  };

  return [remember, recall, forget];
}

/** 由 registerAllTools 在拿到组合根注入的 store 后调用。 */
export function registerPersonMemoryTools(registry: Pick<ToolRegistry, "register">, store: SocialAtomStore): void {
  for (const tool of createPersonMemoryTools(store, Date.now, true)) registry.register(tool);
}
