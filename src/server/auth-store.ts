import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthSession } from "./auth-types";

const AUTH_FILE = "auth.json";
const AUTH_VERSION = 1;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
const MIN_PASSWORD_LENGTH = 6;

interface PersistedAuth {
  version: number;
  username: string;
  salt: string;
  passwordHash: string;
  createdAt: string;
}

interface PasswordRecord {
  salt: Buffer;
  hash: Buffer;
}

function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

function validateCredentials(username: string, password: string): void {
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error("USERNAME_INVALID");
  }
  if (normalizePassword(password).length < MIN_PASSWORD_LENGTH) {
    throw new Error("PASSWORD_TOO_SHORT");
  }
}

async function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      normalizePassword(password),
      salt,
      32,
      { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 },
      (error, derivedKey) => error ? reject(error) : resolve(Buffer.from(derivedKey)),
    );
  });
}

function encodePassword(record: PasswordRecord): { salt: string; passwordHash: string } {
  return {
    salt: record.salt.toString("base64url"),
    passwordHash: record.hash.toString("base64url"),
  };
}

function decodePassword(record: PersistedAuth): PasswordRecord {
  return {
    salt: Buffer.from(record.salt, "base64url"),
    hash: Buffer.from(record.passwordHash, "base64url"),
  };
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, filePath);
}

/**
 * 单管理员认证存储。
 *
 * 账号元数据使用原子 JSON 写入；登录会话只保存在进程内，服务重启后要求重新登录。
 * 这样首期不引入数据库，同时避免把可复用的会话令牌落盘。
 */
export class AuthStore {
  private readonly sessions = new Map<string, AuthSession>();
  private loaded = false;
  private record: PersistedAuth | null = null;
  private bootstrapInProgress = false;

  constructor(private readonly dataDir: string) {}

  private get authPath(): string {
    return path.join(this.dataDir, AUTH_FILE);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.authPath, "utf8")) as PersistedAuth;
      if (
        parsed.version === AUTH_VERSION
        && typeof parsed.username === "string"
        && typeof parsed.salt === "string"
        && typeof parsed.passwordHash === "string"
      ) {
        this.record = parsed;
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
      if (code !== "ENOENT") throw error;
    }
  }

  async isInitialized(): Promise<boolean> {
    await this.load();
    return this.record !== null;
  }

  async bootstrap(username: string, password: string): Promise<void> {
    await this.load();
    if (this.record) throw new Error("ALREADY_INITIALIZED");
    if (this.bootstrapInProgress) throw new Error("BOOTSTRAP_IN_PROGRESS");
    validateCredentials(username, password);

    this.bootstrapInProgress = true;
    try {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const salt = randomBytes(16);
      const hash = await derivePassword(password, salt);
      const record: PersistedAuth = {
        version: AUTH_VERSION,
        username,
        ...encodePassword({ salt, hash }),
        createdAt: new Date().toISOString(),
      };
      await writeJsonAtomically(this.authPath, record);
      this.record = record;
    } finally {
      this.bootstrapInProgress = false;
    }
  }

  async verify(username: string, password: string): Promise<boolean> {
    await this.load();
    if (!this.record || username !== this.record.username) return false;
    const stored = decodePassword(this.record);
    const actual = await derivePassword(password, stored.salt);
    return safeEqual(actual, stored.hash);
  }

  createSession(username: string, now = Date.now()): AuthSession {
    this.pruneSessions(now);
    const session: AuthSession = {
      token: randomBytes(32).toString("base64url"),
      username,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.sessions.set(session.token, session);
    return session;
  }

  getSession(token: string | undefined, now = Date.now()): AuthSession | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= now) {
      if (session) this.sessions.delete(token);
      return null;
    }
    return session;
  }

  revokeSession(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  private pruneSessions(now: number): void {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

/** 仅用于日志或审计关联，不输出可复用的原始 Cookie。 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export const AUTH_CONSTANTS = {
  sessionTtlMs: SESSION_TTL_MS,
  usernamePattern: USERNAME_PATTERN,
};
