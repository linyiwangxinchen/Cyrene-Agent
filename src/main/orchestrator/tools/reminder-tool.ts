import { getSchedulerStore, validateSchedule } from "../../scheduler/scheduler-store";
import type { ScheduleConfig } from "../../scheduler/types";
import { channelManager } from "../../channels/manager";
import type { ToolContext } from "./registry/tool-context";
import type { ToolRegistry } from "./registry/tool-registry";

function parseRunAt(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

export function buildSchedule(args: Record<string, unknown>): ScheduleConfig {
  const kind = String(args.scheduleKind ?? "once");
  if (kind === "once") {
    const delayMinutes = Number(args.delayMinutes);
    const runAt = parseRunAt(args.runAt)
      ?? (Number.isFinite(delayMinutes) && delayMinutes > 0
        ? new Date(Date.now() + delayMinutes * 60_000)
        : null);
    if (!runAt || runAt.getTime() <= Date.now()) {
      throw new Error("一次性任务的 runAt 必须是未来时间，请使用带时区的 ISO 8601 格式");
    }
    return { kind: "once" as const, runAt: runAt.toISOString() };
  }
  if (kind === "daily") return { kind: "daily" as const, timeOfDay: String(args.timeOfDay ?? "") };
  if (kind === "weekdays") return { kind: "weekdays" as const, timeOfDay: String(args.timeOfDay ?? "") };
  if (kind === "weekly") {
    const dayOfWeek = Number(args.dayOfWeek);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) throw new Error("weekly 的 dayOfWeek 必须是 0-6");
    return {
    kind: "weekly" as const,
    dayOfWeek: dayOfWeek as 0 | 1 | 2 | 3 | 4 | 5 | 6,
    timeOfDay: String(args.timeOfDay ?? ""),
    };
  }
  if (kind === "monthly") return {
    kind: "monthly" as const,
    dayOfMonth: Number(args.dayOfMonth),
    timeOfDay: String(args.timeOfDay ?? ""),
  };
  if (kind === "yearly") return {
    kind: "yearly" as const,
    month: Number(args.month),
    dayOfMonth: Number(args.dayOfMonth),
    timeOfDay: String(args.timeOfDay ?? ""),
  };
  if (kind === "interval") return {
    kind: "interval" as const,
    every: Number(args.every),
    unit: String(args.unit ?? "minutes") as "minutes" | "hours",
  };
  throw new Error("不支持的 scheduleKind");
}

