import { AMPHOREUS_RESIDENTS } from "../../shared/amphoreus-canon";
import type { AmphoreusState, EventCondition, WorldEffect } from "../../shared/amphoreus-world";
import { neglectedResidents } from "./narrative";
export interface PlannedFixture {
  startMinute: number; durationMinutes: number; locationId: string; participants: string[];
  activity: string; severity: string; title: string; summary: string; conditions?: EventCondition[];
  visibility?: string;
}
export function plan(date = "2026-11-10", cyrene = false): { date: string; events: PlannedFixture[] } {
  const event = (startMinute: number, locationId: string, participants: string[], title: string): PlannedFixture => ({ startMinute, durationMinutes: 45, locationId, participants, activity: "work", severity: "notable", title, summary: `准备${title}` });
  return { date, events: [
    event(570, "okhema", ["aglaea", "demeter", "nike"], "协商供给"),
    event(900, "grove", ["anaxa", "dan-heng"], "整理研究记录"),
    event(1185, "aedes-elysiae", ["phainon", cyrene ? "cyrene" : "hatonus"], "讨论村落往来"),
  ] };
}
export function rotatingPlan(state: AmphoreusState, date: string, now: number) {
  const selected = new Set([...neglectedResidents(state, now).slice(0, 3), "aglaea", "demeter", "anaxa", "phainon", "nike", "cyrene"]);
  const grouped = new Map<string, string[]>();
  for (const id of selected) { const person = AMPHOREUS_RESIDENTS.find((r) => r.id === id)!; grouped.set(person.home, [...(grouped.get(person.home) ?? []), id]); }
  return { date, events: [...grouped].map(([locationId, participants]) => ({ startMinute: 570, durationMinutes: 45, locationId, participants, activity: "work", severity: "routine", title: `${date}的日常协作`, summary: "讨论各自的需求，尝试解决今天手边的问题。" })) };
}
export function resolutionOutput(state: AmphoreusState, effects: WorldEffect[] = []) {
  return JSON.stringify({ resolutions: state.days.flatMap((day) => day.events).filter((e) => e.status === "awaiting_resolution").slice(0, 6).map((event, i) => ({
    eventId: event.id, version: event.version, status: "completed", outcome: `${event.title}留下了新的记录。`, effects: i ? [] : effects,
    developments: event.locationId === "okhema" ? [{ id: "daily-supplies", title: "日常物资", summary: "已完成一次供需核对。", nextStep: "明天核对配送情况。", participants: event.participants, status: "open" }] : [],
  })) });
}
