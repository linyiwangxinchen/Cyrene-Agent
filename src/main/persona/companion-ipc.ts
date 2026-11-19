import { IPC } from "../../shared/ipc-channels";
import type { CompanionCommand, CompanionWorldSuggestion, CompanionWorldSuggestionInput, CompanionWorldSuggestionResult } from "../../shared/companion";
import type { PersonalAction } from "../../shared/amphoreus-world";
import type { IpcScope } from "../application/ipc-scope";
import { isGroupBoundConversation } from "../channels/conversation-binding-store";
import { getSession, getSessionRecord } from "../chats/chats-store";
import { getRelationshipStore } from "../relationship/relationship-log";
import type { RelationshipLogStore } from "../relationship/relationship-log-core";
import type { ProactiveLifecycle } from "../proactive/proactive-lifecycle";
import { getSharedXilianWorldStore } from "../xilian-world/world-store";
import path from "node:path";
import { app } from "electron";
import { worldUpdate } from "../amphoreus-world/world-update";

async function requirePrivateChat(conversationId: unknown): Promise<string> {
  if (typeof conversationId !== "string" || !conversationId.trim() || conversationId.length > 200) throw new Error("无效的会话标识");
  const session = await getSession(conversationId);
  if (!session || session.mode !== "chat" || session.purpose || isGroupBoundConversation(conversationId)
      || session.messages.some((message) => message.channelSource?.chatType === "group")) {
    throw new Error("只有普通私聊可以建议翁法罗斯里的小事");
  }
  return conversationId;
}

function suggestionView({ id, title, status, startsAt, endsAt, outcome, reason }: PersonalAction): CompanionWorldSuggestion {
  return { id, title, status, startsAt, endsAt, ...(outcome ? { outcome } : {}), ...(reason ? { reason } : {}) };
}

/** Same handlers for Electron and authenticated headless core transport. */
export function registerCompanionIpc(
  ipc: IpcScope,
  store: RelationshipLogStore = getRelationshipStore(),
  world?: Pick<ProactiveLifecycle, "getWorldSnapshot" | "queryWorldTimeline" | "getWorldView" | "setWorldNarrativeEnabled" | "retryWorldNarrative">,
): void {
  ipc.handle(IPC.COMPANION_GET, () => store.snapshot());
  const readWorld = () => {
    if (world) return world.getWorldView({ limit: 80 });
    const store = getSharedXilianWorldStore(path.join(app.getPath("userData"), "xilian-world.json"));
    const state = store.advance();
    return store.worldView({ dateKey: state.worldDate, limit: 80 });
  };
  ipc.handle(IPC.COMPANION_WORLD_GET, readWorld);
  ipc.handle(IPC.COMPANION_WORLD_UPDATE, (_event, cursor) => worldUpdate(readWorld(), cursor));
  ipc.handle(IPC.COMPANION_UPDATE, async (_event, command: CompanionCommand) => {
    const startsFollowup = command?.type === "followup_save"
      || (command?.type === "followup_status" && command.status === "active");
    if (startsFollowup || (command?.type === "repair" && command.conversationId !== undefined)) {
      const conversationId = command.conversationId;
      if (typeof conversationId !== "string" || !await getSessionRecord(conversationId)) {
        throw new Error("会话不存在，请返回聊天后重试");
      }
      if (isGroupBoundConversation(conversationId)) {
        throw new Error("群聊关联的会话不支持个人修正或跟进");
      }
    }
    return store.command(command);
  });
  ipc.handle(IPC.COMPANION_WORLD_HISTORY, (_event, query) => getSharedXilianWorldStore(path.join(app.getPath("userData"), "amphoreus-world.json")).queryWorldHistory(query));
  ipc.handle(IPC.COMPANION_WORLD_ARTIFACT, (_event, id) => getSharedXilianWorldStore(path.join(app.getPath("userData"), "amphoreus-world.json")).readWorldArtifact(id));
  const advanceSuggestionWorld = () => {
    const store = getSharedXilianWorldStore(path.join(app.getPath("userData"), "amphoreus-world.json"));
    if (world) world.getWorldSnapshot();
    else store.advance();
    return store;
  };
  ipc.handle(IPC.COMPANION_WORLD_SUGGESTIONS_GET, async (_event, value: unknown) => {
    const conversationId = await requirePrivateChat(value);
    return advanceSuggestionWorld().listPersonalSuggestions(conversationId).map(suggestionView);
  });
  ipc.handle(IPC.COMPANION_WORLD_SUGGESTION_ADD, async (_event, value: unknown): Promise<CompanionWorldSuggestionResult> => {
    if (!value || typeof value !== "object") throw new Error("无效的小事建议");
    const { conversationId, id, title, intent } = value as Partial<CompanionWorldSuggestionInput>;
    if (typeof id !== "string" || !/^[a-zA-Z0-9:_-]{1,120}$/.test(id)
        || typeof title !== "string" || !title.trim() || title.length > 200
        || typeof intent !== "string" || !intent.trim() || intent.length > 300) {
      throw new Error("请填写有效的小事标题和想法");
    }
    const scopedConversation = await requirePrivateChat(conversationId);
    const action = advanceSuggestionWorld().addPersonalIntention({
      conversationId: scopedConversation,
      id,
      title: title.trim().replace(/\s+/gu, " "),
      intent: intent.trim().replace(/\s+/gu, " "),
    });
    return action ? { action: suggestionView(action) } : { reason: "unavailable" };
  });
  ipc.handle(IPC.COMPANION_WORLD_SUGGESTION_WITHDRAW, async (_event, value: unknown, actionId: unknown) => {
    if (typeof actionId !== "string" || !/^amphoreus:personal:user:[a-f0-9]{32}$/.test(actionId)) throw new Error("无效的小事标识");
    const conversationId = await requirePrivateChat(value);
    const action = advanceSuggestionWorld().withdrawPersonalSuggestion(conversationId, actionId);
    return action ? suggestionView(action) : null;
  });
  ipc.handle(IPC.COMPANION_WORLD_CONFIGURE, (_event, options: unknown) => {
    if (!options || typeof options !== "object" || typeof (options as { narrativeEnabled?: unknown }).narrativeEnabled !== "boolean") throw new Error("Invalid world settings");
    const { narrativeEnabled: enabled, retryNarrative } = options as { narrativeEnabled: boolean; retryNarrative?: unknown };
    if (retryNarrative !== undefined && typeof retryNarrative !== "boolean") throw new Error("Invalid world settings");
    if (retryNarrative) {
      if (!enabled || !world) throw new Error("World retry unavailable");
      world.retryWorldNarrative();
      return;
    }
    if (world) world.setWorldNarrativeEnabled(enabled);
    else getSharedXilianWorldStore(path.join(app.getPath("userData"), "amphoreus-world.json")).updateAmphoreus((state) => { state.narrativeEnabled = enabled; return true; });
  });
  ipc.handle(IPC.COMPANION_EXPORT, () => store.exportData());
}
