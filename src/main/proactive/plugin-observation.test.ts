import { describe, expect, it } from "vitest";
import { normalizePluginObservation } from "./plugin-observation";
import { bilibiliEvidencePrompt, bilibiliMomentEvidence, bilibiliShareProse } from "./bilibili-share";

const bvid = "BV1TqCMBGExu";
const source = "https://www.bilibili.com/video/" + bvid;

describe("normalizePluginObservation", () => {
  it("keeps only a bounded, safe Bilibili observation", () => {
    const result = normalizePluginObservation("bili-garden", "interesting-item", {
      eventId: "report-1:" + bvid,
      bvid,
      title: "有趣的视频",
      summary: "和最近讨论的主题有关",
      reason: "用了熟悉的节奏",
      say: "这地方停得真逗。 https://draft.example/secret",
      clip: { text: "下一句开始加快。", from: 30.5, url: "file:///secret" },
      url: "https://www.bilibili.com/video/BV1other000?tracking=secret",
      cookie: "MUSIC_U=secret",
    });
    expect(result).toMatchObject({
      id: "plugin:bili-garden:report-1:" + bvid, kind: "share", source: "plugin",
      summary: "有趣的视频\n和最近讨论的主题有关\n" + source,
      bilibiliVideo: { bvid, title: "有趣的视频", summary: "和最近讨论的主题有关",
        reason: "用了熟悉的节奏", clip: { text: "下一句开始加快。", from: 30.5 }, say: "这地方停得真逗。" },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("uses a cited excerpt without treating a proposed line as evidence", () => {
    const say = "它还给自己鼓掌了。";
    expect(normalizePluginObservation("bili-garden", "interesting-item", { bvid, say })).toBeNull();
    const clip = { text: "这句之后先停一下。", from: 0 };
    expect(normalizePluginObservation("bili-garden", "interesting-item", { bvid, clip, say })).toMatchObject({
      summary: clip.text + "\n" + source,
      bilibiliVideo: { bvid, title: "", summary: "", clip, say },
    });
  });

  it("carries automatic transcription uncertainty into the share prompt", () => {
    const clip = { text: "这里有几句听不太清。", from: 8 };
    const video = normalizePluginObservation("bili-garden", "interesting-item", { bvid, clip, evidenceSource: "asr" })?.bilibiliVideo;
    expect(video?.evidenceSource).toBe("asr");
    expect(bilibiliEvidencePrompt(video!, "compose")).toContain("听不准的词留作疑问");
  });

  it("rejects other plugin events and unsafe URLs without dropping the observation", () => {
    expect(normalizePluginObservation("other", "interesting-item", { eventId: "x", title: "x" })).toBeNull();
    expect(normalizePluginObservation("bili-garden", "interesting-item", { eventId: "x", title: "x", url: "file:///secret" })).toMatchObject({ summary: "x" });
  });

  it("recovers the original video from an existing publisher-generated queue entry only", () => {
    const legacy = { id: "plugin:bili-garden:4f823177-8290-459e-a6e7-b6307f872adb:" + bvid,
      pluginId: "bili-garden", source: "plugin", kind: "share", summary: "旧标题\n旧摘要\n" + source } as const;
    expect(bilibiliMomentEvidence(legacy)).toEqual({ bvid, title: "旧标题", summary: "旧摘要" });
    expect(bilibiliMomentEvidence({ ...legacy, summary: "旧标题\n旧摘要" })).toEqual({ bvid, title: "旧标题", summary: "旧摘要" });
    expect(bilibiliMomentEvidence({ ...legacy, source: "system" })).toBeUndefined();
    expect(bilibiliMomentEvidence({ ...legacy, id: "plugin:bili-garden:wrong:" + bvid })).toBeUndefined();
  });

  it("keeps the generated prose and discards duplicate, invented and unconfirmed source links", () => {
    const body = "字幕切得挺妙。";
    expect(bilibiliShareProse(body)).toBe(body);
    expect(bilibiliShareProse(body + "\n[原片链接](" + source + ")")).toBe(body);
    expect(bilibiliShareProse(body + "\n原片链接：https://example.test/video")).toBe(body);
    expect(bilibiliShareProse(body + "\n" + source.slice("https://".length))).toBe(body);
    expect(bilibiliShareProse(body + "原片链接还没核实。")).toBe(body);
    expect(bilibiliShareProse("字幕切得挺妙，原片链接还没核实")).toBe("字幕切得挺妙");
    expect(bilibiliShareProse("原片链接我还没有确认。")).toBe("");
  });
});
