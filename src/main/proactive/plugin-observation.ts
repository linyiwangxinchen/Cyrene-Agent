import type { CompanionMoment } from "./companion-life";
import { bilibiliVideoSource, normalizeBilibiliVideoEvidence } from "./bilibili-share";

/** Convert a plugin payload into the small, sanitized shape the life queue accepts. */
export function normalizePluginObservation(
  pluginId: string,
  event: string,
  payload: unknown,
): Omit<CompanionMoment, "status"> | null {
  if (pluginId !== "bili-garden" || event !== "interesting-item") return null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  const itemId = typeof value.eventId === "string" && value.eventId.trim()
    ? value.eventId.trim().slice(0, 160)
    : typeof value.bvid === "string" && value.bvid.trim() ? value.bvid.trim().slice(0, 80) : undefined;
  const title = typeof value.title === "string" ? value.title.trim().slice(0, 200) : "";
  const say = typeof value.say === "string" ? value.say.trim().slice(0, 500) : "";
  const summary = typeof value.summary === "string" ? value.summary.trim().slice(0, 700) : "";
  if (!itemId || (!title && !summary && !say)) return null;
  const bilibiliVideo = normalizeBilibiliVideoEvidence({
    bvid: value.bvid, title, summary: summary || say, reason: value.reason, clip: value.clip,
  });
  const url = bilibiliVideo ? bilibiliVideoSource(bilibiliVideo) : "";
  return {
    id: `plugin:${pluginId}:${itemId}`,
    kind: "share",
    source: "plugin",
    summary: [title, summary || say, url].filter(Boolean).join("\n").slice(0, 1000),
    ...(bilibiliVideo ? { bilibiliVideo } : {}),
    occurredAt: typeof value.occurredAt === "number" && Number.isFinite(value.occurredAt) ? value.occurredAt : Date.now(),
    ...(typeof value.conversationId === "string" ? { conversationId: value.conversationId.slice(0, 200) } : {}),
    pluginId,
  };
}
