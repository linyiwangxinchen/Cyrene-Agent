import { randomUUID } from "node:crypto";
import type { ToolResultImage } from "./vendors/types";

export const MAX_LIVE_TOOL_IMAGES = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_EDGE = 8192;
const MAX_IMAGE_PIXELS = 16_000_000;
const IMAGE_ID = /^shot-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.png$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TRUSTED_IMAGE_PRODUCERS = new WeakSet<object>();
const SCREENSHOT_HANDLERS = new WeakMap<object, (input: ToolScreenshotRequest) => Promise<string>>();

export interface ToolScreenshotRequest {
  base64: string;
  question: string;
  description: string;
}

export interface LoadedToolResultImage {
  mediaType: ToolResultImage["mediaType"];
  data: string;
}

export type ToolResultImageResolver = (image: ToolResultImage) => LoadedToolResultImage | undefined;

export function allowToolResultImages<T extends object>(tool: T): T {
  TRUSTED_IMAGE_PRODUCERS.add(tool);
  return tool;
}

export function bindToolScreenshotHandler(context: object, handler: (input: ToolScreenshotRequest) => Promise<string>): void {
  SCREENSHOT_HANDLERS.set(context, handler);
}

export function handleToolScreenshot(context: object, input: ToolScreenshotRequest): Promise<string> | undefined {
  return SCREENSHOT_HANDLERS.get(context)?.(input);
}

function validImageSize(width: unknown, height: unknown): boolean {
  return typeof width === "number" && typeof height === "number"
    && Number.isSafeInteger(width) && Number.isSafeInteger(height)
    && width > 0 && height > 0 && width <= MAX_IMAGE_EDGE && height <= MAX_IMAGE_EDGE
    && width * height <= MAX_IMAGE_PIXELS;
}

export function isToolResultImage(value: unknown): value is ToolResultImage {
  if (!value || typeof value !== "object") return false;
  const image = value as Partial<ToolResultImage>;
  return typeof image.fileName === "string" && IMAGE_ID.test(image.fileName)
    && image.mediaType === "image/png" && validImageSize(image.width, image.height);
}

export function formatToolImageResult(text: string, image: ToolResultImage): string {
  return JSON.stringify({ kind: "tool_image_result", text, image });
}

export function parseToolResultImages(tool: object, output: string): ToolResultImage[] | undefined {
  if (!TRUSTED_IMAGE_PRODUCERS.has(tool) || output.length > 4096) return undefined;
  try {
    const value = JSON.parse(output);
    if (value?.kind !== "tool_image_result" || !isToolResultImage(value.image)) return undefined;
    const { fileName, mediaType, width, height } = value.image;
    return [{ fileName, mediaType, width, height }];
  } catch {
    return undefined;
  }
}

export function readToolScreenshotSize(base64: string): { width: number; height: number } | undefined {
  if (base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    || Buffer.byteLength(base64, "base64") > MAX_IMAGE_BYTES
    || !/^[a-zA-Z0-9+/]+={0,2}$/.test(base64)) return undefined;
  const header = Buffer.from(base64.slice(0, 44), "base64");
  if (header.length < 33 || !header.subarray(0, 8).equals(PNG_SIGNATURE)
    || header.readUInt32BE(8) !== 13 || header.toString("ascii", 12, 16) !== "IHDR") return undefined;
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  return validImageSize(width, height) ? { width, height } : undefined;
}

/** Captures belong to one in-flight run. References never open a local file. */
export function createToolResultImageCache(signal?: AbortSignal) {
  const images = new Map<string, { reference: ToolResultImage; data: string }>();
  let closed = false;
  function close(): void {
    closed = true;
    images.clear();
    signal?.removeEventListener("abort", close);
  }
  if (signal?.aborted) close();
  else signal?.addEventListener("abort", close, { once: true });
  return {
    remember(data: string): ToolResultImage | undefined {
      if (closed || signal?.aborted) return undefined;
      const size = readToolScreenshotSize(data);
      if (!size) return undefined;
      const reference: ToolResultImage = { fileName: `shot-${randomUUID()}.png`, mediaType: "image/png", ...size };
      images.set(reference.fileName, { reference, data });
      if (images.size > MAX_LIVE_TOOL_IMAGES) images.delete(images.keys().next().value!);
      return reference;
    },
    resolve(image: ToolResultImage): LoadedToolResultImage | undefined {
      if (closed || signal?.aborted || !isToolResultImage(image)) return undefined;
      const entry = images.get(image.fileName);
      if (!entry || entry.reference.width !== image.width || entry.reference.height !== image.height) return undefined;
      return { mediaType: image.mediaType, data: entry.data };
    },
    close,
  };
}
