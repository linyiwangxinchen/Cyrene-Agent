import path from "node:path";
import { app } from "electron";
import type { BaseEvent } from "@ag-ui/core";
import type { ToolDefinition } from "../../tools/registry/tool-registry";
import { resolveEffectKind, toolRegistry } from "../../tools/registry/tool-registry";
import { checkPermission, type ToolRiskLevel } from "../../../permission";
import { isPlanReadOnly } from "../../plan-mode";
import { contextRefRegistry, extractLastUserQuery, type ToolContext } from "../../tools/registry/tool-context";
import type { HarnessInput } from "../index";
import { getTaskSessionStore } from "../../../tasks/task-session-store";
import { createTaskCloser, createTaskExecutor } from "../../task-runtime";
import { FileToolOutputStore } from "../tool-output/file-tool-output-store";
import { sendTaskLifecycleAsAgui } from "./event-mapper";
import type { PreparedHarnessRun } from "./run-preparation";
import type { CyreneRunOptions } from "../../cyrene-agent";
import { getTaskWorktreeManager, type GitInvocation } from "../../task-worktree";
import { resolveGitExecutable } from "../../../code-git/git-executable";
import { resolveImageRoute } from "../../image-router";
import { bindToolScreenshotHandler, createToolResultImageCache, formatToolImageResult } from "../../tool-result-images";

let resolvedTaskGit: GitInvocation | null = null;
/** 与 Git 面板相同的探测顺序：系统 git 优先，打包版回退内置 MinGit；成功结果进程内缓存。 */
async function resolveTaskGit(): Promise<GitInvocation | null> {
  resolvedTaskGit ??= await resolveGitExecutable({
    systemCommand: "git",
    bundledPath: app.isPackaged
      ? path.join(process.resourcesPath, "mingit", "cmd", "git.exe")
      : path.join(app.getAppPath(), "resources", "mingit", "cmd", "git.exe"),
  });
  return resolvedTaskGit;
}

/**
 * 为一次 Harness run 构造工具运行时（tool runtime）。
 * signal、runId 和 permissionCheck 从父 run 原样下传，避免子任务或权限检查产生第二套生命周期。
 */
export interface PreparedToolRuntime {
  toolContext: ToolContext;
  checkPermission: NonNullable<HarnessInput["checkPermission"]>;
  toolOutputStore: FileToolOutputStore;
  taskExecutor: HarnessInput["taskExecutor"];
  closeTaskExecutor: HarnessInput["closeTaskExecutor"];
  openTaskCompanions: string[];
  toolResultImages: ReturnType<typeof createToolResultImageCache>;
}

