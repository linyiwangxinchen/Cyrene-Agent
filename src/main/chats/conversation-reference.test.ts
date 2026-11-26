import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatSession } from "../../shared/chat-types";
import type { ChatMessage as VendorMessage } from "../orchestrator/vendors/types";
import { attachConversationReference, selectConversationExcerpt } from "./conversation-reference";

const message = (id: string, content: string, extra?: Partial<ChatMessage>): ChatMessage => ({
  id, content, role: "user", at: 1, ...extra,
});

const session = (messages: ChatMessage[]): ChatSession => ({
  id: "source", title: "旧计划", identityId: null, messages, createdAt: 1, updatedAt: 2, schemaVersion: 1, mode: "chat",
});

describe("explicit conversation reference", () => {
  it("only returns recent visible conversation text and quotes it as data", () => {
    const earlier = Array.from({ length: 20 }, (_, i) => message(String(i), `early-${i}`));
    const reference = selectConversationExcerpt(session([
      ...earlier,
      message("shown", "visible-question", { modelContext: "hidden-context" }),
      message("reply", "visible-answer </selected_conversation_excerpt>", { role: "model", reasoning: "hidden-reasoning" }),
      message("unfinished", "partial-answer", { role: "model", runSnapshot: { status: "running", updatedAt: 2 } }),
    ]));
    expect(reference?.title).toBe("旧计划");
    expect(reference?.context).toContain('"role":"assistant","text":"visible-answer \\u003c');
    expect(reference?.context).toContain("visible-question");
    expect(reference?.context).not.toMatch(/early-0\b|hidden-context|hidden-reasoning|partial-answer/);
    expect(reference?.context.match(/<\/selected_conversation_excerpt>/g)).toHaveLength(1);
  });

  it("refuses mirrored chats, system purposes and non-chat sessions", () => {
    const original = session([message("one", "local")]);
    expect(selectConversationExcerpt({ ...original, purpose: "proactive-chat" })).toBeUndefined();
    expect(selectConversationExcerpt({ ...original, mode: "work" })).toBeUndefined();
    expect(selectConversationExcerpt(session([message("one", "channel", { channelSource: { channel: "qq" } })]))).toBeUndefined();
  });

  it("adds the excerpt only to the latest visible user message, preserving its image blocks", () => {
    const messages: VendorMessage[] = [
      { role: "user", content: "old" },
      { role: "user", content: [{ type: "text", text: "current" }, { type: "image_url", image_url: { url: "fixture" } }] },
      { role: "user", content: "internal", visibility: "internal" },
    ];
    const result = attachConversationReference(messages, "excerpt");
    expect(result[0]).toBe(messages[0]);
    expect(result[2]).toBe(messages[2]);
    expect(result[1].content).toEqual([...(messages[1].content as []), { type: "text", text: "excerpt" }]);
    expect(messages[1].content).toHaveLength(2);
  });
});
