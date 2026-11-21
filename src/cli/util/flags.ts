/**
 * Small option parser shared by exec/resume/doctor/login.
 *
 * Supports `--name value`, `--name=value`, boolean switches and a `--`
 * terminator after which every token is positional (so prompts may start
 * with "-"). Unknown options are rejected instead of silently ignored.
 */
export class UsageError extends Error {}

export type FlagKind = "string" | "boolean";
export type FlagSpec = Record<string, FlagKind>;

export interface ParsedFlags {
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export function parseFlags(args: readonly string[], spec: FlagSpec, aliases: Record<string, string> = {}): ParsedFlags {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!item.startsWith("-") || item === "-") {
      positionals.push(item);
      continue;
    }
    const equals = item.indexOf("=");
    const rawName = equals >= 0 ? item.slice(0, equals) : item;
    const name = (aliases[rawName] ?? rawName).replace(/^--?/, "");
    const kind = spec[name];
    if (!kind) throw new UsageError(`未知选项：${rawName}`);
    if (kind === "boolean") {
      if (equals >= 0) throw new UsageError(`${rawName} 不接受值`);
      flags[name] = true;
      continue;
    }
    if (equals >= 0) {
      flags[name] = item.slice(equals + 1);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || (value.startsWith("-") && value !== "-")) throw new UsageError(`${rawName} 需要一个值`);
    flags[name] = value;
    index += 1;
  }
  return { flags, positionals };
}

export function stringFlag(parsed: ParsedFlags, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function boolFlag(parsed: ParsedFlags, name: string): boolean {
  return parsed.flags[name] === true;
}
