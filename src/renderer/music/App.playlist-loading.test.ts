// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicPlayerProps, Playlist } from "./types";
import { LOCAL_CACHE_PLAYLIST_ID } from "./player-source";

const capture = vi.hoisted(() => ({ props: null as MusicPlayerProps | null }));
vi.mock("./components/MusicPlayer", () => ({ default: (props: MusicPlayerProps) => { capture.props = props; return null; } }));
vi.mock("./components/LoadingScreen", () => ({ default: () => null }));
import { App } from "./App";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
const playlist = (id: string): Playlist => ({ id, name: id, originalId: "", trackCount: 0, tracks: [] });
const tracks = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `song-${i}`, name: `song ${i}`, artists: [] }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function mount() {
  const getPlaylistDetail = vi.fn();
  Object.assign(window, { music: {
    getStatus: async () => ({ ok: true, data: { account: "signed_in" } }),
    getMyPlaylists: async () => ({ ok: true, data: [] }),
    getCachedTracks: async () => ({ ok: true, data: [] }),
    getPlaybackSession: async () => ({ ok: true, data: { queue: tracks(1), queueIndex: 0, playbackMode: "off", playlistId: "previous" } }),
    getPlaylistDetail,
    search: async () => ({ ok: true, data: [] }),
    getLyrics: async () => ({ ok: true }),
    onPlaybackState: () => () => {}, onPlaybackSessionChanged: () => () => {},
    onStateChanged: () => () => {}, onCacheUpdated: () => () => {},
  } });
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(App)); });
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(capture.props?.activePlaylistId).toBe("previous");
  return getPlaylistDetail;
}
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); capture.props = null; });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined; document.body.innerHTML = "";
  delete (window as Window & { music?: unknown }).music;
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe("music playlist loading", () => {
  it("commits all 61 returned songs together with the selected playlist", async () => {
    const api = await mount();
    api.mockResolvedValue({ ok: true, data: { tracks: tracks(61) } });
    await act(async () => { capture.props!.actions.loadPlaylist(playlist("next")); });
    expect(capture.props!.activePlaylistId).toBe("next");
    expect(capture.props!.state.queue).toHaveLength(61);
    expect(capture.props!.state.queue[60].encryptedId).toBe("song-60");
    expect(capture.props!.state.error).toBeUndefined();
    expect(capture.props!.playlistLoadError).toBeUndefined();
  });

  it.each(["structured", "exception"])("keeps the previous queue and playlist on %s failure and shows an error", async (kind) => {
    const api = await mount();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    if (kind === "structured") api.mockResolvedValue({ ok: false, errorCode: "E_PLAYLIST_LOAD_INCOMPLETE" });
    else api.mockRejectedValue(new Error("offline"));
    const previous = capture.props!.state.queue;
    await act(async () => { capture.props!.actions.loadPlaylist(playlist("failed")); });
    expect(capture.props!.activePlaylistId).toBe("previous");
    expect(capture.props!.state.queue).toEqual(previous);
    expect(capture.props!.playlistLoadError?.message).toBeTruthy();
    expect(capture.props!.state.error).toBeUndefined();
    api.mockResolvedValue({ ok: true, data: { tracks: tracks(61) } });
    await act(async () => { capture.props!.playlistLoadError!.onRetry(); });
    expect(api.mock.calls.map(([id]) => id)).toEqual(["failed", "failed"]);
    expect(capture.props!.activePlaylistId).toBe("failed");
    expect(capture.props!.state.queue).toHaveLength(61);
    expect(capture.props!.playlistLoadError).toBeUndefined();
  });

  it("replaces a failed playlist notice when explicitly playing an unavailable song", async () => {
    const api = await mount();
    api.mockResolvedValue({ ok: false, errorCode: "E_PLAYLIST_LOAD_INCOMPLETE" });
    await act(async () => { capture.props!.actions.loadPlaylist(playlist("failed")); });
    expect(capture.props!.playlistLoadError).toBeDefined();
    const song = { ...capture.props!.state.queue[0], visible: false };
    await act(async () => { capture.props!.actions.playTrack(song); });
    expect(capture.props!.playlistLoadError).toBeUndefined();
    expect(capture.props!.state.error).toContain("暂时无法播放");
  });

  it.each(["success", "failure"])("ignores stale %s after a newer playlist has loaded", async (kind) => {
    const api = await mount();
    const old = deferred<{ ok: boolean; data?: unknown; errorCode?: string }>();
    api.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ok: true, data: { tracks: tracks(61) } });
    await act(async () => { capture.props!.actions.loadPlaylist(playlist("old")); });
    await act(async () => { capture.props!.actions.loadPlaylist(playlist("new")); });
    await act(async () => { old.resolve(kind === "success" ? { ok: true, data: { tracks: tracks(2) } } : { ok: false, errorCode: "offline" }); });
    expect(capture.props!.activePlaylistId).toBe("new");
    expect(capture.props!.state.queue).toHaveLength(61);
    expect(capture.props!.state.error).toBeUndefined();
  });

  it("does not overwrite a local cache selection with a late online response", async () => {
    const api = await mount();
    const online = deferred<{ ok: boolean; data: unknown }>();
    api.mockReturnValueOnce(online.promise);
    await act(async () => { capture.props!.actions.loadPlaylist(playlist("online")); });
    await act(async () => { capture.props!.actions.loadPlaylist(playlist(LOCAL_CACHE_PLAYLIST_ID)); });
    await act(async () => { online.resolve({ ok: true, data: { tracks: tracks(61) } }); });
    expect(capture.props!.activePlaylistId).toBe(LOCAL_CACHE_PLAYLIST_ID);
    expect(capture.props!.state.queue).toEqual([]);
  });
});
