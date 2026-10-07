import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStore } from "./auth-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStore(): Promise<AuthStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cyrene-auth-"));
  temporaryDirectories.push(directory);
  return new AuthStore(directory);
}

describe("AuthStore", () => {
  it("bootstraps one admin account and verifies the password", async () => {
    const store = await createStore();
    expect(await store.isInitialized()).toBe(false);

    await store.bootstrap("admin", "correct horse battery staple");

    expect(await store.isInitialized()).toBe(true);
    expect(await store.verify("admin", "correct horse battery staple")).toBe(true);
    expect(await store.verify("admin", "wrong password")).toBe(false);
    await expect(store.bootstrap("other", "correct horse battery staple")).rejects.toThrow("ALREADY_INITIALIZED");
  });

  it("rejects weak credentials and writes a private auth file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cyrene-auth-"));
    temporaryDirectories.push(directory);
    const store = new AuthStore(directory);

    await expect(store.bootstrap("bad user", "short")).rejects.toThrow("USERNAME_INVALID");
    await expect(store.bootstrap("admin", "short")).rejects.toThrow("PASSWORD_TOO_SHORT");
    await store.bootstrap("admin", "123456");

    const raw = await readFile(path.join(directory, "auth.json"), "utf8");
    expect(raw).toContain('"version": 1');
    expect(raw).not.toContain("123456");
  });

  it("creates, expires, and revokes in-memory sessions", async () => {
    const store = await createStore();
    const session = store.createSession("admin", 1000);
    expect(store.getSession(session.token, 1000)?.username).toBe("admin");
    expect(store.getSession(session.token, session.expiresAt)).toBeNull();

    const second = store.createSession("admin", 1000);
    store.revokeSession(second.token);
    expect(store.getSession(second.token, 1000)).toBeNull();
  });
});
