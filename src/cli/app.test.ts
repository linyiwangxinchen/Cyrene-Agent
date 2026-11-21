/**
 * Integration-ish tests for app.main(). Drives the real dispatch logic with
 * a temporary CYRENE_HOME so first-launch state is isolated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "./app";
import { readState } from "./state/state";

const VERSION = "0.9.0-test";

let tmpHome: string;
let stdoutBuf: string;
let stderrBuf: string;
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), "cyrene-cli-app-"));
  process.env.CYRENE_HOME = tmpHome;
  stdoutBuf = "";
  stderrBuf = "";
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdoutBuf += String(s);
    return true;
  });
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderrBuf += String(s);
    return true;
  });
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  delete process.env.CYRENE_HOME;
  delete process.env.CYRENE_CONFIG_TEST_KEY;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("main: hello", () => {
  it("prints the banner and exits 0", async () => {
    const code = await main(["hello"], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("Every memory has a place.");
    // hello does NOT print the "bringing me home" line (that's default only)
    expect(stdoutBuf).not.toContain("Thank you for bringing me home.");
  });
});

describe("main: about", () => {
  it("prints banner + GitHub URL", async () => {
    const code = await main(["about"], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("https://github.com/Playa-0v0/Cyrene-Agent");
  });
});

describe("main: version", () => {
  it("prints just the version", async () => {
    const code = await main(["version"], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf.trim()).toBe(VERSION);
  });

  it("--version flag maps to version", async () => {
    const code = await main(["--version"], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf.trim()).toBe(VERSION);
  });

  it("-v flag maps to version", async () => {
    const code = await main(["-v"], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf.trim()).toBe(VERSION);
  });
});

describe("main: help", () => {
  it("prints usage and exits 0", async () => {
    const code = await main(["--help"], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("Usage: cyrene");
  });

  it("prints config-specific help", async () => {
    const code = await main(["config", "--help"], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("Usage: cyrene config");
    expect(stdoutBuf).toContain("--api-key-env");
  });
});

describe("main: default (first meeting)", () => {
  it("prints the banner and the greeting line", async () => {
    const code = await main([], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("Every memory has a place.");
    expect(stdoutBuf).toContain("Thank you for bringing me home.");
  });

  it("writes state.json with firstLaunch", async () => {
    await main([], VERSION);
    const result = readState();
    expect(result.kind).toBe("present");
    if (result.kind === "present") {
      expect(result.record.version).toBe(VERSION);
    }
  });
});

describe("main: default (subsequent)", () => {
  it("prints only the Ready line and no banner", async () => {
    // first run
    await main([], VERSION);
    // reset buffer (keep the same spy so the mock impl still captures)
    stdoutBuf = "";
    // second run
    const code = await main([], VERSION);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain(`Cyrene Agent v${VERSION}`);
    expect(stdoutBuf).toContain("Ready.");
    expect(stdoutBuf).not.toContain("Every memory has a place.");
  });
});

describe("main: unavailable commands", () => {
  it("init and update say they are not provided and exit 2", async () => {
    expect(await main(["init"], VERSION)).toBe(2);
    expect(stderrBuf).toContain("当前版本未提供");
    expect(stderrBuf).toContain("cyrene config init");
    stderrBuf = "";
    expect(await main(["update"], VERSION)).toBe(2);
    expect(stderrBuf).toContain("当前版本未提供");
  });

  it("help marks init and update as not provided", async () => {
    await main(["--help"], VERSION);
    expect(stdoutBuf).toMatch(/init\s+Not provided/);
    expect(stdoutBuf).toMatch(/update\s+Not provided/);
    expect(stdoutBuf).toContain("exec");
    expect(stdoutBuf).toContain("resume");
  });
});

describe("main: run", () => {
  it("fails with exit 1 outside a project directory", async () => {
    const previous = process.cwd();
    process.chdir(tmpHome);
    try {
      expect(await main(["run"], VERSION)).toBe(1);
      expect(stderrBuf).toContain("no package.json found");
    } finally {
      process.chdir(previous);
    }
  });
});

describe("main: subcommand help", () => {
  it.each([
    ["exec", "Usage: cyrene exec"],
    ["resume", "Usage: cyrene resume"],
    ["doctor", "Usage: cyrene doctor"],
    ["login", "Usage: cyrene login"],
  ])("%s --help prints its own usage", async (command, expected) => {
    expect(await main([command, "--help"], VERSION)).toBe(0);
    expect(stdoutBuf).toContain(expected);
  });

  it("exec rejects unknown options with exit 2", async () => {
    expect(await main(["exec", "--bogus", "hi"], VERSION)).toBe(2);
    expect(stderrBuf).toContain("未知选项：--bogus");
  });

  it("exec rejects an invalid mode and conflicting flags with exit 2", async () => {
    expect(await main(["exec", "--mode", "learn", "hi"], VERSION)).toBe(2);
    expect(await main(["exec", "--session", "a", "--new", "hi"], VERSION)).toBe(2);
    expect(await main(["exec", "--local", "--server", "http://127.0.0.1:1", "hi"], VERSION)).toBe(2);
    expect(await main(["exec", "--data-dir", "x", "hi"], VERSION)).toBe(2);
  });

  it("exec refuses plain HTTP to a remote host before sending anything", async () => {
    expect(await main(["exec", "--server", "http://example.com", "hi"], VERSION)).toBe(2);
    expect(stderrBuf).toContain("远程服务器必须使用 HTTPS");
  });
});

describe("main: config", () => {
  it("applies inline model flags to a Web data directory", async () => {
    process.env.CYRENE_CONFIG_TEST_KEY = "fixture-key";
    const code = await main([
      "config", "apply", "--target", "web", "--data-dir", tmpHome,
      "--provider", "Fixture", "--base-url", "https://example.test/v1", "--model", "fixture-model",
      "--api-key-env", "CYRENE_CONFIG_TEST_KEY",
    ], VERSION);
    expect(code).toBe(0);
    const data = JSON.parse(readFileSync(path.join(tmpHome, "web-data.json"), "utf8"));
    expect(data.settings.modelProfiles[0]).toMatchObject({ provider: "Fixture", model: "fixture-model", apiKey: "fixture-key" });
  });
});

describe("main: unknown", () => {
  it("prints to stderr and exits 2", async () => {
    const code = await main(["bogus"], VERSION);
    expect(code).toBe(2);
    expect(stderrBuf).toContain("unknown command 'bogus'");
    expect(stdoutBuf).toBe("");
  });
});
