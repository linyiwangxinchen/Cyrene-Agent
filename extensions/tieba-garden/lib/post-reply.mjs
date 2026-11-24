import { authenticatedPage, authenticatedPost, initialJar, REPLY_PATH, replyCookie } from "./authenticated-page.mjs";
import { TIEBA, threadId } from "./public-pages.mjs";
import { normalizeCookie } from "./session.mjs";

const ID = /^[1-9]\d{0,19}$/u;
const BAR = /^[^\p{C}<>\uFFFD]{1,80}$/u;

function replyResult(outcome, url, message, postId) {
  return { outcome, url, message, ...(postId && { postId }) };
}

function pageText({ buffer, declared }) {
  if (!buffer?.length) return "";
  const charset = (declared ?? "") + " " + buffer.subarray(0, 2000).toString("latin1");
  const encoding = /charset=["\s']*(?:gbk|gb2312|gb18030)/i.test(charset) ? "gb18030" : "utf-8";
  return new TextDecoder(encoding).decode(buffer);
}

function needsVerification(text) {
  return /<title\b[^>]*>[^<]*(?:百度安全验证|访问验证)/i.test(text) ||
    /\bBIOC_OPTIONS\b/.test(text.slice(0, 5000));
}

function json(text) {
  try {
    return JSON.parse(text, (key, value, context) => {
      if (["pid", "post_id", "postId"].includes(key) && typeof value === "number") return context.source;
      return value;
    });
  } catch {
    return undefined;
  }
}

function forumLinks(html) {
  const links = [];
  for (const match of html.matchAll(/<a\b[^>]*\s+href\s*=\s*(["'])(.*?)\1[^>]*>/gi)) {
    if (!/^(?:\/(?!\/)|https:\/\/tieba\.baidu\.com\/)/i.test(match[2])) continue;
    const href = URL.parse(match[2].replace(/&amp;|&#38;/gi, "&"), TIEBA);
    if (href?.origin === TIEBA && /^\/(?:f(?:\/|$)|mo\/q\/(?:m|bawuindex)$)/.test(href.pathname)) links.push(href);
  }
  return links;
}

function barName(html) {
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const field = script[1].match(/(?<!\\)"fname"\s*:\s*("(?:\\.|[^"\\])*")/u);
    const name = field && json(field[1]);
    if (typeof name === "string" && BAR.test(name)) return name;
  }
  const names = new Set(forumLinks(html).map(link => link.searchParams.get("kw"))
    .filter(kw => typeof kw === "string" && BAR.test(kw)));
  return names.size === 1 ? [...names][0] : undefined;
}

function forumId(html, kw) {
  // Mobile board pages expose their paired ID and name in the page initialization script.
  const ids = new Set();
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const field of script[1].matchAll(/(?<!\\)\bforum_id\s*:\s*['"]?([1-9]\d{0,19})['"]?\s*,\s*forum_name\s*:\s*("(?:\\.|[^"\\])*")/gu)) {
      if (json(field[2]) === kw) ids.add(field[1]);
    }
  }
  if (ids.size) return ids.size === 1 ? [...ids][0] : undefined;
  const links = forumLinks(html)
    .filter(link => (link.searchParams.get("kw") ?? link.searchParams.get("fn") ?? kw) === kw)
    .map(link => link.searchParams.get("fid")).filter(fid => ID.test(fid ?? ""));
  const linkIds = new Set(links);
  return linkIds.size === 1 ? [...linkIds][0] : undefined;
}

function receipt(response, url) {
  const status = response?.status ?? 0;
  const body = response ? pageText(response) : "";
  if ([401, 403, 429].includes(status) || (status >= 300 && status < 400) || needsVerification(body)) {
    return replyResult("rejected", url, "贴吧限制了回复或要求安全验证，请在浏览器打开原帖查看。");
  }
  const result = json(body);
  const code = result?.no;
  const validCode = Number.isSafeInteger(code) || (typeof code === "string" && /^-?\d+$/u.test(code));
  if (status >= 200 && status < 300 && validCode && Number(code) === 0) {
    const data = result.data;
    const postId = [data?.pid, data?.post_id, data?.postId].find(id => typeof id === "string" && ID.test(id));
    const visible = ![0, "0", false].includes(data?.is_post_visible);
    if (postId && visible) {
      return replyResult("published", url + "#post_content_" + postId, "贴吧已发布回复。", postId);
    }
    return replyResult("accepted", url, "贴吧已接收回复，公开显示待确认。", postId);
  }
  if (status >= 200 && status < 500 && validCode && Number(code) !== 0) {
    return replyResult("rejected", url, "贴吧拒绝了回复（错误码 " + Number(code) + "），请在浏览器查看原帖。");
  }
  return replyResult("unknown", url, "贴吧没有返回可确认的回执，请先在原帖核对回复。");
}

export async function submitThreadReply({ url: inputUrl, content, cookie, signal, canPost }, {
  read = authenticatedPage, write = authenticatedPost,
} = {}) {
  let tid;
  try { tid = threadId(inputUrl); } catch { /* Report invalid input below. */ }
  if (!ID.test(tid ?? "")) return replyResult("rejected", undefined, "请输入有效的贴吧帖子链接。");
  const url = TIEBA + "/p/" + tid;
  const text = typeof content === "string" ? content.trim() : "";
  const length = [...text].length;
  if (length < 4 || length > 400 || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u.test(text)) {
    return replyResult("rejected", url, "回复须为 4 至 400 字，支持普通换行。");
  }
  let jar;
  try { jar = initialJar(normalizeCookie(cookie)); } catch {
    return replyResult("rejected", url, "请在设置中导入有效的贴吧登录 Cookie。");
  }
  const timeout = AbortSignal.timeout(27_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  async function readPage(path) {
    const result = await read(new URL(path, TIEBA), requestSignal, jar);
    const body = pageText(result);
    if ([401, 403, 429].includes(result.status) || (result.status >= 300 && result.status < 400) || needsVerification(body)) {
      throw new Error("贴吧限制了访问或要求安全验证，请在浏览器打开原帖查看。");
    }
    if (result.status < 200 || result.status >= 300 || !body) throw new Error("暂时无法读取贴吧页面，请稍后再试。");
    jar = result.jar || jar;
    return body;
  }

  let form;
  let header;
  try {
    const login = json(await readPage("/dc/common/tbs"));
    if (String(login?.is_login) !== "1" || !/^[A-Za-z0-9]{1,128}$/u.test(login?.tbs ?? "")) {
      return replyResult("rejected", url, "贴吧未确认已登录，请在浏览器登录后重新导入 Cookie。");
    }
    const kw = barName(await readPage("/mo/q/m?kz=" + tid + "&pn=1"));
    if (!kw) return replyResult("rejected", url, "贴吧未返回原帖的吧名，请在浏览器打开原帖查看。");
    const fid = forumId(await readPage("/mo/q/m?kw=" + encodeURIComponent(kw) + "&pn=0"), kw);
    if (!fid) return replyResult("rejected", url, "贴吧未返回可确认的贴吧编号，请在浏览器打开原帖查看。");
    header = replyCookie(jar);
    form = new URLSearchParams({ ie: "utf-8", kw, fid, tid, tbs: login.tbs, files: "[]", content: text });
  } catch (error) {
    const message = error.message?.startsWith("贴吧限制了访问") ? error.message
      : "发送前未能确认贴吧登录和原帖信息，请稍后再试。";
    return replyResult("rejected", url, message);
  }
  if (requestSignal.aborted || (canPost && !canPost())) {
    return replyResult("rejected", url, "回复已取消，请重新确认后发送。");
  }
  try {
    return receipt(await write(new URL(REPLY_PATH, TIEBA), requestSignal, header, form, tid), url);
  } catch {
    return replyResult("unknown", url, "连接在回复结果确认前中断，请先在原帖核对回复。");
  }
}
