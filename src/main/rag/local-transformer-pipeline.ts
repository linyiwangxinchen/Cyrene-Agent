import * as path from "node:path";

// The module is ESM-only. Desktop and headless entry points are both CommonJS.
const importEsm = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<typeof import("@xenova/transformers")>;
let loading: Promise<unknown> = Promise.resolve();

export function loadLocalTransformerPipeline(task: "feature-extraction" | "text-classification", modelDir: string): Promise<any> {
  // Transformers.js v2 shares a mutable directory and cache settings across pipelines.
  const result = loading.then(async () => {
    const { pipeline, env } = await importEsm("@xenova/transformers");
    const original = {
      localModelPath: env.localModelPath, allowLocalModels: env.allowLocalModels, allowRemoteModels: env.allowRemoteModels,
      useFSCache: env.useFSCache, useBrowserCache: env.useBrowserCache, useCustomCache: env.useCustomCache,
    };
    try {
      Object.assign(env, { localModelPath: path.dirname(modelDir), allowLocalModels: true, allowRemoteModels: false,
        useFSCache: false, useBrowserCache: false, useCustomCache: false });
      return await pipeline(task, path.basename(modelDir), { local_files_only: true, quantized: true });
    } finally {
      Object.assign(env, original);
    }
  });
  loading = result.catch(() => undefined);
  return result;
}
