import * as fs from "fs";
import * as path from "path";
import { BUILT_IN_STICKER_DESCRIPTIONS } from "./sticker-descriptions";
import { buildStickerTextIndex, type StickerTextEntry } from "./sticker-text-matcher-core";
export * from "./sticker-text-matcher-core";
import { loadUserStickerManifest } from "./sticker-storage";

export function loadStickerTextIndex(): StickerTextEntry[] {
  return buildStickerTextIndex(BUILT_IN_STICKER_DESCRIPTIONS, loadUserStickerManifest());
}

/** 清除旧版生成的贴纸向量缓存；贴纸图片和用户清单不受影响。 */
export function clearLegacyStickerEmbeddingCache(userDataDir: string): void {
  for (const filePath of [
    path.join(userDataDir, "sticker-embedding-cache.json"),
    path.join(userDataDir, "sticker-embedding-cache.json.tmp"),
  ]) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch (error) {
      console.warn("[StickerTextMatcher] failed to remove legacy embedding cache:", filePath, error);
    }
  }
}
