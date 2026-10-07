import type { IpcScope } from "../../main/application/ipc-scope";
import { IPC } from "../../shared/ipc-channels";
import { getAsrConfig } from "../../main/asr/asr-config";
import { createAsrStream, type AsrStreamSession } from "../../main/asr/asr-dispatcher";
import { startCall, stopCall, setCallWindow, handleAudioFrame, endTurn, onTtsDone } from "../../main/call/call-manager";
import { WebContents } from "./platform";
import { pcmAudioBytes as pcmBytes } from "./pcm-audio";

/** The desktop call coordinator is retained; its window is a single authenticated browser owner. */
export function registerHeadlessVoice(ipc: IpcScope) {
  let owner: WebContents | null = null;
  let turnBytes = 0;
  const transcriptions = new Set<AsrStreamSession>();
  const ownerDestroyed = () => close();
  const close = (closeUi = true) => { if (!owner) return; const sender = owner; owner = null; sender.removeListener("destroyed", ownerDestroyed); stopCall(); setCallWindow(null); if (closeUi) sender.send("host:call-close"); };
  const bind = (sender: WebContents) => {
    if (owner && owner !== sender && !owner.isDestroyed()) throw new Error("VOICE_CALL_BUSY");
    if (owner !== sender) {
      owner = sender;
      sender.once("destroyed", ownerDestroyed);
      setCallWindow({ isDestroyed: () => sender.isDestroyed(), webContents: sender } as any);
    }
  };
  const owned = (sender: WebContents) => { if (owner !== sender) throw new Error("VOICE_CALL_NOT_OWNED"); };
  const handlers: Array<[string, (sender: WebContents, value?: unknown) => unknown]> = [
    [IPC.CALL_OPEN, sender => { bind(sender); sender.send("host:call"); }],
    [IPC.CALL_START, sender => { bind(sender); turnBytes = 0; startCall(); }],
    [IPC.CALL_AUDIO_FRAME, (sender, value) => { owned(sender); const pcm = pcmBytes(value); turnBytes += pcm.length; if (turnBytes > 3_840_000) { close(); throw new Error("单轮录音最长 120 秒"); } handleAudioFrame(pcm); }],
    [IPC.CALL_TURN_END, async sender => { owned(sender); await endTurn(); turnBytes = 0; }],
    [IPC.CALL_TTS_DONE, sender => { owned(sender); turnBytes = 0; onTtsDone(); }],
    [IPC.CALL_STOP, sender => { owned(sender); close(); }],
  ];
  for (const [channel, handler] of handlers) {
    ipc.handle(channel, (event, value) => handler(event.sender as any, value));
    ipc.on(channel, (event, value) => { void Promise.resolve().then(() => handler(event.sender as any, value)).catch(error => event.sender.send(IPC.CALL_ERROR, { message: String(error.message || error) })); });
  }
  ipc.handle("web:call-release", event => { owned(event.sender as any); close(false); });
  ipc.handle("web:asr-transcribe", async (event, value) => {
    const config = getAsrConfig();
    if (!config) throw new Error("请先在语音识别设置中启用并配置 ASR");
    const pcm = pcmBytes(value);
    if (pcm.length > 3_840_000) throw new Error("单次音频最长 120 秒");
    let text = "";
    const stream = createAsrStream(config, partial => { text = partial; }, final => { text = final; });
    transcriptions.add(stream);
    const cancel = () => { stream.cancel?.(); };
    event.sender.once("destroyed", cancel);
    try { await stream.start(); stream.sendAudio(pcm); const result = await stream.stop(); return { text: typeof result === "string" ? result : text }; }
    finally { event.sender.removeListener("destroyed", cancel); transcriptions.delete(stream); stream.cancel?.(); }
  });
  return { close() { close(); for (const stream of transcriptions) stream.cancel?.(); transcriptions.clear(); } };
}
