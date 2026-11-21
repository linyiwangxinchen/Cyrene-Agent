import { describe, expect, it } from "vitest";
import { parseArgv } from "./argv";

describe("parseArgv", () => {
  it("returns default for empty argv", () => {
    expect(parseArgv([])).toEqual({ kind: "default" });
  });

  it("returns hello", () => {
    expect(parseArgv(["hello"])).toEqual({ kind: "hello" });
  });

  it("returns about", () => {
    expect(parseArgv(["about"])).toEqual({ kind: "about" });
  });

  it("returns version for the version subcommand", () => {
    expect(parseArgv(["version"])).toEqual({ kind: "version" });
  });

  it("returns help for the help subcommand", () => {
    expect(parseArgv(["help"])).toEqual({ kind: "help" });
  });

  it("returns run", () => {
    expect(parseArgv(["run"])).toEqual({ kind: "run" });
  });

  it("keeps config arguments for the config handler", () => {
    expect(parseArgv(["config", "apply", "--file", "cyrene.config.json"])).toEqual({
      kind: "config",
      args: ["apply", "--file", "cyrene.config.json"],
    });
  });

  it("maps --help and -h to help, regardless of position", () => {
    expect(parseArgv(["--help"])).toEqual({ kind: "help" });
    expect(parseArgv(["-h"])).toEqual({ kind: "help" });
    expect(parseArgv(["hello", "--help"])).toEqual({ kind: "help" });
    expect(parseArgv(["-h", "run"])).toEqual({ kind: "help" });
  });

  it("maps --version and -v to version, regardless of position", () => {
    expect(parseArgv(["--version"])).toEqual({ kind: "version" });
    expect(parseArgv(["-v"])).toEqual({ kind: "version" });
    expect(parseArgv(["hello", "-v"])).toEqual({ kind: "version" });
  });

  it("hands every token after exec/resume/doctor/login/logout to the command", () => {
    expect(parseArgv(["exec", "--mode", "code", "--", "-v 是什么"])).toEqual({ kind: "exec", args: ["--mode", "code", "--", "-v 是什么"] });
    expect(parseArgv(["exec", "--help"])).toEqual({ kind: "exec", args: ["--help"] });
    expect(parseArgv(["resume", "abc"])).toEqual({ kind: "resume", args: ["abc"] });
    expect(parseArgv(["doctor", "--json"])).toEqual({ kind: "doctor", args: ["--json"] });
    expect(parseArgv(["login", "--server", "https://example.test"])).toEqual({ kind: "login", args: ["--server", "https://example.test"] });
    expect(parseArgv(["logout"])).toEqual({ kind: "logout", args: [] });
  });

  it("ignores global flags after the -- terminator", () => {
    expect(parseArgv(["hello", "--", "--help"])).toEqual({ kind: "hello" });
  });

  it("maps init/update to unavailable", () => {
    expect(parseArgv(["init"])).toEqual({ kind: "unavailable", name: "init" });
    expect(parseArgv(["update"])).toEqual({ kind: "unavailable", name: "update" });
  });

  it("returns unknown for unrecognised subcommands", () => {
    expect(parseArgv(["bogus"])).toEqual({ kind: "unknown", name: "bogus" });
  });

  it("returns unknown for a flag that is not -h/-v", () => {
    expect(parseArgv(["--foo"])).toEqual({ kind: "unknown", name: "--foo" });
  });
});
