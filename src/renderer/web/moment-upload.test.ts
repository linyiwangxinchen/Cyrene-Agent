import { afterEach, describe, expect, it, vi } from "vitest";
import { publishWebMoment } from "./moment-upload";
const image = { name: "test.png", mime: "image/png", bytes: new Uint8Array([0, 1, 255]).buffer };
afterEach(() => vi.unstubAllGlobals());

describe("Web moment publishing", () => {
  it("uploads nine images as individual binary requests and submits metadata only", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let count = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: `image-${++count}`, ok: true }));
    }));
    const submit = vi.fn(async (_input: any) => ({ applied: true }));
    await publishWebMoment({ text: "", images: Array(9).fill(image) }, submit);
    expect(calls.filter(call => call.url === "/api/core/moment-image")).toHaveLength(9);
    expect(calls[0].init.body).toBe(image.bytes);
    expect(submit.mock.calls[0][0].images[8].bytes).toEqual({ __cyreneMomentUpload: "image-9" });
    expect(calls.at(-1)?.url).toBe("/api/core/moment-image/cleanup");
  });
  it("preserves text-only posts and cleans earlier uploads when another image fails", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{"id":"first"}')).mockResolvedValueOnce(new Response('{"error":"REQUEST_TOO_LARGE"}', { status: 413 })).mockResolvedValue(new Response('{"ok":true}'));
    vi.stubGlobal("fetch", fetch);
    const submit = vi.fn(async () => ({ applied: true }));
    await expect(publishWebMoment({ text: "draft", images: [image, image] }, submit)).rejects.toThrow("REQUEST_TOO_LARGE");
    expect(submit).not.toHaveBeenCalled();
    expect(JSON.parse(fetch.mock.calls.at(-1)![1].body)).toEqual({ ids: ["first"] });
    await publishWebMoment({ text: "text-only" }, submit);
    expect(submit).toHaveBeenCalledExactlyOnceWith({ text: "text-only", images: [] });
  });
  it("cleans staged photos when publication fails without changing the draft", async () => {
    const fetch = vi.fn(async () => new Response('{"id":"first"}')); vi.stubGlobal("fetch", fetch);
    const input = { text: "draft", images: [image] };
    await expect(publishWebMoment(input, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(input.images[0].bytes).toBe(image.bytes);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
