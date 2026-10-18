import { describe, it, expect, vi } from "vitest";
import { NeteaseOpenapiProvider } from "./netease-openapi-provider";
import type { NeteaseOpenapiClient } from "./netease-openapi-client";
import type { PlaybackDispatchResult } from "./types";

const ENC = "4C777A98B81DF0CC069B59F63F3882B1";
const ENC2 = "B".repeat(32);

function makeClient() {
  return {
    getDailyRecommendations: vi.fn(),
    searchSongs: vi.fn(),
    getSongDetail: vi.fn(),
    getCreatedPlaylists: vi.fn(),
    getPlaylistDetail: vi.fn(),
    getPlaylistSongs: vi.fn(),
    createPlaylist: vi.fn(),
    addSongsToPlaylist: vi.fn(),
    removeSongsFromPlaylist: vi.fn(),
    getSubscribedAlbums: vi.fn(),
  };
}

const songRec = { originalId: 1, id: ENC, name: "晴天", artists: [{ name: "周杰伦" }], duration: 182890 };

describe("NeteaseOpenapiProvider", () => {
  it("searchTracks trims keyword and normalizes records", async () => {
    const c = makeClient();
    c.searchSongs.mockResolvedValue({ recordCount: 1, records: [songRec, { ...songRec, id: ENC2, visible: false }] });
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient);
    const tracks = await p.searchTracks("  晴天  ");
    expect(c.searchSongs).toHaveBeenCalledWith("晴天", 30, 0);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ id: ENC, encryptedId: ENC, originalId: 1 });
  });

  it("searchTracks rejects empty keyword", async () => {
    const p = new NeteaseOpenapiProvider(makeClient() as unknown as NeteaseOpenapiClient);
    await expect(p.searchTracks("   ")).rejects.toThrow(/E_SEARCH_KEYWORD_EMPTY/);
  });

  it("getDailyRecommendations normalizes the bare array", async () => {
    const c = makeClient();
    c.getDailyRecommendations.mockResolvedValue([songRec]);
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient);
    expect(await p.getDailyRecommendations()).toHaveLength(1);
  });

  it("playTrack: without dispatcher → client_unavailable (URL still resolved)", async () => {
    const c = makeClient();
    c.getSongDetail.mockResolvedValue({ name: "晴天", playUrl: "http://x/y.mp3" });
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient);
    const r = await p.playTrack(ENC);
    expect(r).toEqual({
      state: "client_unavailable",
      resourceType: "song",
      resourceId: ENC,
      errorCode: "E_PLAYBACK_DISPATCHER_MISSING",
    });
  });

  it("playTrack: dispatches resolved URL; no playUrl → E_TRACK_NOT_PLAYABLE; bad id → E_INVALID_ENCRYPTED_ID", async () => {
    const c = makeClient();
    c.getSongDetail.mockResolvedValue({ name: "晴天", playUrl: "http://x/y.mp3", artistName: "周杰伦" });
    const dispatch = vi.fn().mockResolvedValue({ state: "dispatched", resourceType: "song", resourceId: ENC });
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient, dispatch);
    await p.playTrack(ENC);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ kind: "song", playUrl: "http://x/y.mp3" }));

    c.getSongDetail.mockResolvedValue({ name: "受限", playUrl: "" });
    await expect(p.playTrack(ENC)).rejects.toThrow(/E_TRACK_NOT_PLAYABLE/);

    await expect(p.playTrack("123")).rejects.toThrow(/E_INVALID_ENCRYPTED_ID/);
  });

  it("playPlaylist: skips unplayable first tracks, dispatches with full track list", async () => {
    const c = makeClient();
    c.getPlaylistSongs.mockResolvedValue([
      { ...songRec, id: ENC, visible: false },
      { ...songRec, id: ENC2, name: "second" },
    ]);
    c.getSongDetail.mockResolvedValue({ name: "second", playUrl: "http://x/2.mp3" });
    const dispatch = vi.fn().mockResolvedValue({ state: "dispatched", resourceType: "playlist", resourceId: "pl" });
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient, dispatch);
    const r = await p.playPlaylist("pl");
    expect(r.state).toBe("dispatched");
    expect(c.getSongDetail).toHaveBeenCalledTimes(1);
    expect(c.getSongDetail).toHaveBeenCalledWith(ENC2);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "playlist", tracks: [expect.objectContaining({ id: ENC2 })] }),
    );
  });

  it.each([0, 1, 2])("playPlaylist: binds the URL to playable track %i without reordering the queue", async (selected) => {
    const c = makeClient();
    const records = [ENC, ENC2, "C".repeat(32)].map((id, index) => ({
      ...songRec, id, name: `song ${index}`,
    }));
    c.getPlaylistSongs.mockResolvedValue(records);
    c.getSongDetail.mockImplementation(async (id: string) => ({
      playUrl: id === records[selected].id ? "https://example.test/selected.mp3" : "",
    }));
    const dispatch = vi.fn().mockResolvedValue({ state: "dispatched" });
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient, dispatch);

    await p.playPlaylist("pl");

    expect(c.getSongDetail.mock.calls.map(([id]) => id)).toEqual(records.slice(0, selected + 1).map(({ id }) => id));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      kind: "playlist",
      playUrl: "https://example.test/selected.mp3",
      selectedTrack: expect.objectContaining({ id: records[selected].id, name: records[selected].name }),
      tracks: records.map(({ id }) => expect.objectContaining({ id })),
    });
  });

  it("playPlaylist: no playable URL never dispatches", async () => {
    const c = makeClient();
    c.getPlaylistSongs.mockResolvedValue([songRec, { ...songRec, id: ENC2 }]);
    c.getSongDetail.mockResolvedValue({ playUrl: "" });
    const dispatch = vi.fn();
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient, dispatch);
    await expect(p.playPlaylist("pl")).rejects.toThrow("E_PLAYLIST_NOT_PLAYABLE");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("playPlaylist: URL lookup failure never dispatches a mismatched fallback", async () => {
    const c = makeClient();
    c.getPlaylistSongs.mockResolvedValue([songRec, { ...songRec, id: ENC2 }]);
    c.getSongDetail.mockResolvedValueOnce({ playUrl: "" }).mockRejectedValueOnce(new Error("detail unavailable"));
    const dispatch = vi.fn();
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient, dispatch);
    await expect(p.playPlaylist("pl")).rejects.toThrow("detail unavailable");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("playPlaylist: empty playlist → E_PLAYLIST_EMPTY", async () => {
    const c = makeClient();
    c.getPlaylistSongs.mockResolvedValue([]);
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient);
    await expect(p.playPlaylist("pl")).rejects.toThrow(/E_PLAYLIST_EMPTY/);
  });

  it("getMyPlaylists / getPlaylistDetail / createPlaylist / addToPlaylist", async () => {
    const c = makeClient();
    c.getCreatedPlaylists.mockResolvedValue({ records: [{ id: "P".repeat(32), name: "list", trackCount: 3 }] });
    c.getPlaylistDetail.mockResolvedValue({ id: "P".repeat(32), name: "list", describe: "d" });
    c.getPlaylistSongs.mockResolvedValue([songRec]);
    c.createPlaylist.mockResolvedValue({ id: "Q".repeat(32), name: "new" });
    c.addSongsToPlaylist.mockResolvedValue({ count: 1 });
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient);

    expect((await p.getMyPlaylists())[0].trackCount).toBe(3);
    const detail = await p.getPlaylistDetail("P".repeat(32));
    expect(detail).toMatchObject({ name: "list", description: "d" });
    expect(detail.tracks[0].encryptedId).toBe(ENC);

    const created = await p.createPlaylist(" new ");
    expect(c.createPlaylist).toHaveBeenCalledWith("new");
    expect(created.id).toBe("Q".repeat(32));

    const added = await p.addToPlaylist("P".repeat(32), [ENC]);
    expect(added).toEqual({ added: 1, playlistId: "P".repeat(32) });
    await expect(p.addToPlaylist("P".repeat(32), [])).rejects.toThrow(/E_ADD_TO_PLAYLIST_EMPTY/);
    await expect(p.addToPlaylist("P".repeat(32), ["not-hex"])).rejects.toThrow(/E_INVALID_ENCRYPTED_ID/);
  });

  it("removeFromPlaylist: normalizes count, validates ids", async () => {
    const c = makeClient();
    c.removeSongsFromPlaylist.mockResolvedValue({ count: 1 });
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient);

    const removed = await p.removeFromPlaylist("P".repeat(32), [ENC, ENC2]);
    expect(c.removeSongsFromPlaylist).toHaveBeenCalledWith("P".repeat(32), [ENC, ENC2]);
    expect(removed).toEqual({ removed: 1, playlistId: "P".repeat(32) });

    // 无 count 字段 → 回退为请求数
    c.removeSongsFromPlaylist.mockResolvedValue({ whatever: true });
    const fallback = await p.removeFromPlaylist("P".repeat(32), [ENC, ENC2]);
    expect(fallback.removed).toBe(2);

    await expect(p.removeFromPlaylist("P".repeat(32), [])).rejects.toThrow(/E_REMOVE_FROM_PLAYLIST_EMPTY/);
    await expect(p.removeFromPlaylist("P".repeat(32), ["not-hex"])).rejects.toThrow(/E_INVALID_ENCRYPTED_ID/);
  });

  it("getMySubscriptions: artists → [] (no endpoint), albums → normalized", async () => {
    const c = makeClient();
    c.getSubscribedAlbums.mockResolvedValue({ records: [{ id: "A".repeat(32), name: "叶惠美" }] });
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient);
    expect(await p.getMySubscriptions("artists")).toEqual([]);
    expect((await p.getMySubscriptions("albums"))[0].name).toBe("叶惠美");
  });

  it("passes dispatcher failures through", async () => {
    const c = makeClient();
    c.getSongDetail.mockResolvedValue({ name: "x", playUrl: "http://x/y.mp3" });
    const dispatch = vi.fn().mockResolvedValue({ state: "launch_failed", resourceType: "song", resourceId: ENC } as PlaybackDispatchResult);
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient, dispatch);
    expect((await p.playTrack(ENC)).state).toBe("launch_failed");
  });
});

