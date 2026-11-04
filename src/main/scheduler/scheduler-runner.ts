import type { WebContents } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { PluginPromptMode, PluginTurnStatus } from "../../plugins/api";
import type { ChatMessage } from "../../shared/chat-types";
import { AgentRuntimeError } from "../orchestrator/agent-runtime-error";
import { withConversationRun } from "../orchestrator/conversation-run-guard";
import { CyreneAgent, type CyreneRunOptions } from "../orchestrator/cyrene-agent";
import type { LifecyclePublisher } from "../plugin-host/lifecycle-publisher";
import type { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import type { ActiveConversationSelection } from "../chats/active-conversation-registry";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { toastEvents } from "../toast/toast-events";
import { channelManager } from "../channels/manager";
import { loadChannelsSettings } from "../channels/settings-store";
import { createChannelDeliveryService } from "../channels/delivery-service";
import { appendHistory as appendChannelHistory } from "../channels/history-log";
import { appendLog as appendChannelLog } from "../channels/message-log";
import type { ChannelCapability, OutgoingMessage } from "../channels/types";
import { buildCapabilityTextParts } from "../channels/capability-text";
import { buildToolSystemPrompt } from "../orchestrator/system-prompt-builder";
import { buildChannelSystem } from "../orchestrator/expression-context-core";
import { filterToolsForTask } from "./tool-filter";
import type { ScheduledRunResult, ScheduledTask, ScheduledTaskHistoryEntry } from "./types";

/** 兼容 buildOptions 的 system 消息；运行时分离人格与授权工具提示词。 */
type LegacyRunOptions = Omit<CyreneRunOptions, "toolSystemContent" | "soulSystemBaseContent">;

interface RunnerDeps {
  buildOptions: (task: ScheduledTask) => Promise<LegacyRunOptions>;
  /** 有绑定工作区的用户任务每次触发创建独立 Cyrene 会话，不复用当前活动聊天。 */
  createRunSession?: (task: ScheduledTask) => (string) | Promise<string>;
  getChatWebContents: () => WebContents | null;
  recordHistory: (entry: ScheduledTaskHistoryEntry) => void;
  id: () => string;
  now: () => Date;
  /** 生命周期事件发布器；缺省不发布（早期装配与纯策略测试场景）。 */
  publishLifecycle?: LifecyclePublisher;
  conversationJournal?: ConversationJournalService;
  getActiveConversation?: () => ActiveConversationSelection | null;
}

type SchedulerDisplayTool = {
  name: string;
  displayName?: string;
  status: "running" | "success" | "error";
};

/** One deterministic display value is shared by the durable presentation and terminal event. */
function resolveSchedulerDisplayReply(reply: string, tools: readonly SchedulerDisplayTool[]): string {
  const trimmed = reply.trim();
  if (trimmed) return trimmed;
  const summary = tools
    .map((tool) => `${tool.displayName ?? tool.name}：${tool.status === "error" ? "失败" : "完成"}`)
    .join("\n");
  return summary || "任务执行完毕。";
}

/**
 * Scheduled delivery does not have an IncomingMessage to pass through the
 * normal dispatcher composer. Apply the same channel text boundary here so a
 * long unattended reply cannot be rejected by iLink/Feishu after the CTA has
 * already been committed.
 */
export function buildScheduledDeliveryMessage(
  channel: OutgoingMessage["channel"],
  targetId: string,
  text: string,
  capability?: ChannelCapability,
  threadId?: string,
): OutgoingMessage {
  const parts = buildCapabilityTextParts(text, capability?.maxTextLength, "on");
  return { channel, targetId, ...(threadId ? { threadId } : {}), parts };
}

/**
 * 定时任务无人值守：只能使用冻结的工具和权限；需要交互审批时明确失败。
 * 会话模式来自任务冻结的 mode 字段（旧任务默认 work）；执行循环沿用现有
 * 映射：chat 走 chat loop，其余模式走 work harness。
 */
export function applyScheduledExecutionPolicy(options: CyreneRunOptions, mode: PluginPromptMode = "work"): CyreneRunOptions {
  return {
    ...options,
    executionMode: mode === "chat" ? "chat" : "work",
    conversationMode: mode,
    harnessInteractiveTools: false,
    permissionMode: options.permissionMode ?? "allow_all",
    allowPermissionPrompt: false,
  };
}

export function createSchedulerRunner(deps: RunnerDeps) {
  async function runScheduledTask(task: ScheduledTask, _scheduledFireAt: Date, manual: boolean, historyId: string, startedAt: Date, selectedConversationId?: string | null, signal?: AbortSignal): Promise<ScheduledRunResult> {

    // 旧任务仍是纯提醒；新 agent 任务保留创建时的工具白名单。
    const reminderOnly = Boolean(task.delivery && task.kind !== "agent");
    const allTools = toolRegistry.getAllTools();
    const effectiveTools = reminderOnly ? [] : filterToolsForTask(task, allTools);
    const effectiveToolIds = effectiveTools.map(t => t.id);
    // Freeze the UI target before any async build work; a later window switch
    // must not redirect this run's canonical facts or presentation events.
    let conversationId: string | null = null;
    let sessionCreationError: Error | undefined;
    if (task.delivery) {
      conversationId = task.delivery.conversationId ?? task.delivery.sessionId;
      if (!deps.conversationJournal) sessionCreationError = new Error("渠道定时任务缺少会话日志服务，未执行或发送");
    } else if (task.workspaceBinding) {
      try {
        conversationId = (await deps.createRunSession?.(task)) ?? null;
        if (!conversationId) sessionCreationError = new Error("无法为定时任务创建独立会话");
      } catch (error) {
        sessionCreationError = error instanceof Error ? error : new Error(String(error));
      }
    } else {
      conversationId = selectedConversationId ?? null;
    }
    const runMode = reminderOnly ? "chat" : (task.mode ?? "work");
    const noticeId = `scheduler-notice-${historyId}`;
    const replyId = `scheduler-reply-${historyId}`;
    const noticeText = `定时任务「${task.title}」已触发`;
    const schedulerToolExecutions: Array<{
      id: string;
      name: string;
      displayName?: string;
      status: "running" | "success" | "error";
      result?: string;
    }> = [];
    let deferredRunFinished: Record<string, unknown> | undefined;
    let startedEventSent = false;
    let failureEventSent = false;

    const send = (event: unknown): void => {
      const wc = deps.getChatWebContents();
      if (!wc || wc.isDestroyed()) return;
      wc.send(IPC.SCHEDULER_EVENT, event);
    };

    const publishFailure = (finishedAt: Date, status: PluginTurnStatus, message: string, code?: string): void => {
      if (failureEventSent) return;
      failureEventSent = true;
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      try {
        deps.recordHistory({
          id: historyId,
          taskId: task.id,
          taskTitle: task.title,
          firedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs,
          status: "failed",
          reason: status,
          errorMessage: message,
          effectiveToolIds,
          ...(conversationId ? { sessionId: conversationId } : {}),
        });
      } catch {
        // The UI error event remains the last-resort durable signal when history is unavailable.
      }
      try {
        deps.publishLifecycle?.publishTurnFinished({
          source: "scheduler",
          runId: historyId,
          mode: runMode,
          taskId: task.id,
          schedulerRunId: historyId,
          status,
          durationMs,
          ...(conversationId ? { conversationId } : {}),
        });
        deps.publishLifecycle?.publishSchedulerFinished({
          taskId: task.id,
          schedulerRunId: historyId,
          status,
          durationMs,
          ...(conversationId ? { conversationId } : {}),
        });
      } catch {
        // A plugin subscriber must not prevent the renderer from receiving RUN_ERROR.
      }
      if (!startedEventSent) {
        send({
          type: "CUSTOM",
          name: "scheduler.started",
          schedulerRunId: historyId,
          schedulerTaskId: task.id,
          ...(conversationId ? { conversationId } : {}),
          messageId: noticeId,
          value: { taskId: task.id, title: task.title, manual, firedAt: startedAt.toISOString(), runId: historyId, noticeId, replyId, ...(conversationId ? { conversationId } : {}) },
        });
      }
      send({
        type: "RUN_ERROR",
        message,
        reason: status,
        status,
        ...(code ? { code } : {}),
        threadId: `scheduler-${task.id}`,
        runId: historyId,
        schedulerRunId: historyId,
        schedulerTaskId: task.id,
        ...(conversationId ? { conversationId } : {}),
      });
    };

    const appendPresentationWithRetry = async (
      targetConversationId: string,
      messageId: string,
      mutationKey: string,
      patch: Parameters<ConversationJournalService["appendPresentationNext"]>[3],
    ): Promise<void> => {
      let presentationError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await deps.conversationJournal!.appendPresentationNext(targetConversationId, messageId, mutationKey, patch);
          presentationError = undefined;
          break;
        } catch (error) {
          presentationError = error;
        }
      }
      if (presentationError !== undefined) console.warn("[Scheduler] 展示更新失败，已提交的权威轨迹保留:", presentationError);
    };

    let transcriptSink: ReturnType<ConversationJournalService["createRunSink"]> | undefined;
    try {
      signal?.throwIfAborted();
      if (sessionCreationError) throw sessionCreationError;
      if (task.workspaceBinding && !task.delivery && conversationId) deps.recordHistory({
        id: historyId, taskId: task.id, taskTitle: task.title, firedAt: startedAt.toISOString(),
        status: "running", reason: manual ? "manual fireNow" : undefined, effectiveToolIds, sessionId: conversationId,
      });
      if (task.delivery) {
        const status = channelManager.getAdapter(task.delivery.channel)?.getStatus();
        if (!status?.enabled || status.phase !== "running") throw new Error("渠道当前不可用，任务未执行；请检查连接后手动运行");
        if (effectiveTools.length && loadChannelsSettings().toolSandbox === "off") throw new Error("当前渠道已关闭工具权限，定时任务未执行");
      }
      const legacyOptions = await deps.buildOptions(task);
      signal?.throwIfAborted();
      legacyOptions.tools = effectiveTools;

      // 从传统 system 消息拆出人格，工具提示只列出本轮授权的工具。
      const sysIdx = legacyOptions.messages.findIndex((m) => m.role === "system");
      let soulSystemBaseContent: string;
      let messages = legacyOptions.messages;
      if (sysIdx >= 0) {
        const sysMsg = legacyOptions.messages[sysIdx];
        soulSystemBaseContent = typeof sysMsg.content === "string" ? sysMsg.content : "";
        messages = legacyOptions.messages.filter((_, i) => i !== sysIdx);
      } else {
        soulSystemBaseContent = "";
      }
      const toolSystemContent = buildToolSystemPrompt(runMode, effectiveTools);
      if (task.delivery) {
        soulSystemBaseContent += `\n\n${buildChannelSystem(task.delivery.channel)}`;
        const context = await deps.conversationJournal!.buildModelContext(conversationId!);
        legacyOptions.initialHarnessState = { todoItems: context.todoItems ?? [], uncertainEffects: context.uncertainEffects,
          ...(context.continuity ? { continuity: context.continuity } : {}) };
        // 保留同一 CTA 中压缩后的上下文；当前任务始终是最后一条明确指令。
        messages = [...context.messages.filter(message => message.role !== "system"), ...messages];
      }

      const options = applyScheduledExecutionPolicy({
        ...legacyOptions,
        ...(signal ? { signal } : {}),
        messages,
        toolSystemContent,
        soulSystemBaseContent,
        permissionMode: task.permissionMode ?? (task.delivery ? "normal" : "allow_all"),
        ...(task.delivery ? { channelContext: task.delivery } : {}),
        ...(conversationId ? { conversationId, runId: historyId } : { runId: historyId }),
        ...(task.workspaceBinding ? { resolvedWorkspaceRoot: task.workspaceBinding.workspaceRoot } : {}),
        ...(conversationId && deps.conversationJournal ? {
          transcriptSink: deps.conversationJournal.createRunSink({ conversationId, runId: historyId, assistantTurnId: replyId }),
        } : {}),
      }, runMode);
      transcriptSink = options.transcriptSink;

      if (conversationId && deps.conversationJournal) {
        await deps.conversationJournal.appendUser(conversationId, {
          id: noticeId,
          turnId: historyId,
          text: task.prompt,
          runId: historyId,
        });
        await appendPresentationWithRetry(conversationId, noticeId, `scheduler:${historyId}:notice`, { content: noticeText });
      }

      send({
        type: "CUSTOM",
        name: "scheduler.started",
        schedulerRunId: historyId,
        schedulerTaskId: task.id,
        ...(conversationId ? { conversationId } : {}),
        messageId: noticeId,
        value: { taskId: task.id, title: task.title, manual, firedAt: startedAt.toISOString(), runId: historyId, noticeId, replyId, ...(conversationId ? { conversationId } : {}) },
      });
      startedEventSent = true;
      deps.publishLifecycle?.publishTurnStarted({
        source: "scheduler",
        runId: historyId,
        mode: runMode,
        taskId: task.id,
        schedulerRunId: historyId,
        ...(conversationId ? { conversationId } : {}),
      });

      const agent = new CyreneAgent({ threadId: `scheduler-${task.id}`, description: `Scheduled task: ${task.title}` });
      signal?.throwIfAborted();

      await new Promise<void>((resolve, reject) => {
        const sub = agent.runWithEvents(options).subscribe({
          next: (event) => {
            if (event.type === "TOOL_CALL_START" && event.toolCallId) {
              const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
              if (!toolCallId) return;
              schedulerToolExecutions.push({
                id: toolCallId,
                name: typeof event.toolCallName === "string" ? event.toolCallName : "工具",
                ...(typeof event.toolCallDisplayName === "string" ? { displayName: event.toolCallDisplayName } : {}),
                status: "running",
              });
            } else if (event.type === "TOOL_CALL_RESULT" && event.toolCallId) {
              const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
              const tool = schedulerToolExecutions.find((item) => item.id === toolCallId);
              if (tool) {
                tool.status = event.status === "failed" ? "error" : "success";
                tool.result = (typeof event.content === "string" ? event.content : "").slice(0, 4000);
              }
            }
            const outboundEvent = {
              ...event,
              schedulerRunId: historyId,
              schedulerTaskId: task.id,
              ...(event.type === "CUSTOM" ? {} : { messageId: replyId }),
              ...(conversationId ? { conversationId } : {}),
            };
            if (event.type === "RUN_FINISHED") deferredRunFinished = outboundEvent;
            else send(outboundEvent);
          },
          error: (err) => {
            sub.unsubscribe();
            reject(err instanceof Error ? err : new Error(String(err)));
          },
          complete: () => {
            sub.unsubscribe();
            resolve();
          },
        });
      });

      const finishedAt = deps.now();
      const reply = agent.lastResult?.reply ?? "";
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      // Observable 在超时等非成功终态下也会正常 complete：事件状态以 agent 终态为准
      const status: PluginTurnStatus = agent.lastResult?.terminal?.status ?? "success";
      const displayReply = resolveSchedulerDisplayReply(reply, schedulerToolExecutions);
      const terminalRunSnapshot: NonNullable<ChatMessage["runSnapshot"]> = {
        runId: historyId,
        status: "terminal",
        terminalStatus: status,
        updatedAt: Date.now(),
      };
      if (conversationId && transcriptSink) {
        const messageId = transcriptSink.getLastAssistantEntryId?.();
        if (messageId) {
          const presentationMutationKey = `scheduler:${historyId}:reply:${encodeURIComponent(displayReply)}`;
          const presentationPatch = {
            content: displayReply,
            toolExecutions: schedulerToolExecutions,
            runSnapshot: terminalRunSnapshot,
          } as const;
          // A presentation append may have reached JSONL before its projection
          // refresh failed. Retry the exact patch/key so the queue resolves the
          // already-written mutation instead of splitting UI and durable state.
          await appendPresentationWithRetry(conversationId, replyId, presentationMutationKey, presentationPatch);
        }
      }
      if (status !== "success") {
        publishFailure(finishedAt, status, `定时任务${status}终止`);
        return { ok: false, historyId, error: status, effectiveToolIds };
      }
      if (task.delivery) {
        if (!transcriptSink?.getLastAssistantEntryId?.()) throw new Error("任务回复尚未写入权威会话，取消外发");
        const result = await createChannelDeliveryService(channelManager).send(
          buildScheduledDeliveryMessage(
            task.delivery.channel,
            task.delivery.targetId,
            displayReply,
            channelManager.getAdapter(task.delivery.channel)?.capability,
            task.delivery.threadId,
          ),
          { operationId: `scheduler:${historyId}:delivery`, conversationId: conversationId!, assistantTurnId: replyId, runId: historyId, signal },
        );
        await deps.conversationJournal!.appendDeliveryReceipt(conversationId!, {
          assistantTurnId: replyId, channel: task.delivery.channel, runId: historyId,
          status: result.ok ? "delivered" : "failed", revision: 1,
          ...(!result.ok ? { errorCode: result.status === "unknown" ? "DELIVERY_UNCONFIRMED" : result.error } : {}),
        });
        if (!result.ok) {
          publishFailure(deps.now(), "runtime_error", result.error);
          if (result.status === "unknown") deps.recordHistory({
            id: historyId, taskId: task.id, taskTitle: task.title, firedAt: startedAt.toISOString(),
            finishedAt: deps.now().toISOString(), status: "unknown", effectiveToolIds,
            sessionId: conversationId!, outputPreview: displayReply.slice(0, 160),
            errorMessage: "渠道投递结果未知，请核对后再操作；不会自动重发。",
          });
          return { ok: false, historyId, error: result.error, effectiveToolIds };
        }
        appendChannelHistory(task.delivery.sessionId, "assistant", displayReply);
        appendChannelLog({ dir: "outgoing", channel: task.delivery.channel, senderId: task.delivery.targetId,
          chatId: task.delivery.targetId, text: displayReply, hasAttachments: false });
      }
      deps.recordHistory({
        id: historyId,
        taskId: task.id,
        taskTitle: task.title,
        firedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs,
        status: "success",
        outputPreview: displayReply.slice(0, 160),
        effectiveToolIds,
        ...(conversationId ? { sessionId: conversationId } : {}),
      });
      deps.publishLifecycle?.publishTurnFinished({
        source: "scheduler",
        runId: historyId,
        mode: runMode,
        taskId: task.id,
        schedulerRunId: historyId,
        status,
        durationMs,
        ...(conversationId ? { conversationId } : {}),
      });
      deps.publishLifecycle?.publishSchedulerFinished({
        taskId: task.id,
        schedulerRunId: historyId,
        status,
        durationMs,
        ...(conversationId ? { conversationId } : {}),
      });
      // 注意力提醒：任务成功完成时通知 ToastService 弹右下角提醒（失败不弹，V1 边界）
      if (status === "success") {
        toastEvents.publishSchedulerFinished({
          schedulerRunId: historyId,
          taskId: task.id,
          taskTitle: task.title,
          status,
          outputPreview: displayReply.slice(0, 160),
        });
      }
      if (deferredRunFinished) send({
        ...deferredRunFinished,
        content: displayReply,
        message: displayReply,
        toolExecutions: schedulerToolExecutions,
        runSnapshot: terminalRunSnapshot,
      });
      return { ok: true, historyId, reply: displayReply, effectiveToolIds };
    } catch (err) {
      const finishedAt = deps.now();
      const message = err instanceof Error ? err.message : String(err);
      const errorCode = err instanceof AgentRuntimeError ? err.code : undefined;
      publishFailure(finishedAt, "runtime_error", message, errorCode);
      return { ok: false, historyId, error: message, effectiveToolIds };
    }
  }

  const prepareScheduledTask = (task: ScheduledTask, scheduledFireAt: Date, manual: boolean) => {
    const frozenTask = structuredClone(task);
    const target = task.delivery?.conversationId ?? task.delivery?.sessionId
      ?? (!task.workspaceBinding ? deps.getActiveConversation?.()?.sessionId : null);
    const historyId = deps.id(), startedAt = deps.now();
    const effectiveToolIds = task.delivery && task.kind !== "agent" ? [] : filterToolsForTask(task, toolRegistry.getAllTools()).map(tool => tool.id);
    // Persist BEFORE waiting for another conversation run. The engine consumes
    // the scheduled occurrence immediately; a crash in this queue must be visible.
    deps.recordHistory({ id: historyId, taskId: task.id, taskTitle: task.title, firedAt: startedAt.toISOString(),
      status: "running", reason: target ? "waiting_for_conversation" : manual ? "manual fireNow" : undefined,
      effectiveToolIds, ...(target ? { sessionId: target } : {}) });
    return async (signal?: AbortSignal): Promise<ScheduledRunResult> => {
      let began = false;
      const execute = () => { began = true; return runScheduledTask(frozenTask, scheduledFireAt, manual, historyId, startedAt, target, signal); };
      try {
        signal?.throwIfAborted();
        return target ? await withConversationRun(target, execute, signal) : await execute();
      } catch (error) {
        const cancelled = signal?.aborted && !began;
        const reason = cancelled ? "等待会话期间已取消，未执行模型、工具或发送" : error instanceof Error ? error.message : String(error);
        deps.recordHistory({ id: historyId, taskId: task.id, taskTitle: task.title, firedAt: startedAt.toISOString(), finishedAt: deps.now().toISOString(),
          status: cancelled ? "skipped" : "unknown", reason, effectiveToolIds, ...(target ? { sessionId: target } : {}) });
        return { ok: false, historyId, error: reason, effectiveToolIds };
      }
    };
  };
  return {
    prepareScheduledTask,
    runScheduledTask: async (task: ScheduledTask, scheduledFireAt: Date, manual: boolean, signal?: AbortSignal) => prepareScheduledTask(task, scheduledFireAt, manual)(signal),
  };
}
