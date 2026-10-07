import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { receiveMomentImage, removeMomentUploads, resolveMomentUploads } from "./moment-uploads";
import { MOMENT_MAX_IMAGE_BYTES } from "../shared/moments-types";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "cyrene-moment-test-")); });
afterEach(async () => {
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("cyrene-moment-test-")) throw new Error("Unsafe test cleanup");
  await rm(directory, { recursive: true, force: true });
});
function request(bytes: Buffer, mime = "image/png"): IncomingMessage {
  return Object.assign(Readable.from([bytes]), { headers: { "content-type": mime } }) as unknown as IncomingMessage;
}
describe("staged Web moment images", () => {
  it("uploads and restores nine photos in order, then removes only their staging copies", async () => {
    const images = [];
    const ids = [];
    for (let n = 0; n < 9; n++) {
      const id = await receiveMomentImage(directory, request(Buffer.from([n, 255]))); ids.push(id);
      images.push({ name: `${n}.png`, mime: "image/png", bytes: { __cyreneMomentUpload: id } });
    }
    const args = await resolveMomentUploads(directory, [{ text: "", mentions: ["cyrene"], images }]);
    const post = args[0] as any;
    expect(post.mentions).toEqual(["cyrene"]);
    expect(post.images.map((image: any) => [...new Uint8Array(image.bytes)])).toEqual(images.map((_, n) => [n, 255]));
    await removeMomentUploads(directory, ids);
    expect(await readdir(path.join(directory, "moment-uploads"))).toEqual([]);
  });
  it("supports the original 15 MiB boundary and rejects larger or unsupported uploads", async () => {
    const id = await receiveMomentImage(directory, request(Buffer.alloc(MOMENT_MAX_IMAGE_BYTES, 1)));
    expect((await readFile(path.join(directory, "moment-uploads", id))).length).toBe(MOMENT_MAX_IMAGE_BYTES);
    await expect(receiveMomentImage(directory, request(Buffer.alloc(MOMENT_MAX_IMAGE_BYTES + 1)))).rejects.toThrow("REQUEST_TOO_LARGE");
    await expect(receiveMomentImage(directory, request(Buffer.from([1]), "text/plain"))).rejects.toThrow("unsupported_mime");
  });
  it("rejects traversal, excessive images and arbitrary server-file references", async () => {
    await expect(removeMomentUploads(directory, ["../../secret"])).rejects.toThrow("INVALID_MOMENT_UPLOAD");
    await expect(resolveMomentUploads(directory, [{ images: [{ mime: "image/png", bytes: { __cyreneMomentUpload: "/etc/passwd" } }] }])).rejects.toThrow("INVALID_MOMENT_UPLOAD");
    await expect(resolveMomentUploads(directory, [{ images: Array(10).fill({}) }])).rejects.toThrow("too_many_images");
  });
});
