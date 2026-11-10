import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

let sequence = 0;
const response = (body, cookies = []) => ({
  ok: true, status: 200, json: async () => body, headers: { getSetCookie: () => cookies },
});

async function setup(handler, savedSession) {
  const storage = new Map(savedSession ? [["session", structuredClone(savedSession)]] : []);
  const prompts = [];
  const storageReads = [];
  globalThis.host = {
    storage: { get: (k) => { storageReads.push(k); return storage.get(k); }, set: (k, v) => storage.set(k, structuredClone(v)), remove: (k) => storage.delete(k) },
    crypto: {
      md5: (text) => createHash("md5").update(text).digest("hex"),
      aesEcbEncrypt: (key, text) => {
        const c = createCipheriv("aes-128-ecb", key, null);
        return Buffer.concat([c.update(text, "utf8"), c.final()]).toString("hex");
      },
    },
    signInPrompt: (prompt) => prompts.push(prompt),
  };
  globalThis.fetch = handler;
  const plugin = await import(`./index.js?test=${++sequence}`);
  return { plugin, storage, prompts, storageReads };
}

function decode(body) {
  const encrypted = new URLSearchParams(body).get("params");
  const c = createDecipheriv("aes-128-ecb", "e82ckenh8dichen8", null);
  const text = Buffer.concat([c.update(Buffer.from(encrypted, "hex")), c.final()]).toString();
  const [path, json, digest] = text.split("-36cd479b6b5-");
  assert.equal(digest, createHash("md5").update(`nobody${path}use${json}md5forencrypt`).digest("hex"));
  return { path, data: JSON.parse(json) };
}

const song = (id) => ({ id, name: `Song ${id}`, ar: [{ id: 5, name: "Artist" }], al: { id: 6, name: "Album" }, dt: 180000, fee: 1 });

// Each public search mapping must expose a template, not the full original or
// a fixed small picture that would also be used in Now Playing.
test("search provides sized artwork for tracks, albums, artists, playlists and shows", async () => {
  const picture = "http://p1.music.126.net/fixture.jpg";
  const track = { ...song(1), al: { id: 6, picUrl: picture }, ar: [{ id: 5, img1v1Url: picture }] };
  for (const [kind, key, item] of [
    ["tracks", "songs", track], ["albums", "albums", { id: 6, picUrl: picture }],
    ["artists", "artists", { id: 5, img1v1Url: picture }],
    ["playlists", "playlists", { id: 9, coverImgUrl: picture }],
    ["shows", "djRadios", { id: 8, picUrl: picture }],
  ]) {
    const { plugin } = await setup(async (url) => url.includes("cloudsearch")
      ? response({ code: 200, result: { [key]: [item] } })
      : response({ code: 200, songs: [track], privileges: [] }));
    const record = (await plugin.search({ query: "fixture", kind }))[kind][0];
    const images = kind === "tracks" ? [record.album.imageUrl, record.artists[0].imageUrl] : [record.imageUrl];
    for (const image of images) {
      const url = new URL(image);
      assert.equal(url.protocol, "https:", kind);
      assert.equal(url.searchParams.get("param"), "{size}y{size}", kind);
    }
  }
});

// Only the image CDN understands param; existing query values, fragments and
// non-CDN URLs must survive without redirecting their requests to another host.
test("artwork templates preserve query values and leave other URLs alone", async () => {
  const source = "https://p12.music.126.net/cover.jpg?quality=90&param=200y200&version=v2&param=800y800&label=a%20b&token=a%2Fb#cover";
  const unchanged = [
    "https://images.example/cover.jpg?param=200y200",
    "https://p1.music.126.net.example/cover.jpg",
    "https://m1.music.126.net/cover.jpg",
    "https://p1.music.126.net:8443/cover.jpg",
    "https://user:password@p1.music.126.net/cover.jpg",
    "file:///tmp/cover.jpg", "data:image/png;base64,fixture", "not a URL",
  ];
  const { plugin } = await setup(async () => response({ code: 200, result: {
    albums: [source, ...unchanged, "http://images.example/cover.jpg", "", null].map((picUrl, id) => ({ id, picUrl })),
  } }));
  const albums = (await plugin.search({ query: "fixture", kind: "albums" })).albums;
  const url = new URL(albums[0].imageUrl);
  assert.deepEqual(url.searchParams.getAll("param"), ["{size}y{size}"]);
  assert.equal(url.searchParams.get("quality"), "90");
  assert.equal(url.searchParams.get("version"), "v2");
  assert.equal(url.searchParams.get("label"), "a b");
  assert.equal(url.searchParams.get("token"), "a/b");
  assert.equal(url.hash, "#cover");
  assert.deepEqual(albums.slice(1, 1 + unchanged.length).map(album => album.imageUrl), unchanged);
  assert.deepEqual(albums.slice(-3).map(album => album.imageUrl), ["https://images.example/cover.jpg", "", ""]);
});

// Podcast episodes can have their own cover or fall back to their show; both
// routes need the same size contract as albums and playlist artwork.
test("podcast covers and episode fallbacks use sized artwork", async () => {
  const showPicture = "https://p2.music.126.net/show.jpg";
  const episodePicture = "https://p3.music.126.net/episode.jpg";
  const { plugin } = await setup(async (url) => url.includes("djradio/v2/get")
    ? response({ code: 200, data: { id: 8, picUrl: showPicture } })
    : response({ code: 200, programs: [
      { id: 1, coverUrl: episodePicture, mainSong: { id: 11 } },
      { id: 2, mainSong: { id: 12 } },
    ] }));
  const page = await plugin.show({ id: "8" });
  const covers = [page.show.imageUrl, ...page.episodes.map(episode => episode.album.imageUrl)];
  assert.deepEqual(covers.map(cover => new URL(cover).pathname), ["/show.jpg", "/episode.jpg", "/show.jpg"]);
  assert.ok(covers.every(cover => new URL(cover).searchParams.get("param") === "{size}y{size}"));
});

