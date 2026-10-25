import type { WebContents } from "electron";

/**
 * 视口身份切换后的自动刷新护栏（#243 评审）：页面正被使用时不刷新，避免丢失用户输入或打断 Agent 操作。
 *
 * 「用户是否输入过」只认真实的用户输入事件（isTrusted）：搜索页自动聚焦输入框、脚本回填搜索词
 * 都不算，否则百度、必应这类本功能针对的页面会永远不切换。监听运行在独立的隔离世界里，
 * 页面脚本读不到也改不了这个标记；页面重新加载或跳转后自然清零。
 */
export const USER_INPUT_WORLD_ID = 1047;

const WATCH_USER_INPUT = `(() => {
  if (window.__cyreneInputWatch) return;
  window.__cyreneInputWatch = true;
  window.__cyreneUserEdited = false;
  const mark = (event) => { if (event.isTrusted) window.__cyreneUserEdited = true; };
  document.addEventListener("input", mark, true);
  document.addEventListener("change", mark, true);
})()`;

const READ_USER_INPUT = "window.__cyreneUserEdited === true";
const PROBE_TIMEOUT_MS = 500;

/** 在页面 DOM 就绪时调用，开始记录真实用户输入。 */
export function watchUserInput(contents: WebContents): void {
  if (contents.isDestroyed()) return;
  void contents.executeJavaScriptInIsolatedWorld(USER_INPUT_WORLD_ID, [{ code: WATCH_USER_INPUT }]).catch(() => {});
}

/** 页面里是否有用户输入过的内容。查询失败或超时按「有」处理，宁可不刷新也不丢输入。 */
export async function pageHasUserInput(contents: WebContents): Promise<boolean> {
  if (contents.isDestroyed()) return true;
  const probe = contents.executeJavaScriptInIsolatedWorld(USER_INPUT_WORLD_ID, [{ code: READ_USER_INPUT }])
    .then((value) => value === true, () => true);
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(true), PROBE_TIMEOUT_MS));
  return Promise.race([probe, timeout]);
}

/** WebContents 的 before-input-event 输入（只用到其中几个字段）。 */
export interface KeyboardInputLike {
  type: string;
  key: string;
  control?: boolean;
  meta?: boolean;
  alt?: boolean;
}

/**
 * 是否是可能改动页面内容的按键。before-input-event 覆盖页面内所有 frame（含 iframe 里的表单），
 * 而 DOM 的 input 事件不会跨 frame 冒泡，因此键盘编辑用它来记录；
 * 还需结合 focusedElementIsEditable 确认焦点在可编辑元素上。方向键、Tab、翻页、复制等不算。
 */
export function isEditingKeystroke(input: KeyboardInputLike): boolean {
  if (input.type !== "keyDown") return false;
  const key = input.key;
  if (input.control || input.meta) return /^[vx]$/i.test(key);
  if (input.alt) return false;
  return key.length === 1 || key === "Backspace" || key === "Delete" || key === "Enter";
}

/** 在收到按键的 frame 里判断焦点是否在可编辑元素上（含 shadow DOM 内的输入框）。 */
export const FOCUSED_ELEMENT_EDITABLE = `(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return !el.disabled && !el.readOnly;
  if (tag !== "INPUT") return false;
  const type = (el.getAttribute("type") || "text").toLowerCase();
  return !el.disabled && !el.readOnly
    && !["button", "submit", "reset", "image", "hidden", "checkbox", "radio", "range", "color", "file"].includes(type);
})()`;

/** 焦点所在 frame（含 iframe）的焦点元素是否可编辑。查询失败按「否」处理，交给其他信号判断。 */
export async function focusedElementIsEditable(contents: WebContents): Promise<boolean> {
  if (contents.isDestroyed()) return false;
  const frame = contents.focusedFrame ?? contents.mainFrame;
  try {
    return (await frame.executeJavaScript(FOCUSED_ELEMENT_EDITABLE)) === true;
  } catch {
    return false;
  }
}

/**
 * 缓存响应是否按 User-Agent 区分（Vary: User-Agent 或 Vary: *）。
 * 这类缓存只会在 UA 匹配时命中，内容就是本次请求的身份；否则命中的可能是其他身份时缓存的内容。
 */
export function responseVariesByUserAgent(headers: Record<string, string[]> | undefined): boolean {
  if (!headers) return false;
  return Object.entries(headers).some(([name, values]) => name.toLowerCase() === "vary"
    && values.some((value) => value.split(",").some((part) => {
      const field = part.trim().toLowerCase();
      return field === "user-agent" || field === "*";
    })));
}

export interface UserAgentReloadState {
  /** Agent 浏览器控制正持有该标签。 */
  controlled: boolean;
  /** 元素选择器正在该标签上运行。 */
  picking: boolean;
  /** 页面仍在加载。 */
  loading: boolean;
  /** 最近一次主框架导航被用户停止或加载失败：不能用刷新把它重新拉起。 */
  interrupted?: boolean;
  /** 当前文档是表单 POST 的响应：刷新会重提交表单（可能重复下单、登录等），只能等用户下一次导航时应用新身份。 */
  postDocument?: boolean;
}

/** 这些情况下先不刷新，保留待刷新标记，交给下一次宽度变化、切换标签或用户自己导航时再判断。 */
export function shouldDeferUserAgentReload(state: UserAgentReloadState): boolean {
  return state.controlled || state.picking || state.loading || state.interrupted === true || state.postDocument === true;
}

export interface UserAgentReloadSnapshot extends UserAgentReloadState {
  /** 主框架跨文档导航的计数；探测期间有新导航开始时会变化。 */
  navigationGeneration: number;
  /** 用户编辑类按键与鼠标按下的计数（主进程在分发给页面前同步累加）；探测期间有新输入时会变化。 */
  inputGeneration: number;
  /** 当前文档仍按旧身份渲染、仍需要刷新。 */
  stillNeeded: boolean;
}

/**
 * 带护栏地刷新：先检查页面状态，再异步探测用户输入，探测返回后重新读取一次状态——
 * 探测期间用户可能从地址栏 / 工具栏发起了导航（刷新会取消那次导航），
 * 也可能刚开始输入（探测读到的是旧快照，刷新会丢掉刚输入的内容），两种情况都必须放弃。
 * 输入代次在主进程收到输入事件时同步累加，早于页面处理该输入，因此探测返回后、刷新前到达的输入都能被发现。
 */
export async function reloadForUserAgentIfIdle(options: {
  snapshot: () => UserAgentReloadSnapshot | null;
  hasUserInput: () => Promise<boolean>;
  reload: () => void;
}): Promise<boolean> {
  const before = options.snapshot();
  if (!before || !before.stillNeeded || shouldDeferUserAgentReload(before)) return false;
  if (await options.hasUserInput()) return false;
  const after = options.snapshot();
  if (!after || !after.stillNeeded || shouldDeferUserAgentReload(after)) return false;
  if (after.navigationGeneration !== before.navigationGeneration) return false;
  if (after.inputGeneration !== before.inputGeneration) return false;
  options.reload();
  return true;
}
