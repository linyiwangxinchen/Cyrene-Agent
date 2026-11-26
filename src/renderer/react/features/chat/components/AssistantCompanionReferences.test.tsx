// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AssistantCompanionReferences } from "./AssistantCompanionReferences";

it("keeps the card collapsed and navigates using the source saved with the reply", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const navigate = vi.fn().mockResolvedValue(true);
  const get = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "preference-source" }).mockResolvedValueOnce({ id: "history-source" });
  vi.stubGlobal("chatStore", { get, openInReactChatWindow: navigate });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<AssistantCompanionReferences />));
    expect(host.querySelector("details")).toBeNull();
    await act(async () => root.render(<AssistantCompanionReferences references={[
      { kind: "preference", topic: "questions", conversationId: "preference-source" },
      { kind: "expression", quote: "抱抱", appeared: true, conversationId: "expression-source" },
      { kind: "chat-history", conversationId: "history-source", userTurnId: "u", userEntryId: "user-entry", assistantEntryId: "assistant-entry" },
    ]} />));
    const details = host.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("本轮参考了什么");
    details.open = true;
    const items = details.querySelectorAll("li");
    expect(items[0]?.textContent).toContain("少用问句收尾");
    expect(items[1]?.textContent).toContain("原句出现在回复中");
    await act(async () => items[1].querySelector("button")!.click());
    expect(get).toHaveBeenNthCalledWith(1, "expression-source");
    expect(navigate).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("无法打开来源会话");
    await act(async () => items[0].querySelector("button")!.click());
    expect(navigate).toHaveBeenCalledExactlyOnceWith("preference-source");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(items[2]?.textContent).toContain("查阅过的旧聊天");
    expect(items[2]?.textContent).not.toContain("assistant-entry");
    await act(async () => items[2].querySelector("button")!.click());
    expect(navigate).toHaveBeenNthCalledWith(2, "history-source");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
