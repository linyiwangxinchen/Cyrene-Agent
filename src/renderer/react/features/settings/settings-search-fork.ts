import type { SettingsSearchItem } from "./settings-search-index";

// Keep fork-specific entries and platform gates apart from the upstream index.
export interface ForkSearchAvailability {
  isWeb?: boolean;
  proactiveEnabled?: boolean;
  asrEngine?: string;
}

const desktopOnly = new Set([
  "settingsPage.general.windows", "settingsPage.general.rememberWindowState",
  "settingsPage.general.launchAtLogin", "settingsPage.general.disableGpu",
  "settingsPage.general.softwareUpdate", "settingsPage.pet", "settingsPage.petAlwaysOnTop",
  "settingsPage.petVisible", "settingsPage.petZoom",
]);

export function isForkSettingsSearchAvailable(id: string, state: ForkSearchAvailability): boolean {
  if (state.isWeb && desktopOnly.has(id)) return false;
  if (["deliveryTarget", "proactiveScoreStatus", "proactiveTargetScore"].some(key => id === `settingsPage.preferences.${key}`))
    return state.proactiveEnabled === true;
  if (id === "settingsPage.asr.localTitle") return state.asrEngine === "local";
  return true;
}

export function extendSettingsSearchIndex(items: SettingsSearchItem[]): SettingsSearchItem[] {
  return [
    ...items.map(item => item.id === "section:plugins"
      ? { ...item, keywords: ["B站", "B 站", "bilibili", "小花园", "bili-garden", "魔搭", "modelscope"] }
      : item),
    ...["proactiveScoreStatus", "proactiveTargetScore"].map(key => ({
      id: `settingsPage.preferences.${key}`, titleKey: `settingsPage.preferences.${key}`,
      section: "preferences" as const, category: "basic" as const,
      sectionKey: "settingsPage.preferencesLabel",
      source: "src/renderer/react/features/settings/PreferencesSettingsPanel.tsx",
    })),
    { id: "settingsPage.asr.localTitle", titleKey: "settingsPage.asr.localTitle",
      section: "asr", category: "voice", sectionKey: "settingsPage.asr.title",
      source: "src/renderer/react/features/settings/AsrSettingsPanel.tsx" },
  ];
}