export async function prepareToolRuntime(input: {
  options: CyreneRunOptions;
  signal: AbortSignal;
  prepared: PreparedHarnessRun;
  sendBaseEvent: (event: BaseEvent) => void;
}): Promise<PreparedToolRuntime> {
  const { options, signal, prepared } = input;
  const { threadId, runId, systemPrompt, vendorConfig, tools } = prepared;
  const permissionCheck: NonNullable<HarnessInput["checkPermission"]> = async (
    toolId: string,
    args: Record<string, unknown>,
  ) => {
    // 计划只读不变量：必须先于 allow_all 判断。
    // 用户说"先规划不要动"是对本轮对话的契约，任何权限档位都不能越过。
    // 判断依据从 risk（危险程度）换成 effectKind（是否改变世界），只放行纯读取工具；
    // 未注册工具也拒绝（fail-closed：MCP/插件工具必须显式声明 effectKind 才能参与计划阶段）。
    if (
      (options.conversationMode === "code" || options.conversationMode === "chat")
      && isPlanReadOnly(threadId)
    ) {
      const planTool = toolRegistry.getById(toolId);
      if (!planTool) return false;
      const effect = resolveEffectKind(planTool, args);
      if (effect !== "read") {
        console.log(`[HarnessAdapter] [Plan] read-only enforcement blocked tool=${toolId} effect=${effect}`);
        return false;
      }
    }
    // 契约检查完毕后，allow_all 才生效（只影响执行阶段语义）
    // Explicit channel auto-approval still obeys live capability revocation.
    const tool = toolRegistry.getById(toolId);
    if (!tool) return false;
    const risk: ToolRiskLevel = (tool as ToolDefinition & { risk?: ToolRiskLevel }).risk ?? "safe";
    const decision = await checkPermission({
      toolId,
      toolName: tool.name,
      toolDescription: tool.description,
      args,
      risk,
      runId,
      signal,
      allowPrompt: options.allowPermissionPrompt,
      bypassBasePolicy: options.permissionMode === "allow_all",
      bypassCompanionApproval: options.bypassCompanionApproval,
      requireApproval: tool.requiresApproval === true,
      effect: resolveEffectKind(tool, args),
    });
    if (!decision.allowed && decision.denialCode === "git_scoped_write" && decision.reason) {
      return { allowed: false, reason: decision.reason };
    }
    return decision.allowed;
  };

  const toolContext: ToolContext = {
    userQuery: extractLastUserQuery(options.messages),
    conversationId: options.conversationId ?? "default",
    memoryScope: options.memoryScope,
    memoryModeVersion: options.memoryModeVersion,
    memoryUserTurnId: options.memoryUserTurnId,
    onHistorySourcesRead: options.onHistorySourcesRead,
    historyTimeZone: options.historyTimeZone,
    runId,
    contextRefs: contextRefRegistry,
    signal,
    resolvedWorkspaceRoot: options.resolvedWorkspaceRoot,
    mode: options.conversationMode,
    allowedSkillIds: options.capabilities?.skillIds,
    permissionMode: options.permissionMode,
    channelContext: options.channelContext,
    allowUserInteraction: options.harnessInteractiveTools,
    onShellJobComplete: options.onShellJobComplete,
  };
  const toolOutputStore = new FileToolOutputStore(app.getPath("userData"));
  const toolResultImages = createToolResultImageCache(signal);
  bindToolScreenshotHandler(toolContext, async ({ base64, description, question }) => {
    if (signal.aborted) return "[错误] 截图已取消。";
    const route = resolveImageRoute("tool", options.settings);
    if (route.mode === "reject") return `[错误] ${route.reason}`;
    if (route.mode === "direct") {
      const reference = toolResultImages.remember(base64);
      return reference ? formatToolImageResult(description, reference) : "[错误] 无法读取受支持尺寸内的 PNG 截图。";
    }
    const { captionImage } = await import("../../vision-captioner.js");
    const caption = await captionImage({ base64, mime: "image/png" }, question, route.config);
    return caption.startsWith("[错误") ? caption : `${description}\n视觉模型转述：${caption}`;
  });
  // 只有 work/code 模式允许派生任务；chat 模式不创建 TaskSession，避免出现不可见的后台执行。
  // taskMode 在收窄的同时保留 "work" | "code" 字面量类型，供下方 executor 的 parent.mode 使用。
  const taskMode = options.conversationMode === "work" || options.conversationMode === "code"
    ? options.conversationMode
    : undefined;
  const taskStore = taskMode ? getTaskSessionStore(app.getPath("userData")) : undefined;
  const taskExecutor = taskStore && taskMode
    ? createTaskExecutor({
      parent: {
        parentConversationId: threadId,
        parentRunId: runId,
        mode: taskMode,
        capabilities: options.capabilities,
        systemPrompt,
        vendorConfig,
        tools,
        resolvedWorkspaceRoot: options.resolvedWorkspaceRoot,
        signal,
        checkPermission: permissionCheck,
        includeInteractiveTools: options.harnessInteractiveTools,
        permissionMode: options.permissionMode,
        toolOutputStore,
        transcriptRoot: app.getPath("userData"),
      },
      store: taskStore,
      worktrees: getTaskWorktreeManager({ resolveGit: resolveTaskGit }),
      onLifecycle: (event) => sendTaskLifecycleAsAgui(event, threadId, runId, input.sendBaseEvent),
    })
    : undefined;
  const closeTaskExecutor = taskStore
    ? createTaskCloser({ store: taskStore, parentConversationId: threadId })
    : undefined;
  const openTaskCompanions = taskStore ? await taskStore.listOpenCompanions(threadId) : [];

  return { toolContext, checkPermission: permissionCheck, toolOutputStore, taskExecutor, closeTaskExecutor, openTaskCompanions, toolResultImages };
}
