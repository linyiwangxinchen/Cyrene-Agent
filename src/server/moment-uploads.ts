import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { MOMENT_ALLOWED_IMAGE_MIME, MOMENT_MAX_IMAGE_BYTES, MOMENT_MAX_IMAGES_PER_POST } from "../shared/moments-types";

function uploadPath(root: string, id: unknown): string {
  if (typeof id !== "string" || !/^[a-f0-9]{48}$/.test(id)) throw new Error("INVALID_MOMENT_UPLOAD");
  return path.join(root, "moment-uploads", id);
}

export async function receiveMomentImage(root: string, request: IncomingMessage): Promise<string> {
  const mime = request.headers["content-type"]?.split(";")[0];
  if (!MOMENT_ALLOWED_IMAGE_MIME.includes(mime as any)) throw new Error("unsupported_mime");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk); length += buffer.length;
    if (length > MOMENT_MAX_IMAGE_BYTES) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  if (!length) throw new Error("image_too_large");
  const directory = path.join(root, "moment-uploads");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Interrupted browser uploads expire; never touch files outside this staging directory.
  for (const id of await readdir(directory)) {
    if (!/^[a-f0-9]{48}$/.test(id)) continue;
    const file = uploadPath(root, id);
    if ((await stat(file)).mtimeMs < Date.now() - 3_600_000) await unlink(file).catch(() => {});
  }
  const id = randomBytes(24).toString("hex");
  await writeFile(uploadPath(root, id), Buffer.concat(chunks), { flag: "wx", mode: 0o600 });
  return id;
}

export async function removeMomentUploads(root: string, ids: unknown[]): Promise<void> {
  if (ids.length > MOMENT_MAX_IMAGES_PER_POST) throw new Error("too_many_images");
  const files = ids.map(id => uploadPath(root, id));
  await Promise.all(files.map(file => unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; })));
}

export async function resolveMomentUploads(root: string, args: unknown[]): Promise<unknown[]> {
  const post = args[0] as any;
  if (!post || !Array.isArray(post.images)) return args;
  if (post.images.length > MOMENT_MAX_IMAGES_PER_POST) throw new Error("too_many_images");
  const images = [];
  for (const image of post.images) {
    if (!image?.bytes || typeof image.bytes !== "object" || !("__cyreneMomentUpload" in image.bytes)) { images.push(image); continue; }
    if (!MOMENT_ALLOWED_IMAGE_MIME.includes(image.mime)) throw new Error("unsupported_mime");
    const file = uploadPath(root, image.bytes.__cyreneMomentUpload);
    const info = await stat(file);
    if (!info.isFile() || info.size <= 0 || info.size > MOMENT_MAX_IMAGE_BYTES) throw new Error("image_too_large");
    const bytes = await readFile(file);
    images.push({ ...image, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
  return [{ ...post, images }, ...args.slice(1)];
}
