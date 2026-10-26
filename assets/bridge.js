// shirabe bridge: injected into every document of the player webview, active
// only on music.youtube.com. Neyuki talks to it with view:send({ id, op, args })
// (a "neyuki" event on window) and it answers with window.neyuki.postMessage.
(() => {
  "use strict";
  if (location.hostname !== "music.youtube.com" || window.top !== window) return;

  const post = (message) => window.neyuki.postMessage(JSON.stringify(message));

  // Everything that depends on YouTube Music internals lives here.
  const YTM = {
    cfg: (key) => window.ytcfg?.get?.(key),
    player: () => document.getElementById("movie_player"),
    app: () => document.querySelector("ytmusic-app"),
  };

  // AUTH -------------------------------------------------------------------

  const cookie = (name) => {
    const match = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[.$]/g, "\\$&") + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : null;
  };

  const sha1 = async (text) => {
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  // The Authorization header the site itself sends: one hash per SAPISID cookie.
  const authorization = async () => {
    const ts = Math.floor(Date.now() / 1000);
    const origin = location.origin;
    const parts = [];
    for (const [scheme, name] of [
      ["SAPISIDHASH", "SAPISID"],
      ["SAPISID1PHASH", "__Secure-1PAPISID"],
      ["SAPISID3PHASH", "__Secure-3PAPISID"],
    ]) {
      const value = cookie(name);
      if (value) parts.push(`${scheme} ${ts}_${await sha1(`${ts} ${value} ${origin}`)}`);
    }
    return parts.join(" ");
  };

  const identity = () => ({
    signedIn: YTM.cfg("LOGGED_IN") === true,
    sessionIndex: YTM.cfg("SESSION_INDEX") ?? 0,
    pageId: YTM.cfg("DELEGATED_SESSION_ID") ?? null,
    datasyncId: YTM.cfg("DATASYNC_ID") ?? null,
  });

  // INNERTUBE --------------------------------------------------------------

  const api = async (endpoint, body = {}) => {
    const context = structuredClone(YTM.cfg("INNERTUBE_CONTEXT") ?? {});
    const id = identity();
    const headers = {
      "Content-Type": "application/json",
      "X-Goog-AuthUser": String(id.sessionIndex),
      "X-Origin": location.origin,
      "X-Youtube-Client-Name": String(YTM.cfg("INNERTUBE_CONTEXT_CLIENT_NAME") ?? 67),
      "X-Youtube-Client-Version": String(YTM.cfg("INNERTUBE_CLIENT_VERSION") ?? ""),
    };
    if (id.pageId) {
      headers["X-Goog-PageId"] = id.pageId;
      context.user = { ...(context.user ?? {}), onBehalfOfUser: id.pageId };
    }
    const auth = await authorization();
    if (auth) headers.Authorization = auth;
    const response = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ ...body, context }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status} ${text.slice(0, 300)}`);
    return text;
  };

  // PLAYER -----------------------------------------------------------------

  const state = () => {
    const player = YTM.player();
    if (!player?.getVideoData) return { ready: false };
    const data = player.getVideoData() ?? {};
    const playerState = player.getPlayerState?.(); // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    return {
      ready: true,
      videoId: data.video_id ?? null,
      title: data.title ?? null,
      author: data.author ?? null,
      position: player.getCurrentTime?.() ?? 0,
      duration: player.getDuration?.() ?? 0,
      playing: playerState === 1,
      buffering: playerState === 3,
      playerState,
      volume: player.getVolume?.() ?? null,
      playlistId: player.getPlaylistId?.() ?? null,
      ad: player.classList?.contains("ad-showing") ?? false,
      videoMuted: document.querySelector("video")?.muted ?? null,
      videoTime: document.querySelector("video")?.currentTime ?? null,
      videoDuration: document.querySelector("video")?.duration ?? null,
      muted: player.isMuted?.() ?? null,
    };
  };

  const play = ({ videoId, playlistId, params, via }) => {
    // A playlist / radio without a starting track (artist "Play", "Radio").
    if (!videoId && playlistId) {
      dispatch("yt-navigate", { endpoint: { watchPlaylistEndpoint: { playlistId, ...(params ? { params } : {}) } } });
      autoStartAny();
      return "yt-navigate";
    }
    // A same-document navigation through the app keeps the page (and the FX
    // graph later) alive; fall back to a full load if the app API is missing.
    const query = new URLSearchParams({ v: videoId });
    if (playlistId) query.set("list", playlistId);
    const app = YTM.app();
    const endpoint = { watchEndpoint: { videoId, ...(playlistId ? { playlistId } : {}), ...(params ? { params } : {}) } };
    if (via !== "location" && app) {
      dispatch("yt-navigate", { endpoint });
      autoStart(videoId);
      return "yt-navigate";
    }
    sessionStorage.setItem("shirabe.autostart", videoId);
    location.assign(`/watch?${query}`);
    return "location";
  };

  // The app's own event-based command routing (what its links and menus use).
  const dispatch = (name, detail) => {
    const app = YTM.app();
    if (!app) throw new Error("ytmusic-app is not on the page");
    app.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));
  };

  // A hidden window gets no user gesture, so the player can stay "unstarted"
  // or "cued": start it once the requested video is loaded.
  const silenced = () => sessionStorage.getItem("shirabe.mute") === "1";
  document.addEventListener("play", (event) => {
    if (silenced() && event.target instanceof HTMLMediaElement) event.target.muted = true;
  }, true);

  const autoStart = (videoId) => {
    const started = Date.now();
    const tick = () => {
      const player = YTM.player();
      const loaded = player?.getVideoData?.()?.video_id === videoId;
      const playerState = player?.getPlayerState?.();
      if (loaded && playerState === 1) return;
      if (loaded && (playerState === -1 || playerState === 5)) player.playVideo();
      if (Date.now() - started < 15000) setTimeout(tick, 250);
    };
    tick();
  };

  // IMAGES -------------------------------------------------------------------

  // Fetches artwork for Neyuki, whose strings cannot carry binary data: the
  // bytes come back base64-encoded with their content type.
  const image = async (url, maxBytes = 8_000_000) => {
    const parsed = new URL(url, location.href);
    if (!/(^|\.)(ytimg\.com|googleusercontent\.com|ggpht\.com|gstatic\.com|music\.youtube\.com)$/.test(parsed.hostname)) {
      throw new Error(`image host not allowed: ${parsed.hostname}`);
    }
    const response = await fetch(parsed, { credentials: "omit" });
    if (!response.ok) throw new Error(`image: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`image too large (${bytes.length} bytes)`);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return { type: response.headers.get("content-type"), data: btoa(binary) };
  };

  // Like autoStart, for whatever video the navigation lands on.
  const autoStartAny = () => {
    const started = Date.now();
    const before = YTM.player()?.getVideoData?.()?.video_id;
    const tick = () => {
      const player = YTM.player();
      const id = player?.getVideoData?.()?.video_id;
      const playerState = player?.getPlayerState?.();
      if (id && id !== before && playerState === 1) return;
      if (id && id !== before && (playerState === -1 || playerState === 5)) player.playVideo();
      if (Date.now() - started < 15000) setTimeout(tick, 250);
    };
    tick();
  };

  // Runs an endpoint the page itself would run (e.g. selectActiveIdentityEndpoint).
  const command = (endpoint) => {
    dispatch("yt-navigate", { endpoint });
    return "yt-navigate";
  };

  const ops = {
    identity: () => identity(),
    state: () => state(),
    api: ({ endpoint, body }) => api(endpoint, body),
    play: (args) => play(args),
    pause: () => YTM.player()?.pauseVideo(),
    resume: () => YTM.player()?.playVideo(),
    next: () => YTM.player()?.nextVideo(),
    prev: () => YTM.player()?.previousVideo(),
    seek: ({ seconds }) => YTM.player()?.seekTo(seconds, true),
    volume: ({ value }) => YTM.player()?.setVolume(value),
    mute: ({ muted }) => {
      const player = YTM.player();
      sessionStorage.setItem("shirabe.mute", muted ? "1" : "0");
      if (muted) player?.mute(); else player?.unMute();
      // Covers ads and pages where the player API is not ready yet.
      for (const video of document.querySelectorAll("video")) video.muted = !!muted;
    },
    command: ({ endpoint }) => command(endpoint),
    navigate: ({ url }) => location.assign(url),
    image: ({ url, maxBytes }) => image(url, maxBytes),
  };

  window.addEventListener("neyuki", async (event) => {
    let request;
    try {
      request = JSON.parse(event.detail);
    } catch {
      return;
    }
    const { id, op, args } = request ?? {};
    try {
      if (!Object.hasOwn(ops, op)) throw new Error(`unknown op ${op}`);
      const value = await ops[op](args ?? {});
      post({ id, type: "result", ok: true, value: value ?? null });
    } catch (error) {
      post({ id, type: "result", ok: false, error: String(error?.message ?? error) });
    }
  });

  // EVENTS -----------------------------------------------------------------

  const announce = () => {
    if (!window.ytcfg?.get) return setTimeout(announce, 100);
    post({ type: "ready", ...identity() });
    const pending = sessionStorage.getItem("shirabe.autostart");
    if (pending) {
      sessionStorage.removeItem("shirabe.autostart");
      autoStart(pending);
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", announce);
  else announce();

  let last = "";
  setInterval(() => {
    if (silenced()) for (const video of document.querySelectorAll("video")) video.muted = true;
    const s = state();
    if (!s.ready) return;
    const key = `${s.videoId}|${s.playerState}|${Math.floor(s.position)}`;
    if (key === last) return;
    last = key;
    post({ type: "state", ...s });
  }, 250);
})();
