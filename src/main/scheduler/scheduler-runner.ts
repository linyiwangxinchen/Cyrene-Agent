import type { WebContents } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { PluginPromptMode, PluginTurnStatus } from "../../plugins/api";
import type { ChatMessage } from "../../shared/chat-types";
import { AgentRuntimeError } from "../orchestrator/agent-runtime-error";
import { CyreneAgent, type CyreneRunOptions } from "../orchestrator/cyrene-agent";
import type { LifecyclePublisher } from "../plugin-host/lifecycle-publisher";
import type { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import type { ActiveConversationSelection } from "../chats/active-conversation-registry";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { toastEvents } from "../toast/toast-events";
import { channelManager } from "../channels/manager";
import { createChannelDeliveryService } from "../channels/delivery-service";
import { appendHistory as appendChannelHistory } from "../channels/history-log";
import { appendLog as appendChannelLog } from "../channels/message-log";
import type { OutgoingMessage } from "../channels/types";
import { buildChannelSystem } from "../orchestrator/expression-context-core";
import { filterToolsForTask } from "./tool-filter";
import type { ScheduledRunResult, ScheduledTask, ScheduledTaskHistoryEntry } from "./types";

/**
 * 第一期：scheduler 的 buildOptions 返回"传统"形式（包含 system 消息）。
 * CyreneAgent 暂时通过 fallback 兼容：检测 options.messages[0].role === "system" 时，
 * 用它作为 soulSystemBaseContent（重复一次），toolSystemContent 用同一个串（暂时不拆分）。
 *
 * 第二期：scheduler 同步迁移到 tool_system / soul_system 分阶段，buildOptions 改为返回
 * 带 toolSystemContent / soulSystemBaseContent 的 CyreneRunOptions。
 */
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
 * 定时任务是无人值守的 Work Harness：不询问、不审批，直接执行已分配工具。
 * 会话模式来自任务冻结的 mode 字段（旧任务默认 work）；执行循环沿用现有
 * 映射：chat 走 chat loop，其余模式走 work harness。
 */
export function applyScheduledExecutionPolicy(options: CyreneRunOptions, mode: PluginPromptMode = "work"): CyreneRunOptions {
  return {
    ...options,
    executionMode: mode === "chat" ? "chat" : "work",
    conversationMode: mode,
    harnessInteractiveTools: false,
    permissionMode: "allow_all",
  };
}

export function createSchedulerRunner(deps: RunnerDeps) {
  async function runScheduledTask(task: ScheduledTask, _scheduledFireAt: Date, manual: boolean): Promise<ScheduledRunResult> {
    const historyId = deps.id();
    const startedAt = deps.now();

    // 渠道提醒不创建本地工作区会话，但到点仍启动一次昔涟 Chat 生成；
    // 用户的提醒内容只是意图，最终发送内容由模型结合渠道人格自然生成。
    if (task.delivery) {
      const effectiveToolIds: string[] = [];
      deps.recordHistory({
        id: historyId,
        taskId: task.id,
        taskTitle: task.title,
        firedAt: startedAt.toISOString(),
        status: "running",
        reason: manual ? "manual fireNow" : undefined,
        effectiveToolIds,
      });
      let reply = "";
      try {
        const legacyOptions = await deps.buildOptions(task);
        const sysIdx = legacyOptions.messages.findIndex((m) => m.role === "system");
        const baseSoul = sysIdx >= 0 && typeof legacyOptions.messages[sysIdx].content === "string"
          ? legacyOptions.messages[sysIdx].content
          : "";
        const messages = legacyOptions.messages.filter((_, index) => index !== sysIdx);
        const options = applyScheduledExecutionPolicy({
          ...legacyOptions,
          messages,
          executionMode: "chat",
          conversationMode: "chat",
          tools: [],
          toolSystemContent: "",
          soulSystemBaseContent: `${baseSoul}\n\n${buildChannelSystem(task.delivery.channel)}`,
          permissionMode: "normal",
          runId: historyId,
          channelContext: task.delivery,
        }, "chat");
        const agent = new CyreneAgent({ threadId: `channel-reminder-${task.id}`, description: `Channel reminder: ${task.title}` });
        await new Promise<void>((resolve, reject) => {
          const sub = agent.runWithEvents(options).subscribe({
            error: (error) => { sub.unsubscribe(); reject(error instanceof Error ? error : new Error(String(error))); },
            complete: () => { sub.unsubscribe(); resolve(); },
          });
        });
        reply = (agent.lastResult?.reply ?? "").trim();
        if (!reply) throw new Error("模型未生成可发送的提醒内容");
      } catch (error) {
        const finishedAt = deps.now();
        const message = error instanceof Error ? error.message : String(error);
        deps.recordHistory({
          id: historyId,
          taskId: task.id,
          taskTitle: task.title,
          firedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          status: "failed",
          errorMessage: message,
          effectiveToolIds,
        });
        return { ok: false, historyId, error: message, effectiveToolIds };
      }
      const delivery = createChannelDeliveryService(channelManager);
      const message: OutgoingMessage = {
        channel: task.delivery.channel,
        targetId: task.delivery.targetId,
        ...(task.delivery.threadId ? { threadId: task.delivery.threadId } : {}),
        parts: [{ kind: "text", text: reply }],
      };
      const result = await delivery.send(message);
      const finishedAt = deps.now();
      if (!result.ok) {
        deps.recordHistory({
          id: historyId,
          taskId: task.id,
          taskTitle: task.title,
          firedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          status: "failed",
          errorMessage: result.error ?? "渠道提醒发送失败",
          effectiveToolIds,
        });
        return { ok: false, historyId, error: result.error ?? "渠道提醒发送失败", effectiveToolIds };
      }
      appendChannelHistory(task.delivery.sessionId, "assistant", reply);
      appendChannelLog({
        dir: "outgoing",
        channel: task.delivery.channel,
        senderId: task.delivery.targetId,
        chatId: task.delivery.targetId,
        text: reply,
        hasAttachments: false,
      });
      deps.recordHistory({
        id: historyId,
        taskId: task.id,
        taskTitle: task.title,
        firedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        status: "success",
        outputPreview: reply.slice(0, 160),
        effectiveToolIds,
      });
      return { ok: true, historyId, reply, effectiveToolIds };
    }

    const allTools = toolRegistry.getAllTools();
    const effectiveTools = filterToolsForTask(task, allTools);
    const effectiveToolIds = effectiveTools.map(t => t.id);
    // Freeze the UI target before any async build work; a later window switch
    // must not redirect this run's canonical facts or presentation events.
    let conversationId: string | null = null;
    let sessionCreationError: Error | undefined;
    if (task.workspaceBinding) {
      try {
        conversationId = (await deps.createRunSession?.(task)) ?? null;
        if (!conversationId) sessionCreationError = new Error("无法为定时任务创建独立会话");
      } catch (error) {
        sessionCreationError = error instanceof Error ? error : new Error(String(error));
      }
    } else {
      conversationId = deps.getActiveConversation?.()?.sessionId ?? null;
    }
    const runMode = task.mode ?? "work";
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

    deps.recordHistory({
      id: historyId,
      taskId: task.id,
      taskTitle: task.title,
      firedAt: startedAt.toISOString(),
      status: "running",
      reason: manual ? "manual fireNow" : undefined,
      effectiveToolIds,
      ...(conversationId ? { sessionId: conversationId } : {}),
    });

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
      if (sessionCreationError) throw sessionCreationError;
      const legacyOptions = await deps.buildOptions(task);
      legacyOptions.tools = effectiveTools;

      // 第一期兼容：把传统 messages 里的 system 消息拆出来作为 soulSystemBaseContent。
      // toolSystemContent 暂用同一份（scheduler 第二期再迁）。
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
      const toolSystemContent = soulSystemBaseContent; // 第一期暂用同一份

      const options = applyScheduledExecutionPolicy({
        ...legacyOptions,
        messages,
        toolSystemContent,
        soulSystemBaseContent,
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
      deps.recordHistory({
        id: historyId,
        taskId: task.id,
        taskTitle: task.title,
        firedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs,
        status: status === "success" ? "success" : "failed",
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

  return { runScheduledTask };
}
