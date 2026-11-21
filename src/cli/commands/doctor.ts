/**
 * cyrene doctor — check the local environment and print ✓ / ! / ✗ per item.
 *
 * Secrets are never printed: model API keys and WeChat bot tokens are only
 * reported as present or missing. Any ✗ makes the exit code 1; ! is advisory.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveDesktopDataDir, resolveWebDataDir } from "../config/config.js";
import { findSession, isLoopbackHost, resolveServer } from "../remote/credentials.js";
import { checkSession, probe } from "../remote/web-client.js";
import { boolFlag, parseFlags, stringFlag, UsageError, type ParsedFlags } from "../util/flags.js";
import { outLine } from "../util/log.js";
import { EXIT, reportError } from "./common.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface DoctorOptions {
  target: "desktop" | "web";
  dataDir: string;
  server: string;
  /** The server came from a flag, CYRENE_SERVER or a saved login; unreachable is then an error. */
  serverExplicit: boolean;
  nodeVersion?: string;
}

const DOCTOR_FLAGS = { target: "string", "data-dir": "string", server: "string", json: "boolean", help: "boolean" } as const;
const REQUIRED_NODE_MAJOR = 24;

export function doctorHelp(): string {
  return `Usage: cyrene doctor [--target auto|desktop|web] [--data-dir DIR] [--server URL] [--json]

Checks Node.js, the data directory, the default model profile and its API key,
node:sqlite, WeChat channel settings, and the Web service (/healthz, /readyz).
Secrets are reported only as configured or missing. Exits 1 when any check fails.`;
}