describe("playlist song pagination", () => {
  const songs = (count: number) => Array.from({ length: count }, (_, i) => ({
    ...songRec, id: (i + 1).toString(16).padStart(32, "0"), name: `song ${i + 1}`, visible: true,
  }));
  function setup(records: ReturnType<typeof songs>) {
    const client = makeClient();
    client.getPlaylistDetail.mockResolvedValue({ id: "playlist", name: "list", trackCount: records.length });
    client.getPlaylistSongs.mockImplementation((_id, limit, offset) => Promise.resolve(records.slice(offset, offset + limit)));
    client.getSongDetail.mockResolvedValue({ playUrl: "https://example.test/song.mp3" });
    const dispatch = vi.fn().mockResolvedValue({ state: "dispatched", resourceType: "playlist" });
    return { client, dispatch, provider: new NeteaseOpenapiProvider(client as unknown as NeteaseOpenapiClient, dispatch) };
  }

  it.each([0, 20, 30, 60, 100])("loads all %i songs including exact page boundaries", async (count) => {
    const { client, provider } = setup(songs(count));
    const detail = await provider.getPlaylistDetail("playlist");
    expect(detail.tracks.map((t) => t.id)).toEqual(songs(count).map((s) => s.id));
    expect(client.getPlaylistSongs.mock.calls).toEqual(
      Array.from({ length: Math.floor(count / 30) + 1 }, (_, page) => ["playlist", 30, page * 30]),
    );
  });

  it.each([0, 3, 30])("keeps later playable songs when only %i songs on the first page are visible", async (visible) => {
    const records = songs(100).map((song, i) => ({ ...song, visible: i >= 30 || i < visible }));
    const { client, dispatch, provider } = setup(records);
    const detail = await provider.getPlaylistDetail("playlist");
    expect(detail.tracks).toHaveLength(70 + visible);
    client.getPlaylistSongs.mockClear();
    await provider.playPlaylist("playlist");
    expect(dispatch).toHaveBeenCalledWith({ kind: "playlist", playUrl: "https://example.test/song.mp3", tracks: detail.tracks, selectedTrack: detail.tracks[0] });
    expect(client.getPlaylistSongs.mock.calls.map((args) => args[2])).toEqual([0, 30, 60, 90]);
    expect(client.getSongDetail).toHaveBeenCalledWith(detail.tracks[0].id);
  });

  it("does not use filtered length or missing ids to advance pagination", async () => {
    const records = songs(61).map((song, i) => ({ ...song, id: i < 30 ? "" : song.id }));
    const { client, provider } = setup(records);
    expect((await provider.getPlaylistDetail("playlist")).tracks).toHaveLength(31);
    expect(client.getPlaylistSongs.mock.calls.map((args) => args[2])).toEqual([0, 30, 60]);
  });

  it.each(["", undefined])("loads later valid songs after two full pages with missing encrypted IDs (%s)", async (id) => {
    const records = songs(61).map((song, i) => ({ ...song, originalId: i + 1, id: i < 60 ? id : song.id }));
    const { client, dispatch, provider } = setup([]);
    client.getPlaylistSongs.mockImplementation((_id, limit, offset) => Promise.resolve(records.slice(offset, offset + limit)));
    const detail = await provider.getPlaylistDetail("playlist");
    expect(detail.tracks.map((track) => track.id)).toEqual([records[60].id]);
    expect(client.getPlaylistSongs.mock.calls.map((args) => args[2])).toEqual([0, 30, 60]);
    await provider.playPlaylist("playlist");
    expect(dispatch).toHaveBeenCalledWith({ kind: "playlist", playUrl: "https://example.test/song.mp3", tracks: detail.tracks, selectedTrack: detail.tracks[0] });
  });

  it("does not treat pages without reliable identities as proof of a repeated page", async () => {
    const records = songs(61).map((song, i) => i < 60 ? { ...song, id: "", originalId: 0 } : song);
    const { client, provider } = setup(records);
    expect((await provider.getPlaylistDetail("playlist")).tracks).toHaveLength(1);
    expect(client.getPlaylistSongs.mock.calls.map((args) => args[2])).toEqual([0, 30, 60]);
  });

  it("still rejects repeated pages identified by original IDs", async () => {
    const { client, provider } = setup([]);
    client.getPlaylistSongs.mockResolvedValue(songs(30).map((song, i) => ({ ...song, id: "", originalId: i + 1 })));
    await expect(provider.getPlaylistDetail("playlist")).rejects.toThrow("repeated page");
    expect(client.getPlaylistSongs).toHaveBeenCalledTimes(2);
  });

  it("bounds pages without reliable identities when the endpoint never terminates", async () => {
    const { client, provider } = setup([]);
    client.getPlaylistSongs.mockResolvedValue(songs(30).map((song) => ({ ...song, id: "", originalId: 0 })));
    await expect(provider.getPlaylistDetail("playlist")).rejects.toThrow("pagination limit reached");
    expect(client.getPlaylistSongs).toHaveBeenCalledTimes(1000);
  });

  it.each([undefined, 0, 1, 999])("does not trust stale playlist trackCount %s as a pagination boundary", async (trackCount) => {
    const { client, provider } = setup(songs(61));
    client.getPlaylistDetail.mockResolvedValue({ id: "playlist", trackCount });
    expect((await provider.getPlaylistDetail("playlist")).tracks).toHaveLength(61);
  });

  it("fully checks invisible playlists before reporting empty playback", async () => {
    const { client, dispatch, provider } = setup(songs(61).map((song) => ({ ...song, visible: false })));
    await expect(provider.playPlaylist("playlist")).rejects.toThrow("E_PLAYLIST_EMPTY");
    expect(client.getPlaylistSongs).toHaveBeenCalledTimes(3);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["getPlaylistDetail", "playPlaylist"] as const)("%s propagates later page failure without dispatching a partial queue", async (method) => {
    const { client, dispatch, provider } = setup(songs(61));
    client.getPlaylistSongs.mockReset().mockResolvedValueOnce(songs(30)).mockRejectedValueOnce(new Error("page unavailable"));
    await expect(provider[method]("playlist")).rejects.toThrow("page unavailable");
    expect(dispatch).not.toHaveBeenCalled();
    expect(client.getSongDetail).not.toHaveBeenCalled();
  });

  it("rejects repeated pages instead of returning duplicate partial results", async () => {
    const { client, dispatch, provider } = setup(songs(60));
    client.getPlaylistSongs.mockResolvedValue(songs(30));
    await expect(provider.playPlaylist("playlist")).rejects.toThrow("E_PLAYLIST_LOAD_INCOMPLETE");
    expect(client.getPlaylistSongs).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects malformed pages rather than treating them as an empty playlist", async () => {
    const { client, provider } = setup([]);
    client.getPlaylistSongs.mockResolvedValue(undefined);
    await expect(provider.getPlaylistDetail("playlist")).rejects.toThrow("E_PLAYLIST_LOAD_INCOMPLETE");
  });

  it("bounds non-terminating pagination with an explicit failure", async () => {
    const { client, dispatch, provider } = setup([]);
    client.getPlaylistSongs.mockImplementation((_id, _limit, offset) => Promise.resolve(songs(30).map((song) => ({ ...song, id: `${offset}-${song.id}` }))));
    await expect(provider.playPlaylist("playlist")).rejects.toThrow("pagination limit reached");
    expect(client.getPlaylistSongs).toHaveBeenCalledTimes(1000);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("preserves the search and daily recommendation limit", async () => {
    const { client, provider } = setup([]);
    client.searchSongs.mockResolvedValue({ records: songs(100) });
    client.getDailyRecommendations.mockResolvedValue(songs(100));
    expect(await provider.searchTracks("songs")).toHaveLength(30);
    expect(await provider.getDailyRecommendations()).toHaveLength(30);
  });
});

describe("concurrent playlist loading", () => {
  it("keeps offsets and repeat detection local to each request", async () => {
    const client = makeClient();
    const records = Array.from({ length: 31 }, (_, i) => ({ ...songRec, id: String(i) }));
    client.getPlaylistDetail.mockImplementation(async (id) => ({ id }));
    client.getPlaylistSongs.mockImplementation(async (_id, limit, offset) => records.slice(offset, offset + limit));
    const provider = new NeteaseOpenapiProvider(client as unknown as NeteaseOpenapiClient);
    const results = await Promise.all([provider.getPlaylistDetail("a"), provider.getPlaylistDetail("b")]);
    expect(results.map((result) => result.tracks.length)).toEqual([31, 31]);
    for (const id of ["a", "b"]) {
      expect(client.getPlaylistSongs.mock.calls.filter((args) => args[0] === id).map((args) => args[2])).toEqual([0, 30]);
    }
  });
});
