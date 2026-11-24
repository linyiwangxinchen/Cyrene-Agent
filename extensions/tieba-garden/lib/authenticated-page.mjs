import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { normalizeCookie } from "./session.mjs";

const MAX_BODY_BYTES = 4_000_000;
const RESPONSE_TRAILER = "\n__CYRENE_TIEBA_HTTP__:";
const MOBILE_USER_AGENT = "Mozilla/5.0 (Linux; Android 13; V2425A) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const ORIGIN = "https://tieba.baidu.com";
export const REPLY_PATH = "/f/commit/post/add";
const transferArgs = [
  "--disable", "--silent", "--show-error", "--globoff", "--proto", "=https",
  "--connect-timeout", "8", "--max-time", "25", "--max-filesize", String(MAX_BODY_BYTES),
];

export function initialJar(cookie) {
  const cookies = cookie.split(/;\s*/);
  const bduss = cookies.find(pair => pair.startsWith("BDUSS="));
  return (bduss ? [bduss] : cookies).map(pair => {
    const separator = pair.indexOf("=");
    return ".baidu.com\tTRUE\t/\tFALSE\t4102444800\t" + pair.slice(0, separator) + "\t" + pair.slice(separator + 1);
  }).join("\n") + "\n";
}

export function authenticatedPage(url, signal, jar, run = execFile) {
  if (url.origin !== ORIGIN || url.username || url.password) throw new Error("Invalid Tieba destination");
  const postId = url.searchParams.get("kz") || url.searchParams.get("tid");
  const referer = /^\d{1,20}$/.test(postId ?? "") ? ORIGIN + "/p/" + postId : ORIGIN + "/";
  const args = [
    ...transferArgs,
    ...(url.pathname === "/dc/common/tbs" ? [] : ["--user-agent", MOBILE_USER_AGENT]),
    "--header", "Accept-Language: zh-CN,zh;q=0.9",
    "--referer", referer, "--cookie", "-", "--cookie-jar", "-",
  ];
  return transfer(url, signal, args, jar, run);
}

export function replyCookie(jar) {
  const pairs = [];
  for (const line of jar.split(/\r?\n/)) {
    const [domain, subdomains, path, , expiry, name, value] = line.replace(/^#HttpOnly_/, "").split("\t");
    const host = domain.replace(/^\./, "").toLowerCase();
    const firstParty = host === "tieba.baidu.com" || (host === "baidu.com" && subdomains === "TRUE");
    const matchingPath = path === REPLY_PATH || REPLY_PATH.startsWith(path?.endsWith("/") ? path : path + "/");
    if (firstParty && path?.startsWith("/") && matchingPath && /^\d+$/.test(expiry ?? "") &&
        (expiry === "0" || Number(expiry) * 1000 > Date.now()) && name && value !== undefined) {
      try { pairs.push(normalizeCookie(name + "=" + value)); } catch { /* Ignore malformed Set-Cookie entries. */ }
    }
  }
  return normalizeCookie(pairs.join("; "));
}

export function authenticatedPost(url, signal, cookie, form, threadId, run = execFile) {
  if (url.href !== ORIGIN + REPLY_PATH || !/^\d{1,20}$/.test(threadId) || form.get("tid") !== threadId) {
    throw new Error("Invalid Tieba reply destination");
  }
  // Both secrets and the user message are sent through stdin, outside the process arguments.
  const config = "header = " + JSON.stringify("Cookie: " + normalizeCookie(cookie)) + "\n" +
    "data-binary = " + JSON.stringify(form.toString()) + "\n";
  const args = [
    ...transferArgs, "--config", "-", "--request", "POST",
    "--header", "Origin: " + ORIGIN,
    "--header", "Accept: application/json",
    "--header", "Content-Type: application/x-www-form-urlencoded",
    "--referer", ORIGIN + "/p/" + threadId,
  ];
  return transfer(url, signal, args, config, run);
}

function transfer(url, signal, args, input, run) {
  const requestArgs = [
    ...args,
    "--write-out", RESPONSE_TRAILER + "%{http_code}\n%{content_type}\n",
    "--url", url.href,
  ];
  const binary = process.platform === "win32"
    ? win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "curl.exe") : "curl";
  return new Promise((resolve, reject) => {
    const child = run(binary, requestArgs, {
      signal, windowsHide: true, encoding: "buffer", maxBuffer: MAX_BODY_BYTES + 4096,
    }, (error, stdout) => {
      if (error) {
        reject(Object.assign(new Error("Tieba request failed"), { code: error.code }));
        return;
      }
      // curl writes the status and Content-Type after the raw page bytes.
      const offset = stdout.lastIndexOf(RESPONSE_TRAILER);
      if (offset === -1) {
        reject(new Error("Missing Tieba HTTP status"));
        return;
      }
      const [status, declared, ...cookies] = stdout.subarray(offset + RESPONSE_TRAILER.length).toString().split("\n");
      resolve({ status: Number(status), buffer: stdout.subarray(0, offset), declared, jar: cookies.join("\n") });
    });
    child.stdin?.on("error", () => { /* The process callback handles launch and transfer errors. */ });
    child.stdin?.end(input);
  });
}
