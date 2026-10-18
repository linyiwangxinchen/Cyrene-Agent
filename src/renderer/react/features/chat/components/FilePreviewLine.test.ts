// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../../i18n";
import { FilePreviewContent } from "./FileTreePanel";
import { RightInspector } from "./RightInspector";

// 保留真实预览状态、标签复用和 DOM 事件，只隔离与定位无关的正文渲染及语法上色。
vi.mock("./ChatMessageList", () => ({
  MarkdownContent: ({ content }: { content: string }) => createElement("div", null, content),
}));
vi.mock("./syntaxHighlight", () => ({
  syntaxLanguageForFile: () => undefined,
  syntaxThemeForUi: () => "github-light",
  getSyntaxHighlighter: vi.fn(),
}));

const readme = "# README\n\n第三行目标\n第四行目标\n文档结尾";
const readFile = vi.fn(async () => ({ ok: true, content: readme, size: new Blob([readme]).size }));
const scrollIntoView = vi.fn();
let host: HTMLDivElement;
let root: Root;
let originalScrollIntoView: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("workspaceFiles", { read: readFile });
  originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  readFile.mockClear();
  scrollIntoView.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
  vi.unstubAllGlobals();
});

async function render({ scrollToLine, lineSeq, activeTabId = "file:README.md" }: {
  scrollToLine?: number;
  lineSeq?: number;
  activeTabId?: "file:README.md" | "other";
} = {}) {
  // 与 ChatPageInspector 一致：文件路径决定标签 ID，重复点击链接仅更新定位参数。
  await act(async () => root.render(createElement(RightInspector, {
    tabs: [
      {
        id: "file:README.md", label: "README.md",
        content: createElement(FilePreviewContent, {
          sessionId: "session-1", relPath: "README.md", scrollToLine, lineSeq,
        }),
      },
      { id: "other", label: "其他标签", content: createElement("div", null, "其他标签内容") },
    ],
    activeTabId, onTabChange: vi.fn(), onCloseTab: vi.fn(),
  })));
}

async function choosePreview() {
  const button = [...host.querySelectorAll<HTMLButtonElement>(".cy-file-preview__md-btn")]
    .find((node) => node.getAttribute("aria-label") === t("fileTree.viewPreview"));
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(host.querySelector(".cy-file-preview__markdown")).not.toBeNull();
}

function expectSourceAt(line: number) {
  const target = host.querySelector<HTMLElement>(`.cy-file-preview__line[data-line="${line}"]`);
  expect(target).not.toBeNull();
  expect(host.querySelector(".cy-file-preview__markdown")).toBeNull();
  expect(host.querySelector('[role="tabpanel"][data-state="active"]')?.contains(target)).toBe(true);
  expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "center", behavior: "auto" });
  expect(scrollIntoView.mock.contexts.at(-1)).toBe(target);
  expect(readFile).toHaveBeenCalledExactlyOnceWith("session-1", "README.md");
}

describe("Markdown 文件预览的行号定位", () => {
  it("首次打开带行号的文件时显示源码并滚动到指定行", async () => {
    await render({ scrollToLine: 3, lineSeq: 1 });
    expectSourceAt(3);
  });

  it("已有 Markdown 预览收到行号定位时切换源码且不重新读取文件", async () => {
    await render();
    expect(host.querySelector(".cy-file-preview__markdown")).not.toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();

    await render({ scrollToLine: 3, lineSeq: 1 });
    expectSourceAt(3);
  });

  it("手动切回预览后再次点击同一行号链接仍能定位", async () => {
    await render({ scrollToLine: 3, lineSeq: 1 });
    expectSourceAt(3);
    await choosePreview();
    scrollIntoView.mockClear();

    await render({ scrollToLine: 3, lineSeq: 2 });
    expectSourceAt(3);
  });

  it("从其他标签打开已有 Markdown 预览的行号链接时激活文件并定位", async () => {
    await render();
    const previewBeforeSwitch = host.querySelector(".cy-file-preview");
    await render({ activeTabId: "other" });
    expect(host.querySelector(".cy-file-preview")).toBe(previewBeforeSwitch);
    expect(host.querySelector('[role="tabpanel"][data-state="active"]')?.textContent).toBe("其他标签内容");
    expect(host.querySelector(".cy-file-preview__markdown")).not.toBeNull();
    scrollIntoView.mockClear();

    await render({ scrollToLine: 4, lineSeq: 1 });
    expect(host.querySelector(".cy-file-preview")).toBe(previewBeforeSwitch);
    expectSourceAt(4);
  });

  it("没有新的定位请求时普通重渲染及标签切换保留手动预览", async () => {
    await render({ scrollToLine: 3, lineSeq: 1 });
    await choosePreview();
    scrollIntoView.mockClear();

    await render({ scrollToLine: 3, lineSeq: 1 });
    await render({ scrollToLine: 3, lineSeq: 1, activeTabId: "other" });
    await render({ scrollToLine: 3, lineSeq: 1 });
    expect(host.querySelector(".cy-file-preview__markdown")).not.toBeNull();
    expect(host.querySelector(".cy-file-preview__code")).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledExactlyOnceWith("session-1", "README.md");
  });
});
