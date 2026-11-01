import { videoId } from "./config.mjs";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
const credentialKey = "bilibili-account";
export class BiliError extends Error {
  constructor(message, { definitive = false } = {}) {
    super(message);
    this.definitive = definitive;
  }
}
export class BilibiliClient {
  constructor({ secrets, runtime, fetchImpl = fetch }) {
    this.secrets = secrets;
    this.runtime = runtime;
    this.fetch = fetchImpl;
    this.qr = null;
  }
  async credentials() {
    const raw = await this.secrets.get(credentialKey);
    if (!raw) throw new Error("请先扫码登录 B 站");
    const value = JSON.parse(raw);
    if (!value.sessdata || !value.bili_jct)
      throw new Error("登录凭据不完整，请重新扫码");
    return value;
  }
  async loggedIn() {
    try {
      return Boolean(await this.secrets.get(credentialKey));
    } catch {
      return false;
    }
  }
  async json(url, { credential, signal, ...options } = {}) {
    const r = await this.fetch(url, {
      ...options,
      redirect: "error",
      headers: {
        "User-Agent": UA,
        Referer: "https://www.bilibili.com/",
        ...(credential
          ? {
              Cookie: `SESSDATA=${credential.sessdata}; bili_jct=${credential.bili_jct}; buvid3=${credential.buvid3 || ""}; DedeUserID=${credential.dedeuserid || ""}`,
            }
          : {}),
      },
      signal: AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(20000),
      ]),
    });
    if (!r.ok)
      throw new BiliError(`B站请求 HTTP ${r.status}`, { definitive: true });
    const data = await r.json();
    if (data.code !== undefined && data.code !== 0)
      throw new BiliError(`B站返回 ${data.code}，请检查账号或稍后重试`, {
        definitive: true,
      });
    return { data: data.data ?? data, response: r };
  }
  async loginStart(signal) {
    const { data } = await this.json(
      "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
      { signal },
    );
    if (!data.qrcode_key || !data.url) throw new Error("生成登录二维码失败");
    this.qr = {
      key: data.qrcode_key,
      url: data.url,
      expires: Date.now() + 180000,
    };
    let image = "";
    if (this.runtime.status().installed)
      image = (await this.runtime.request("qr", { url: data.url }, { signal }))
        .image;
    return { key: this.qr.key, url: data.url, image, expires: this.qr.expires };
  }
  async loginPoll(key, signal) {
    if (!this.qr || key !== this.qr.key || Date.now() > this.qr.expires)
      return { state: "expired" };
    const { data, response } = await this.json(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`,
      { signal },
    );
    if (!this.qr || key !== this.qr.key) return { state: "expired" };
    if (data.code !== 0)
      return {
        state:
          { 86101: "waiting", 86090: "scanned", 86038: "expired" }[data.code] ||
          "waiting",
      };
    const cred = {};
    const keys = {
      SESSDATA: "sessdata",
      bili_jct: "bili_jct",
      buvid3: "buvid3",
      DedeUserID: "dedeuserid",
    };
    for (const cookie of response.headers.getSetCookie()) {
      const first = cookie.split(";")[0],
        at = first.indexOf("="),
        name = first.slice(0, at);
      if (keys[name]) cred[keys[name]] = first.slice(at + 1);
    }
    if (!cred.sessdata || !cred.bili_jct)
      throw new Error("二维码已确认但凭据不完整，请重新扫码");
    if (!cred.buvid3) {
      try {
        const { data: fingerprint } = await this.json("https://api.bilibili.com/x/frontend/finger/spi", { signal });
        cred.buvid3 = String(fingerprint.b_3 || "");
      } catch { /* 指纹服务暂不可用时仍保留已取得的有效登录凭据。 */ }
    }
    if (!this.qr || key !== this.qr.key || signal?.aborted) return { state: "expired" };
    await this.secrets.set(credentialKey, JSON.stringify(cred));
    this.qr = null;
    this.runtime.stopWorker();
    return { state: "ok", account: await this.account(signal) };
  }
  async logout() {
    this.qr = null;
    this.runtime.stopWorker();
    await this.secrets.delete(credentialKey);
  }
  async account(signal) {
    if (!(await this.loggedIn())) return { loggedIn: false };
    const credential = await this.credentials();
    const { data } = await this.json(
      "https://api.bilibili.com/x/web-interface/nav",
      { credential, signal },
    );
    return {
      loggedIn: Boolean(data.isLogin),
      uid: String(data.mid || ""),
      name: String(data.uname || ""),
      avatar: String(data.face || ""),
    };
  }
  async call(name, args = {}, options = {}) {
    const result = await this.runtime.request(name, args, options);
    if (!result || typeof result !== "object")
      throw new BiliError("B站没有返回可核对的结果");
    if (result?.error || result?.ok === false || result?.success === false)
      throw new BiliError(
        String(result.error || result.message || "B站未确认操作成功").slice(
          0,
          500,
        ),
        { definitive: true },
      );
    return result;
  }
  async search(keyword, options) {
    const r = await this.call(
      "bili_search",
      { keyword: String(keyword).slice(0, 100), num: 10, order: "pubdate" },
      options,
    );
    return (Array.isArray(r) ? r : (r.videos ?? [])).slice(0, 10).map((v) => ({
      ...v,
      bvid: videoId(v.bvid),
      title: String(v.title || ""),
      owner: String(v.author || v.owner || ""),
      cover: String(v.pic || v.cover || ""),
      duration: duration(v.duration),
      views: Number(v.play || v.views || 0),
    }));
  }
  info(bvid, options) {
    return this.call("video", { bvid: videoId(bvid) }, options);
  }
  subtitle(bvid, options) {
    return this.call("subtitle", { bvid: videoId(bvid) }, options);
  }
  transcribe(bvid, model, options) {
    if (!this.runtime.status().asr)
      throw new Error("请先在设置中安装所选转写模型");
    return this.call(
      "transcribe",
      { bvid: videoId(bvid), model },
      { ...options, timeout: 600000 },
    );
  }
}
export function duration(value) {
  if (typeof value === "number") return value;
  const parts = String(value ?? "")
    .split(":")
    .map(Number);
  return parts.every(Number.isFinite)
    ? parts.reduce((n, v) => n * 60 + v, 0)
    : 0;
}
