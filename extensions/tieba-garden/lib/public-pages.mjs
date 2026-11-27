import { setTimeout as wait } from "node:timers/promises";
import { authenticatedPage, initialJar } from "./authenticated-page.mjs";
import { normalizeCookie } from "./session.mjs";

export const TIEBA = "https://tieba.baidu.com";
export const DIRECTORY_INDEX_PATH = "/f/index/forumclass";
const DIRECTORY_CATEGORY_PATH = /^\/f\/fdir\?fd=[^&#]+&sd=[^&#]+&ie=utf-8$/u;
const POST_ID = /^\d{1,20}$/;
const MOBILE_REPLY_PATH = /^\/mo\/q\/flr\?kz=\d{1,20}&pid=\d{1,20}&fpn=[1-9]\d{0,3}&is_ajax=1&has_url_param=0$/;

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

function mobileItems(html) {
  return blocks(html, (tag) => {
    if (!attribute(tag, "class")?.split(/\s+/).includes("j_post_list_item")) return;
    const info = attribute(tag, "data-info");
    if (!info) return { post: "" };
    try {
      // Preserve the original digits when Tieba sends the post ID as a JSON number.
      const data = JSON.parse(decodeEntities(info), (key, value, context) =>
        key === "pid" && typeof value === "number" ? context.source : value);
      const post = typeof data?.pid === "string" && POST_ID.test(data.pid) ? data.pid : "";
      const floor = Number(data?.floor_num);
      return Number.isSafeInteger(floor) && floor > 0 ? { post, floor } : { post };
    } catch {
      return { post: "" };
    }
  }, "li", 40);
}

function mobileFloors(html) {
  const content = (tag) => {
    const classes = attribute(tag, "class")?.split(/\s+/);
    if (classes?.includes("content") && !classes.includes("top_bar")) return { post: "" };
  };
  const items = mobileItems(html);
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

function mobileReplyRows(html, post, limit) {
  const replies = [];
  const seen = new Set();
  for (const { replyId, body } of blocks(html, (tag) => {
    if (!attribute(tag, "class")?.split(/\s+/).includes("j_list_item_floor")) return;
    const id = attribute(tag, "pid") ?? "";
    return POST_ID.test(id) ? { replyId: id } : {};
  }, "li", 40)) {
    if (replyId && seen.has(replyId)) continue;
    const [content] = blocks(body, (tag) => {
      if (attribute(tag, "class")?.split(/\s+/).includes("floor_content")) return {};
    }, "span", 1);
    const quote = content ? text(content.body).slice(0, 500) : "";
    if (!quote) continue;
    if (replyId) seen.add(replyId);
    replies.push({ post, body: quote, reply: true, ...(replyId && { replyId }) });
    if (replies.length === limit) break;
  }
  return replies;
}

export function mobileRepliesFromHtml(html, parents) {
  const requested = new Set(parents);
  const replies = [];
  const counts = new Map();
  for (const { post, body } of mobileItems(html)) {
    if (!requested.has(post) || !post) continue;
    const [panel] = blocks(body, (tag) => {
      if (!attribute(tag, "class")?.split(/\s+/).includes("j_floor_panel")) return;
      const count = attribute(tag, "data-list-count") ?? "";
      return /^\d{1,10}$/.test(count) ? { count: Number(count) } : {};
    }, "div", 1);
    if (!panel) continue;
    if (panel.count !== undefined) counts.set(post, panel.count);
    if (replies.length < 40) replies.push(...mobileReplyRows(panel.body, post, 40 - replies.length));
  }
  return { replies, counts };
}

export function mobileReplyPagePath(tid, post, page = 1) {
  const path = "/mo/q/flr?kz=" + tid + "&pid=" + post + "&fpn=" + page + "&is_ajax=1&has_url_param=0";
  if (!MOBILE_REPLY_PATH.test(path)) throw new TiebaPageError("贴吧楼中楼读取入口无效");
  return path;
}

export function repliesFromMobilePage(payload, post) {
  if (typeof payload !== "string") throw new TiebaPageError("贴吧楼中楼返回格式无法识别");
  if (verificationPage(payload)) throw verificationError();
  let result;
  try { result = JSON.parse(payload); }
  catch { throw new TiebaPageError("贴吧楼中楼返回格式无法识别"); }
  if ([401, 403, 429, "401", "403", "429"].includes(result?.no) ||
    [result?.msg, result?.error, result?.errmsg].some(message =>
      typeof message === "string" && /百度安全验证|访问验证|验证码/.test(message))) {
    throw verificationError();
  }
  if (result?.no !== 0 && result?.no !== "0") throw new TiebaPageError("贴吧楼中楼读取失败");
  const { page: pagination, floor_html: html } = result.data ?? {};
  const { current_page: page, total_page: totalPages, total_num: total } = pagination ?? {};
  if (!/^[1-9]\d{0,3}$/.test(page) || !/^\d{1,10}$/.test(totalPages) ||
    !/^\d{1,10}$/.test(total) || typeof html !== "string") {
    throw new TiebaPageError("贴吧楼中楼返回格式无法识别");
  }
  return {
    replies: mobileReplyRows(html, post, 40),
    page: Number(page), total: Number(total), totalPages: Number(totalPages),
  };
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

function firstPartyLink(href) {
  try {
    const url = new URL(decodeEntities(href), TIEBA);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.hostname === "tieba.baidu.com"
      && !url.port && !url.username && !url.password && !url.hash) return url;
  } catch { /* Ignore malformed links in the public directory. */ }
}

function directoryName(value) {
  const name = value?.trim();
  return name && name.length <= 50 && /[\p{L}\p{N}]/u.test(name) && !/[\p{Cc}\p{Cf}\uFFFD<>]/u.test(name) ? name : "";
}

function directoryLinks(html) {
  return html.replace(/<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/giu, "").matchAll(/<a\b[^>]*>/giu);
}

export function directoryPathsFromHtml(html) {
  const pages = new Set();
  for (const [tag] of directoryLinks(html)) {
    const href = attribute(tag, "href");
    const url = href && firstPartyLink(href);
    if (url?.pathname !== "/f/index/forumpark") continue;
    const group = directoryName(url.searchParams.get("pcn"));
    const subgroup = directoryName(url.searchParams.get("cn"));
    if (group && subgroup) pages.add("/f/fdir?" + new URLSearchParams({ fd: group, sd: subgroup, ie: "utf-8" }));
  }
  return [...pages];
}

function decodeDirectoryKeyword(value) {
  const encoded = value.replace(/\+/gu, " ");
  try { return decodeURIComponent(encoded); }
  catch {
    // The legacy public directory encodes its board links with GBK even when
    // the category request itself uses UTF-8. Decode only well-formed bytes.
    if (!/^[\x20-\x7e]+$/u.test(encoded) || /%(?![0-9a-f]{2})/iu.test(encoded)) return "";
    const bytes = Buffer.from(encoded.replace(/%([0-9a-f]{2})/giu, (_, byte) => String.fromCharCode(Number.parseInt(byte, 16))), "latin1");
    try { return new TextDecoder("gb18030", { fatal: true }).decode(bytes); }
    catch { return ""; }
  }
}

export function forumsFromDirectoryHtml(html) {
  const list = /<!--\s*贴吧列表start\s*-->([\s\S]*?)<!--\s*贴吧列表end\s*-->/iu.exec(html)?.[1];
  if (list === undefined) throw new TiebaPageError("贴吧分类页没有返回可识别的吧列表");
  const names = [];
  for (const [tag] of directoryLinks(list)) {
    const href = attribute(tag, "href");
    const url = href && firstPartyLink(href);
    if (url?.pathname !== "/f") continue;
    const keyword = /(?:^\?|&)kw=([^&]+)/u.exec(url.search)?.[1];
    const name = keyword && directoryName(decodeDirectoryKeyword(keyword));
    if (name) names.push(name);
  }
  return names;
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

function checkStatus(status) {
  if (status === 401 || status === 403 || status === 429 || (status >= 300 && status < 400)) {
    throw new TiebaPageError("贴吧限制了自动访问（HTTP " + status + "）。可在浏览器打开原帖后导入楼层摘录。", true);
  }
  if (status < 200 || status >= 300) throw new TiebaPageError("贴吧读取失败（HTTP " + status + "）");
}

async function visitorPage(url, signal) {
  const response = await fetch(url.href, {
    method: "GET",
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    redirect: "manual",
    headers: { Accept: url.pathname === "/mo/q/flr" ? "application/json" : "text/html, application/xhtml+xml" },
  });
  if (!response.ok) await response.body?.cancel();
  checkStatus(response.status);
  if (!response.body) throw new TiebaPageError("贴吧返回空白页面");
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 4_000_000) throw new TiebaPageError("贴吧页面过大");
    chunks.push(chunk);
  }
  return { buffer: Buffer.concat(chunks), declared: response.headers.get("content-type") };
}

function verificationPage(html) {
  return /<title\b[^>]*>[^<]*(?:百度安全验证|访问验证)/i.test(html) ||
    /\bBIOC_OPTIONS\b/.test(html.slice(0, 5000));
}

function verificationError() {
  return new TiebaPageError("贴吧要求安全验证。可在浏览器打开原帖后导入摘录。", true);
}

function decodePage({ buffer, declared }) {
  if (!buffer.length) throw new TiebaPageError("贴吧返回空白页面");
  if (buffer.length > 4_000_000) throw new TiebaPageError("贴吧页面过大");
  const encoding = /charset=["\s\x27]*(?:gbk|gb2312|gb18030)/i.test(
    (declared ?? "") + " " + buffer.subarray(0, 2000).toString("latin1"),
  ) ? "gb18030" : "utf-8";
  const html = new TextDecoder(encoding).decode(buffer);
  if (verificationPage(html)) throw verificationError();
  return html;
}

export function createAuthenticatedReader(request = authenticatedPage, now = Date.now, gapMs = 1200) {
  let previousCookie;
  let jar;
  let loginUntil = 0;
  let nextRequestAt = 0;
  async function readWithJar(url, signal) {
    const delay = nextRequestAt - now();
    if (delay > 0) await wait(delay, undefined, { signal });
    nextRequestAt = now() + gapMs;
    return request(url, signal, jar);
  }
  return {
    clear() {
      previousCookie = undefined;
      jar = undefined;
      loginUntil = 0;
    },
    async read(url, signal, cookie) {
      if (cookie !== previousCookie) {
        previousCookie = cookie;
        jar = initialJar(cookie);
        loginUntil = 0;
      }
      if (now() >= loginUntil) {
        const check = await readWithJar(new URL("/dc/common/tbs", TIEBA), signal);
        checkStatus(check.status);
        const body = decodePage(check);
        let login;
        try { login = JSON.parse(body); }
        catch { throw new TiebaPageError("贴吧未返回可识别的登录状态"); }
        if (String(login?.is_login) !== "1") {
          throw new TiebaPageError("贴吧未识别当前 Cookie 的登录态，请在浏览器登录后重新导入");
        }
        jar = check.jar || jar;
        loginUntil = now() + 600_000;
      }
      const result = await readWithJar(url, signal);
      if (result.status >= 200 && result.status < 300) jar = result.jar || jar;
      return result;
    },
  };
}

export async function publicPage(path, signal, cookie, readAuthenticated) {
  // Callers may only use the existing first-party reading routes.
  const url = new URL(TIEBA + path);
  const directoryPage = path === DIRECTORY_INDEX_PATH || DIRECTORY_CATEGORY_PATH.test(path);
  const knownPage = /^\/f\?kw=[^&#]+$/.test(path)
    || /^\/p\/\d{1,20}(?:\?pn=\d{1,4})?$/.test(path)
    || /^\/mo\/q\/m\?(?:kw=[^&#]+&pn=0|kz=\d{1,20}&pn=\d{1,4})$/.test(path)
    || MOBILE_REPLY_PATH.test(path)
    || /^\/p\/comment\?tid=\d{1,20}&pid=\d{1,20}&pn=1$/.test(path);
  if (url.origin !== TIEBA || !(knownPage || directoryPage) || (directoryPage && cookie)) throw new TiebaPageError("贴吧读取入口无效");
  try {
    const page = cookie
      ? await (readAuthenticated ?? createAuthenticatedReader().read)(url, signal, normalizeCookie(cookie))
      : await visitorPage(url, signal);
    if (cookie) checkStatus(page.status);
    return decodePage(page);
  } catch (error) {
    if (signal.aborted || error instanceof TiebaPageError) throw error;
    if (error.code === "ENOENT") throw new TiebaPageError("找不到 curl，安装后可使用贴吧登录态");
    if (error.code === 63 || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new TiebaPageError("贴吧页面过大");
    throw new TiebaPageError(error.name === "TimeoutError" || error.code === 28
      ? "读取贴吧页面超时"
      : "暂时连不上贴吧");
  }
}
