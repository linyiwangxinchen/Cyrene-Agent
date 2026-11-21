// skill_write / skill_install —— 让昔涟把做法沉淀为用户级 Skill，或从 GitHub 安装 Skill。
// 两个工具都声明 requiresApproval：任何权限档位都会弹审批卡，渠道后台/定时任务
// （无交互界面）直接拒绝且不暴露；风险等级按文件写入（fs-write）处理，只读档位下拒绝。

import type { ToolDefinition } from "../orchestrator/tools/registry/tool-registry";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import type { ToolContext } from "../orchestrator/tools/registry/tool-context";
import {
  SkillAuthoringError,
  normalizeSkillModesInput,
  writeUserSkill,
  type SkillDirectories,
} from "./skill-authoring";
import { installSkillFromGitHub, type FetchLike, type InstallSkillResult } from "./skill-installer";

export interface SkillManagementDeps {
  getDirectories: () => SkillDirectories;
  /** 写入/安装后重新扫描，使新 Skill 立即生效。 */
  rescan: () => number;
  fetchImpl?: FetchLike;
}

function formatError(toolId: string, error: unknown): string {
  if (error instanceof SkillAuthoringError) return `[${toolId}] ${error.code}: ${error.message}`;
  if ((error as Error)?.name === "AbortError" || (error as Error)?.name === "TimeoutError") {
    return `[${toolId}] E_SKILL_FETCH_ABORTED: 网络请求超时或已取消。`;
  }
  return `[${toolId}] 失败: ${error instanceof Error ? error.message : String(error)}`;
}

/** 无交互界面的运行（渠道后台、定时任务、子任务）不执行，审批不能被绕过。 */
function rejectWithoutUser(toolId: string, ctx?: ToolContext): string | null {
  if (ctx?.allowUserInteraction === false || ctx?.channelContext || ctx?.readOnly) {
    return `[${toolId}] E_APPROVAL_REQUIRED: 需要在桌面或 Web 会话里由用户确认后才能修改 Skill，当前运行没有交互界面。`;
  }
  return null;
}

export function formatInstallResult(result: InstallSkillResult): string {
  return [
    `[skill_install] 已${result.updated ? "更新" : "安装"} Skill: ${result.id}`,
    `来源: ${result.repository}${result.path ? "/" + result.path : ""} @ ${result.commit.slice(0, 12)}`,
    `文件数: ${result.fileCount}`,
    `说明: ${result.description}`,
    `目录: ${result.dirPath}`,
    "已重新扫描，Skill 立即可用（可在设置 → Skill 里关闭）。",
  ].join("\n");
}

