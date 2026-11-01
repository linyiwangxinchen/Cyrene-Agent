import { randomUUID } from "node:crypto";
import { videoId } from "./config.mjs";

const text = (value, max) =>
  String(value ?? "")
    .trim()
    .slice(0, max);
export function evidenceView(evidence, query = "") {
  let rows = (evidence.segments ?? []).map((s, i) => ({
    index: i,
    from: Number(s.from) || 0,
    text: s.text,
  }));
  if (query) {
    const terms = query
      .toLowerCase()
      .split(/[\s，。？！,?!]+/)
      .filter(Boolean);
    rows = rows
      .map((s) => ({
        ...s,
        score: terms.reduce(
          (n, q) => n + (s.text.toLowerCase().includes(q) ? 1 : 0),
          0,
        ),
      }))
      .sort((a, b) => b.score - a.score);
  }
  let chars = 0;
  return {
    bvid: evidence.bvid,
    source: evidence.source,
    totalSegments: evidence.segments.length,
    truncated: evidence.text.length > 24000,
    segments: rows
      .filter((s) => {
        chars += s.text.length;
        return chars < 24000;
      })
      .slice(0, query ? 30 : 160),
  };
}
export function validateCitations(evidence, indices) {
  if (!Array.isArray(indices) || !indices.length || indices.length > 6)
    throw new Error("请提供 1–6 个真实字幕片段编号");
  return [...new Set(indices)].map((i) => {
    if (!Number.isInteger(i) || !evidence?.segments?.[i])
      throw new Error("引用的字幕片段不存在");
    const s = evidence.segments[i];
    return {
      index: i,
      text: text(s.text, 500),
      from: Number(s.from) || 0,
      url: `https://www.bilibili.com/video/${evidence.bvid}?t=${Math.floor(Number(s.from) || 0)}`,
    };
  });
}
export function saveReport(store, run, input, quota) {
  if (store.get("report", run.id)) return store.get("report", run.id);
  if (!Array.isArray(input.items) || input.items.length > quota)
    throw new Error(`本轮最多收录 ${quota} 条视频`);
  const seen = new Set();
  const items = input.items.map((item) => {
    const bvid = videoId(item.bvid);
    if (seen.has(bvid)) throw new Error("报告包含重复视频");
    seen.add(bvid);
    const evidence = store.get("evidence", bvid),
      video = store.get("video", bvid);
    if (!evidence?.text || !video) throw new Error(`尚未读取 ${bvid} 的内容`);
    const summary = text(item.summary, 1600),
      reason = text(item.reason, 600);
    if (!summary || !reason) throw new Error("每条视频需有摘要与推荐理由");
    return {
      ...video,
      bvid,
      summary,
      reason,
      citations: validateCitations(evidence, item.citations),
    };
  });
  const report = {
    runId: run.id,
    day: run.day,
    created: Date.now(),
    items,
    diary: text(input.diary, 3000),
    say: text(input.say, 150),
    summary: text(input.summary, 1500),
  };
  store.transaction(() => {
    store.put("report", run.id, report);
    for (const item of items)
      store.put("video", item.bvid, {
        ...store.get("video", item.bvid),
        picked: true,
        summary: item.summary,
        reason: item.reason,
        citations: item.citations,
      });
    for (const memory of (Array.isArray(input.memories)
      ? input.memories
      : []
    ).slice(0, 3)) {
      const body = text(memory, 500);
      if (body)
        store.put("memory", randomUUID(), {
          text: body,
          day: run.day,
          runId: run.id,
          created: Date.now(),
        });
    }
  });
  return report;
}
export function markdownReport(
  reports,
  { title = "昔涟的 B 站小花园", day = "" } = {},
) {
  const escape = (s) =>
    String(s ?? "")
      .replace(/[<>]/g, "")
      .replace(/\r/g, "");
  return (
    `# ${title}${day ? " · " + day : ""}\n\n` +
    reports
      .map((r) => {
        const body = (r.items ?? [])
          .map(
            (item) =>
              `### ${escape(item.title)}\n\n[${item.bvid}](https://www.bilibili.com/video/${item.bvid}) · ${escape(item.owner)}\n\n${escape(item.summary)}\n\n**想和你分享的理由**：${escape(item.reason)}\n\n` +
              (item.citations ?? [])
                .map(
                  (c) =>
                    `> ${escape(c.text)} [${Math.floor(c.from / 60)}:${String(Math.floor(c.from % 60)).padStart(2, "0")}](${c.url})`,
                )
                .join("\n"),
          )
          .join("\n\n");
        return `## ${r.day} · ${new Date(r.created).toISOString()}\n\n${escape(r.summary)}\n\n${body}\n\n${r.diary ? "### 手记\n\n" + escape(r.diary) : ""}\n\n${r.say ? "*" + escape(r.say) + "*" : ""}`;
      })
      .join("\n\n---\n\n")
  );
}
export function timePlaylist(videos, minutes) {
  if (![10, 30, 60].includes(Number(minutes)))
    throw new Error("请选择 10、30 或 60 分钟");
  let left = Number(minutes) * 60;
  const picked = [];
  for (const video of videos
    .filter(
      (v) =>
        v.picked && v.feedback !== "dislike" && v.queueStatus !== "watched",
    )
    .sort(
      (a, b) =>
        (b.feedback === "like") - (a.feedback === "like") ||
        (b.readAt || 0) - (a.readAt || 0),
    )) {
    if (video.duration > 0 && video.duration <= left) {
      picked.push(video);
      left -= video.duration;
    }
  }
  return {
    minutes: Number(minutes),
    seconds: Number(minutes) * 60 - left,
    items: picked,
  };
}
