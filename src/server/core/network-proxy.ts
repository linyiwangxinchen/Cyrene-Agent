import http from "node:http";
import { configureNodeRequestProxy, type NodeRequestProxyLogger } from "../../main/network/node-request-proxy";

/** Configure the worker before its model, channel and embedding services start.
 * Headless hosts use explicit environment proxies and have no Chromium session
 * from which to resolve a desktop proxy. The shared implementation preserves
 * local-model bypasses and redacts proxy credentials from diagnostics.
 */
export async function configureHeadlessRequestProxy(options: {
  env?: Record<string, string | undefined>;
  log?: NodeRequestProxyLogger;
} = {}): Promise<void> {
  await configureNodeRequestProxy({
    env: options.env ?? process.env,
    resolveProxy: async () => "DIRECT",
    setGlobalProxyFromEnv: (env) => http.setGlobalProxyFromEnv(env),
    log: options.log ?? {
      info: (message) => console.info(`[HeadlessCore] ${message}`),
      warn: (message) => console.warn(`[HeadlessCore] ${message}`),
    },
  });
}
