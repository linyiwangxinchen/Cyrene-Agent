const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], dialog[open]';

function containsDialog(node: Node): boolean {
  return node instanceof Element
    && (node.matches(DIALOG_SELECTOR) || node.querySelector(DIALOG_SELECTOR) !== null);
}

/** 原生网页不能参与 DOM 层级；按弹窗实际可见性避让，关闭动画结束后再恢复。 */
export function observeDialogOcclusion(onChange: (occluded: boolean) => void): () => void {
  let previous: boolean | undefined;
  const update = () => {
    const occluded = Array.from(document.querySelectorAll(DIALOG_SELECTOR)).some((dialog) =>
      dialog.getAttribute("aria-modal") !== "false"
        && dialog.getClientRects().length > 0 && getComputedStyle(dialog).visibility !== "hidden",
    );
    if (occluded !== previous) {
      previous = occluded;
      onChange(occluded);
    }
  };
  const observer = new MutationObserver((records) => {
    // 流式文本变化不触发布局查询，也不发送重复的浏览器 bounds IPC。
    const changed = records.some((record) => record.type === "attributes"
      ? record.attributeName === "role" || record.attributeName === "open" || containsDialog(record.target)
      : [...record.addedNodes, ...record.removedNodes].some(containsDialog));
    if (changed) update();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["role", "aria-modal", "class", "style", "hidden", "open"],
  });
  update();
  return () => observer.disconnect();
}
