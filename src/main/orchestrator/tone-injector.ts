// 语气注入器 —— 把通用语气规则注入 system prompt。
// 场景匹配（embedding 分类 + 场景台词注入）已整体移除：
// 阈值贴边导致超短输入频繁误判（如"去掉它"命中告别场景），误触发的硬指令
// 比不注入更糟。人格表达由人设 prompt + 通用语气规则承载。

import * as fs from "fs";
import { findPromptPath } from "../external-content-paths";

import { formatToneRules } from "./tone-rules-core";

export function buildToneInjection(): string {
  try {
    const rulesPath = findPromptPath("tone-rules.md");
    return formatToneRules(rulesPath ? fs.readFileSync(rulesPath, "utf8") : "");
  }
  catch { return formatToneRules(); }
}
