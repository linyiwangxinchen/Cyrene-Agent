import type { AmphoreusClock } from "../../shared/amphoreus-world";

const formatters = new Map<string, Intl.DateTimeFormat>();
const timezones = new Map<string, string>();
export function worldTimezone(timezone: string): string {
  const cached = timezones.get(timezone);
  if (cached) return cached;
  if (timezones.size >= 32) timezones.clear();
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    timezones.set(timezone, timezone);
    return timezone;
  } catch { timezones.set(timezone, "UTC"); return "UTC"; }
}
export function worldClock(now: number, timezone: string): AmphoreusClock {
  timezone = worldTimezone(timezone);
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    if (formatters.size >= 16) formatters.clear();
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(now);
  const part = (key: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === key)!.value;
  const minute = Number(part("hour")) * 60 + Number(part("minute"));
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}`, minute, timezone,
    phase: minute < 360 || minute >= 1260 ? "night" : minute < 480 ? "dawn" : minute < 720 ? "morning" : minute < 810 ? "noon" : minute < 1080 ? "afternoon" : "dusk" };
}

/** Convert a wall-clock minute to an instant, re-evaluating the UTC offset across DST. */
export function worldInstant(date: string, minute: number, timezone: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`) + minute * 60_000;
  let instant = wall;
  for (let i = 0; i < 4; i++) {
    const local = worldClock(instant, timezone);
    const delta = wall - (Date.parse(`${local.date}T00:00:00Z`) + local.minute * 60_000);
    if (delta === 0) return instant;
    instant += delta;
  }
  // The caller rejects events whose local wall time does not exist (DST gap).
  return instant;
}
