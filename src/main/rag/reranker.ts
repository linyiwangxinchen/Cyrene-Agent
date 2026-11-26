// Reranker module — cross-encoder reranking for RAG
// 只支持 bge-reranker-base，不再提供 light 版本
import { getModelInstallStatusDetail } from "./model-status";
import { loadLocalTransformerPipeline } from "./local-transformer-pipeline";

// ── Types ──
export interface RerankerProvider {
  rerank(query: string, documents: string[]): Promise<Array<{ text: string; score: number }>>;
  readonly name: string;
}

// ── Pipeline cache ──
let standardPipeline: any = null;

async function loadRerankerPipeline(modelDir: string): Promise<any> {
  const modelsDir = getModelInstallStatusDetail("reranker", "standard").matchedAt;
  if (!modelsDir) throw new Error("Local reranker model is not installed");
  const pipe = await loadLocalTransformerPipeline("text-classification", modelsDir);
  console.log(`[Reranker] pipeline "${modelDir}" loaded OK`);
  return pipe;
}

// ── Standard reranker (bge-reranker-base, ~279MB) ──
export async function createStandardReranker(): Promise<RerankerProvider> {
  if (!standardPipeline) {
    standardPipeline = await loadRerankerPipeline("bge-reranker-base");
  }

  return {
    name: "bge-reranker-base",

    async rerank(query: string, documents: string[]): Promise<Array<{ text: string; score: number }>> {
      if (documents.length === 0) return [];
      if (!standardPipeline) throw new Error("Standard reranker not initialized");

      const start = Date.now();

      const inputs = documents.map((doc) => [query, doc]);
      const outputs = await standardPipeline(inputs);

      const results = documents.map((text, i) => ({
        text,
        score: outputs[i]?.score ?? 0,
      }));

      results.sort((a, b) => b.score - a.score);

      console.log(`[Reranker] standard: ${documents.length} docs reranked in ${Date.now() - start}ms`);
      return results;
    },
  };
}

// ── Reranker manager ──
let currentReranker: RerankerProvider | null = null;
let currentRerankerMode: "standard" | "none" = "none";

function checkRerankerModelInstalled(): boolean {
  return getModelInstallStatusDetail("reranker", "standard").installed;
}

export function getRerankerInstallStatus(): { standard: boolean } {
  return { standard: checkRerankerModelInstalled() };
}

export async function initReranker(mode: "standard" | "none"): Promise<void> {
  currentRerankerMode = mode;

  if (mode === "none") {
    currentReranker = null;
    console.log("[Reranker] disabled");
    return;
  }

  if (!checkRerankerModelInstalled()) {
    console.warn(`[Reranker] bge-reranker-base 未找到 (models/bge-reranker-base/onnx/model_quantized.onnx)，自动降级为 none。`);
    currentRerankerMode = "none";
    currentReranker = null;
    return;
  }

  console.log("[Reranker] initializing standard mode (bge-reranker-base)...");
  currentReranker = await createStandardReranker();
  console.log(`[Reranker] standard mode ready: ${currentReranker.name}`);
}

export function getReranker(): RerankerProvider | null {
  return currentReranker;
}

export function getRerankerMode(): "standard" | "none" {
  return currentRerankerMode;
}

export function resetReranker(): void {
  currentReranker = null;
  currentRerankerMode = "none";
  standardPipeline = null;
}
