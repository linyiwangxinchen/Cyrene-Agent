import { createRequire } from "node:module";
import { inspect } from "node:util";
import type { Jieba } from "@node-rs/jieba";
import { logger } from "../shared/logger";

// 原生模块保持外置，只在调用方的降级保护内按需加载。
const requireNative = createRequire(__filename);
let instance: Jieba | undefined;
let generation = 0;

/** 初始化成功后失效此前产生的降级分词缓存；读取版本不会触发加载。 */
export function getSearchJiebaGeneration(): number {
  return generation;
}

export function getSearchJieba(): Jieba {
  if (instance) return instance;
  // 未成功初始化时，每次调用只尝试一次；失败交给调用方立即降级，不等待重试。
  try {
    const { Jieba: NativeJieba } = requireNative("@node-rs/jieba") as typeof import("@node-rs/jieba");
    instance = new NativeJieba();
    generation++;
    return instance;
  } catch (error) {
    // 原生加载器可能把底层错误数组挂在 cause 上；保留 code/stack，
    // 同时用 inspect 安全处理嵌套或循环引用，避免 JSON 序列化丢失诊断。
    logger.warn(
      "Search",
      "@node-rs/jieba initialization failed; using fallback tokenization (Chinese retrieval quality may be reduced).",
      inspect(error, { depth: null }),
    );
    throw error;
  }
}

/** 在初始化恢复的同一批检索中统一词元；不重试持续失败或 cut/tag 错误。 */
export function tokenizeSearchBatch<Q, D>(
  tokenizeQuery: () => Q,
  tokenizeDocuments: () => D,
): { queryTokens: Q; documents: D } {
  let queryTokens = tokenizeQuery();
  const generation = getSearchJiebaGeneration();
  let documents = tokenizeDocuments();
  if (generation !== getSearchJiebaGeneration()) {
    // 某篇文档分词时才恢复：查询和此前文档也切换到原生词元。
    // 成功实例始终复用，generation 只转换一次，无需重试循环。
    queryTokens = tokenizeQuery();
    documents = tokenizeDocuments();
  }
  return { queryTokens, documents };
}
