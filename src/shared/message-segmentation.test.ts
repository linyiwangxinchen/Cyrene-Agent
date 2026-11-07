import { describe, expect, it } from "vitest";
import { splitTextNaturally } from "./message-segmentation";

describe("splitTextNaturally", () => {
  it("keeps fenced code and standalone URLs intact", () => {
    expect(splitTextNaturally("```ts\nconst x = 1;\n```\n")).toHaveLength(1);
    expect(splitTextNaturally("https://example.com/a?b=1")).toEqual(["https://example.com/a?b=1"]);
  });

  it("groups a long reply into a small number of readable parts", () => {
    const parts = splitTextNaturally("第一段说明问题。这里补充原因。\n\n第二段给出处理方式。最后说明验证结果。", 3);
    expect(parts.length).toBeLessThanOrEqual(3);
    expect(parts.join("")).toContain("验证结果");
  });

  it("keeps the final group when the natural grouping reaches the requested limit", () => {
    const parts = splitTextNaturally("第一句很长很长很长很长很长。第二句也很长很长很长很长很长。第三句仍然很长很长很长很长很长。", 3);
    expect(parts).toHaveLength(3);
    expect(parts.join("")).toContain("第三句");
  });
});
