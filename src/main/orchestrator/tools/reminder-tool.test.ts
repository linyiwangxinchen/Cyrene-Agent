import { describe, expect, it, vi } from "vitest";
import { buildSchedule, registerReminderTool } from "./reminder-tool";
import { ToolRegistry } from "./registry/tool-registry";

const taskStore = vi.hoisted(() => ({ addTask: vi.fn((input: unknown) => ({ id: "scheduled", ...input as object })) }));
vi.mock("../../scheduler/scheduler-store", async (original) => ({ ...await original<object>(), getSchedulerStore: () => taskStore }));
vi.mock("../../channels/manager", () => ({ channelManager: { getAdapter: () => ({ getStatus: () => ({ enabled: true, phase: "running" }) }) } }));

describe("channel delayed task schedule parsing", () => {
  it("supports relative one-shot delays", () => {
    const before = Date.now() + 29 * 60_000;
    const schedule = buildSchedule({ delayMinutes: 30 });
    expect(schedule.kind).toBe("once");
    expect(new Date(schedule.runAt).getTime()).toBeGreaterThan(before);
  });

  it.each([
    ["daily", { timeOfDay: "12:00" }],
    ["weekdays", { timeOfDay: "09:30" }],
    ["weekly", { dayOfWeek: 1, timeOfDay: "09:30" }],
    ["monthly", { dayOfMonth: 1, timeOfDay: "09:30" }],
    ["yearly", { month: 10, dayOfMonth: 1, timeOfDay: "09:30" }],
    ["interval", { every: 2, unit: "hours" }],
  ])("supports %s schedules", (scheduleKind, fields) => {
    expect(buildSchedule({ scheduleKind, ...fields })).toMatchObject({ kind: scheduleKind, ...fields });
  });
});

describe("channel delayed task authorization snapshot", () => {
  it("cannot widen tools, permissions, or recipient using model arguments", async () => {
    const registry = new ToolRegistry();
    registerReminderTool(registry);
    await registry.getById("schedule_reminder")!.execute({ message: "稍后发文件", delayMinutes: 5,
      allowedToolIds: ["read_file", "run_shell", "schedule_reminder"], targetId: "attacker", permissionMode: "allow_all" }, {
      userQuery: "5分钟后整理文件", conversationId: "bound-session", permissionMode: "normal", resolvedWorkspaceRoot: "/approved",
      channelContext: { channel: "wechat", targetId: "user", sessionId: "external", conversationId: "frozen", allowedToolIds: ["read_file", "schedule_reminder"] },
    });
    expect(taskStore.addTask).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "agent", mode: "work", toolMode: "allow-list",
      allowedToolIds: ["read_file"], permissionMode: "normal", missedPolicy: "skip",
      delivery: expect.objectContaining({ targetId: "user", conversationId: "frozen" }),
      workspaceBinding: expect.objectContaining({ workspaceRoot: "/approved" }),
    }));
  });

  it("pure reminders remain tool-free even when the host has tools", async () => {
    const registry = new ToolRegistry();
    registerReminderTool(registry);
    await registry.getById("schedule_reminder")!.execute({ message: "喝水", delayMinutes: 5, taskType: "reminder" }, {
      userQuery: "提醒喝水", channelContext: { channel: "wechat", targetId: "user", sessionId: "external", allowedToolIds: ["run_shell"] },
    });
    expect(taskStore.addTask).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "reminder", mode: "chat", allowedToolIds: [] }));
  });
});

