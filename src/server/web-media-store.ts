import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { BUILT_IN_STICKER_IDS, type StickerConfigItem, type UserStickerMeta } from "../shared/sticker-types";
import { BUILT_IN_STICKER_DESCRIPTIONS, BUILT_IN_STICKER_FILES } from "../main/sticker-descriptions";
import { buildStickerTextIndex, matchSticker } from "../main/sticker-text-matcher-core";
import { buildStickerMatchQuery } from "../main/sticker-query";
import type { GeneratedImageAttachment } from "../shared/generated-image";

interface MediaState { enabled: Record<string, boolean>; stickers: UserStickerMeta[]; avatars: Partial<Record<"cyrene" | "user", string>>; generated: Record<string, { file: string; mime: string; byteLength: number }> }
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const WEB_GENERATED_IMAGE_MAX_BYTES = 128 * 1024 * 1024;
export const WEB_GENERATED_IMAGE_MAX_COUNT = 200;

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
  private data: MediaState = { enabled: {}, stickers: [], avatars: {}, generated: {} };
  private loadPromise?: Promise<void>;
  private writeChain: Promise<void> = Promise.resolve();
  constructor(private readonly dataDir: string) {}
  private get manifest() { return path.join(this.dataDir, "web-media.json"); }
  private get directory() { return path.join(this.dataDir, "web-media"); }
  private load(): Promise<void> {
    return this.loadPromise ??= (async () => {
      try { const saved = JSON.parse(await readFile(this.manifest, "utf8")); this.data = { enabled: saved.enabled ?? {}, stickers: saved.stickers ?? [], avatars: saved.avatars ?? {}, generated: saved.generated ?? {} }; await this.cleanupOrphans(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await this.cleanupOrphans(); }
    })();
  }
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${this.manifest}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      try { await rename(temporary, this.manifest); } finally { await unlink(temporary).catch(() => undefined); }
    }); return this.writeChain;
  }
  private async cleanupOrphans(): Promise<void> {
    const referenced = new Set([
      ...this.data.stickers.map(item => item.file),
      ...Object.values(this.data.avatars).filter((file): file is string => typeof file === "string"),
      ...Object.values(this.data.generated).map(item => item.file),
    ]);
    const entries = await readdir(this.directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.filter(entry => entry.isFile() && !referenced.has(entry.name)).map(entry => unlink(path.join(this.directory, entry.name)).catch(() => undefined)));
    let changed = false;
    for (const [id, item] of Object.entries(this.data.generated)) {
      if (!referenced.has(item.file)) { delete this.data.generated[id]; changed = true; continue; }
      const info = await stat(path.join(this.directory, item.file)).catch(() => null);
      if (!info?.isFile()) { delete this.data.generated[id]; changed = true; }
    }
    if (changed) await this.save();
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
  async saveGeneratedImage(input: { id: string; base64: string; mime?: string }): Promise<GeneratedImageAttachment> {
    await this.load();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.id)) throw new Error("生成图片标识无效");
    const dataUrl = `data:${input.mime || "image/png"};base64,${input.base64}`;
    const image = decodeImage(dataUrl);
    if (image.mime !== "image/png") throw new Error("模型生成图片必须是 PNG");
    const existing = this.data.generated[input.id];
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const currentBytes = Object.values(this.data.generated).reduce((sum, item) => sum + (Number.isFinite(item.byteLength) ? item.byteLength : 0), 0);
    const oldBytes = existing?.byteLength ?? 0;
    if (!existing && Object.keys(this.data.generated).length >= WEB_GENERATED_IMAGE_MAX_COUNT) throw new Error("生成图片存储配额已满");
    if (currentBytes - oldBytes + image.body.byteLength > WEB_GENERATED_IMAGE_MAX_BYTES) throw new Error("生成图片存储配额已满");
    let file = existing?.file ?? `generated-${randomUUID()}.png`;
    let target = path.join(this.directory, file);
    let createdFile = false;
    let replacedFile = false;
    if (existing) {
      const current = await readFile(target).catch(() => null);
      if (!current?.equals(image.body)) {
        file = `generated-${randomUUID()}.png`;
        target = path.join(this.directory, file);
        replacedFile = true;
      }
    }
    try {
      if (replacedFile || !existing) { await writeFile(target, image.body, { flag: "wx", mode: 0o600 }); createdFile = true; }
      this.data.generated[input.id] = { file, mime: image.mime, byteLength: image.body.byteLength };
      try {
        await this.save();
      } catch (error) {
        if (createdFile) await unlink(target).catch(() => undefined);
        if (existing) this.data.generated[input.id] = existing;
        else delete this.data.generated[input.id];
        throw error;
      }
      if (existing && existing.file !== file) await unlink(path.join(this.directory, existing.file)).catch(() => undefined);
    } catch (error) {
      if (createdFile) await unlink(target).catch(() => undefined);
      throw error;
    }
    return {
      id: input.id,
      kind: "image",
      name: `xilian-selfie-${input.id.slice(0, 8)}.png`,
      filePath: "",
      previewUrl: `/api/media/files/${encodeURIComponent(file)}`,
      mime: image.mime,
      source: "model",
      byteLength: image.body.byteLength,
      status: "done",
    };
  }
  async readFile(file: string) {
    await this.load();
    if (!this.data.stickers.some(item => item.file === file) && !Object.values(this.data.avatars).includes(file) && !Object.values(this.data.generated).some(item => item.file === file)) return null;
    try { return await readFile(path.join(this.directory, path.basename(file))); } catch { return null; }
  }

  /** Resolve a managed media name to a local path for channel adapters. */
  async resolveFilePath(file: string): Promise<string | null> {
    await this.load();
    const managed = this.data.stickers.some(item => item.file === file)
      || Object.values(this.data.avatars).includes(file)
      || Object.values(this.data.generated).some(item => item.file === file);
    if (!managed || !file || path.basename(file) !== file) return null;
    const resolved = path.join(this.directory, file);
    try { return (await stat(resolved)).isFile() ? resolved : null; } catch { return null; }
  }
}
