import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  credentialsPath, DEFAULT_SERVER, findSession, normalizeServer, readCredentials, removeSession, resolveServer, saveSession,
} from "./credentials";
import { parseFlags, UsageError } from "../util/flags";

let home: string;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "cyrene-cred-"));
  process.env.CYRENE_HOME = home;
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  errSpy.mockRestore();
  delete process.env.CYRENE_HOME;
  delete process.env.CYRENE_SERVER;
  rmSync(home, { recursive: true, force: true });
});

const session = { server: "https://cyrene.example.test", username: "u", sessionToken: "token-abc", savedAt: "2026-01-01T00:00:00.000Z" };

describe("credentials file", () => {
  it("round-trips sessions and sets the default server", () => {
    saveSession(session);
    expect(findSession(session.server)).toEqual(session);
    expect(readCredentials().defaultServer).toBe(session.server);
    expect(resolveServer(undefined)).toEqual({ server: session.server, explicit: true });
    expect(removeSession(session.server)).toBe(true);
    expect(findSession(session.server)).toBeUndefined();
    expect(resolveServer(undefined)).toEqual({ server: DEFAULT_SERVER, explicit: false });
  });

  it.skipIf(process.platform === "win32")("creates the file with mode 600 in a 700 directory", () => {
    saveSession(session);
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(credentialsPath())).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("tightens a file that became world readable", () => {
    saveSession(session);
    chmodSync(credentialsPath(), 0o644);
    readCredentials();
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  });

  it("treats a corrupt file as logged out", () => {
    mkdirSync(path.dirname(credentialsPath()), { recursive: true });
    writeFileSync(credentialsPath(), "{not json");
    expect(readCredentials().sessions).toEqual({});
  });

  it("stores no password field", () => {
    saveSession(session);
    expect(Object.keys(JSON.parse(readFileSync(credentialsPath(), "utf8")).sessions[session.server]).sort())
      .toEqual(["savedAt", "server", "sessionToken", "username"]);
  });
});

describe("normalizeServer", () => {
  it("accepts https anywhere and http only on loopback", () => {
    expect(normalizeServer("https://cyrene.example.test/")).toBe("https://cyrene.example.test");
    expect(normalizeServer("http://127.0.0.1:4317")).toBe("http://127.0.0.1:4317");
    expect(normalizeServer("localhost:4317")).toBe("http://localhost:4317");
    expect(() => normalizeServer("http://192.168.1.2:4317")).toThrow(UsageError);
  });

  it("rejects credentials or paths in the URL", () => {
    expect(() => normalizeServer("https://user:pass@cyrene.example.test")).toThrow("不要把用户名或密码写进服务器地址");
    expect(() => normalizeServer("https://cyrene.example.test/app")).toThrow(UsageError);
    expect(() => normalizeServer("ftp://cyrene.example.test")).toThrow(UsageError);
  });

  it("prefers CYRENE_SERVER over a saved login", () => {
    saveSession(session);
    process.env.CYRENE_SERVER = "http://127.0.0.1:9999";
    expect(resolveServer(undefined).server).toBe("http://127.0.0.1:9999");
    expect(resolveServer("https://other.example.test").server).toBe("https://other.example.test");
  });
});

describe("parseFlags", () => {
  const spec = { mode: "string", json: "boolean" } as const;
  it("parses values, booleans, = syntax and the -- terminator", () => {
    expect(parseFlags(["--mode", "code", "a", "--json", "--", "--mode", "-x"], spec)).toEqual({
      flags: { mode: "code", json: true }, positionals: ["a", "--mode", "-x"],
    });
    expect(parseFlags(["--mode=work", "-"], spec)).toEqual({ flags: { mode: "work" }, positionals: ["-"] });
  });

  it("rejects unknown options, missing values and values on switches", () => {
    expect(() => parseFlags(["--nope"], spec)).toThrow("未知选项：--nope");
    expect(() => parseFlags(["--mode"], spec)).toThrow("需要一个值");
    expect(() => parseFlags(["--mode", "--json"], spec)).toThrow("需要一个值");
    expect(() => parseFlags(["--json=1"], spec)).toThrow("不接受值");
  });
});