function readJson(file: string): Record<string, unknown> | null | "corrupt" {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : "corrupt";
  } catch {
    return "corrupt";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function checkNode(version = process.versions.node): CheckResult {
  const major = Number(version.split(".")[0]);
  return major >= REQUIRED_NODE_MAJOR
    ? { id: "node", label: "Node.js", status: "ok", detail: `v${version}` }
    : { id: "node", label: "Node.js", status: "fail", detail: `v${version}，需要 ${REQUIRED_NODE_MAJOR} 或更高`, hint: `安装 Node.js ${REQUIRED_NODE_MAJOR}（与 package.json engines 一致）` };
}

export function checkDataDir(dataDir: string): CheckResult {
  const label = "数据目录";
  if (!fs.existsSync(dataDir)) {
    let parent = path.dirname(dataDir);
    while (!fs.existsSync(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent);
    try {
      fs.accessSync(parent, fs.constants.W_OK);
      return { id: "data-dir", label, status: "warn", detail: `${dataDir} 尚不存在，首次启动或 cyrene config apply 时会创建` };
    } catch {
      return { id: "data-dir", label, status: "fail", detail: `${dataDir} 不存在且无法在 ${parent} 下创建`, hint: "用 --data-dir 指向有写权限的目录，或修正目录权限" };
    }
  }
  const probeFile = path.join(dataDir, `.cyrene-doctor-${process.pid}.tmp`);
  try {
    fs.writeFileSync(probeFile, "ok", { mode: 0o600 });
    fs.unlinkSync(probeFile);
    return { id: "data-dir", label, status: "ok", detail: `${dataDir} 可写` };
  } catch (error) {
    return { id: "data-dir", label, status: "fail", detail: `${dataDir} 不可写：${error instanceof Error ? error.message : String(error)}`, hint: "修正目录所有者/权限，Linux 上确认与 Web 服务使用同一账号" };
  }
}

interface ProfileView { id?: unknown; provider?: unknown; model?: unknown; baseUrl?: unknown; apiKey?: unknown }

/** Model settings: model-settings.json (desktop and migrated Web), falling back to legacy web-data.json. */
export function checkModel(dataDir: string): CheckResult[] {
  const label = "模型配置";
  const hint = "运行 cyrene config apply --provider ... --base-url ... --model ... --api-key-env 环境变量名，或在设置页添加模型档案";
  const modelSettings = readJson(path.join(dataDir, "model-settings.json"));
  const webData = modelSettings ? null : readJson(path.join(dataDir, "web-data.json"));
  if (modelSettings === "corrupt" || webData === "corrupt") {
    return [{ id: "model", label, status: "fail", detail: "模型配置文件无法解析", hint: "检查 model-settings.json / web-data.json 是否为有效 JSON（可从 backups 目录恢复）" }];
  }
  const settings = modelSettings ?? record(webData?.settings);
  const profiles = (Array.isArray(settings.modelProfiles) ? settings.modelProfiles : []).map(record) as ProfileView[];
  const defaultId = typeof settings.defaultModelProfileId === "string" ? settings.defaultModelProfileId : undefined;
  let profile: ProfileView | undefined = profiles.find((item) => item.id === defaultId);
  if (!profile && !profiles.length && nonEmpty(settings.model) && nonEmpty(settings.baseUrl)) {
    profile = { id: "(旧版单模型配置)", provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl, apiKey: settings.apiKey };
  }
  if (!profile) {
    const detail = profiles.length ? `有 ${profiles.length} 个档案，但默认档案 ${defaultId ?? "(未设置)"} 不存在` : "没有模型档案";
    return [{ id: "model", label, status: "fail", detail, hint }];
  }
  const results: CheckResult[] = [{
    id: "model", label, status: "ok",
    detail: `默认档案 ${String(profile.id)}（${String(profile.provider ?? "-")} / ${String(profile.model ?? "-")}）`,
  }];
  const perProvider = record(record(settings.perProvider)[String(profile.provider ?? "")]);
  const hasKey = nonEmpty(profile.apiKey) || nonEmpty(perProvider.apiKey);
  let local = false;
  try { local = typeof profile.baseUrl === "string" && isLoopbackHost(new URL(profile.baseUrl).hostname); } catch { /* invalid URL is reported below */ }
  if (hasKey) results.push({ id: "model-api-key", label: "模型 apiKey", status: "ok", detail: "已配置（不显示内容）" });
  else if (local) results.push({ id: "model-api-key", label: "模型 apiKey", status: "ok", detail: "未配置；默认档案指向本机模型服务，可不需要" });
  else results.push({ id: "model-api-key", label: "模型 apiKey", status: "fail", detail: "默认档案没有 apiKey", hint: "设置环境变量后运行 cyrene config apply --api-key-env 变量名，或在设置页填写" });
  return results;
}

export async function checkSqlite(): Promise<CheckResult> {
  try {
    const sqlite = await import("node:sqlite");
    const database = new sqlite.DatabaseSync(":memory:");
    const row = database.prepare("select 1 as ok").get() as { ok?: number } | undefined;
    database.close();
    if (row?.ok !== 1) throw new Error("查询结果异常");
    return { id: "sqlite", label: "SQLite", status: "ok", detail: "node:sqlite 可用" };
  } catch (error) {
    return { id: "sqlite", label: "SQLite", status: "fail", detail: `node:sqlite 不可用：${error instanceof Error ? error.message : String(error)}`, hint: `会话存储依赖 Node.js ${REQUIRED_NODE_MAJOR} 内置的 node:sqlite，请升级 Node.js` };
  }
}

export function checkWechat(dataDir: string): CheckResult {
  const label = "微信渠道";
  const channels = readJson(path.join(dataDir, "channels-settings.json"));
  const features = channels ? null : readJson(path.join(dataDir, "web-features.json"));
  if (channels === "corrupt" || features === "corrupt") {
    return { id: "wechat", label, status: "fail", detail: "渠道配置文件无法解析", hint: "检查 channels-settings.json / web-features.json 是否为有效 JSON" };
  }
  const wechat = record(channels ? channels.wechat : record(features?.channels).wechat);
  if (wechat.enabled !== true) return { id: "wechat", label, status: "ok", detail: "未启用（跳过）" };
  const credentials = readJson(path.join(dataDir, "weixin", "credentials.json"));
  if (credentials === "corrupt") return { id: "wechat", label, status: "fail", detail: "已启用，但 weixin/credentials.json 无法解析", hint: "在设置页重新扫码登录微信" };
  if (!credentials || !nonEmpty(credentials.botToken) || !nonEmpty(credentials.ilinkBotId)) {
    return { id: "wechat", label, status: "fail", detail: "已启用，但缺少 iLink 凭据", hint: "在设置页扫码登录微信，或运行 cyrene config apply --wechat-credentials-file 凭据文件" };
  }
  const allowed = Array.isArray(wechat.allowedUserIds) ? wechat.allowedUserIds.length : 0;
  return { id: "wechat", label, status: "ok", detail: `已启用，凭据已配置（不显示 token），白名单 ${allowed} 人` };
}

export async function checkWebService(server: string, explicit: boolean): Promise<CheckResult[]> {
  const label = "Web 服务";
  const health = await probe(`${server}/healthz`);
  if (!health.reachable || health.status !== 200 || health.body?.service !== "cyrene-web") {
    const detail = health.reachable ? `${server}/healthz 返回 HTTP ${health.status}，不是 Cyrene Web 服务` : `${server} 不可达`;
    return explicit
      ? [{ id: "web", label, status: "fail", detail, hint: "确认服务已启动（systemctl status cyrene-web 或 node dist/server/server/index.js），以及地址和端口" }]
      : [{ id: "web", label, status: "warn", detail: `${detail}（未指定 --server，按本机默认地址检查；只用桌面端可忽略）` }];
  }
  const results: CheckResult[] = [];
  if (health.body?.initialized === false) {
    results.push({ id: "web", label, status: "warn", detail: `${server} 可达，但尚未创建管理员账号`, hint: "在浏览器打开该地址，用服务日志中的一次性初始化令牌完成初始化" });
  } else {
    results.push({ id: "web", label, status: "ok", detail: `${server} 可达` });
  }
  const ready = await probe(`${server}/readyz`);
  if (ready.status === 200 && ready.body?.ready === true) results.push({ id: "web-ready", label: "Web 核心就绪", status: "ok", detail: "/readyz 正常" });
  else results.push({ id: "web-ready", label: "Web 核心就绪", status: "fail", detail: `/readyz ${ready.reachable ? `返回 HTTP ${ready.status}` : "不可达"}`, hint: "共享核心未启动或已崩溃：查看服务日志，确认已运行 corepack pnpm run build:server" });
  const saved = findSession(server);
  if (saved) {
    try {
      const username = await checkSession(server, saved.sessionToken);
      results.push(username === null
        ? { id: "web-login", label: "登录会话", status: "warn", detail: `${server} 的已保存会话已过期`, hint: `运行 cyrene login --server ${server}` }
        : { id: "web-login", label: "登录会话", status: "ok", detail: `已登录（${username || saved.username}）` });
    } catch (error) {
      results.push({ id: "web-login", label: "登录会话", status: "warn", detail: error instanceof Error ? error.message : String(error) });
    }
  } else {
    results.push({ id: "web-login", label: "登录会话", status: "warn", detail: "未保存登录会话；exec/resume 需要先 cyrene login 或设置 CYRENE_USERNAME/CYRENE_PASSWORD" });
  }
  return results;
}

export async function runDoctorChecks(options: DoctorOptions): Promise<CheckResult[]> {
  return [
    checkNode(options.nodeVersion),
    { id: "target", label: "检查目标", status: "ok", detail: `${options.target === "web" ? "Web 端" : "桌面端"}数据（${options.dataDir}）` },
    checkDataDir(options.dataDir),
    ...checkModel(options.dataDir),
    await checkSqlite(),
    checkWechat(options.dataDir),
    ...await checkWebService(options.server, options.serverExplicit),
  ];
}

function resolveTarget(flag: string | undefined, dataDirFlag: string | undefined): { target: "desktop" | "web"; dataDir: string } {
  if (flag !== undefined && !["auto", "desktop", "web"].includes(flag)) throw new UsageError("--target 只能是 auto、desktop 或 web");
  if (flag === "desktop") return { target: "desktop", dataDir: resolveDesktopDataDir(dataDirFlag) };
  if (flag === "web") return { target: "web", dataDir: resolveWebDataDir(dataDirFlag) };
  // auto: an explicit directory or CYRENE_DATA_DIR means Web; otherwise prefer whichever exists.
  if (dataDirFlag || process.env.CYRENE_DATA_DIR) return { target: "web", dataDir: resolveWebDataDir(dataDirFlag) };
  const desktop = resolveDesktopDataDir();
  const web = resolveWebDataDir();
  if (fs.existsSync(desktop)) return { target: "desktop", dataDir: desktop };
  if (fs.existsSync(web)) return { target: "web", dataDir: web };
  return process.platform === "linux" ? { target: "web", dataDir: web } : { target: "desktop", dataDir: desktop };
}

const SYMBOL: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

export async function cmdDoctor(args: readonly string[]): Promise<number> {
  let parsed: ParsedFlags;
  try {
    parsed = parseFlags(args, DOCTOR_FLAGS, { "-h": "--help" });
    if (parsed.positionals.length) throw new UsageError(`多余的参数：${parsed.positionals.join(" ")}`);
  } catch (error) {
    return reportError("doctor", error);
  }
  if (boolFlag(parsed, "help")) { outLine(doctorHelp()); return EXIT.OK; }
  try {
    const { target, dataDir } = resolveTarget(stringFlag(parsed, "target"), stringFlag(parsed, "data-dir"));
    const { server, explicit } = resolveServer(stringFlag(parsed, "server"));
    const results = await runDoctorChecks({ target, dataDir, server, serverExplicit: explicit });
    const failed = results.some((item) => item.status === "fail");
    if (boolFlag(parsed, "json")) {
      outLine(JSON.stringify({ ok: !failed, checks: results }));
    } else {
      for (const item of results) {
        outLine(`${SYMBOL[item.status]} ${item.label}：${item.detail}`);
        if (item.hint && item.status !== "ok") outLine(`    修复：${item.hint}`);
      }
      const failures = results.filter((item) => item.status === "fail").length;
      outLine(failed ? `\n${failures} 项检查未通过。` : "\n检查通过。");
    }
    return failed ? EXIT.FAILED : EXIT.OK;
  } catch (error) {
    return reportError("doctor", error);
  }
}
