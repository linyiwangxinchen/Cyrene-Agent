import { createHash } from "node:crypto";
import type { IncomingMessage } from "./types";

export function resolveChannelMemoryScope(
  input: Pick<IncomingMessage, "channel" | "accountId" | "senderId" | "chatType">,
): string | undefined {
  if (input.chatType !== "private") return;
  const accountId = input.accountId?.trim();
  const senderId = input.senderId.trim();
  if (!accountId || !senderId) return;
  return "peer:" + createHash("sha256").update(JSON.stringify([input.channel, accountId, senderId])).digest("hex");
}