/** 注册给微信/飞书私聊的通用延时任务工具。到点会再次调用昔涟生成自然回复。 */
export function registerReminderTool(registry: ToolRegistry): void {
  registry.register({
    id: "schedule_reminder",
    name: "设置延时任务",
    description:
      "创建一次性或重复的延时任务，到时间通过当前私聊渠道再次调用昔涟生成自然回复。" +
      "支持到点查询、处理文件、生成内容并回复当前私聊，冻结当前会话、工具与权限；不会因任务延期而增加权限。" +
      "用于用户明确要求的提醒、稍后执行、每日/每周播报；当前仅支持微信或飞书私聊，不能用于群聊。任务失败不会自动重做。",
    catalogHint: "创建延时或重复任务，到点通过当前私聊渠道生成回复",
    enabled: true,
    risk: "safe",
    effectKind: "external_side_effect",
    verificationPolicy: "none",
    needsContext: true,
    modes: ["chat", "work"],
    inputSchema: {
      type: "object",
      properties: {
        scheduleKind: {
          type: "string",
          enum: ["once", "daily", "weekdays", "weekly", "monthly", "yearly", "interval"],
          description: "调度类型，默认 once",
        },
        runAt: {
          type: "string",
          description: "once 类型的未来执行时间，ISO 8601；例如 2026-10-12T12:00:00+08:00",
        },
        delayMinutes: { type: "number", description: "once 类型也可用相对延时，例如 30 表示 30 分钟后" },
        timeOfDay: { type: "string", description: "daily/weekdays/weekly/monthly/yearly 使用的 HH:mm 时间" },
        dayOfWeek: { type: "number", description: "weekly 使用，0=周日，1=周一，直到 6=周六" },
        dayOfMonth: { type: "number", description: "monthly/yearly 使用，1-31" },
        month: { type: "number", description: "yearly 使用，1-12" },
        every: { type: "number", description: "interval 使用的正整数间隔" },
        unit: { type: "string", enum: ["minutes", "hours"], description: "interval 的单位" },
        message: { type: "string", description: "到点时希望昔涟完成或提醒的事情" },
        title: { type: "string", description: "提醒标题，可选" },
        maxRuns: { type: "number", description: "最多执行次数，可选；once 默认 1" },
        taskType: { type: "string", enum: ["agent", "reminder"], description: "agent（默认）到点可使用当前已授权工具执行任务；reminder 仅生成提醒、不调用工具" },
        allowedToolIds: { type: "array", items: { type: "string" }, description: "可选：进一步限制到点可用工具 ID，不能超出当前轮权限" },
        missedPolicy: { type: "string", enum: ["skip", "run-within-grace"], description: "默认 skip 跳过停机错过的任务；仅当用户明确要求补执行时使用 run-within-grace" },
        missedGraceMinutes: { type: "number", description: "允许补执行的宽限分钟，1-1440；默认15。不得用于重试已开始或结果未知的任务" },
      },
      required: ["message"],
    },
    execute: async (args: Record<string, unknown>, ctx?: ToolContext) => {
      const target = ctx?.channelContext;
      if (!target || (target.channel !== "wechat" && target.channel !== "feishu")) {
        return "[错误] 设置延时任务需要在微信或飞书私聊中使用；当前会话没有可投递的外部渠道目标";
      }
      if (target.chatType === "group") {
        return "[错误] 为避免把提醒发给整个群聊，定时主动提醒目前只支持微信或飞书私聊";
      }
      const adapter = channelManager.getAdapter(target.channel);
      if (!adapter || adapter.getStatus().phase !== "running") {
        return `[错误] ${target.channel === "wechat" ? "微信" : "飞书"}连接当前不可用，请先保持渠道连接`;
      }
      const message = String(args.message ?? "").trim();
      if (!message) return "[错误] 延时任务内容不能为空";
      let schedule;
      try {
        schedule = buildSchedule(args);
        validateSchedule(schedule);
      } catch (error) {
        return `[错误] ${error instanceof Error ? error.message : String(error)}`;
      }
      const title = String(args.title ?? "").trim() || message.slice(0, 24);
      const maxRunsValue = args.maxRuns === undefined
        ? (schedule.kind === "once" ? 1 : undefined)
        : Number(args.maxRuns);
      const task = getSchedulerStore().addTask({
        title,
        prompt: message,
        enabled: true,
        schedule,
        ...(maxRunsValue !== undefined ? { maxRuns: maxRunsValue } : {}),
        mode: args.taskType === "reminder" ? "chat" : "work",
        kind: args.taskType === "reminder" ? "reminder" : "agent",
        delivery: { channel: target.channel, targetId: target.targetId, sessionId: target.sessionId,
          conversationId: target.conversationId ?? ctx?.conversationId ?? target.sessionId,
          ...(target.chatType ? { chatType: target.chatType } : {}), ...(target.threadId ? { threadId: target.threadId } : {}) },
        toolMode: "allow-list",
        allowedToolIds: args.taskType === "reminder" ? [] : (target.allowedToolIds ?? []).filter(id =>
          !["schedule_reminder", "cancel_channel_scheduled_task"].includes(id)
          && (!Array.isArray(args.allowedToolIds) || args.allowedToolIds.includes(id))),
        permissionMode: ctx?.permissionMode === "allow_all" ? "allow_all" : "normal",
        ...(ctx?.resolvedWorkspaceRoot ? { workspaceBinding: { workspaceRoot: ctx.resolvedWorkspaceRoot,
          displayName: ctx.resolvedWorkspaceRoot, boundAt: Date.now() } } : {}),
        missedPolicy: args.missedPolicy === "run-within-grace" ? "run-within-grace" : "skip",
        ...(args.missedGraceMinutes !== undefined ? { missedGraceMinutes: Number(args.missedGraceMinutes) } : {}),
      });
      const scheduleText = schedule.kind === "once"
        ? `于 ${new Date(schedule.runAt).toLocaleString("zh-CN", { hour12: false })}`
        : schedule.kind === "interval"
          ? `按 interval 规则（每 ${schedule.every}${schedule.unit === "hours" ? "小时" : "分钟"}）`
          : `按 ${schedule.kind} 规则（${schedule.timeOfDay}）`;
      return `已设置延时任务，将${scheduleText}通过当前${target.channel === "wechat" ? "微信" : "飞书"}私聊触发昔涟回复：${message}（任务 ${task.id}）`;
    },
  });

  registry.register({
    id: "list_channel_scheduled_tasks",
    name: "查看延时任务",
    description: "查看当前微信或飞书私聊下已经创建的一次性或重复延时任务，取消任务前先调用此工具获取任务 ID。",
    catalogHint: "查看当前私聊的延时任务列表",
    enabled: true,
    effectKind: "read",
    verificationPolicy: "none",
    needsContext: true,
    modes: ["chat", "work"],
    inputSchema: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      const target = ctx?.channelContext;
      if (!target || (target.channel !== "wechat" && target.channel !== "feishu")) return "[错误] 当前会话没有外部渠道目标";
      const tasks = getSchedulerStore().getTasks().filter(task =>
        task.delivery?.channel === target.channel
        && task.delivery.targetId === target.targetId
        && task.delivery.sessionId === target.sessionId,
      );
      if (tasks.length === 0) return "当前私聊没有已创建的延时任务";
      return tasks.map(task => `${task.id}｜${task.title}｜${task.enabled ? "启用" : "停用"}｜下次：${task.nextFireAt ?? "无"}｜内容：${task.prompt}`).join("\n");
    },
  });

  registry.register({
    id: "cancel_channel_scheduled_task",
    name: "取消延时任务",
    description: "取消当前微信或飞书私聊下的延时任务。必须使用查看延时任务返回的任务 ID，只能取消当前私聊自己创建的任务。",
    catalogHint: "取消当前私聊中的延时任务",
    enabled: true,
    effectKind: "mutation",
    verificationPolicy: "none",
    needsContext: true,
    modes: ["chat", "work"],
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string", description: "查看延时任务返回的任务 ID" } },
      required: ["taskId"],
    },
    execute: async (args, ctx) => {
      const target = ctx?.channelContext;
      if (!target || (target.channel !== "wechat" && target.channel !== "feishu")) return "[错误] 当前会话没有外部渠道目标";
      const taskId = String(args.taskId ?? "").trim();
      const task = getSchedulerStore().getTasks().find(item =>
        item.id === taskId
        && item.delivery?.channel === target.channel
        && item.delivery.targetId === target.targetId
        && item.delivery.sessionId === target.sessionId,
      );
      if (!task) return "[错误] 找不到属于当前私聊的延时任务，请先查看任务列表";
      getSchedulerStore().updateTask(task.id, { enabled: false, nextFireAt: null });
      return `已取消延时任务「${task.title}」（${task.id}）`;
    },
  });
}
