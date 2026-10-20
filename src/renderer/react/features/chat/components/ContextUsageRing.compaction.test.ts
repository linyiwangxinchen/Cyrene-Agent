// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ContextUsageSnapshot } from "../../../../../shared/context-usage";

vi.stubGlobal("React", React);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock("antd", () => ({
  Popover: ({ children, content }: { children?: React.ReactNode; content?: React.ReactNode }) => React.createElement("div", null, children, content),
}));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));
import { ContextUsageRing } from "./ContextUsageRing";

describe("ContextUsageRing manual compaction feedback", () => {
  it("shows safe server details after failure and clears them after a successful retry", async () => {
    const compactConversation = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "TRANSCRIPT_COMPACTION_REQUIRED", detail: "摘要模型请求超时，原始会话记录已保留。" })
      .mockResolvedValueOnce({ ok: true });
    Object.assign(window, { chatStore: { compactConversation } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const usage: ContextUsageSnapshot = { phase: "terminal", contextWindowTokens: 256000, totalTokens: 1000,
      categories: [{ key: "conversation", tokens: 1000 }], messageCount: 4, updatedAt: Date.now() };
    try {
      await act(async () => { root.render(React.createElement(ContextUsageRing, { usage, sessionId: "c1" })); });
      const trigger = host.querySelector<HTMLButtonElement>(".cy-context-usage-menu__mood-figure")!;
      await act(async () => { trigger.click(); });
      expect(compactConversation).toHaveBeenCalledWith("c1");
      expect(host.textContent).toContain("摘要模型请求超时，原始会话记录已保留。");
      expect(host.textContent).not.toContain("TRANSCRIPT_COMPACTION_REQUIRED");
      await act(async () => { trigger.click(); });
      expect(compactConversation).toHaveBeenCalledTimes(2);
      expect(host.textContent).not.toContain("摘要模型请求超时");
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
      Object.assign(window, { chatStore: undefined });
    }
  });
});
