import type { AgentExecutionMode, CyreneRunOptions } from "../orchestrator/cyrene-agent";
import type { ChannelToolSandbox } from "./settings-store";
import type { ChannelChatType, ChannelId } from "./types";

export interface ChannelAgentPolicy {
  executionMode: AgentExecutionMode;
  exposeTools: boolean;
  includeInteractiveTools: boolean;
  permissionMode: NonNullable<CyreneRunOptions["permissionMode"]>;
  allowPermissionPrompt: boolean;
  bypassCompanionApproval: boolean;
}

export function resolveChannelAgentPolicy(
  toolSandbox: ChannelToolSandbox,
  context?: { channel?: ChannelId; chatType?: ChannelChatType },
): ChannelAgentPolicy {
  // QQ 群聊（NapCat 与官方机器人同样处理）：共享群上下文，强制纯 Chat 模式、禁工具
  if ((context?.channel === "qq" || context?.channel === "qqbot") && context.chatType === "group") {
    return {
      executionMode: "chat",
      exposeTools: false,
      includeInteractiveTools: false,
      permissionMode: "normal",
      allowPermissionPrompt: false,
      bypassCompanionApproval: false,
    };
  }
  if (toolSandbox === "off") {
    return {
      executionMode: "chat",
      exposeTools: false,
      includeInteractiveTools: false,
      permissionMode: "normal",
      allowPermissionPrompt: false,
      bypassCompanionApproval: false,
    };
  }
  return {
    executionMode: "work",
    exposeTools: true,
    includeInteractiveTools: false,
    permissionMode: "allow_all",
    allowPermissionPrompt: false,
    bypassCompanionApproval: true,
  };
}

/**
 * 在 buildOptions 之后再次收紧策略，避免 Chat 工具开关已把工具目录写入
 * capabilities/toolSystemContent 时，QQ 群聊仍看到或意外启用这些工具。
 */
export function enforceChannelAgentPolicy(
  options: CyreneRunOptions,
  policy: ChannelAgentPolicy,
): void {
  options.harnessInteractiveTools = policy.includeInteractiveTools;
  options.permissionMode = policy.permissionMode;
  options.allowPermissionPrompt = policy.allowPermissionPrompt;
  options.bypassCompanionApproval = policy.bypassCompanionApproval;
  // 渠道运行没有可回收的桌面审批卡；即便上游复用了带回调的 options，
  // 也不能把审批送到 Web 窗口并让微信轮次悬挂。
  options.requestUserClarification = undefined;
  if (policy.exposeTools) return;
  options.tools = [];
  options.toolSystemContent = "";
  options.skillLayerContent = "";
  if (options.capabilities) {
    options.capabilities = {
      ...options.capabilities,
      tools: [],
      toolIds: new Set<string>(),
    };
  }
}
