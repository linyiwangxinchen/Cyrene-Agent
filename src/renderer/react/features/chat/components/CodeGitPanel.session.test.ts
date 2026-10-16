// @vitest-environment jsdom
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CodeGitPanel } from "./CodeGitPanel";

vi.mock("../../../i18n", () => {
  const t = (key: string) => key;
  return { t, useTranslation: () => ({ t }) };
});
vi.mock("./PlanReviewPanel", () => ({ PlanReviewEntry: () => null }));
// 此测试只检查会话状态；真实 Modal 退出动画另由 Electron 隔离测试覆盖。
vi.mock("antd", () => ({
  Modal: ({ open, children }: any) => open ? createElement("div", { role: "dialog" }, children) : null,
  Input: ({ onPressEnter: _, ...props }: any) => createElement("input", props),
}));

it("closes the old Git dialog when the active session changes", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  (window as any).codeGit = {
    getStatus: async () => ({
      state: "ready", branch: { current: "main", branches: ["main", "topic"] },
      files: [], ahead: 0, lines: { insertions: 0, deletions: 0 },
      summary: { added: 0, modified: 0, deleted: 0, renamed: 0, conflicted: 0 },
    }),
    watch: async () => {}, unwatch: async () => {}, onChanged: () => () => {},
  };
  try {
    const render = (sessionId: string) => act(async () => {
      root.render(createElement(CodeGitPanel, { sessionId, todoState: null }));
    });
    await render("session-a");
    await act(async () => host.querySelector<HTMLButtonElement>(".cy-code-git__git-actions > button")!.click());
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    await render("session-b");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(".cy-code-git__git-actions > button")!.click());
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    delete (window as any).codeGit;
    vi.unstubAllGlobals();
  }
});
