import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { PlaybackState } from "../../shared/music-types";
import { ipcMain, chatWindow } from "./platform";

/** Browser audio output port; MusicService still owns library, account and queue. */
export class MpvController extends EventEmitter {
  private state: PlaybackState = { connected: false, loaded: false, paused: true, position: 0, duration: 0, volume: 70, eofReached: false };
  private source?: { id: string; uri: string };
  constructor() {
    super();
    for (const channel of ["web:audio-source", "web:audio-get", "web:audio-state"]) ipcMain.removeHandler(channel);
    ipcMain.handle("web:audio-source", (_event, id: string) => id === this.source?.id ? this.source.uri : null);
    ipcMain.handle("web:audio-get", () => this.snapshot());
    ipcMain.handle("web:audio-state", (_event, input: any) => {
      if (!this.source || input?.sourceId !== this.source.id) return false;
      for (const key of ["paused", "eofReached", "loaded"] as const) if (typeof input[key] === "boolean") this.state[key] = input[key];
      for (const key of ["position", "duration", "volume"] as const) if (Number.isFinite(input[key]) && input[key] >= 0) this.state[key] = input[key];
      this.emit("state", this.getState()); return true;
    });
  }
  private snapshot() { return { ...this.getState(), sourceId: this.source?.id, src: this.source ? `/api/core/audio?id=${this.source.id}` : null }; }
  private publish(command: string, value?: unknown) { chatWindow.webContents.send("web:audio-command", { command, value, ...this.snapshot() }); this.emit("state", this.getState()); }
  async start() { this.state.connected = true; this.publish("state"); }
  async load(uri: string) { this.source = { id: randomUUID(), uri }; this.state = { ...this.state, loaded: false, paused: false, position: 0, duration: 0, track: undefined, eofReached: false }; this.publish("load"); }
  setTrack(track: PlaybackState["track"]) { this.state.track = track; this.publish("state"); }
  async play() { this.publish("play"); }
  async pause() { this.publish("pause"); }
  async togglePlay() { this.publish(this.state.paused ? "play" : "pause"); }
  async seek(seconds: number, mode = "relative") { this.publish("seek", mode === "absolute" ? seconds : this.state.position + seconds); }
  async setVolume(value: number) { this.state.volume = Math.min(100, Math.max(0, value)); this.publish("volume", this.state.volume); }
  async stop() { this.source = undefined; this.state.loaded = false; this.state.paused = true; this.state.position = 0; this.state.eofReached = false; this.publish("stop"); }
  async next() { this.state.eofReached = true; this.emit("state", this.getState()); }
  async prev() { await this.seek(0, "absolute"); }
  getState() { return { ...this.state }; }
  isReady() { return this.state.connected; }
  onStateChange(listener: (state: PlaybackState) => void) { this.on("state", listener); return () => { this.off("state", listener); }; }
  async dispose() { await this.stop(); this.state.connected = false; this.removeAllListeners(); }
}
