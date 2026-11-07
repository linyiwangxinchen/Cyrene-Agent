import { describe, expect, it } from "vitest";
import { normalizePluginObservation } from "./plugin-observation";

describe("normalizePluginObservation", () => {
  it("keeps only a bounded, safe Bilibili observation", () => {
    const result = normalizePluginObservation("bili-garden", "interesting-item", {
      eventId: "report-1:BV1abc",
      bvid: "BV1abc",
      title: "有趣的视频",
      summary: "和最近讨论的主题有关",
      url: "https://www.bilibili.com/video/BV1abc",
      cookie: "MUSIC_U=secret",
    });
    expect(result).toMatchObject({ id: "plugin:bili-garden:report-1:BV1abc", kind: "share", source: "plugin" });
    expect(JSON.stringify(result)).not.toContain("MUSIC_U");
  });

  it("rejects other plugin events and unsafe URLs without dropping the observation", () => {
    expect(normalizePluginObservation("other", "interesting-item", { eventId: "x", title: "x" })).toBeNull();
    expect(normalizePluginObservation("bili-garden", "interesting-item", { eventId: "x", title: "x", url: "file:///secret" })).toMatchObject({ summary: "x" });
  });
});
