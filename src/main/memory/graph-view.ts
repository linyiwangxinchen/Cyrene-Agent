import { graphBuilder } from "../../shared/memory-graph";
import { pluginPromptRegistry } from "../../plugins/prompts";
import { entityGraph } from "./entity-graph";
import {
  isVectorMemoryEnabled,
  isWikiMemoryEnabled,
  isSummaryMemoryEnabled,
} from "./memory-mode";
import { memoryStore } from "./memory-store";
import { getWikiMemoryStore } from "./wiki-memory-scheduler";
import { getRelationshipStore } from "../relationship/relationship-log";
import { activeConversationRegistry } from "../chats/active-conversation-registry";
import * as chats from "../chats/chats-store";
import { loadSummaryMemoryContext } from "./summary-memory-context";
import { app } from "electron";

export async function loadMemoryGraph() {
  const graph = graphBuilder();
  const convo = (id: string) =>
    graph.add({
      id: "chat:" + id,
      kind: "会话",
      label: "原对话",
      detail: id,
      conversationId: id,
    });
  if (isVectorMemoryEnabled()) {
    const entities = entityGraph.load();
    for (const n of entities.entities)
      graph.add({
        id: "entity:" + n.id,
        kind: "实体",
        label: n.name,
        detail: n.aliases.join("、"),
        at: n.lastMentionedAt,
      });
    for (const r of entities.relations)
      graph.link("entity:" + r.sourceId, "entity:" + r.targetId, r.relation);
    const vector = await memoryStore.load();
    const evidenceByMemory = new Map<
      string,
      NonNullable<typeof vector.evidence>
    >();
    for (const item of vector.evidence ?? []) {
      const rows = evidenceByMemory.get(item.memoryId) ?? [];
      rows.push(item);
      evidenceByMemory.set(item.memoryId, rows);
    }
    for (const m of vector.l2) {
      const id = graph.add({
        id: "memory:" + m.id,
        kind: "记忆",
        label: m.slug || m.content.slice(0, 30),
        detail:
          ({
            active: "当前",
            aging: "淡化",
            archived: "已归档",
            superseded: "已更正",
            merged: "已合并",
          }[m.status] ?? "") +
          " · " +
          m.content,
        at: m.createdAt,
      });
      const sources = evidenceByMemory.get(m.id) ?? [];
      for (const s of sources.filter(
        (item) => item.sourceStatus !== "deleted",
      )) {
        const source = graph.add({
          id: "evidence:" + s.id,
          kind: "出处",
          label: (s.quoteSnippet || "原始证据").slice(0, 48),
          detail: s.quoteSnippet,
          at: s.createdAt,
          conversationId: s.conversationId,
        });
        graph.link(id, source, "依据");
        if (s.conversationId)
          graph.link(source, convo(s.conversationId), "出自会话");
      }
      if (!sources.length && m.sourceConversationId)
        graph.link(id, convo(m.sourceConversationId), "出自会话");
      if (!sources.length && m.sourceQuote)
        graph.link(
          id,
          graph.add({
            id: "quote:" + m.id,
            kind: "出处",
            label: m.sourceQuote.slice(0, 35),
            detail: m.sourceQuote,
            conversationId: m.sourceConversationId,
          }),
          "原话",
        );
      if (m.mergedInto) graph.link(id, "memory:" + m.mergedInto, "已合并到");
      for (const child of m.subEntryIds ?? [])
        graph.link(id, "memory:" + child, "归纳自");
      if (m.supersededBy)
        graph.link(id, "memory:" + m.supersededBy, "被更正为");
    }
  }
  if (isWikiMemoryEnabled()) {
    const wiki = getWikiMemoryStore();
    if (wiki) {
      const total = await wiki.countPages();
      for (let offset = 0; offset < total; offset += 80) {
        const rows = await wiki.listPages({ offset, limit: 80 });
        for (const row of rows) {
          const page = await wiki.readPage(row.id);
          if (!page) continue;
          const id = graph.add({
            id: "wiki:" + page.id,
            kind: "记忆",
            label: page.title,
            detail: row.summary,
            at: page.updatedAt,
            wikiId: page.id,
          });
          for (const tag of page.tags)
            graph.link(
              id,
              graph.add({ id: "tag:" + tag, kind: "主题", label: tag }),
              "共用标签",
              true,
            );
          for (const link of page.links)
            graph.link(id, "wiki:" + link, "直接引用");
          for (const claim of page.claims.filter(
            (c) => !c.manuallyRevoked && c.status !== "revoked",
          )) {
            const fact = graph.add({
              id: "claim:" + page.id + ":" + claim.id,
              kind: "记忆",
              label: claim.value.slice(0, 40),
              detail:
                {
                  current: "当前",
                  historical: "过去",
                  uncertain: "待确认",
                  revoked: "已撤回",
                }[claim.status] +
                " · " +
                claim.value,
              at: claim.assertedAt,
              wikiId: page.id,
            });
            graph.link(id, fact, "记载");
            for (const s of claim.sources) {
              const sourceId =
                s.kind === "chat"
                  ? JSON.stringify([s.conversationId, s.messageId, s.revision])
                  : s.sourceId;
              const src = graph.add({
                id: "wiki-source:" + sourceId,
                kind: "出处",
                label:
                  s.kind === "chat"
                    ? (s.evidenceQuote || "对话原文").slice(0, 48)
                    : s.kind === "manual"
                      ? "手动记录"
                      : "文档",
                at: s.assertedAt,
                ...(s.kind === "chat" && {
                  conversationId: s.conversationId,
                  detail: s.evidenceQuote,
                }),
              });
              graph.link(fact, src, "依据");
              if (s.kind === "chat")
                graph.link(src, convo(s.conversationId), "出自会话");
            }
          }
        }
      }
    }
  }
  if (isSummaryMemoryEnabled()) {
    const sessionId =
      activeConversationRegistry.getMostRecent()?.sessionId ??
      (await chats.getLatestSessionId());
    if (sessionId) {
      const summary = await loadSummaryMemoryContext({
        conversationId: sessionId,
        userDataRoot: app.getPath("userData"),
        getSessionRecord: chats.getSessionRecord,
      });
      for (const [name, body] of [
        ["会话摘要", summary.sessionContent],
        ["工作区摘要", summary.workspaceContent],
      ] as const)
        if (body)
          graph.link(
            graph.add({
              id: "summary:" + name + ":" + sessionId,
              kind: "记忆",
              label: name,
              detail: body.slice(0, 4000),
            }),
            convo(sessionId),
            "摘要上下文",
          );
    }
  }
  const relationship = getRelationshipStore();
  for (const s of relationship.privateExpressions()) {
    const id = graph.add({
      id: "private-expression:" + JSON.stringify([s.turn.scope,s.quote]),
      kind: "表达",
      label: s.quote,
      detail: s.scene,
      at: s.turn.at,
    });
    const source = graph.add({
      id: "turn:" + s.turn.id,
      kind: "出处",
      label: s.kind === "definition" ? "私聊约定" : "私聊用例",
      detail: s.quote,
      at: s.turn.at,
      conversationId: s.turn.conversationId,
    });
    graph.link(id, source, "学自");
    graph.link(source, convo(s.turn.conversationId!), "出自会话");
  }
  const samples = pluginPromptRegistry.listExpressions();
  const turns = samples.length
    ? getRelationshipStore().expressionEvidence()
    : [];
  for (const s of samples) {
    const id = graph.add({
      id: "expression:" + s.id,
      kind: "表达",
      label: s.quote,
      detail: s.scene,
      at: s.at,
    });
    const src = graph.add({
      id: "web:" + s.source,
      kind: "出处",
      label:
        new URL(s.source).hostname === "tieba.baidu.com"
          ? "贴吧帖子"
          : "B 站视频",
      url: s.source,
      detail: s.source,
    });
    graph.link(id, src, "学自");
    for (const turn of turns) {
      if (
        !turn.userText.includes(s.quote) &&
        !turn.assistantText.includes(s.quote)
      )
        continue;
      const used = graph.add({
        id: "usage:" + turn.id,
        kind: "记忆",
        label: "私聊中出现",
        detail: turn.userText.includes(s.quote)
          ? turn.userText
          : turn.assistantText,
        at: turn.createdAt,
        conversationId: turn.conversationId,
      });
      graph.link(id, used, "原句出现");
      graph.link(used, convo(turn.conversationId!), "出自会话");
    }
  }
  return graph.finish();
}
