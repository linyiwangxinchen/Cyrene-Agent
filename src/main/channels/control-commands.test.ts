import { describe, expect, it } from "vitest";
import { formatChannelControlHelp, makeChannelTextMessage, parseChannelControlCommand } from "./control-commands";

describe("channel control commands", () => {
  it.each([
    ["/stop", "stop"], ["/cancel", "stop"], ["/取消", "stop"],
    ["/status", "status"], ["/进度", "status"],
    ["/help", "help"], ["/帮助", "help"],
  ] as const)("parses %s", (text, expected) => {
    expect(parseChannelControlCommand(text)).toBe(expected);
  });

  it("does not intercept ordinary text", () => {
    expect(parseChannelControlCommand("请帮我停止服务，但先说明原因")).toBeNull();
    expect(parseChannelControlCommand("/status report")).toBe("status");
  });

  it("builds a reply that preserves group reply metadata", () => {
    expect(makeChannelTextMessage({
      channel: "wechat", chatType: "group", chatId: "room-1", messageId: "m-1", senderId: "u-1",
    }, "当前没有任务")).toMatchObject({
      targetId: "room-1",
      replyContext: { messageId: "m-1", mentionUserId: "u-1" },
      parts: [{ kind: "text", text: "当前没有任务" }],
    });
    expect(formatChannelControlHelp("wechat")).toContain("/stop");
  });
});
