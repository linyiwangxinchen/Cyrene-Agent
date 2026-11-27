import type { TextClassificationPipeline } from "@xenova/transformers";
import { open } from "node:fs/promises";
import path from "node:path";
import { getMemoryModeVersion, isVectorMemoryEnabled } from "../memory/memory-mode";
import { loadLocalTransformerPipeline } from "./local-transformer-pipeline";
import { getModelInstallStatusDetail } from "./model-status";

export interface RerankerProvider {
  rerank(query: string, documents: string[]): Promise<Array<{ text: string; score: number }>>;
  readonly name: string;
}

export type RerankerRuntimeStatus = "disabled" | "missingModel" | "loading" | "ready" | "loadFailed";

type RerankerPipeline = Pick<TextClassificationPipeline, "tokenizer" | "model" | "dispose">;
interface LoadedReranker {
  provider: RerankerProvider;
  retire(): void;
}

function createReranker(pipeline: RerankerPipeline, isCurrent: () => boolean): LoadedReranker {
  let retired = false;
  let active = 0;

  function disposeIfInactive() {
    if (retired && !active) {
      void pipeline.dispose().catch(error => console.warn("[Reranker] model disposal failed:", error));
    }
  }

  return {
    provider: {
      name: "bge-reranker-base",
      async rerank(query, documents) {
        if (!documents.length) return [];
        if (retired || !isCurrent()) throw new Error("重排模型已停用");
        active += 1;
        try {
          // The text classification pipeline neither takes text_pair nor uses
          // sigmoid for the single logit returned by BGE.
          const inputs = pipeline.tokenizer(documents.map(() => query), {
            text_pair: documents, padding: true, truncation: true,
          });
          const { logits } = await pipeline.model(inputs);
          if (retired || !isCurrent()) throw new Error("重排模型已停用");
          if (logits?.dims.length !== 2 || logits.dims[0] !== documents.length || logits.dims[1] !== 1
            || logits.data.length !== documents.length) throw new Error("重排模型没有为每个句对返回一个分数");
          const scores = Array.from(logits.data as Float32Array);
          if (scores.some(score => !Number.isFinite(score))) throw new Error("重排模型返回了非有限分数");
          return documents.map((text, index) => ({ text, score: 1 / (1 + Math.exp(-scores[index])) }))
            .sort((first, second) => second.score - first.score);
        } finally {
          active -= 1;
          disposeIfInactive();
        }
      },
    },
    retire() {
      if (retired) return;
      retired = true;
      disposeIfInactive();
    },
  };
}

function findModelDirectory(): string | null {
  return getModelInstallStatusDetail("reranker", "standard").matchedAt;
}

async function loadAndVerify(modelDirectory: string, isCurrent: () => boolean): Promise<LoadedReranker> {
  // Reject common failed downloads before handing the file to native ONNX.
  // The supported Xenova model starts with ModelProto's ir_version field.
  const weights = await open(path.join(modelDirectory, "onnx", "model_quantized.onnx"), "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await weights.read(header);
    if (bytesRead !== header.length || header[0] !== 0x08 || header[1] === 0) {
      throw new Error("BGE 重排模型权重文件不是有效的 ONNX 模型");
    }
  } finally {
    await weights.close();
  }
  if (!isCurrent()) throw new Error("重排模型已停用");
  const pipeline: RerankerPipeline = await loadLocalTransformerPipeline("text-classification", modelDirectory);
  const reranker = createReranker(pipeline, isCurrent);
  try {
    await reranker.provider.rerank("哪颗星球被称为红色星球？", ["火星是太阳系的一颗行星。"]);
    return reranker;
  } catch (error) {
    reranker.retire();
    throw error;
  }
}

export async function createStandardReranker(): Promise<RerankerProvider> {
  const modelDirectory = findModelDirectory();
  if (!modelDirectory) throw new Error("未安装本地 BGE 重排模型");
  return (await loadAndVerify(modelDirectory, () => true)).provider;
}

let running: { modelDirectory: string; version: number; reranker: LoadedReranker } | null = null;
let pending: { modelDirectory: string; version: number; promise: Promise<boolean> } | null = null;
let generation = 0;
let status: RerankerRuntimeStatus = "disabled";
let statusVersion = 0;

export function getRerankerInstallStatus(): { standard: boolean } {
  return { standard: Boolean(findModelDirectory()) };
}

export async function initReranker(mode: "standard" | "none"): Promise<boolean> {
  if (mode === "none" || !isVectorMemoryEnabled()) {
    resetReranker();
    return false;
  }
  const version = getMemoryModeVersion();
  const modelDirectory = findModelDirectory();
  if (modelDirectory && running?.version === version && running.modelDirectory === modelDirectory) return true;
  if (modelDirectory && pending?.version === version && pending.modelDirectory === modelDirectory) return pending.promise;

  resetReranker();
  statusVersion = version;
  if (!modelDirectory) {
    status = "missingModel";
    return false;
  }
  status = "loading";
  const request = generation;
  const isCurrent = () => request === generation && version === getMemoryModeVersion() && isVectorMemoryEnabled();
  const promise = (async () => {
    try {
      const reranker = await loadAndVerify(modelDirectory, isCurrent);
      if (!isCurrent()) {
        reranker.retire();
        return false;
      }
      running = { modelDirectory, version, reranker };
      status = "ready";
      return true;
    } catch (error) {
      if (isCurrent()) {
        status = "loadFailed";
        console.warn("[Reranker] model could not run:", error);
      }
      return false;
    } finally {
      if (request === generation) pending = null;
    }
  })();
  pending = { modelDirectory, version, promise };
  return promise;
}

export function getRerankerRuntimeStatus(): RerankerRuntimeStatus {
  return isVectorMemoryEnabled() && statusVersion === getMemoryModeVersion() ? status : "disabled";
}

export function isRerankerReady(): boolean {
  return getRerankerRuntimeStatus() === "ready";
}

export function getReranker(): RerankerProvider | null {
  return isRerankerReady() ? running?.reranker.provider ?? null : null;
}

export function getRerankerMode(): "standard" | "none" {
  return isRerankerReady() ? "standard" : "none";
}

export function resetReranker(): void {
  generation += 1;
  running?.reranker.retire();
  running = null;
  pending = null;
  status = "disabled";
  statusVersion = getMemoryModeVersion();
}
