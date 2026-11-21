/**
 * Pick and open a CoreTransport for exec/resume.
 *
 * Web mode credential order: the session saved by `cyrene login` for this
 * server, then CYRENE_USERNAME + CYRENE_PASSWORD. A session obtained from
 * environment variables is used for this process only and logged out on
 * close, so scripted runs do not pile up server sessions. Passwords are never
 * accepted as command-line arguments.
 */
import path from "node:path";
import { resolveWebDataDir } from "../config/config.js";
import { findSession, isLoopbackHost, resolveServer, saveSession } from "./credentials.js";
import { defaultAppRoot, startLocalCore } from "./local-core.js";
import { AuthError, type CoreTransport } from "./transport.js";
import { connectWebCore, loginWithPassword, logoutSession } from "./web-client.js";

export interface ConnectOptions {
  server?: string;
  local?: boolean;
  dataDir?: string;
  appRoot?: string;
  verbose?: boolean;
}

export async function openTransport(options: ConnectOptions): Promise<CoreTransport> {
  if (options.local) {
    const dataDir = path.resolve(options.dataDir ?? resolveWebDataDir());
    const appRoot = options.appRoot ? path.resolve(options.appRoot) : defaultAppRoot();
    return startLocalCore({ dataDir, appRoot, verbose: options.verbose });
  }
  if (options.dataDir || options.appRoot) throw new AuthError("--data-dir / --app-root 只能与 --local 一起使用");
  const { server } = resolveServer(options.server);
  const remote = !isLoopbackHost(new URL(server).hostname);
  const saved = findSession(server);
  const username = process.env.CYRENE_USERNAME;
  const password = process.env.CYRENE_PASSWORD;
  const hasEnvCredentials = Boolean(username && password);

  if (saved) {
    try {
      return await connectWebCore(server, saved.sessionToken, { remote });
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      if (!hasEnvCredentials) throw new AuthError(`${server} 的登录已过期，请重新运行 cyrene login --server ${server}`);
    }
  }
  if (!hasEnvCredentials) {
    throw new AuthError(`尚未登录 ${server}：请先运行 cyrene login --server ${server}，或设置 CYRENE_USERNAME 与 CYRENE_PASSWORD`);
  }
  const token = await loginWithPassword(server, username!, password!);
  if (saved) {
    // Refresh the expired saved session instead of creating a throwaway one.
    saveSession({ server, username: username!, sessionToken: token, savedAt: new Date().toISOString() }, false);
    return connectWebCore(server, token, { remote });
  }
  const transport = await connectWebCore(server, token, { remote });
  const close = transport.close.bind(transport);
  transport.close = async () => {
    await close();
    await logoutSession(server, token).catch(() => {});
  };
  return transport;
}
