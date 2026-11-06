import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { beforeEach, describe, expect, it } from "vitest"

describe("relationship log", () => {
  let filePath: string

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relationship-log-"))
    filePath = path.join(dir, "relationship-log.json")
  })

  it("records relationship cues without asking for confirmation", async () => {
    const { RelationshipLogStore } = await import("./relationship-log")
    const store = new RelationshipLogStore(filePath)

    await store.recordTurn({
      userText: "记忆确认卡片不要，太影响观感了！",
      assistantText: "明白，这个不做。",
      cyreneFeeling: "温柔",
      channel: "desktop",
    })

    const data = JSON.parse(await store.exportData()) as {
      entries: Array<{ userMood: string; relationshipSignal: string; nextCareCue: string }>
      dailySummaries: Array<{ summary: string }>
    }

    expect(data.entries).toHaveLength(1)
    expect(data.entries[0].userMood).toBe("明确边界")
    expect(data.entries[0].relationshipSignal).toContain("低打扰")
    expect(data.entries[0].nextCareCue).toContain("风险确认仍需执行")
    expect(data.dailySummaries[0].summary).toContain("明确边界")
  })

  it("builds a compact context from recent cues", async () => {
    const { RelationshipLogStore } = await import("./relationship-log")
    const store = new RelationshipLogStore(filePath)

    await store.recordTurn({
      userText: "我今天有点累，先别安排太多",
      assistantText: "那就慢一点来。",
      cyreneFeeling: "担心",
      channel: "desktop",
    })

    const context = await store.buildContext()

    expect(context).toContain("【近期关系线索】")
    expect(context).toContain("用户最近状态")
    expect(context).toContain("疲惫")
    expect(context).toContain("下次回应提示")
    expect(context).toContain("关系阶段")
    expect(context).toContain("昔涟当前感受")
  })

  it("does not misread common words as boundary signals", async () => {
    const { RelationshipLogStore } = await import("./relationship-log")
    const store = new RelationshipLogStore(filePath)

    for (const text of ["我今天不想吃火锅", "我今天想吃点别的", "先不管这个报错，帮我看下代码"]) {
      await store.recordTurn({
        userText: text,
        assistantText: "好的。",
        cyreneFeeling: "平稳",
        channel: "desktop",
      })
    }

    const data = JSON.parse(await store.exportData()) as {
      entries: Array<{ userMood: string }>
    }
    expect(data.entries.every((e) => e.userMood === "未知")).toBe(true)
  })

  it("persists relationship and affect state separately from permission", async () => {
    const { RelationshipLogStore } = await import("./relationship-log")
    const store = new RelationshipLogStore(filePath)
    await store.recordTurn({ userText: "太好了，终于完成了！", assistantText: "我也替你开心。", cyreneFeeling: "开心", channel: "desktop" })
    const data = JSON.parse(await store.exportData()) as { relationshipState: { stage: string; warmth: number }; affectState: { renderedFeeling: string } }
    expect(data.relationshipState.stage).toBe("familiar")
    expect(data.relationshipState.warmth).toBe(0.55)
    expect(data.affectState.renderedFeeling).toBe("平静")
  })

  it("lets the user edit relationship preferences without writing scores", async () => {
    const { RelationshipLogStore } = await import("./relationship-log")
    const store = new RelationshipLogStore(filePath)
    const state = await store.updatePreferences({ userLabel: "小夏", sharedGoals: ["一起完成项目"], boundaries: ["少打断"] })
    expect(state.userLabel).toBe("小夏")
    expect(state.sharedGoals).toEqual(["一起完成项目"])
    expect(state.boundaries).toEqual(["少打断"])
    expect(state.trust).toBe(0.5)
    expect(state.closeness).toBe(0.35)
  })

  it("injects user-defined Xilian taste notes without changing permissions", async () => {
    const { RelationshipLogStore } = await import("./relationship-log-core")
    const store = new RelationshipLogStore(filePath)
    const before = await store.snapshot()
    const after = await store.command({
      type: "preferences",
      expectedRevision: before.revision,
      patch: { tasteNotes: ["喜欢雨天", "喜欢把复杂问题讲清楚"] },
    })
    expect(after.relationship.tasteNotes).toEqual(["喜欢雨天", "喜欢把复杂问题讲清楚"])
    expect(after.permissions).toEqual(before.permissions)
    const context = await store.buildContext("conversation-1")
    expect(context).toContain("昔涟的兴趣与品味")
    expect(context).toContain("喜欢雨天")
  })
})
