// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishAskCard, resolveAskCardSubmission } from "../../../../../main/orchestrator/ask-card";
import { executeAskUser } from "../../../../../main/orchestrator/harness/builtin-tools";
import type { AskCardSubmission, AskClarificationCard } from "../../../../../shared/ask-clarification";
import { setUiLocale, t } from "../../../i18n";
import { AskUserPanel, PlanApprovalPanel } from "./InteractionPanel";
import { normalizeChoiceInteraction, type AskUserInteraction, type AskUserQuestion } from "./run-presentation";

// 只隔离与此交互无关的 Markdown/LaTeX 渲染，保留实际状态、DOM 事件与回包链路。
vi.mock("./ChatMessageList", () => ({
  MarkdownContent: ({ content }: { content: string }) => createElement("span", null, content),
}));

const deferredText = "用户选择暂不回答本题。";
const localizedDeferAnswers = [
  { locale: "zh-CN", label: "暂不回答", text: deferredText },
  { locale: "en", label: "Skip for now", text: "The user chose to skip this question for now." },
  { locale: "ja-JP", label: "今は回答しない", text: "ユーザーはこの質問への回答を保留しました。" },
];
const localizedDeferSubmissions = localizedDeferAnswers.flatMap((answer) =>
  [false, true].map((deferAll) => ({ ...answer, deferAll })),
);
const textQuestion = (id: string): AskUserQuestion => ({
  id, question: `Question ${id}`, options: [], allowCustomInput: true,
});
const choiceQuestion = (id: string, multiple = false): AskUserQuestion => ({
  ...textQuestion(id), multiple,
  options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
});
const interaction = (questions = [textQuestion("first")]): AskUserInteraction => ({
  kind: "ask", id: "ask-1", runId: "run-1", revision: 2,
  cardMode: "semantic_clarification", responseKind: "submission",
  question: questions[0].question, options: questions[0].options, questions,
});

let root: Root;
let host: HTMLDivElement;
const onAnswer = vi.fn();

function render(card = interaction(), disabled = false) {
  act(() => root.render(createElement(AskUserPanel, { interaction: card, disabled, onAnswer })));
}

function element<T extends HTMLElement>(selector: string): T {
  const node = host.querySelector<T>(selector);
  if (!node) throw new Error(`未找到元素：${selector}`);
  return node;
}

function button(text: string): HTMLButtonElement {
  const node = [...host.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!node) throw new Error(`未找到按钮：${text}`);
  return node;
}

const customInput = () => element<HTMLInputElement>(".cy-interaction-panel__custom-answer input");
const submitButton = () => element<HTMLButtonElement>(".cy-interaction-panel__actions .is-primary");
const page = () => element(".cy-interaction-panel__page").textContent;
const options = () => [...host.querySelectorAll<HTMLInputElement>(".cy-questionnaire-choice__input")];

function click(node: HTMLElement) {
  act(() => node.click());
}

function input(value: string) {
  const node = customInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function navigate(direction: "prevQuestion" | "nextQuestion") {
  const node = [...host.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === t(`interaction.${direction}`));
  if (!node) throw new Error(`未找到翻页按钮：${direction}`);
  click(node);
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setUiLocale("zh-CN");
  onAnswer.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setUiLocale("zh-CN");
  vi.unstubAllGlobals();
});

