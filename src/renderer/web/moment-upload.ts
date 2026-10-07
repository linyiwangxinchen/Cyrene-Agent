import type { MomentCreatePostInput } from "../../shared/moments-types";

/** Upload sequentially: nine full-size photos must not form a giant JSON request. */
export async function publishWebMoment<T>(input: MomentCreatePostInput, submit: (input: any) => Promise<T>): Promise<T> {
  const uploads: string[] = [];
  try {
    const images = [];
    for (const image of input.images ?? []) {
      const response = await fetch("/api/core/moment-image", { method: "POST", credentials: "same-origin", headers: { "Content-Type": image.mime }, body: image.bytes });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "图片上传失败");
      uploads.push(result.id);
      images.push({ ...image, bytes: { __cyreneMomentUpload: result.id } });
    }
    return await submit({ ...input, images });
  } finally {
    if (uploads.length) {
      await fetch("/api/core/moment-image/cleanup", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: uploads }) }).catch(() => {});
    }
  }
}
