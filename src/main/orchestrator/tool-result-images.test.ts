import { describe, expect, it } from "vitest";
import { allowToolResultImages, createToolResultImageCache, formatToolImageResult, parseToolResultImages, readToolScreenshotSize } from "./tool-result-images";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("temporary tool screenshots", () => {
  it("requires the registered producer identity and rejects path-like image references", () => {
    const cache = createToolResultImageCache();
    const image = cache.remember(PNG)!;
    const tool = allowToolResultImages({ id: "browser_screenshot" });
    const formatted = formatToolImageResult("capture", image);
    const result = parseToolResultImages(tool, formatted)!;
    expect(cache.resolve(result[0])).toEqual({ mediaType: "image/png", data: PNG });
    expect(parseToolResultImages({ ...tool }, formatted)).toBeUndefined();
    expect(parseToolResultImages(tool, formatToolImageResult("capture", { ...image, fileName: "../../secret.png" }))).toBeUndefined();
    expect(cache.resolve({ ...image, fileName: "shot-00000000-0000-0000-0000-000000000000.png" })).toBeUndefined();
  });

  it("bounds image dimensions and input bytes before retaining them", () => {
    const cache = createToolResultImageCache();
    const hugeHeader = Buffer.from(PNG, "base64");
    hugeHeader.writeUInt32BE(8193, 16);
    expect(cache.remember(hugeHeader.toString("base64"))).toBeUndefined();
    expect(cache.remember(Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64"))).toBeUndefined();
    expect(readToolScreenshotSize(Buffer.from("arbitrary local data").toString("base64"))).toBeUndefined();
  });

  it("does not share entries between runs and forgets old, cancelled and completed screenshots", () => {
    const controller = new AbortController();
    const cache = createToolResultImageCache(controller.signal);
    const older = cache.remember(PNG)!;
    const live = [cache.remember(PNG)!, cache.remember(PNG)!, cache.remember(PNG)!];
    expect(cache.resolve(older)).toBeUndefined();
    expect(cache.resolve(live[0])).toBeDefined();
    expect(createToolResultImageCache().resolve(live[0])).toBeUndefined();
    controller.abort();
    expect(cache.resolve(live[0])).toBeUndefined();
    expect(cache.remember(PNG)).toBeUndefined();
    const completed = createToolResultImageCache();
    const image = completed.remember(PNG)!;
    completed.close();
    expect(completed.resolve(image)).toBeUndefined();
    expect(completed.remember(PNG)).toBeUndefined();
  });
});
