// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./App";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined; document.body.innerHTML = "";
  delete (window as Window & { music?: unknown }).music;
  vi.useRealTimers(); vi.restoreAllMocks();
});

async function mountFailedPlaylist() {
  vi.useFakeTimers(); localStorage.clear();
  let playback!: (state: unknown) => void;
  const old = { id: "old-song", name: "旧歌", artists: [] };
  const getPlaylistDetail = vi.fn().mockImplementation(async (id: string) => id === "previous"
    ? { ok: true, data: { tracks: [old] } }
    : { ok: false, errorCode: "E_PLAYLIST_LOAD_INCOMPLETE" });
  const playSessionTrack = vi.fn();
  Object.assign(window, { music: {
    getStatus: async () => ({ ok: true, data: { account: "signed_in" } }),
    getMyPlaylists: async () => ({ ok: true, data: [
      { id: "previous", name: "旧歌单" }, { id: "failed", name: "新歌单" },
    ] }),
    getCachedTracks: async () => ({ ok: true, data: [] }),
    getPlaybackSession: async () => ({ ok: true, data: { queue: [old], queueIndex: 0, playbackMode: "off", playlistId: "previous" } }),
    getPlaylistDetail, playSessionTrack,
    search: async () => ({ ok: true, data: [] }), getLyrics: async () => ({ ok: true }),
    onPlaybackState: (fn: (state: unknown) => void) => { playback = fn; return () => {}; },
    onPlaybackSessionChanged: () => () => {}, onStateChanged: () => () => {}, onCacheUpdated: () => () => {},
  } });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(createElement(App)); });
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  const chip = Array.from(document.querySelectorAll<HTMLButtonElement>(".playlist-chip")).find(el => el.textContent === "新歌单");
  expect(chip).toBeTruthy();
  await act(async () => { chip!.click(); });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("歌单加载失败");
  expect(document.querySelector(".playlist-chip.is-active")?.textContent).toBe("旧歌单");
  return { playback, getPlaylistDetail, playSessionTrack };
}

it("retries the failed playlist through the real player after a playback event, without replaying the old song", async () => {
  const { playback, getPlaylistDetail, playSessionTrack } = await mountFailedPlaylist();
  await act(async () => { playback({ paused: false, position: 5, duration: 180, error: undefined }); });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("歌单加载失败");
  getPlaylistDetail.mockResolvedValue({ ok: true, data: { tracks: Array.from({ length: 61 }, (_, i) => ({ id: `new-${i}`, name: `新歌${i}`, artists: [] })) } });
  await act(async () => { (document.querySelector(".mp-error-retry") as HTMLButtonElement).click(); });
  expect(getPlaylistDetail.mock.calls.filter(([id]) => id === "failed")).toHaveLength(2);
  expect(playSessionTrack).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector(".playlist-chip.is-active")?.textContent).toBe("新歌单");
  expect(document.querySelector(".panel-count")?.textContent).toBe("61");
});


it("shows the latest explicit playback failure and retries that song after a playlist load failed", async () => {
  const { getPlaylistDetail, playSessionTrack } = await mountFailedPlaylist();
  playSessionTrack.mockResolvedValue({ ok: false, errorCode: "E_PLAYBACK_FAILED" });
  const song = document.querySelector<HTMLButtonElement>('button[title="播放"]');
  expect(song).toBeTruthy();
  await act(async () => { song!.click(); });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("播放失败：E_PLAYBACK_FAILED");
  expect(document.querySelector('[role="alert"]')?.textContent).not.toContain("歌单加载失败");
  playSessionTrack.mockResolvedValue({ ok: true });
  await act(async () => { (document.querySelector(".mp-error-retry") as HTMLButtonElement).click(); });
  expect(playSessionTrack).toHaveBeenCalledTimes(2);
  expect(playSessionTrack.mock.calls[1][0].queue[0].encryptedId).toBe("old-song");
  expect(getPlaylistDetail.mock.calls.filter(([id]) => id === "failed")).toHaveLength(1);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
