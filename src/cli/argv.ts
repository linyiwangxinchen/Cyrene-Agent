/**
 * Hand-rolled argv parser. No commander/yargs; the surface is tiny.
 *
 * `unknown` is a first-class variant so the dispatch switch in app.ts is
 * exhaustive: adding a new Command variant without a handler is a TS error.
 */
export type ArgCommandName = "config" | "exec" | "resume" | "doctor" | "login" | "logout";

export type Command =
  | { kind: "default" }
  | { kind: "hello" }
  | { kind: "about" }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "run" }
  | { kind: ArgCommandName; args: string[] }
  | { kind: "unavailable"; name: "init" | "update" }
  | { kind: "unknown"; name: string };

const SIMPLE_COMMANDS = new Map<string, Command>([
  ["hello", { kind: "hello" }],
  ["about", { kind: "about" }],
  ["version", { kind: "version" }],
  ["help", { kind: "help" }],
  ["run", { kind: "run" }],
  ["init", { kind: "unavailable", name: "init" }],
  ["update", { kind: "unavailable", name: "update" }],
]);

/** Commands that own every following token, including their own --help. */
const ARG_COMMANDS = new Set<ArgCommandName>(["config", "exec", "resume", "doctor", "login", "logout"]);

function isArgCommand(value: string): value is ArgCommandName {
  return ARG_COMMANDS.has(value as ArgCommandName);
}

export function parseArgv(argv: readonly string[]): Command {
  // Commands with options parse their own flags (and their own --help), so a
  // prompt such as `cyrene exec -- "-v 是什么"` is never hijacked globally.
  const first = argv[0];
  if (first !== undefined && isArgCommand(first)) return { kind: first, args: argv.slice(1) };

  // Flags first: --help/-h and --version/-v are accepted anywhere and win
  // over any simple subcommand. This matches user expectations from other CLIs.
  const terminator = argv.indexOf("--");
  const head = terminator >= 0 ? argv.slice(0, terminator) : argv;
  for (const a of head) {
    if (a === "--help" || a === "-h") return { kind: "help" };
    if (a === "--version" || a === "-v") return { kind: "version" };
  }

  const subIndex = head.findIndex((a) => !a.startsWith("-"));
  if (subIndex < 0) {
    // No subcommand. If there are any leftover flags we did not recognise,
    // treat the first one as an unknown command rather than silently defaulting.
    const leftover = head.find((a) => a.startsWith("-") && a !== "--");
    if (leftover !== undefined) return { kind: "unknown", name: leftover };
    return { kind: "default" };
  }

  const sub = head[subIndex];
  if (isArgCommand(sub)) return { kind: sub, args: argv.slice(subIndex + 1) };
  return SIMPLE_COMMANDS.get(sub) ?? { kind: "unknown", name: sub };
}
