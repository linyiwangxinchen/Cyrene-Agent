const COOKIE_KEY = "read-session-cookie";
const COOKIE_LIMIT = 8192;
const COOKIE_PAIR = /^[!#$%&'*+\-.^_\x60|~\w]+=(?:"[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*"|[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*)$/u;

export function normalizeCookie(value) {
  if (typeof value !== "string" || value.length > COOKIE_LIMIT || /[\x00-\x1F\x7F]/u.test(value)) {
    throw new Error("请粘贴单行 Cookie 请求头，长度最多 8192 字符");
  }
  // Cookie headers copied from formatted text may escape underscores and tildes.
  const header = value.trim().replace(/^cookie: */i, "").replace(/\\([_~])/gu, "$1");
  const pairs = header.split(";").map(part => part.trim());
  if (!pairs.at(-1)) pairs.pop();
  if (!pairs.length || !pairs.every(part => COOKIE_PAIR.test(part))) {
    throw new Error("Cookie 格式无效，请复制贴吧请求中的 Cookie 请求头");
  }
  return pairs.join("; ");
}

export function createReadSession(secrets) {
  async function get() {
    return secrets?.get(COOKIE_KEY);
  }

  function requireStorage() {
    if (!secrets) throw new Error("当前宿主未提供加密存储，请继续使用公开访问");
    return secrets;
  }

  let check;
  return {
    async state() {
      if (!secrets) return { available: false, hasCookie: false };
      try {
        const hasCookie = Boolean(await get());
        return { available: true, hasCookie, ...(hasCookie && check && { check }) };
      } catch {
        return { available: false, hasCookie: false };
      }
    },
    async requestCookie() {
      try {
        const cookie = await get();
        return cookie ? normalizeCookie(cookie) : undefined;
      } catch {
        return undefined;
      }
    },
    async save(value) {
      const cookie = normalizeCookie(value);
      try {
        await requireStorage().set(COOKIE_KEY, cookie);
        check = undefined;
      } catch {
        throw new Error("当前宿主无法加密保存 Cookie，请继续使用公开访问");
      }
    },
    async clear() {
      try {
        await requireStorage().delete(COOKIE_KEY);
        check = undefined;
      } catch {
        throw new Error("无法清除贴吧 Cookie，请稍后重试");
      }
    },
    recordCheck(result) { check = result; },
  };
}
