export const TIEBA = "https://tieba.baidu.com";

export function threadId(value) {
  const url = new URL(String(value), TIEBA);
  if (url.origin !== TIEBA || url.username || url.password || !/^\/p\/\d{1,20}\/?$/.test(url.pathname)) {
    throw new Error("请输入贴吧帖子链接");
  }
  return url.pathname.split("/")[2];
}

const entities = new Map(Object.entries({
  nbsp: " ", lt: "<", gt: ">", amp: "&", quot: '"', apos: "'",
  hellip: "…", middot: "·", ldquo: "“", rdquo: "”",
}));

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] !== "#") return entities.get(code.toLowerCase()) ?? entity;
    const hex = code[1].toLowerCase() === "x";
    const number = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
      ? String.fromCodePoint(number)
      : entity;
  });
}

function text(html) {
  return decodeEntities(html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(?:div|p|li)>/gi, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function attribute(tag, name) {
  return tag.match(new RegExp("\\s" + name + "\\s*=\\s*([\"'])(.*?)\\1", "i"))?.[2];
}

function blocks(html, matchOpen, tag, limit) {
  const tags = new RegExp("<\\/?" + tag + "\\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*>", "gi");
  const result = [];
  let current;
  for (const match of html.matchAll(tags)) {
    const closing = match[0][1] === "/";
    if (!current) {
      if (closing) continue;
      const fields = matchOpen(match[0]);
      if (fields) current = { fields, start: match.index + match[0].length, depth: 1 };
    } else {
      current.depth += closing ? -1 : 1;
      if (current.depth > 0) continue;
      result.push({ ...current.fields, body: html.slice(current.start, match.index) });
      if (result.length === limit) break;
      current = undefined;
    }
  }
  return result;
}

function mobileFloors(html) {
  const content = (tag) => {
    const classes = attribute(tag, "class")?.split(/\s+/);
    if (classes?.includes("content") && !classes.includes("top_bar")) return { post: "" };
  };
  const items = blocks(html, (tag) => {
    if (!attribute(tag, "class")?.split(/\s+/).includes("j_post_list_item")) return;
    const info = attribute(tag, "data-info");
    if (!info) return { post: "" };
    try {
      // Preserve the original digits when Tieba sends the post ID as a JSON number.
      const data = JSON.parse(decodeEntities(info), (key, value, context) =>
        key === "pid" && typeof value === "number" ? context.source : value);
      const post = typeof data?.pid === "string" && /^\d{1,20}$/.test(data.pid) ? data.pid : "";
      const floor = Number(data?.floor_num);
      return Number.isSafeInteger(floor) && floor > 0 ? { post, floor } : { post };
    } catch {
      return { post: "" };
    }
  }, "li", 40);
  if (!items.length) return blocks(html, content, "div", 40);
  return items.flatMap(({ body, ...fields }) =>
    blocks(body, content, "div", 1).map((row) => ({ ...row, ...fields })));
}

export function floorsFromHtml(html, mobile = false) {
  const desktop = blocks(html, (tag) => {
    const post = tag.match(/\sid\s*=\s*["']post_content_(\d+)["']/i)?.[1];
    if (post) return { post };
  }, "div", 40);
  const floors = desktop.length || !mobile ? desktop : mobileFloors(html);
  return floors
    .map(({ body, ...fields }) => ({ ...fields, body: text(body).slice(0, 800) }))
    .filter((row) => row.body);
}

export function repliesFromHtml(html, parent) {
  return blocks(html, (tag) => {
    if (/\sclass\s*=\s*["'][^"']*\blzl_content_main\b[^"']*["']/i.test(tag)) return {};
  }, "span", 12)
    .map(({ body }) => ({ post: parent, body: text(body).slice(0, 500), reply: true }))
    .filter((row) => row.body);
}

export function threadsFromHtml(html, bar) {
  const links = new Map();
  const marked = new Map();
  for (const match of html.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a>/gi)) {
    const href = attribute(match[1], "href");
    if (!href) continue;
    let id;
    try { id = threadId(href); } catch { continue; }
    const title = text(attribute(match[1], "title") || match[2]).slice(0, 160);
    if (!title) continue;
    const item = { id, title, url: TIEBA + "/p/" + id, bar };
    if (!links.has(id)) links.set(id, item);
    if (attribute(match[1], "class")?.split(/\s+/).includes("j_th_tit")) marked.set(id, item);
  }
  return [...(marked.size ? marked : links).values()].slice(0, 25);
}

export function threadTitle(html) {
  const match = html.match(/<(?:h1|h3)\b[^>]*class=["'][^"']*\bcore_title_txt\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:h1|h3)>/i)
    ?? html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? text(match[1]).replace(/[_\s]+[^_]+吧[_\s]+百度贴吧$|[_\s]+百度贴吧$/u, "").slice(0, 160) : "";
}

export class TiebaPageError extends Error {
  constructor(message, pauseVisit = false) {
    super(message);
    this.pauseVisit = pauseVisit;
  }
}

export async function publicPage(path, signal, cookie) {
  // Callers may only use the existing first-party reading routes.
  const url = new URL(TIEBA + path);
  const knownPage = /^\/f\?kw=[^&#]+$/.test(path)
    || /^\/p\/\d{1,20}(?:\?pn=\d{1,4})?$/.test(path)
    || /^\/mo\/q\/m\?(?:kw=[^&#]+&pn=0|kz=\d{1,20}&pn=\d{1,4})$/.test(path)
    || /^\/p\/comment\?tid=\d{1,20}&pid=\d{1,20}&pn=1$/.test(path);
  if (url.origin !== TIEBA || !knownPage) throw new TiebaPageError("贴吧读取入口无效");
  try {
    const response = await fetch(url.href, {
      method: "GET",
      signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      redirect: "manual",
      headers: { Accept: "text/html, application/xhtml+xml", ...(cookie && { Cookie: cookie }) },
    });
    if (response.status === 401 || response.status === 403 || response.status === 429 ||
      (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new TiebaPageError("贴吧限制了自动访问（HTTP " + response.status + "）。可在浏览器打开原帖后导入楼层摘录。", true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new TiebaPageError("贴吧读取失败（HTTP " + response.status + "）");
    }
    if (!response.body) throw new TiebaPageError("贴吧返回空白页面");
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 4_000_000) throw new TiebaPageError("贴吧页面过大");
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const declared = response.headers.get("content-type") ?? "";
    const encoding = /charset=["\s\x27]*(?:gbk|gb2312|gb18030)/i.test(
      declared + " " + buffer.subarray(0, 2000).toString("latin1"),
    ) ? "gb18030" : "utf-8";
    const html = new TextDecoder(encoding).decode(buffer);
    if (/<title\b[^>]*>[^<]*(?:百度安全验证|访问验证)/i.test(html) ||
      /\bBIOC_OPTIONS\b/.test(html.slice(0, 5000))) {
      throw new TiebaPageError("贴吧要求安全验证。可在浏览器打开原帖后导入摘录。", true);
    }
    return html;
  } catch (error) {
    if (signal.aborted || error instanceof TiebaPageError) throw error;
    throw new TiebaPageError(error.name === "TimeoutError"
      ? "读取贴吧公开页面超时"
      : "暂时连不上贴吧公开页面");
  }
}
