import { expect, it } from "vitest";
import { resolveChannelMemoryScope } from "./memory-scope";

it("requires an identified private sender and isolates by active account and platform", () => {
  const first = { channel: "wechat", accountId: "account-one", senderId: "peer", chatType: "private" } as const;
  const scope = resolveChannelMemoryScope(first);
  expect(scope).toMatch(/^peer:[a-f0-9]{64}$/);
  expect(resolveChannelMemoryScope(first)).toBe(scope);
  expect(resolveChannelMemoryScope({ ...first, accountId: "account-two" })).not.toBe(scope);
  expect(resolveChannelMemoryScope({ ...first, senderId: "different-peer" })).not.toBe(scope);
  expect(resolveChannelMemoryScope({ ...first, channel: "feishu" })).not.toBe(scope);
  expect(resolveChannelMemoryScope({ ...first, chatType: "group" })).toBeUndefined();
  expect(resolveChannelMemoryScope({ ...first, accountId: undefined })).toBeUndefined();
  expect(resolveChannelMemoryScope({ ...first, chatType: undefined })).toBeUndefined();
});
