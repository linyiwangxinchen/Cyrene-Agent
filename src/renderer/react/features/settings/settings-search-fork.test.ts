import { describe, expect, it } from "vitest";
import { isSettingsSearchAvailable } from "./settings-search-availability";
import { searchSettings } from "./settings-search-index";
import zh from "../../i18n/zh-CN.json";

const t = (key: string): string => key.split(".").reduce((value: any, part) => value?.[part], zh) ?? key;

describe("共享设置搜索的 Web 与插件适配", () => {
  it("Web 不列出不存在的桌面控制，Windows 仍可搜索到这些控制", () => {
    for (const query of ["窗口", "开机", "GPU", "软件更新", "桌面伙伴"]) {
      const desktop = searchSettings(query, t).filter(item => isSettingsSearchAvailable(item.id, { isWeb: false }));
      expect(desktop.length, query).toBeGreaterThan(0);
      const web = desktop.filter(item => isSettingsSearchAvailable(item.id, { isWeb: true }));
      expect(web.some(item => ["windows", "rememberWindowState", "launchAtLogin", "disableGpu", "softwareUpdate"].includes(item.id.split(".").at(-1)!)), query).toBe(false);
      expect(web.some(item => /^settingsPage\.pet/.test(item.id)), query).toBe(false);
    }
    expect(isSettingsSearchAvailable("settingsPage.general.dataDir", { isWeb: true })).toBe(true);
    expect(isSettingsSearchAvailable("section:general", { isWeb: true })).toBe(true);
  });

  it("主动聊天开启后才显示评分与投递目标，仍能搜索到总开关", () => {
    const results = searchSettings("评分", t);
    expect(results.map(item => item.id)).toEqual(expect.arrayContaining([
      "settingsPage.preferences.proactiveScoreStatus", "settingsPage.preferences.proactiveTargetScore",
    ]));
    for (const item of results) {
      expect(isSettingsSearchAvailable(item.id, { proactiveEnabled: false })).toBe(false);
      expect(isSettingsSearchAvailable(item.id, { proactiveEnabled: true })).toBe(true);
    }
    expect(isSettingsSearchAvailable("settingsPage.preferences.deliveryTarget", {})).toBe(false);
    expect(isSettingsSearchAvailable("settingsPage.preferences.proactiveChat", {})).toBe(true);
  });

  it("本地 ASR 与小花园能被搜索，条件项只在实际可见时出现", () => {
    const local = searchSettings("自部署", t).find(item => item.id === "settingsPage.asr.localTitle");
    expect(local?.section).toBe("asr");
    expect(isSettingsSearchAvailable(local!.id, { asrEngine: "local" })).toBe(true);
    expect(isSettingsSearchAvailable(local!.id, { asrEngine: "off" })).toBe(false);
    for (const query of ["小花园", "B站", "bilibili", "modelscope"]) {
      expect(searchSettings(query, t).some(item => item.id === "section:plugins"), query).toBe(true);
    }
  });
});
