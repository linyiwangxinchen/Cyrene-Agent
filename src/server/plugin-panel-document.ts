/** Opaque sandbox frames cannot send SameSite session cookies for subresources.
 * Deliver their local scripts/styles inside the authenticated HTML response,
 * retaining the opaque origin and the existing IPC ownership checks.
 */
export async function inlinePluginPanelAssets(input: {
  html: string;
  url: string;
  nonce: string;
  read: (url: string) => Promise<{ status: number; contentType?: string | null; base64?: string }>;
}): Promise<string> {
  const base = new URL(input.url);
  async function asset(reference: string, type: "script" | "style"): Promise<string> {
    const url = new URL(reference, base);
    if (url.protocol !== "cyrene-plugin:" || url.hostname !== base.hostname) {
      throw new Error("插件面板只能加载本插件的脚本和样式");
    }
    const result = await input.read(url.href);
    if (result.status !== 200 || !result.base64 ||
      !(type === "style" ? result.contentType?.startsWith("text/css") : result.contentType?.includes("javascript"))) {
      throw new Error("插件面板资源不存在或类型错误");
    }
    const body = Buffer.from(result.base64, "base64");
    if (body.length > 2 * 1024 * 1024) throw new Error("插件面板单个资源超过 2MB");
    return body.toString("utf8");
  }
  const attr = (attrs: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(attrs)?.[2];
  let html = input.html;
  for (const match of [...html.matchAll(/<link\b([^>]*?)>/gi)]) {
    const attrs = match[1];
    if (attr(attrs, "rel")?.toLowerCase() !== "stylesheet") continue;
    const href = attr(attrs, "href");
    if (!href) throw new Error("插件样式链接缺少 href");
    const stylesheet = (await asset(href, "style")).replace(/<\/style/gi, "<\\/style");
    html = html.replace(match[0], () => `<style>${stylesheet}</style>`);
  }
  let output = "", offset = 0;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    output += html.slice(offset, match.index);
    const source = attr(match[1], "src");
    const body = source ? await asset(source, "script") : match[2];
    const type = attr(match[1], "type");
    if (type && !["module", "text/javascript", "application/javascript"].includes(type)) {
      output += match[0];
    } else {
      output += `<script nonce="${input.nonce}"${type === "module" ? ' type="module"' : ""}>${body.replace(/<\/script/gi, "<\\/script")}</script>`;
    }
    offset = match.index! + match[0].length;
  }
  return output + html.slice(offset);
}
