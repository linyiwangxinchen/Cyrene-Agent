import { loadGeneralSettings } from "../../../settings/settings-facade";
import { loadModelSettings, resolveModelSettingsProfile } from "../../../settings/model-settings";
import { syncBuiltInToolToggles } from "./tool-toggles";
export { syncBuiltInToolToggles } from "./tool-toggles";
import { registerEmailTools } from "../email-tools";
import { registerGmailTools } from "../gmail-tools";
import type { GmailService } from "../../../email/gmail-service";
import { registerDocumentTools } from "../document-tools";
// fs-tools / built-in-tools 仍依赖模块加载副作用，先集中在此，后续可继续显式化
import "../fs-tools";
import { registerLifeTools, setTranslateConfig } from "../life-tools";
import { registerMomentsTools } from "../moments-tools";
import { registerRecallHistoryTool } from "../history-tools";
import { registerChatHistoryTools } from "../chat-history-tools";
import { registerWikiMemoryTools } from "../wiki-memory-tools";
import { registerKnowledgeBaseTools } from "../knowledge-base-tools";
import { registerSearchTextTool } from "../search-text-tools";
import { registerAstGrepTools } from "../ast-grep-tools";
import { toolRegistry } from "./tool-registry";
import { registerTravelTools } from "../travel-tools";
import { registerZCodeFileTools } from "../zcode-file-tools";
import type { LspManager } from "../../../lsp/manager";
import { registerLspTool } from "../lsp-tool";
import "../built-in-tools";
import { registerReminderTool } from "../reminder-tool";
import { registerChannelFileTool } from "../channel-file-tool";
import { registerPersonMemoryTools } from "../person-memory-tools";
import type { SocialAtomStore } from "../../../social-context/store";

export function registerAllTools(deps: { lspManager: LspManager; gmailService?: GmailService; socialAtomStore?: SocialAtomStore }): void {
  registerLspTool(deps.lspManager, toolRegistry);
  registerSearchTextTool();
  registerAstGrepTools();
  registerRecallHistoryTool();
  registerChatHistoryTools();
  registerWikiMemoryTools();
  registerKnowledgeBaseTools();
  registerDocumentTools();

  setTranslateConfig(() => {
    const s = resolveModelSettingsProfile(loadModelSettings());
    return s.apiKey
      ? { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey, explicitTransport: s.explicitTransport }
      : null;
  });
  registerLifeTools();
  registerZCodeFileTools({
    read: toolRegistry.getById("read_file")!,
    readImage: toolRegistry.getById("read_image")!,
    write: toolRegistry.getById("write_file")!,
    edit: toolRegistry.getById("str_replace")!,
    grep: toolRegistry.getById("search_text")!,
  });
  registerMomentsTools();
  // 显式记忆工具与私聊长期记忆共用组合根构造的社交原子库
  if (deps.socialAtomStore) registerPersonMemoryTools(toolRegistry, deps.socialAtomStore);
  registerReminderTool(toolRegistry);
  registerChannelFileTool(toolRegistry);

  registerTravelTools();
  registerEmailTools();
  if (deps.gmailService) registerGmailTools(deps.gmailService);

  syncBuiltInToolToggles(loadGeneralSettings());
}
