import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Credentials } from "./ilink-protocol-client";

// Local retention only; it is not a claim about the platform's token validity.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
type ContextEntry = { targetId: string; token: string; at: number };

/** Account-scoped, encrypted reply context survives service restarts. */
export class WechatReplyContextStore {
  constructor(private readonly filePath: string) {}

  load(credentials: Credentials, now = Date.now()): ContextEntry[] {
    try {
      const stored = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (stored.version !== 1 || stored.botId !== credentials.ilinkBotId) return [];
      const decipher = createDecipheriv("aes-256-gcm", this.key(credentials), Buffer.from(stored.iv, "base64"));
      decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
      const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.data, "base64")), decipher.final()]).toString("utf8"));
      if (!Array.isArray(value)) return [];
      return value.filter((item): item is ContextEntry => typeof item?.targetId === "string" && !!item.targetId
        && typeof item.token === "string" && !!item.token && Number.isFinite(item.at)
        && item.at <= now && now - item.at < RETENTION_MS).slice(-200);
    } catch { return []; }
  }

  remember(credentials: Credentials, targetId: string, token: string, now = Date.now()): void {
    const entries = this.load(credentials, now).filter(item => item.targetId !== targetId);
    entries.push({ targetId, token, at: now });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(credentials), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(entries.slice(-200)), "utf8"), cipher.final()]);
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, botId: credentials.ilinkBotId, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }), { mode: 0o600 });
      renameSync(temporary, this.filePath);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }

  clear(): void { if (existsSync(this.filePath)) unlinkSync(this.filePath); }

  private key(credentials: Credentials): Buffer {
    return createHash("sha256").update(`cyrene-wechat-reply-context\0${credentials.ilinkBotId}\0${credentials.botToken}`).digest();
  }
}
