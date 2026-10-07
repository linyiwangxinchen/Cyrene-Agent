const MAX_PCM_BYTES = 3_840_000; // 120 seconds, 16 kHz, mono signed 16-bit PCM.

/** HTTP revives binary IPC arguments; WebSocket/legacy clients may send Base64. */
export function pcmAudioBytes(value: unknown): Buffer {
  let pcm: Buffer;
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > MAX_PCM_BYTES) throw new Error("INVALID_PCM_AUDIO");
    pcm = Buffer.from(value);
  } else if (ArrayBuffer.isView(value)) {
    if (value.byteLength > MAX_PCM_BYTES) throw new Error("INVALID_PCM_AUDIO");
    pcm = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  } else {
    const wire = value as { __cyreneBinary?: unknown; data?: unknown } | null;
    if (!wire || wire.__cyreneBinary !== "base64" || typeof wire.data !== "string"
      || wire.data.length > 5_120_000 || wire.data.length % 4
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(wire.data)) throw new Error("INVALID_PCM_AUDIO");
    pcm = Buffer.from(wire.data, "base64");
  }
  if (!pcm.length || pcm.length % 2 || pcm.length > MAX_PCM_BYTES) throw new Error("INVALID_PCM_AUDIO");
  return pcm;
}
