import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMathPlugin } from "@streamdown/math";
import { Streamdown } from "streamdown";
import { describe, expect, it } from "vitest";

const mathRequire = createRequire(import.meta.resolve("@streamdown/math"));
const rehypeRequire = createRequire(mathRequire.resolve("rehype-katex"));
const rendererVersion = JSON.parse(readFileSync(rehypeRequire.resolve("katex/package.json"), "utf8")).version;

describe("KaTeX 渲染与随页面打包的样式契约", () => {
  it("真实 Streamdown 插件可渲染行内与块级公式", () => {
    const html = renderToStaticMarkup(React.createElement(Streamdown, {
      mode: "streaming",
      plugins: { math: createMathPlugin({ singleDollarTextMath: true }) },
      children: "行内 $E=mc^2$\n\n$$\n\\frac{1}{2}+\\sqrt{x}=y\n$$",
    }));

    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
    expect(html).toContain('encoding="application/x-tex"');
    expect(html).not.toContain("katex-error");
  });

  it.each(["StreamdownMessageContent.css", "LearnExamPanel.css"])("%s 的实际 CSS、字体与渲染器来自相同版本", (filename) => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), filename);
    // 从页面真正导入的 CSS 定位资源，不拿顶层依赖声明替代打包时的解析结果。
    const imports = [...readFileSync(sourcePath, "utf8").matchAll(/@import\s+["'](katex\/dist\/[^"']+)["']/g)];
    expect(imports).toHaveLength(1);
    const styleRequire = createRequire(sourcePath);
    const styleVersion = JSON.parse(readFileSync(styleRequire.resolve("katex/package.json"), "utf8")).version;
    expect(styleVersion).toBe(rendererVersion);

    const cssPath = styleRequire.resolve(imports[0][1]);
    const css = readFileSync(cssPath, "utf8");
    expect(css).toContain(".katex");
    const fonts = [...css.matchAll(/url\(["']?(fonts\/[^)"']+)["']?\)/g)];
    expect(fonts.length).toBeGreaterThan(0);
    for (const [, font] of fonts) expect(statSync(resolve(dirname(cssPath), font)).size).toBeGreaterThan(0);
  });
});
