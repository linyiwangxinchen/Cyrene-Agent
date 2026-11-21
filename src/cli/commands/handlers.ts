/**
 * Command handlers. Each returns the process exit code and performs its own
 * IO via util/log.ts (never console.log, to avoid Windows codepage issues).
 *
 * `version` is passed in (not read from a global) so tests can supply a
 * deterministic value. In production it is injected at build time by esbuild
 * as __CYRENE_VERSION__ and threaded through main().
 */
import { renderAbout, renderBanner } from "../banner/render.js";
import { ABOUT_LINES, BANNER_LINES } from "../banner/text.js";
import { readState, writeState, type FirstLaunchRecord } from "../state/state.js";
import { errLine, outLine } from "../util/log.js";

export interface HandlerCtx {
  version: string;
}

function versionLine(ctx: HandlerCtx): string {
  return `Cyrene Agent v${ctx.version}`;
}

export function cmdHello(): number {
  outLine(renderBanner());
  return 0;
}

export function cmdAbout(): number {
  outLine(renderAbout());
  return 0;
}

export function cmdVersion(ctx: HandlerCtx): number {
  outLine(ctx.version);
  return 0;
}

export function cmdHelp(): number {
  outLine(`Usage: cyrene [command] [options]

Commands:
  hello     Print the welcome banner
  about     Print banner plus project metadata
  version   Print version only
  run       Launch the Electron desktop app [dev only]
  config    Configure model and WeChat settings from a file or flags
  exec      Run one turn and stream Cyrene's reply (see cyrene exec --help)
  resume    List recent sessions or continue one (see cyrene resume --help)
  login     Log in to a Cyrene Web service; logout forgets the saved session
  doctor    Diagnose Node.js, data directory, model, SQLite, WeChat and Web service
  init      Not provided; use \`cyrene config init\`
  update    Not provided; update with the installer or git pull + rebuild
  help      Show this help

Flags:
  -v, --version   Print version and exit
  -h, --help      Show this help

Run \`cyrene\` with no arguments for the first-time greeting.`);
  return 0;
}

const UNAVAILABLE_HINTS: Record<"init" | "update", string> = {
  init: "生成配置模板请使用 cyrene config init，写入设置请使用 cyrene config apply。",
  update: "桌面安装包会自行检查更新；源码部署请 git pull 后重新运行 corepack pnpm run build:cli（Web 服务另需 build:server）。",
};

/** init/update are intentionally not implemented; say so and fail so scripts notice. */
export function cmdUnavailable(name: "init" | "update"): number {
  errLine(`cyrene ${name}：当前版本未提供此命令。${UNAVAILABLE_HINTS[name]}`);
  return 2;
}

export function cmdUnknown(name: string): number {
  errLine(`cyrene: unknown command '${name}'. Try 'cyrene --help'.`);
  return 2;
}

/**
 * The default invocation: first meeting vs subsequent.
 * Never fails: write errors are warned about, not fatal.
 */
export function cmdDefault(ctx: HandlerCtx): number {
  const state = readState();
  if (state.kind === "present") {
    outLine(versionLine(ctx));
    outLine("Ready.");
    return 0;
  }

  if (state.kind === "corrupt") {
    errLine("cyrene: ~/.cyrene/state.json was unreadable; treating as first meeting.");
  }

  outLine(renderBanner());
  outLine();
  outLine("Thank you for bringing me home.");

  const record: FirstLaunchRecord = {
    firstSeenAt: new Date().toISOString(),
    version: ctx.version,
  };
  try {
    writeState({ firstLaunch: record });
  } catch {
    errLine(
      "cyrene: could not write ~/.cyrene/state.json; you may see this banner again next time.",
    );
  }
  return 0;
}

// Re-export for tests that assert on banner content.
export { BANNER_LINES, ABOUT_LINES, renderBanner, renderAbout };