export function createSkillManagementTools(deps: SkillManagementDeps): ToolDefinition[] {
  const skillWrite: ToolDefinition = {
    id: "skill_write",
    name: "写入 Skill",
    catalogHint: "把一个可复用的做法写成用户级 Skill（需要用户审批）",
    description:
      "把一个经过验证、以后还会反复用到的做法写成用户级 Skill（<userData>/skills/<id>/SKILL.md），写完立即生效。\n\n" +
      "何时用：用户明确要你“记住这个做法 / 做成 Skill / 以后都这样做”，或你们一起摸索出一套稳定流程并且用户同意沉淀。\n\n" +
      "不要用于：记录用户偏好或事实（用记忆工具）；一次性任务；修改内置 Skill（不允许）。\n\n" +
      "参数：id（必填，小写字母/数字/短横线，如 weekly-report）、description（必填，一句话说明什么时候该用它，会进入 Skill 清单）、" +
      "body（必填，Markdown 正文：步骤、检查项、注意事项）、name（可选展示名，默认等于 id）、" +
      "modes（可选，适用模式数组 work/code/learn，缺省全部）、overwrite（已存在时更新必须传 true）。\n\n" +
      "每次调用都会请求用户审批。",
    enabled: true,
    risk: "fs-write",
    requiresApproval: true,
    modes: ["work", "code", "learn"],
    effectKind: "mutation",
    verificationPolicy: "none",
    ledgerPolicy: "bypass",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Skill id（小写字母、数字、短横线）" },
        description: { type: "string", description: "一句话：什么时候该用这个 Skill" },
        body: { type: "string", description: "SKILL.md 正文（Markdown）" },
        name: { type: "string", description: "展示名，可选" },
        modes: { type: "array", items: { type: "string", enum: ["work", "code", "learn"] }, description: "适用模式，可选" },
        overwrite: { type: "boolean", description: "已存在时更新需为 true" },
      },
      required: ["id", "description", "body"],
    },
    needsContext: true,
    execute: async (args, ctx?: ToolContext) => {
      const blocked = rejectWithoutUser("skill_write", ctx);
      if (blocked) return blocked;
      try {
        const result = writeUserSkill({
          id: String(args.id ?? "").trim(),
          name: typeof args.name === "string" ? args.name : undefined,
          description: String(args.description ?? ""),
          body: String(args.body ?? ""),
          modes: normalizeSkillModesInput(args.modes),
          overwrite: args.overwrite === true,
        }, deps.getDirectories());
        deps.rescan();
        return `[skill_write] 已${result.updated ? "更新" : "创建"} Skill: ${result.id}\n文件: ${result.skillPath}\n已重新扫描，之后可用 invoke_skill 或 /${result.id} 调用。`;
      } catch (error) {
        return formatError("skill_write", error);
      }
    },
  };

  const skillInstall: ToolDefinition = {
    id: "skill_install",
    name: "安装 Skill",
    catalogHint: "从 GitHub 仓库安装 Skill 到用户 Skill 目录（需要用户审批）",
    description:
      "从 GitHub 下载并安装一个 Skill 到用户 Skill 目录，装完立即生效，并记录来源仓库与提交号。\n\n" +
      "何时用：用户给了 GitHub 上的 Skill 地址并要求安装/更新。\n\n" +
      "不要用于：非 GitHub 来源；用户没要求安装时自行安装。\n\n" +
      "参数：source（必填：owner/repo、owner/repo/path/to/skill 或 https://github.com/owner/repo[/tree/<分支>/<目录>]）、" +
      "ref（可选分支/标签/提交）、id（可选，安装后的 id，缺省取 SKILL.md 的 name 或目录名）、overwrite（更新已安装的 Skill 时传 true）。\n\n" +
      "安装前会校验：必须有 SKILL.md、大小和文件数有上限、拒绝符号链接和路径穿越、不能覆盖内置 Skill。每次调用都会请求用户审批。",
    enabled: true,
    risk: "fs-write",
    requiresApproval: true,
    modes: ["work", "code", "learn"],
    effectKind: "mutation",
    verificationPolicy: "none",
    ledgerPolicy: "bypass",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "GitHub 来源：owner/repo、owner/repo/path 或仓库 URL" },
        ref: { type: "string", description: "分支、标签或提交，可选" },
        id: { type: "string", description: "安装后的 Skill id，可选" },
        overwrite: { type: "boolean", description: "覆盖已安装的同名 Skill" },
      },
      required: ["source"],
    },
    needsContext: true,
    execute: async (args, ctx?: ToolContext) => {
      const blocked = rejectWithoutUser("skill_install", ctx);
      if (blocked) return blocked;
      try {
        const result = await installSkillFromGitHub({
          ...deps.getDirectories(),
          source: String(args.source ?? ""),
          ref: typeof args.ref === "string" ? args.ref : undefined,
          id: typeof args.id === "string" ? args.id : undefined,
          overwrite: args.overwrite === true,
          fetchImpl: deps.fetchImpl,
          signal: ctx?.signal,
        });
        deps.rescan();
        return formatInstallResult(result);
      } catch (error) {
        return formatError("skill_install", error);
      }
    },
  };

  return [skillWrite, skillInstall];
}

export function registerSkillManagementTools(deps: SkillManagementDeps): void {
  for (const tool of createSkillManagementTools(deps)) toolRegistry.register(tool);
}
