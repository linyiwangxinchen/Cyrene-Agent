import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { BUILT_IN_STICKER_IDS, type StickerConfigItem, type UserStickerMeta } from "../shared/sticker-types";
import { BUILT_IN_STICKER_DESCRIPTIONS, BUILT_IN_STICKER_FILES } from "../main/sticker-descriptions";
import { buildStickerTextIndex, matchSticker } from "../main/sticker-text-matcher-core";
import { buildStickerMatchQuery } from "../main/sticker-query";

interface MediaState { enabled: Record<string, boolean>; stickers: UserStickerMeta[]; avatars: Partial<Record<"cyrene" | "user", string>> }
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Validate bytes as well as the claimed MIME; no executable SVG/HTML uploads. */
export function decodeImage(dataUrl: string): { body: Buffer; extension: string; mime: string } {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match || match[2].length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4) throw new Error("请选择 PNG/JPEG/GIF/WebP 图片，大小不能超过 8 MB");
  const body = Buffer.from(match[2], "base64");
  const mime = body.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
    : body[0] === 255 && body[1] === 216 && body[2] === 255 ? "image/jpeg"
      : /^GIF8[79]a/.test(body.subarray(0, 6).toString()) ? "image/gif"
        : body.subarray(0, 4).toString() === "RIFF" && body.subarray(8, 12).toString() === "WEBP" ? "image/webp" : "";
  if (!body.length || body.length > MAX_IMAGE_BYTES || mime !== match[1]) throw new Error("图片格式或内容无效");
  return { body, mime, extension: ({ "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" } as Record<string, string>)[mime]! };
}

export class WebMediaStore {
  private data: MediaState = { enabled: {}, stickers: [], avatars: {} };
  private loadPromise?: Promise<void>;
  private writeChain: Promise<void> = Promise.resolve();
  constructor(private readonly dataDir: string) {}
  private get manifest() { return path.join(this.dataDir, "web-media.json"); }
  private get directory() { return path.join(this.dataDir, "web-media"); }
  private load(): Promise<void> {
    return this.loadPromise ??= (async () => {
      try { const saved = JSON.parse(await readFile(this.manifest, "utf8")); this.data = { enabled: saved.enabled ?? {}, stickers: saved.stickers ?? [], avatars: saved.avatars ?? {} }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    })();
  }
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${this.manifest}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 }); await rename(temporary, this.manifest);
    }); return this.writeChain;
  }
  async list(): Promise<StickerConfigItem[]> {
    await this.load();
    return [...BUILT_IN_STICKER_IDS.map(id => ({ id, src: `/stickers/${BUILT_IN_STICKER_FILES[id]}`, enabled: this.data.enabled[id] !== false, builtIn: true,
      description: BUILT_IN_STICKER_DESCRIPTIONS[id]?.phrases.join("，") ?? id })),
      ...this.data.stickers.map(item => ({ id: item.id, src: `/api/media/files/${encodeURIComponent(item.file)}`, enabled: this.data.enabled[item.id] !== false, builtIn: false, description: item.description }))];
  }
  async setEnabled(id: string, enabled: boolean) { if (!(await this.list()).some(item => item.id === id)) throw new Error("表情包不存在"); this.data.enabled[id] = enabled; await this.save(); return this.list(); }
  async matchReply(reply: string, userText: string, options: { enabled: boolean; threshold?: number }): Promise<string | null> {
    if (!options.enabled) return null;
    await this.load();
    const query = buildStickerMatchQuery(reply, userText);
    const custom = Object.fromEntries(this.data.stickers.map(item => [item.id, { description: item.description, phrases: item.phrases }]));
    const index = buildStickerTextIndex(BUILT_IN_STICKER_DESCRIPTIONS, custom).filter(item => this.data.enabled[item.id] !== false);
    return matchSticker(query, index, options.threshold)?.id ?? null;
  }
  async add(input: { id: string; description: string; phrases: string[]; dataUrl: string }) {
    await this.load();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.id) || !input.description.trim()) throw new Error("表情包 ID 或描述无效");
    if ((await this.list()).some(item => item.id === input.id)) throw new Error("表情包 ID 已存在");
    const image = decodeImage(input.dataUrl); const file = `${randomUUID()}${image.extension}`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); await writeFile(path.join(this.directory, file), image.body, { mode: 0o600 });
    this.data.stickers.push({ id: input.id, description: input.description.slice(0, 500), phrases: input.phrases.map(String).slice(0, 50), file, createdAt: Date.now() });
    await this.save(); return { ok: true };
  }
  async delete(id: string) {
    await this.load();
    if ((BUILT_IN_STICKER_IDS as readonly string[]).includes(id)) throw new Error("内置表情包只能禁用");
    const item = this.data.stickers.find(item => item.id === id); if (!item) throw new Error("表情包不存在");
    this.data.stickers = this.data.stickers.filter(item => item.id !== id); delete this.data.enabled[id]; await this.save();
    await unlink(path.join(this.directory, item.file)).catch(() => undefined); return { ok: true };
  }
  async avatar(kind: "cyrene" | "user") { await this.load(); const file = this.data.avatars[kind]; return file ? `/api/media/files/${encodeURIComponent(file)}` : null; }
  async setAvatar(kind: "cyrene" | "user", dataUrl: string) {
    await this.load(); const image = decodeImage(dataUrl); const file = `${randomUUID()}${image.extension}`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); await writeFile(path.join(this.directory, file), image.body, { mode: 0o600 });
    const previous = this.data.avatars[kind];
    this.data.avatars[kind] = file; await this.save();
    if (previous) await unlink(path.join(this.directory, previous)).catch(() => undefined);
    return this.avatar(kind);
  }
  async resetAvatar(kind: "cyrene" | "user") {
    await this.load(); const previous = this.data.avatars[kind]; delete this.data.avatars[kind]; await this.save();
    if (previous) await unlink(path.join(this.directory, previous)).catch(() => undefined);
  }
  async readFile(file: string) {
    await this.load();
    if (!this.data.stickers.some(item => item.file === file) && !Object.values(this.data.avatars).includes(file)) return null;
    try { return await readFile(path.join(this.directory, path.basename(file))); } catch { return null; }
  }
}
