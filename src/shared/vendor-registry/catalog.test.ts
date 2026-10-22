import { describe, expect, it } from "vitest";
import { getBuiltinModels } from "./catalog";
import { renderAdaptedModelsMarkdown } from "./catalog-doc";
import { MINIMAX_REGISTRY } from "./entries/minimax";

describe("内置静态型号目录", () => {
  it("保持推荐顺序，并保留运行默认与候选首项的区别", () => {
    expect(getBuiltinModels("minimax", "chat")).toEqual([
      "MiniMax-M3.1-Flash", "MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5",
    ]);
    expect(MINIMAX_REGISTRY.capability.defaultModel).toBe("MiniMax-M3");
    expect(MINIMAX_REGISTRY.capability.baseUrl).toBe("https://api.minimaxi.com/anthropic");
  });

  it("正式版发布后预览版名称仍留在目录中，但不再推荐", () => {
    const preview = MINIMAX_REGISTRY.models.find((entry) => entry.model === "MiniMax-M3.1-Flash-Preview");
    expect(preview?.recommendedFor).toEqual([]);
  });

  it("官方核验只记在正式型号上，预览版名称在兼容清单里仍标为历史未核验", () => {
    const rows = renderAdaptedModelsMarkdown([MINIMAX_REGISTRY]).split("\n");
    const row = (model: string) => rows.find((line) => line.startsWith(`| ${model} |`)) ?? "";
    expect(row("MiniMax-M3.1-Flash")).toContain("platform.minimax.io/docs/guides/text-generation");
    expect(row("MiniMax-M3.1-Flash")).not.toContain("历史未核验");
    expect(row("MiniMax-M3.1-Flash-Preview")).toContain("历史未核验");
    expect(row("MiniMax-M3.1-Flash-Preview")).not.toContain("platform.minimax.io");
  });

  it("视觉推荐单独筛选，历史型号不自动推荐或改写", () => {
    expect(getBuiltinModels("mimo", "vision")).toEqual(["mimo-v2.6-pro", "mimo-v2.6-flash"]);
    expect(getBuiltinModels("mimo", "chat")).toEqual([
      "mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed",
    ]);
    expect(getBuiltinModels("deepseek", "chat")).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(getBuiltinModels("deepseek", "vision")).toEqual([]);
  });

  it("调用方改动返回数组不会污染后续查询", () => {
    const models = getBuiltinModels("qwen", "chat") as string[];
    const original = [...models];
    models.pop();
    expect(getBuiltinModels("qwen", "chat")).toEqual(original);
    expect(getBuiltinModels("qwen", "chat")).not.toBe(models);
  });
});