// Account and comment avatars pass through the host's image loader too.
test("account and comment avatars use the same artwork size contract", async () => {
  const picture = "https://p4.music.126.net/avatar.jpg";
  const { plugin } = await setup(async (url) => url.includes("account/get")
    ? response({ code: 200, profile: { userId: 8, nickname: "Fixture", avatarUrl: picture } })
    : response({ code: 200, comments: [{ commentId: 9, user: { nickname: "Fixture", avatarUrl: picture } }] }),
  { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  const account = await plugin.account();
  const page = await plugin.comments({ trackId: "1" });
  assert.equal(new URL(account.imageUrl).searchParams.get("param"), "{size}y{size}");
  assert.equal(new URL(page.comments[0].avatarUrl).searchParams.get("param"), "{size}y{size}");
});

// MyGo 0.1.6 holds its mutex while importing: top-level storage calls deadlock.
test("module initialization defers host storage until an action", async () => {
  const { plugin, storageReads } = await setup(async () => response({ code: 200 }));
  assert.deepEqual(storageReads, []);
  assert.equal(await plugin.account(), null);
  assert.deepEqual(storageReads, ["session"]);
});

// Details may return IDs in another order and correct search's stale privileges.
test("search preserves order, pages, and uses the account's detail privileges", async () => {
  const { plugin } = await setup(async (url, init) => {
    if (url.includes("cloudsearch")) {
      assert.equal(new URL(url).searchParams.get("offset"), "30");
      return response({ code: 200, result: { songs: [song(1), song(2)], songCount: 90 } });
    }
    const { path, data } = decode(init.body);
    assert.equal(path, "/api/v3/song/detail");
    assert.deepEqual(JSON.parse(data.c), [{ id: 1 }, { id: 2 }]);
    return response({ code: 200, songs: [song(2), song(1)], privileges: [{ id: 1, st: 0, pl: 320000 }, { id: 2, st: 0, pl: 0 }] });
  });
  const result = await plugin.search({ query: "song", offset: 30 });
  assert.deepEqual(result.tracks.map((t) => [t.id, t.unavailable]), [["1", false], ["2", true]]);
  assert.equal(result.more, true);
});

// A playlist can contain only a preview of the actual track list.
test("playlist resolves trackIds beyond the preview and retains their order", async () => {
  const { plugin } = await setup(async (url) => url.includes("playlist/detail")
    ? response({ code: 200, playlist: { id: 9, name: "List", trackCount: 3, tracks: [song(3)], trackIds: [{ id: 3 }, { id: 2 }, { id: 1 }] } })
    : response({ code: 200, songs: [song(1), song(2), song(3)], privileges: [] }));
  assert.deepEqual((await plugin.playlist({ id: "9" })).tracks.map((t) => t.id), ["3", "2", "1"]);
});

// Previews and missing authorization must not be represented as full playback.
test("stream rejects previews, unavailable tracks and unexpected download hosts", async () => {
  for (const audio of [
    { id: 1, url: "https://m1.music.126.net/song.mp3", freeTrialInfo: { start: 0, end: 30 } },
    { id: 1, url: null, code: 404 },
    { id: 1, url: "https://unexpected.example/song.mp3" },
  ]) {
    const { plugin } = await setup(async () => response({ code: 200, data: [audio] }));
    await assert.rejects(plugin.stream({ id: "1" }), { code: "unavailable" });
  }
});

// Host quality names differ from NetEase's; CDN requests must never get cookies.
test("stream maps quality and keeps the session away from the CDN", async () => {
  const urls = [];
  const { plugin } = await setup(async (url, init) => {
    urls.push(url);
    const query = new URL(url).searchParams;
    assert.equal(query.get("level"), "exhigh");
    assert.match(init.headers.Cookie, /MUSIC_U=synthetic-session/);
    return response({ code: 200, data: [{ id: 1, code: 200, url: "http://m1.music.126.net/song.mp3?token=audio%2Ftoken&expires=123", type: "mp3", level: "exhigh", size: 100, freeTrialInfo: null }] });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  const audio = await plugin.stream({ id: "1", quality: "high" });
  assert.equal(audio.url, "https://m1.music.126.net/song.mp3?token=audio%2Ftoken&expires=123");
  assert.equal(audio.quality, "high");
  assert.equal(audio.headers.Cookie, undefined);
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).origin, "https://music.163.com");
});

// A late account response after sign-out must not resurrect persisted credentials.
test("sign-out wins over an in-flight account request", async () => {
  let finish;
  const { plugin, storage } = await setup(() => new Promise((resolve) => { finish = resolve; }), {
    cookies: { MUSIC_U: "synthetic-session" }, profile: null,
  });
  const pending = plugin.account();
  plugin.signOut();
  finish(response({ code: 200, profile: { userId: 8, nickname: "Fixture" } }));
  await assert.rejects(pending);
  assert.equal(await plugin.account(), null);
  assert.equal(storage.has("session"), false);
});

// A QR confirmation persists only accepted session cookies, not response metadata.
test("QR sign-in stores an approved session, restores it, then removes it on sign-out", async () => {
  const { plugin, storage, prompts } = await setup(async (url, init) => {
    if (url.includes("unikey")) return response({ code: 200, unikey: "synthetic-qr" });
    if (url.includes("qrcode/client/login")) return response({ code: 803 }, [
      "MUSIC_U=synthetic-session; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/; HttpOnly",
      "__csrf=synthetic-csrf; Path=/", "unrelated=ignored; Path=/",
    ]);
    assert.equal(init.headers.Cookie, "MUSIC_U=synthetic-session; __csrf=synthetic-csrf");
    return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
  });
  assert.equal((await plugin.signIn()).id, "8");
  assert.equal(prompts.some((p) => !!p.qr), true);
  assert.deepEqual(Object.keys(storage.get("session").cookies).sort(), ["MUSIC_U", "__csrf"]);
  assert.equal((await plugin.account()).name, "Fixture");
  plugin.signOut();
  assert.equal(await plugin.account(), null);
  assert.equal(storage.has("session"), false);
});

// Expired credentials must lead to a sign-in prompt instead of endless retries.
test("expired session is cleared; guest private actions require sign-in", async () => {
  const { plugin, storage } = await setup(async () => response({ code: 301 }), {
    cookies: { MUSIC_U: "synthetic-session" }, profile: null,
  });
  assert.equal(await plugin.account(), null);
  assert.equal(storage.has("session"), false);
  await assert.rejects(plugin.like({ id: "1", on: true }), { code: "signIn" });
  await assert.rejects(plugin.liked({ offset: 0 }), { code: "signIn" });
  assert.deepEqual(await plugin.playlists(), []);
});

// Missing details must still consume a slot in the host's offset-based pages.
test("search and liked keep missing IDs across partial and empty detail pages", async () => {
  const all = Array.from({ length: 60 }, (_, i) => i + 1);
  for (const kind of ["search", "liked"]) {
    for (const missingAll of [false, true]) {
      const offsets = [];
      const { plugin } = await setup(async (url, init) => {
        if (url.includes("account/get")) return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
        if (url.includes("cloudsearch")) {
          const offset = Number(new URL(url).searchParams.get("offset"));
          offsets.push(offset);
          return response({ code: 200, result: { songs: all.slice(offset, offset + 30).map(song), songCount: 60 } });
        }
        const { path, data } = decode(init.body);
        if (path === "/api/song/like/get") return response({ code: 200, ids: all });
        assert.equal(path, "/api/v3/song/detail");
        const ids = JSON.parse(data.c).map(x => x.id);
        const present = ids.filter(id => missingAll ? id > 30 : id !== 1);
        return response({ code: 200, songs: present.map(song), privileges: present.map(id => ({ id, st: 0, pl: 320000 })) });
      }, kind === "liked" ? { cookies: { MUSIC_U: "synthetic-session" }, profile: null } : undefined);
      const page = offset => kind === "search" ? plugin.search({ query: "song", offset }) : plugin.liked({ offset });
      const first = await page(0);
      assert.equal(first.tracks.length, 30);
      assert.equal(first.more, true);
      assert.equal(first.tracks[0].id, "1");
      assert.equal(first.tracks[0].unavailable, true);
      if (kind === "search") assert.equal(first.tracks[0].name, "Song 1");
      if (missingAll) assert.ok(first.tracks.every(track => track.unavailable));
      const second = await page(first.tracks.length);
      assert.equal(second.more, false);
      assert.deepEqual([...first.tracks, ...second.tracks].map(track => track.id), all.map(String));
      if (kind === "search") assert.deepEqual(offsets, [0, 30]);
    }
  }
});

// A successful response can revoke a session through Set-Cookie, not only code 301.
test("server cookie deletion clears persisted state and cannot return after reload", async () => {
  for (const cookie of [
    "MUSIC_U=deleted; Max-Age=0; Path=/",
    "MUSIC_U=deleted; Max-Age=-1; Path=/",
    "MUSIC_U=; Path=/",
    "MUSIC_U=deleted; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/",
  ]) {
    const { plugin, storage } = await setup(async () => response({ code: 200, result: [] }, [cookie]), {
      cookies: { MUSIC_U: "synthetic-old-session" }, profile: { id: "8", name: "Fixture" },
    });
    await assert.rejects(plugin.home(), { code: "signIn" });
    assert.equal(storage.has("session"), false);
    assert.equal(await plugin.account(), null);
    const restored = await setup(async (_url, init) => {
      assert.equal(init.headers.Cookie, undefined);
      return response({ code: 200, result: [] });
    }, storage.get("session"));
    await restored.plugin.home();
    assert.equal(await restored.plugin.account(), null);
  }
});

// A positive Max-Age overrides Expires and must persist the replacement cookie.
test("normal cookie renewal remains persisted", async () => {
  const { plugin, storage } = await setup(async () => response({ code: 200, result: [] }, [
    "MUSIC_U=synthetic-renewed; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/",
  ]), { cookies: { MUSIC_U: "synthetic-old" }, profile: null });
  await plugin.home();
  assert.equal(storage.get("session").cookies.MUSIC_U, "synthetic-renewed");
});

// Concurrent requests share a single retry, using the same identity and quality.
test("stream recovers from 460 without duplicating concurrent requests", async () => {
  for (const code of [460, -460]) {
    const desktop = [];
    let calls = 0;
    const { plugin } = await setup(async (url, init) => {
      calls++;
      if (url.includes("interfacepc")) desktop.push(decode(init.body).data);
      // The web request and the first desktop request are both refused.
      if (calls <= 2) return response({ code });
      return response({ code: 200, data: [{ id: 1, code: 200, url: "https://m1.music.126.net/song.mp3", type: "mp3", freeTrialInfo: null }] });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
    const [a, b] = await Promise.all([plugin.stream({ id: "1" }), plugin.stream({ id: "1" })]);
    assert.deepEqual(a, b);
    assert.equal(calls, 3);
    assert.equal(desktop.length, 2);
    assert.equal(desktop[0].header.deviceId, desktop[1].header.deviceId);
    assert.equal(desktop[0].header.MUSIC_U, desktop[1].header.MUSIC_U);
    assert.equal(desktop[0].level, desktop[1].level);
  }
});

// Persistent rejection stops after two eapi attempts plus one web attempt, and the failed promise isn't cached.
test("stream bounds persistent 460 retries and releases the in-flight entry", async () => {
  let calls = 0;
  const { plugin } = await setup(async () => {
    calls++;
    if (calls <= 3) return response({ code: -460 });
    return response({ code: 200, data: [{ id: 1, url: "https://m1.music.126.net/song.mp3", freeTrialInfo: null }] });
  });
  await assert.rejects(plugin.stream({ id: "1" }), /仍拒绝播放请求（-460）/);
  assert.equal(calls, 3);
  assert.equal((await plugin.stream({ id: "1" })).type, "mp3");
  assert.equal(calls, 4);
});

// The desktop eapi is throttled intermittently; the web endpoint serves the same
// song/quality/account, but preview audio must still be refused there.
test("stream tries the web endpoint first and falls back to the desktop one", async () => {
  const cases = [
    // [web body, desktop body, expected requests]
    [{ code: 200, data: [{ id: 1, code: 200, url: "http://m1.music.126.net/web.mp3", type: "mp3", freeTrialInfo: null }] }, null, 1, "https://m1.music.126.net/web.mp3"],
    [{ code: -460 }, { code: 200, data: [{ id: 1, code: 200, url: "https://m1.music.126.net/pc.mp3", type: "mp3", freeTrialInfo: null }] }, 2, "https://m1.music.126.net/pc.mp3"],
    [{ code: 200, data: [{ id: 1, code: 200, url: "https://m1.music.126.net/clip.mp3", freeTrialInfo: { start: 0 } }] },
      { code: 200, data: [{ id: 1, code: 200, url: "https://m1.music.126.net/pc.mp3", type: "mp3", freeTrialInfo: null }] }, 2, "https://m1.music.126.net/pc.mp3"],
  ];
  for (const [web, desktop, expected, url] of cases) {
    let calls = 0;
    const { plugin } = await setup(async (target) => {
      calls++;
      return response(target.includes("interfacepc") ? desktop : web);
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
    assert.equal((await plugin.stream({ id: "1", quality: "standard" })).url, url);
    assert.equal(calls, expected);
  }
  // A preview must stay refused when neither endpoint plays it in full.
  const trial = await setup(async () => response({ code: 200, data: [{ id: 1, code: 200, url: "https://m1.music.126.net/clip.mp3", freeTrialInfo: { start: 0 } }] }));
  await assert.rejects(trial.plugin.stream({ id: "1" }), (error) => error.code === "unavailable");
});

// Signing out during backoff must prevent the retry from using another session.
test("sign-out cancels a scheduled playback retry", async (t) => {
  const timer = globalThis.setTimeout;
  let wake;
  let scheduled;
  const queued = new Promise(resolve => { scheduled = resolve; });
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    if (ms === 1000) { wake = fn; scheduled(); return 0; }
    return timer(fn, ms, ...args);
  });
  let calls = 0;
  const { plugin } = await setup(async () => { calls++; return response({ code: -460 }); });
  const playing = plugin.stream({ id: "1" });
  await queued;
  plugin.signOut();
  wake();
  await assert.rejects(playing, /账号状态已改变/);
  assert.equal(calls, 2);
});

// The retry must not turn permission errors or previews into playback successes.
test("stream does not retry expired authentication or trial audio", async () => {
  for (const body of [
    { code: 301 },
    { code: 200, data: [{ id: 1, url: "https://m1.music.126.net/song.mp3", freeTrialInfo: { start: 0, end: 30 } }] },
  ]) {
    let calls = 0;
    const { plugin } = await setup(async () => { calls++; return response(body); });
    await assert.rejects(plugin.stream({ id: "1" }));
    // Expired authentication stops at once; a preview is checked on both endpoints.
    assert.equal(calls, body.code === 301 ? 1 : 2);
  }
});

// Personal recommendations require a real session before making their requests.
test("guests can discover entries but private recommendations ask for sign-in", async () => {
  let calls = 0;
  const { plugin } = await setup(async () => { calls++; return response({ code: 200, result: [] }); });
  const home = await plugin.home();
  assert.ok(home.sections.some(section => section.links?.some(link => link.page === "daily")));
  const stations = await plugin.stations();
  assert.equal(stations.length, 3);
  assert.ok(stations.every(station => station.description.includes("个性化服务")));
  for (const page of ["daily", "radar", "recommendations"]) await assert.rejects(plugin.browse({ page }), { code: "signIn" });
  await assert.rejects(plugin.stationNext({ id: "DEFAULT" }), { code: "signIn" });
  assert.equal(calls, 1);
});

// Daily songs and each FM mode use their own endpoint and account-aware details.
test("daily, radar, personalized playlists and continuous FM map to host capabilities", async () => {
  const modes = [];
  const { plugin } = await setup(async (url, init) => {
    if (url.includes("account/get")) return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
    if (url.includes("playlist/detail")) {
      assert.equal(new URL(url).searchParams.get("id"), "3136952023");
      assert.match(init.headers.Cookie, /MUSIC_U=synthetic-session/);
      return response({ code: 200, playlist: { id: 3136952023, name: "Fixture Radar", trackCount: 2, trackIds: [{ id: 2 }, { id: 1 }] } });
    }
    if (url.includes("recommend/songs")) return response({ code: 200, data: { dailySongs: [song(2), song(1)] } });
    if (url.includes("recommend/resource")) return response({ code: 200, recommend: [{ id: 9, name: "Fixture Radar", trackCount: 2 }] });
    const { path, data } = decode(init.body);
    assert.equal(data.header.MUSIC_U, "synthetic-session");
    if (path === "/api/v1/radio/get") {
      modes.push(data.mode);
      assert.equal(data.limit, 3);
      return response({ code: 200, data: [song(2), song(1)] });
    }
    assert.equal(path, "/api/v3/song/detail");
    return response({ code: 200, songs: [song(1), song(2)], privileges: [{ id: 1, st: 0, pl: 320000 }, { id: 2, st: 0, pl: 320000 }] });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  const daily = await plugin.browse({ page: "daily" });
  assert.deepEqual(daily.sections[0].tracks.map(track => track.id), ["2", "1"]);
  assert.ok(daily.sections[0].tracks.every(track => !track.unavailable));
  const radar = await plugin.browse({ page: "radar" });
  assert.deepEqual(radar.sections[0].tracks.map(track => track.id), ["2", "1"]);
  const lists = await plugin.browse({ page: "recommendations" });
  assert.equal(lists.sections[0].playlists[0].id, "9");
  for (const id of ["DEFAULT", "FAMILIAR", "EXPLORE", "DEFAULT"]) {
    assert.deepEqual((await plugin.stationNext({ id })).map(track => track.id), ["2", "1"]);
  }
  assert.deepEqual(modes, ["DEFAULT", "FAMILIAR", "EXPLORE", "DEFAULT"]);
  await assert.rejects(plugin.stationNext({ id: "unknown" }), { code: "unsupported" });
});

test("disabled personalization explains an empty radio batch and permits recovery", async () => {
  for (const mode of ["DEFAULT", "FAMILIAR", "EXPLORE"]) {
    let radioCalls = 0;
    let detailCalls = 0;
    let settingsCalls = 0;
    const { plugin } = await setup(async (url, init) => {
      if (url.includes("account/get")) return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
      if (url.includes("/user/setting")) {
        settingsCalls++;
        assert.match(init.headers.Cookie, /MUSIC_U=synthetic-session/);
        return response({ code: 200, setting: { personalServiceSetting: 2 } });
      }
      const { path, data } = decode(init.body);
      if (path === "/api/v1/radio/get") {
        assert.equal(data.mode, mode);
        radioCalls++;
        return response({ code: 200, data: radioCalls === 1 ? [] : [song(1)] });
      }
      assert.equal(path, "/api/v3/song/detail");
      detailCalls++;
      return response({ code: 200, songs: [song(1)], privileges: [{ id: 1, st: 0, pl: 320000 }] });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });

    await assert.rejects(plugin.stationNext({ id: mode }), error => {
      assert.equal(error.code, "unavailable");
      assert.match(error.message, /个性化服务/);
      return true;
    });
    assert.equal(radioCalls, 1);
    assert.equal(detailCalls, 0);
    assert.equal(settingsCalls, 1);
    assert.notEqual(await plugin.account(), null);
    assert.deepEqual((await plugin.stationNext({ id: mode })).map(track => track.id), ["1"]);
    assert.equal(radioCalls, 2);
    assert.equal(detailCalls, 1);
    assert.equal(settingsCalls, 1);
  }
});

test("other empty radio batches remain retryable when the setting is enabled or unknown", async () => {
  for (const preferences of [
    { code: 200, setting: { personalServiceSetting: 0 } },
    { code: 200, setting: {} },
    { code: 500 },
  ]) {
    const { plugin } = await setup(async (url, init) => {
      if (url.includes("account/get")) return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
      if (url.includes("/user/setting")) return response(preferences);
      assert.equal(decode(init.body).path, "/api/v1/radio/get");
      return response({ code: 200, data: [] });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
    assert.deepEqual(await plugin.stationNext({ id: "DEFAULT" }), []);
    assert.notEqual(await plugin.account(), null);
  }
});

test("radio and diagnostic authentication failures keep their sign-in error", async () => {
  for (const failingEndpoint of ["radio", "settings"]) {
    const { plugin } = await setup(async (url, init) => {
      if (url.includes("account/get")) return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
      if (url.includes("/user/setting")) return response({ code: 301 });
      assert.equal(decode(init.body).path, "/api/v1/radio/get");
      return response(failingEndpoint === "radio" ? { code: 301 } : { code: 200, data: [] });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });

    await assert.rejects(plugin.stationNext({ id: "DEFAULT" }), { code: "signIn" });
    assert.equal(await plugin.account(), null);
  }
});

// The host already shows the listener's liked songs, so do not repeat that
// playlist under My Playlists. Another user's liked playlist remains visible.
test("fixed playlist mapping preserves ownership and hides the duplicate liked list", async () => {
  const fixtures = [
    { id: 21, specialType: 5, creator: { userId: 7 }, expectedFixed: true, expectedMine: true },
    { id: 22, specialType: "5", creator: { userId: 8 }, subscribed: true, expectedFixed: true, expectedMine: false },
    { id: 23, specialType: 0, creator: { userId: 7 }, expectedFixed: false, expectedMine: true },
    { id: 24, creator: { userId: 8 }, subscribed: true, expectedFixed: false, expectedMine: false },
  ];
  const { plugin } = await setup(async (url) => {
    if (url.includes("nuser/account/get")) return response({ code: 200, profile: { userId: 7, nickname: "Fixture" } });
    if (url.includes("user/playlist")) return response({ code: 200, playlist: fixtures, more: false });
    if (url.includes("playlist/detail")) {
      const id = Number(new URL(url).searchParams.get("id"));
      return response({ code: 200, playlist: { ...fixtures.find(p => p.id === id), trackIds: [] } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: { id: "7", name: "Fixture" } });
  const lists = await plugin.playlists();
  const listed = fixtures.slice(1);
  assert.deepEqual(lists.map(list => list.id), listed.map(source => String(source.id)));
  const assertFlags = (mapped, source) => {
    assert.equal(mapped.fixed, source.expectedFixed, `fixed for ${source.id}`);
    assert.equal(mapped.mine, source.expectedMine, `mine for ${source.id}`);
    assert.equal(mapped.saved, !!source.subscribed, `saved for ${source.id}`);
  };
  for (const [i, source] of listed.entries()) assertFlags(lists[i], source);
  for (const source of fixtures) assertFlags(await plugin.playlist({ id: String(source.id) }), source);
});

// Playlists are no longer cut at 1000 songs: details load in bounded parallel
// batches, keep playlist order, and are cached for the next open.
test("playlist loads more than 1000 songs in order and reuses cached details", async () => {
  const total = 2450;
  const trackIds = Array.from({ length: total }, (_, index) => ({ id: index + 1 }));
  let detailCalls = 0;
  let active = 0;
  let peak = 0;
  const { plugin } = await setup(async (url, init) => {
    if (url.includes("playlist/detail")) {
      return response({ code: 200, playlist: { id: 9, name: "Big", trackCount: total, trackIds, tracks: [], creator: { userId: 1 } } });
    }
    const ids = JSON.parse(decode(init.body).data.c).map(item => item.id);
    detailCalls++;
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    assert.ok(ids.length <= 200);
    return response({ code: 200, songs: ids.map(id => song(id)), privileges: ids.map(id => ({ id, st: 0, pl: 128000 })) });
  });
  const first = await plugin.playlist({ id: "9" });
  assert.equal(first.tracks.length, total);
  assert.deepEqual(first.tracks.slice(0, 3).map(track => track.id), ["1", "2", "3"]);
  assert.equal(first.tracks[total - 1].id, String(total));
  assert.ok(!first.description.includes("已载入前"));
  assert.equal(detailCalls, Math.ceil(total / 200));
  assert.ok(peak > 1 && peak <= 8);
  assert.equal((await plugin.playlist({ id: "9" })).tracks.length, total);
  assert.equal(detailCalls, Math.ceil(total / 200));
});

// The liked playlist keeps the order the app shows; the like map does not.
test("liked follows the liked playlist order and falls back to the like map", async () => {
  const order = ["3", "1", "2"];
  const paths = [];
  const { plugin } = await setup(async (url, init) => {
    paths.push(new URL(url).pathname);
    if (url.includes("nuser/account/get")) return response({ code: 200, profile: { userId: 7, nickname: "Fixture" } });
    if (url.includes("/api/user/playlist")) return response({ code: 200, more: false, playlist: [
      { id: 8, name: "Other", specialType: 0, trackCount: 0, creator: { userId: 7 } },
      { id: 9, name: "Liked", specialType: 5, trackCount: 3, creator: { userId: 7 } },
    ] });
    if (url.includes("/api/v6/playlist/detail")) return response({ code: 200, playlist: {
      id: 9, specialType: 5, trackCount: 3, creator: { userId: 7 }, trackIds: order.map(id => ({ id: Number(id) })),
    } });
    if (url.includes("song/like/get")) return response({ code: 200, ids: [1, 2, 3] });
    const ids = JSON.parse(decode(init.body).data.c).map(item => item.id);
    return response({ code: 200, songs: ids.map(song), privileges: ids.map(id => ({ id, st: 0, pl: 128000 })) });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: { id: "7", name: "Fixture" } });
  assert.deepEqual((await plugin.liked({ offset: 0 })).tracks.map(track => track.id), order);
  assert.ok(!paths.some(path => path.includes("song/like/get")));

  // Without a liked playlist the like map still answers, in its own order.
  const fallback = await setup(async (url, init) => {
    if (url.includes("nuser/account/get")) return response({ code: 200, profile: { userId: 7, nickname: "Fixture" } });
    if (url.includes("/api/user/playlist")) return response({ code: 200, more: false, playlist: [] });
    if (url.includes("song/like/get")) return response({ code: 200, ids: [2, 3] });
    const ids = JSON.parse(decode(init.body).data.c).map(item => item.id);
    return response({ code: 200, songs: ids.map(song), privileges: ids.map(id => ({ id, st: 0, pl: 128000 })) });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: { id: "7", name: "Fixture" } });
  assert.deepEqual((await fallback.plugin.liked({ offset: 0 })).tracks.map(track => track.id), ["2", "3"]);
});

// Cloud disk songs may or may not carry catalog metadata; both map to a track,
// and the list pages until hasMore is false.
test("cloud disk lists uploaded songs and pages through them", async () => {
  const { plugin } = await setup(async (url) => {
    if (url.includes("nuser/account/get")) return response({ code: 200, profile: { userId: 7, nickname: "Fixture" } });
    if (url.includes("/api/v1/cloud/get")) {
      return response({ code: 200, count: 3, hasMore: true, data: [
        { privateCloud: { songId: 11, song: "A.mp3", artist: "未知艺术家", album: "未知专辑" },
          simpleSong: { id: 11, name: "爱人穿过你", dt: 200000, ar: [{ id: 1, name: "刘森" }], al: { id: 2, name: "华北浪革", picUrl: "http://p1.music.126.net/a.jpg" } } },
        { privateCloud: { songId: 12, song: "B.flac", artist: "某人", album: "某专辑" } },
        { privateCloud: { songId: 11, song: "A.mp3" } },
      ] });
    }
    return response({ code: 200, data: [], hasMore: false });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: { id: "7", name: "Fixture" } });
  const page = await plugin.browse({ page: "cloud" });
  assert.equal(page.title, "我的云盘");
  const tracks = page.sections[0].tracks;
  assert.deepEqual(tracks.map(track => track.id), ["11", "12"]);
  assert.equal(tracks[0].name, "爱人穿过你");
  assert.deepEqual(tracks[0].artists.map(artist => artist.name), ["刘森"]);
  assert.equal(tracks[0].album.imageUrl, "https://p1.music.126.net/a.jpg?param=%7Bsize%7Dy%7Bsize%7D");
  assert.equal(tracks[1].name, "B");
  assert.deepEqual(tracks[1].artists.map(artist => artist.name), ["某人"]);
  assert.equal(tracks[1].album.name, "某专辑");
  assert.equal(tracks[1].duration, 0);
});

// The host exposes its full playlist UI when these write capabilities exist.
test("playlist lifecycle creates, renames, saves and deletes playlists", async () => {
  const sent = [];
  const { plugin } = await setup(async (url, init) => {
    if (url.includes("nuser/account/get")) return response({ code: 200, profile: { userId: 7, nickname: "Fixture" } });
    const { path, data: { header, e_r, ...data } } = decode(init.body);
    sent.push({ path, data });
    if (path === "/api/playlist/create") return response({ code: 200, playlist: {
      id: 9, name: data.name, creator: { userId: 7, nickname: "Fixture" }, trackCount: 0,
    } });
    return response({ code: 200 });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });

  const created = await plugin.createPlaylist({ name: "  New list  " });
  assert.equal(created.id, "9");
  assert.equal(created.name, "New list");
  assert.equal(created.mine, true);
  await plugin.renamePlaylist({ id: "9", name: "  Renamed  " });
  await plugin.savePlaylist({ id: "9", on: true });
  await plugin.savePlaylist({ id: "9", on: false });
  await plugin.deletePlaylist({ id: "9" });
  assert.deepEqual(sent.map(({ path, data }) => [path, data]), [
    ["/api/playlist/create", { name: "New list", privacy: 0, type: "NORMAL" }],
    ["/api/playlist/update/name", { id: "9", name: "Renamed" }],
    ["/api/playlist/subscribe", { id: "9" }],
    ["/api/playlist/unsubscribe", { id: "9" }],
    ["/api/playlist/remove", { ids: "[9]" }],
  ]);
});

// Reordering submits the complete order; it never removes and re-adds a song.
test("movePlaylistTrack moves in both directions and validates positions", async () => {
  const updates = [];
  const { plugin } = await setup(async (url, init) => {
    if (url.includes("nuser/account/get")) return response({ code: 200, profile: { userId: 7, nickname: "Fixture" } });
    if (url.includes("playlist/detail")) return response({ code: 200, playlist: {
      id: 9, trackCount: 4, trackIds: [1, 2, 3, 4].map(id => ({ id })),
    } });
    const form = new URLSearchParams(init.body);
    updates.push(Object.fromEntries(form));
    return response({ code: 200 });
  }, { cookies: { MUSIC_U: "synthetic-session", __csrf: "synthetic-csrf" }, profile: null });

  await plugin.movePlaylistTrack({ id: "9", from: 0, to: 2 });
  await plugin.movePlaylistTrack({ id: "9", from: 3, to: 1 });
  await plugin.movePlaylistTrack({ id: "9", from: 2, to: 2 });
  assert.deepEqual(updates.map(form => [form.op, form.pid, form.trackIds, form.csrf_token]), [
    ["update", "9", "[2,3,1,4]", "synthetic-csrf"],
    ["update", "9", "[1,4,2,3]", "synthetic-csrf"],
  ]);
  for (const [from, to] of [[-1, 0], [0, 4], [1.5, 2], ["0", 1]]) {
    await assert.rejects(plugin.movePlaylistTrack({ id: "9", from, to }), /排序位置/);
  }
  assert.equal(updates.length, 2);
});

// A partial or stale track list must never be submitted as the complete order.
test("movePlaylistTrack refuses incomplete lists and account changes", async () => {
  let updates = 0;
  const partial = await setup(async (url, init) => {
    if (url.includes("nuser/account/get")) return response({ code: 200, profile: { userId: 7, nickname: "Fixture" } });
    if (url.includes("playlist/detail")) return response({ code: 200, playlist: {
      id: 9, trackCount: 3, trackIds: [{ id: 1 }, { id: 2 }],
    } });
    updates++;
    return response({ code: 200 });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  await assert.rejects(partial.plugin.movePlaylistTrack({ id: "9", from: 0, to: 1 }), /完整歌曲列表/);
  assert.equal(updates, 0);

  let finish;
  const changed = await setup((url) => {
    if (url.includes("nuser/account/get")) return response({ code: 200, profile: { userId: 7, nickname: "Fixture" } });
    return new Promise(resolve => { finish = resolve; });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  const pending = changed.plugin.movePlaylistTrack({ id: "9", from: 0, to: 1 });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  changed.plugin.signOut();
  finish(response({ code: 200, playlist: { id: 9, trackCount: 2, trackIds: [{ id: 1 }, { id: 2 }] } }));
  await assert.rejects(pending, /账号状态已改变/);
});

// Existing batch writes keep their ID normalization and duplicate retry behavior.
test("playlist track writes normalize IDs and retry only missing songs", async () => {
  const forms = [];
  let duplicate = true;
  const { plugin } = await setup(async (url, init) => {
    if (url.includes("nuser/account/get")) return response({ code: 200, profile: { userId: 7, nickname: "Fixture" } });
    if (url.includes("playlist/detail")) return response({ code: 200, playlist: {
      id: 9, trackCount: 1, trackIds: [{ id: 1 }],
    } });
    const form = Object.fromEntries(new URLSearchParams(init.body));
    forms.push(form);
    if (form.op === "add" && duplicate) {
      duplicate = false;
      return response({ code: 502 });
    }
    return response({ code: 200 });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  await plugin.addToPlaylist({ id: "9", trackIds: ["1", "2", "1"] });
  await plugin.removeFromPlaylist({ id: "9", trackIds: ["2"] });
  assert.deepEqual(forms.map(form => [form.op, form.trackIds]), [
    ["add", "[1,2]"], ["add", "[2]"], ["del", "[2]"],
  ]);
  await assert.rejects(plugin.addToPlaylist({ id: "9", trackIds: ["program:12:34"] }), { code: "unsupported" });
  assert.equal(forms.length, 3);
});

// Invalid input and guest writes fail before any playlist mutation request.
test("playlist management validates input and requires sign-in", async () => {
  let requests = 0;
  const invalid = await setup(async () => { requests++; return response({ code: 200 }); });
  await assert.rejects(invalid.plugin.createPlaylist({ name: "  " }), /名称/);
  await assert.rejects(invalid.plugin.renamePlaylist({ id: "9", name: "" }), /名称/);
  await assert.rejects(invalid.plugin.deletePlaylist({ id: "invalid" }), /无效/);
  await assert.rejects(invalid.plugin.savePlaylist({ id: "invalid", on: true }), /无效/);
  assert.equal(requests, 0);

  const guest = await setup(async () => { requests++; return response({ code: 200 }); });
  for (const action of [
    () => guest.plugin.createPlaylist({ name: "New" }),
    () => guest.plugin.renamePlaylist({ id: "9", name: "New" }),
    () => guest.plugin.deletePlaylist({ id: "9" }),
    () => guest.plugin.savePlaylist({ id: "9", on: true }),
    () => guest.plugin.movePlaylistTrack({ id: "9", from: 0, to: 1 }),
    () => guest.plugin.addToPlaylist({ id: "9", trackIds: ["1"] }),
    () => guest.plugin.removeFromPlaylist({ id: "9", trackIds: ["1"] }),
  ]) await assert.rejects(action(), { code: "signIn" });
  assert.equal(requests, 0);
});

// Comments are posted through the desktop endpoint, which carries the session.
test("postComment posts to the track thread and rejects empty or long text", async () => {
  const sent = [];
  const { plugin } = await setup(async (url, init) => {
    if (url.includes("nuser/account/get")) return response({ code: 200, profile: { userId: 7, nickname: "Fixture" } });
    const { path, data } = decode(init.body);
    sent.push({ path, data });
    return response({ code: 200, comment: { commentId: 5, content: data.content, time: 1, likedCount: 2, user: { nickname: "Fixture" } } });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: { id: "7", name: "Fixture" } });
  const comment = await plugin.postComment({ trackId: "1", text: "  好听  " });
  assert.equal(comment.id, "5");
  assert.equal(comment.text, "好听");
  assert.equal(comment.author, "Fixture");
  assert.equal(sent[0].path, "/api/v1/resource/comments/add");
  assert.equal(sent[0].data.threadId, "R_SO_4_1");
  assert.equal(sent[0].data.content, "好听");
  assert.equal(sent[0].data.t, 1);
  await assert.rejects(plugin.postComment({ trackId: "1", text: "   " }), /不能为空/);
  await assert.rejects(plugin.postComment({ trackId: "1", text: "字".repeat(141) }), /140/);
});

// Comment likes target the same song or program thread as the comment list.
test("likeComment likes and unlikes song and episode comments", async () => {
  const sent = [];
  const { plugin } = await setup(async (url, init) => {
    if (url.includes("nuser/account/get")) return response({ code: 200, profile: { userId: 7, nickname: "Fixture" } });
    const { path, data } = decode(init.body);
    sent.push({ path, data });
    return response({ code: 200 });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: { id: "7", name: "Fixture" } });
  await plugin.likeComment({ trackId: "1", commentId: "9", on: true });
  await plugin.likeComment({ trackId: "program:12:34", commentId: 10, on: false });
  assert.deepEqual(sent.map(({ path, data }) => [path, data.threadId, data.commentId]), [
    ["/api/v1/comment/like", "R_SO_4_1", "9"],
    ["/api/v1/comment/unlike", "A_DJ_1_12", "10"],
  ]);
  await assert.rejects(plugin.likeComment({ trackId: "1", commentId: "invalid", on: true }), /无效/);
  assert.equal(sent.length, 2);
});

// Guests must be asked to sign in without sending a like request.
test("likeComment requires sign-in", async () => {
  let requests = 0;
  const { plugin } = await setup(async () => {
    requests++;
    return response({ code: 200 });
  });
  await assert.rejects(plugin.likeComment({ trackId: "1", commentId: "9", on: true }), error => {
    assert.equal(error.code, "signIn");
    assert.match(error.message, /请先扫码登录/);
    return true;
  });
  assert.equal(requests, 0);
});

// A repeated or truncated subscription page must not hide the podcasts we have.
test("shows keeps paging subscriptions and returns what it got", async () => {
  const { plugin } = await setup(async (url) => {
    if (url.includes("nuser/account/get")) return response({ code: 200, profile: { userId: 7, nickname: "Fixture" } });
    const offset = Number(new URL(url).searchParams.get("offset"));
    if (offset === 0) return response({ code: 200, count: 2, hasMore: true, djRadios: [{ id: 1, name: "A", picUrl: "http://p2.music.126.net/a.jpg" }] });
    return response({ code: 200, count: 2, hasMore: true, djRadios: [{ id: 2, name: "B" }] });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: { id: "7", name: "Fixture" } });
  const shows = await plugin.shows();
  assert.deepEqual(shows.map(show => show.id).sort(), ["1", "2"]);
});

// Paging is opt-in: only a host that asks with a limit gets one page.
test("playlist pages only when the host asks with a limit", async () => {
  const trackIds = Array.from({ length: 45 }, (_, index) => ({ id: index + 1 }));
  const { plugin } = await setup(async (url, init) => {
    if (url.includes("playlist/detail")) return response({ code: 200, playlist: { id: 9, name: "P", trackCount: 45, creator: { userId: 1 }, trackIds } });
    const ids = JSON.parse(decode(init.body).data.c).map(item => item.id);
    return response({ code: 200, songs: ids.map(song), privileges: ids.map(id => ({ id, st: 0, pl: 128000 })) });
  });
  const whole = await plugin.playlist({ id: "9" });
  assert.equal(whole.tracks.length, 45);
  assert.equal(whole.more, undefined);
  const first = await plugin.playlist({ id: "9", offset: 0, limit: 30 });
  assert.equal(first.tracks.length, 30);
  assert.equal(first.more, true);
  assert.equal(first.count, 45);
  const last = await plugin.playlist({ id: "9", offset: 30, limit: 30 });
  assert.equal(last.tracks.length, 15);
  assert.equal(last.more, false);
  assert.deepEqual(last.tracks.map(track => track.id), trackIds.slice(30).map(track => String(track.id)));
});
