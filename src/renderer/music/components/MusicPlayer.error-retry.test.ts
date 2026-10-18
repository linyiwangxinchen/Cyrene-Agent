// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import MusicPlayer from "./MusicPlayer";
import type { MusicPlayerProps, Track } from "../types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
const track: Track = { encryptedId: "old-song", originalId: "", name: "旧歌", artists: [], visible: true };
function props(): MusicPlayerProps {
  return {
    state: { currentTrack: track, queue: [track], queueIndex: 0, isPlaying: false,
      positionMs: 0, durationMs: 0, volume: 70, isMuted: false, playbackMode: "off", isLoading: false },
    actions: { playTrack: vi.fn(), togglePlayPause: vi.fn(), next: vi.fn(), prev: vi.fn(), seek: vi.fn(),
      setVolume: vi.fn(), toggleMute: vi.fn(), addToQueue: vi.fn(), removeFromQueue: vi.fn(),
      loadPlaylist: vi.fn(), cycleMode: vi.fn(), toggleFavorite: vi.fn() },
    playlists: [], activePlaylistId: "old-playlist", onSelectPlaylist: vi.fn(), modeSet: "online",
    searchResults: [], isSearching: false, onSearch: vi.fn(),
  };
}
async function render(value: MusicPlayerProps) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(MusicPlayer, value)); });
}
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  document.body.innerHTML = "";
});

describe("music error retry", () => {
  it.each([true, false])("retries playlist loading without playing the old song (current track: %s)", async (hasTrack) => {
    const value = props();
    if (!hasTrack) value.state.currentTrack = null;
    value.state.error = "旧播放错误";
    value.playlistLoadError = { message: "歌单加载失败，请稍后重试", onRetry: vi.fn() };
    await render(value);
    await act(async () => { (document.querySelector(".mp-error-retry") as HTMLButtonElement).click(); });
    expect(value.playlistLoadError.onRetry).toHaveBeenCalledOnce();
    expect(value.actions.playTrack).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("歌单加载失败");
  });

  it("keeps the existing playback retry for playback errors", async () => {
    const value = props();
    value.state.error = "播放失败";
    await render(value);
    await act(async () => { (document.querySelector(".mp-error-retry") as HTMLButtonElement).click(); });
    expect(value.actions.playTrack).toHaveBeenCalledExactlyOnceWith(track);
  });
});
