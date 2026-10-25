// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { FOCUSED_ELEMENT_EDITABLE } from "./user-agent-reload-guard";

// 与主进程注入页面的脚本相同，在真实 DOM 上执行
const focusedIsEditable = (): boolean => (0, eval)(FOCUSED_ELEMENT_EDITABLE) as boolean;

afterEach(() => { document.body.innerHTML = ""; });

describe("焦点元素是否可编辑（区分输入与网页快捷键 / 空格翻页）", () => {
  it.each([
    ['<input id="t">'],
    ['<input id="t" type="search">'],
    ['<input id="t" type="password">'],
    ['<textarea id="t"></textarea>'],
    ['<div id="t" contenteditable="true" tabindex="0">x</div>'],
  ])("可编辑：%s", (html) => {
    document.body.innerHTML = html;
    (document.getElementById("t") as HTMLElement).focus();
    // jsdom 未实现 isContentEditable，按属性补上以模拟浏览器
    const el = document.getElementById("t") as HTMLElement & { isContentEditable?: boolean };
    if (el.getAttribute("contenteditable") === "true") Object.defineProperty(el, "isContentEditable", { value: true });
    expect(focusedIsEditable()).toBe(true);
  });

  it.each([
    ['<button id="t">x</button>'],
    ['<input id="t" type="checkbox">'],
    ['<input id="t" readonly>'],
    ['<input id="t" disabled>'],
    ['<a id="t" href="#">link</a>'],
  ])("不可编辑：%s", (html) => {
    document.body.innerHTML = html;
    (document.getElementById("t") as HTMLElement).focus();
    expect(focusedIsEditable()).toBe(false);
  });

  it("焦点在页面主体（空格翻页、j/k 快捷键）时不算输入", () => {
    document.body.innerHTML = "<p>article</p>";
    (document.activeElement as HTMLElement | null)?.blur();
    expect(focusedIsEditable()).toBe(false);
  });

  it("shadow DOM 内的输入框算可编辑", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    root.append(input);
    input.focus();
    expect(focusedIsEditable()).toBe(true);
  });
});