describe("AskUserPanel 暂不回答", () => {
  it.each([false, true])("替换已选的选项并作为自定义回答提交（multiple=%s）", (multiple) => {
    render(interaction([choiceQuestion("first", multiple)]));
    click(options()[0]);
    if (multiple) click(options()[1]);
    expect(options().filter((option) => option.checked)).toHaveLength(multiple ? 2 : 1);

    click(button("暂不回答"));
    expect(options().every((option) => !option.checked)).toBe(true);
    expect(customInput().value).toBe(deferredText);
    expect(submitButton().disabled).toBe(false);
    expect(onAnswer).not.toHaveBeenCalled();

    click(submitButton());
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({
      interactionId: "ask-1", runId: "run-1", revision: 2,
      answers: [{ questionId: "first", source: "custom", text: deferredText }],
    });
  });

  it("纯文本题可以替换原草稿，点击后等待用户明确提交", () => {
    render();
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    input("先前填写的内容");
    click(button("暂不回答"));
    expect(customInput().value).toBe(deferredText);
    expect(onAnswer).not.toHaveBeenCalled();
    click(submitButton());
    expect(onAnswer.mock.calls[0][0].answers).toEqual([
      { questionId: "first", source: "custom", text: deferredText },
    ]);
  });

  it("非末题前进、末题不自动提交，返回后仍可改写或改选", () => {
    render(interaction([textQuestion("first"), choiceQuestion("second")]));
    click(button("暂不回答"));
    expect(page()).toBe("2 / 2");
    expect(customInput().value).toBe("");
    expect(submitButton().disabled).toBe(true);
    click(button("暂不回答"));
    expect(page()).toBe("2 / 2");
    expect(submitButton().disabled).toBe(false);
    expect(onAnswer).not.toHaveBeenCalled();

    navigate("prevQuestion");
    expect(customInput().value).toBe(deferredText);
    input("  后来补充的信息  ");
    navigate("nextQuestion");
    expect(customInput().value).toBe(deferredText);
    click(options()[1]);
    expect(customInput().value).toBe("");
    click(submitButton());
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({
      interactionId: "ask-1", runId: "run-1", revision: 2,
      answers: [
        { questionId: "first", source: "custom", text: "后来补充的信息" },
        { questionId: "second", source: "option", optionId: "b" },
      ],
    });
  });

  it("末题暂不回答仍不能代替其他尚未作答的题目", () => {
    render(interaction([textQuestion("first"), textQuestion("second")]));
    navigate("nextQuestion");
    click(button("暂不回答"));
    expect(submitButton().disabled).toBe(true);
    click(submitButton());
    expect(onAnswer).not.toHaveBeenCalled();
    navigate("prevQuestion");
    expect(customInput().value).toBe("");
  });

  it("禁用时不能写入固定文本或切题", () => {
    render(interaction([textQuestion("first"), textQuestion("second")]), true);
    expect(button("暂不回答").disabled).toBe(true);
    click(button("暂不回答"));
    expect(page()).toBe("1 / 2");
    expect(customInput().value).toBe("");
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it.each([
    { name: "参数补全", card: { ...interaction(), cardMode: "action_parameters" as const } },
    { name: "计划审批", card: { ...interaction(), cardMode: "plan_approval" as const } },
    { name: "缺少卡片模式", card: { ...interaction(), cardMode: undefined } },
    { name: "固定选项", card: interaction([{ ...choiceQuestion("first"), allowCustomInput: false }]) },
    { name: "未显式允许自定义输入", card: interaction([{ ...textQuestion("first"), allowCustomInput: undefined }]) },
    { name: "旧式 choice", card: { ...interaction(), responseKind: "choice" as const } },
    { name: "旧式 clarification", card: { ...interaction(), responseKind: "clarification" as const } },
    { name: "缺少提交类型", card: { ...interaction(), responseKind: undefined } },
  ])("$name 不提供暂不回答入口", ({ card }) => {
    render(card);
    expect([...host.querySelectorAll("button")].some((node) => node.textContent === "暂不回答")).toBe(false);
  });

  it("专用计划审批面板不增加暂不回答入口", () => {
    act(() => root.render(createElement(PlanApprovalPanel, {
      interaction: { ...interaction([choiceQuestion("first")]), cardMode: "plan_approval" }, onAnswer,
    })));
    expect(host.textContent).not.toContain("暂不回答");
    expect(host.querySelectorAll(".cy-plan-approval__decisions button")).toHaveLength(3);
  });

  it.each(localizedDeferAnswers)("$locale 界面显示并提交对应语言的暂不回答内容", ({ locale, label, text }) => {
    render();
    act(() => setUiLocale(locale));
    click(button(label));
    expect(customInput().value).toBe(text);
    expect(onAnswer).not.toHaveBeenCalled();
    click(submitButton());
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({
      interactionId: "ask-1", runId: "run-1", revision: 2,
      answers: [{ questionId: "first", source: "custom", text }],
    });
  });

  it("切换界面语言不会覆盖已写入或经用户编辑的回答草稿", () => {
    render();
    click(button("暂不回答"));
    act(() => setUiLocale("en"));
    expect(host.textContent).toContain("Skip for now");
    expect(customInput().value).toBe(deferredText);

    input("I will provide more details later.");
    act(() => setUiLocale("ja-JP"));
    expect(host.textContent).toContain("今は回答しない");
    expect(customInput().value).toBe("I will provide more details later.");
    click(submitButton());
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({
      interactionId: "ask-1", runId: "run-1", revision: 2,
      answers: [{ questionId: "first", source: "custom", text: "I will provide more details later." }],
    });
  });

  it.each(localizedDeferSubmissions)("$locale 真实发布、DOM 提交和工具回包保留暂不回答内容（全部暂不回答=$deferAll）", async ({ locale, label, text, deferAll }) => {
    act(() => setUiLocale(locale));
    const result = await executeAskUser({
      id: "tool-1", name: "ask_user",
      arguments: JSON.stringify({ questions: [
        { id: "format", question: "选择格式？", type: "single_select", options: [
          { value: "markdown", label: "Markdown（推荐）" },
          { value: "word", label: "Word" },
        ] },
        { id: "note", question: "补充说明？", type: "text" },
      ] }),
    }, async (card) => {
      const publication = publishAskCard(card as AskClarificationCard, {
        interactionId: "ask-1", runId: "run-1", revision: 2,
      });
      const normalized = normalizeChoiceInteraction(publication.payload);
      expect(normalized).toBeDefined();
      render(normalized!);
      expect(host.textContent).toContain("Markdown（推荐）");
      if (deferAll) click(button(label));
      else click(options()[0]);
      expect(page()).toBe("2 / 2");
      click(button(label));
      expect(customInput().value).toBe(text);
      expect(onAnswer).not.toHaveBeenCalled();
      click(submitButton());
      expect(onAnswer).toHaveBeenCalledTimes(1);
      return resolveAskCardSubmission(publication, onAnswer.mock.calls[0][0] as AskCardSubmission);
    });

    expect(result.outcome).toBe("success");
    expect(JSON.parse(result.output ?? "null")).toEqual({ answers: [
      deferAll
        ? { questionId: "format", customInput: text }
        : { questionId: "format", selectedValues: ["markdown"], selectedLabels: ["Markdown（推荐）"] },
      { questionId: "note", customInput: text },
    ] });
    expect(result.message).not.toContain("用户未在时限内回答问题");
  });
});
