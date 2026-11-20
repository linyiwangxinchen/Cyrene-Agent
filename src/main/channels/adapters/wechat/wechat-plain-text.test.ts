import { describe, expect, it } from "vitest";
import { toWechatPlainText } from "./wechat-plain-text";

describe("WeChat plain text", () => {
  it("removes Markdown that WeChat would show as symbols", () => {
    expect(toWechatPlainText("人家投 **番茄牛腩长寿面＋煎蛋** 一票！")).toBe("人家投 番茄牛腩长寿面＋煎蛋 一票！");
    expect(toWechatPlainText("## 顺序\n- 本科\n- 硕士\n> 引用")).toBe("顺序\n· 本科\n· 硕士\n引用");
    expect(toWechatPlainText("文件在 `report.pdf`，见 [链接](https://example.com)")).toBe("文件在 report.pdf，见 链接 https://example.com");
  });

  it("keeps ordinary chat text and numbered steps unchanged", () => {
    expect(toWechatPlainText("戳回去～雯雯♪")).toBe("戳回去～雯雯♪");
    expect(toWechatPlainText("1. 本科\n2. 硕士")).toBe("1. 本科\n2. 硕士");
    expect(toWechatPlainText("3*4=12")).toBe("3*4=12");
  });
});
