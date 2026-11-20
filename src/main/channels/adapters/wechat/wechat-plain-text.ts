/**
 * 微信不渲染 Markdown，原样发出去会看到 `**`、`#`、`> ` 等符号。
 * 发送前把常见标记还原成聊天里会打的纯文本；编号列表保留（手打也会这样写）。
 */
export function toWechatPlainText(text: string): string {
  return text
    .replace(/^```[^\n]*\n?/gmu, "")
    .replace(/\*\*([^*\n]+)\*\*/gu, "$1")
    .replace(/__([^_\n]+)__/gu, "$1")
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/!?\[([^\]\n]+)\]\((\S+?)\)/gu, "$1 $2")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/^>\s?/gmu, "")
    .replace(/^(\s*)[-*+]\s+/gmu, "$1· ")
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
