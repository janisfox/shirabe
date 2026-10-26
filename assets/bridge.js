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
    video: () => document.querySelector("video"),
    bar: () => document.querySelector("ytmusic-player-bar"),
    // The play queue element; its redux store holds the queue (`queue` slice:
    // items, automixItems, selectedItemIndex, repeatMode, shuffleEnabled).
    queue: () => document.querySelector("ytmusic-player-queue#queue") ?? document.querySelector("#queue"),
    queueState: () => YTM.queue()?.queue?.store?.store?.getState?.()?.queue ?? null,
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
      rate: document.querySelector("video")?.playbackRate ?? null,
      fxGraph: FX.nodes !== null,
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

  // QUEUE --------------------------------------------------------------------

  // YouTube Music's queue is the source of truth: Shirabe mirrors it from the
  // store and changes it with the store's own actions (the ones the queue's
  // drag and drop and menus use).
  const queueRenderer = (item) =>
    item?.playlistPanelVideoRenderer ?? item?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer ?? null;

  // Only what the queue list shows (the store's entries carry menus and
  // tracking data several kilobytes each).
  const queueEntry = (item) => {
    const r = queueRenderer(item);
    if (!r) return null;
    return { playlistPanelVideoRenderer: {
      title: r.title, longBylineText: r.longBylineText, thumbnail: r.thumbnail, lengthText: r.lengthText,
      videoId: r.videoId, selected: r.selected, playlistSetVideoId: r.playlistSetVideoId,
      navigationEndpoint: r.navigationEndpoint, badges: r.badges,
    } };
  };

  const queueSnapshot = () => {
    const q = YTM.queueState();
    if (!q) return null;
    return {
      items: (q.items ?? []).map(queueEntry),
      automix: (q.automixItems ?? []).slice(0, 25).map(queueEntry),
      selected: q.selectedItemIndex ?? null,
      repeat: q.repeatMode ?? "NONE",
      shuffle: q.shuffleEnabled === true,
      autoplay: q.autoplay !== false,
    };
  };

  const queueDispatch = (action) => {
    const element = YTM.queue();
    if (!element?.dispatch) throw new Error("the queue is not on the page");
    element.dispatch(action);
  };

  // position: "next" (after the playing track) or "end".
  const queueAdd = async ({ videoIds, position }) => {
    const q = YTM.queueState();
    if (!q) throw new Error("the queue is not on the page");
    const app = YTM.app();
    const response = await app.networkManager.fetch("/music/get_queue", {
      queueContextParams: q.queueContextParams,
      queueInsertPosition: position === "next" ? "INSERT_AFTER_CURRENT_VIDEO" : "INSERT_AT_END",
      videoIds,
    });
    const items = (response?.queueDatas ?? []).map((d) => d?.content).filter(Boolean);
    if (items.length === 0) throw new Error("YouTube Music returned no queue entries");
    const now = YTM.queueState();
    const length = now.items?.length ?? 0;
    // An empty queue (nothing played yet) cannot take entries: play the first.
    if (length === 0) return play({ videoId: videoIds[0] });
    const index = position === "next" ? Math.min(length, (now.selectedItemIndex ?? -1) + 1) : length;
    queueDispatch({ type: "ADD_ITEMS", payload: {
      nextQueueItemId: now.nextQueueItemId, index, items, shuffleEnabled: false, shouldAssignIds: true,
    } });
    return items.length;
  };

  // Clicking an entry of YouTube Music's own queue.
  const queuePlay = ({ index }) => {
    queueDispatch({ type: "SET_INDEX", payload: index });
    autoStartAny();
  };

  // Removes everything after the playing track.
  const queueClear = () => {
    const q = YTM.queueState();
    if (!q) return 0;
    const keep = (q.selectedItemIndex ?? 0) + 1;
    let removed = 0;
    for (let i = (q.items?.length ?? 0) - 1; i >= keep; i--) {
      queueDispatch({ type: "REMOVE_ITEM", payload: i });
      removed++;
    }
    return removed;
  };

  // repeat: "NONE" | "ALL" | "ONE"; the player bar's button cycles through them.
  const setRepeat = ({ mode }) => {
    const bar = YTM.bar();
    for (let i = 0; i < 3 && bar && bar.repeatMode !== mode; i++) bar.onRepeatButtonClick();
    return bar?.repeatMode ?? null;
  };

  const setShuffle = ({ on }) => {
    const bar = YTM.bar();
    if (bar && (bar.shuffleOn === true) !== !!on) bar.onShuffleButtonClick();
    return bar?.shuffleOn ?? null;
  };

  // AUDIO FX -----------------------------------------------------------------

  // The <video> is fed by MediaSource from the same origin, so its audio can
  // be routed through Web Audio. The graph is built only once an effect is
  // asked for (until then YouTube Music's own output path is untouched) and
  // rebuilt when the page swaps the <video> element.
  //   video -> [pitch shifter] -> EQ (10 bands) -> dry + reverb -> [compressor] -> pre-amp -> out
  // The page's security policy blocks AudioWorklet modules, so the pitch
  // shifter is a ScriptProcessor (a granular two-tap delay line).
  const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const FX = {
    params: { speed: 1, pitch: 0, link: false, eq: EQ_BANDS.map(() => 0), reverb: 0, decay: 2.4, preDelay: 0.02,
      loudness: false, preamp: 0, fade: 1 },
    ctx: null, video: null, nodes: null, irKey: null,
  };

  const neutral = (p) => p.pitch === 0 && p.reverb === 0 && !p.loudness && p.preamp === 0 && p.fade === 1
    && p.eq.every((g) => g === 0);

  const makeShifter = (ctx) => {
    const node = ctx.createScriptProcessor(2048, 2, 2);
    const size = 16384, mask = size - 1;
    const window = Math.round(ctx.sampleRate * 0.06);
    const rings = [new Float32Array(size), new Float32Array(size)];
    let write = 0, phase = 0;
    node.ratio = 1;
    const read = (ring, pos) => {
      const i = Math.floor(pos), f = pos - i;
      return ring[i & mask] * (1 - f) + ring[(i + 1) & mask] * f;
    };
    node.onaudioprocess = (event) => {
      const input = event.inputBuffer, output = event.outputBuffer;
      const n = input.length;
      const channels = input.numberOfChannels;
      const step = (1 - node.ratio) / window;
      for (let c = 0; c < 2; c++) {
        const src = input.getChannelData(Math.min(c, channels - 1));
        const dst = output.getChannelData(c);
        const ring = rings[c];
        let ph = phase;
        for (let i = 0; i < n; i++) {
          const w = write + i;
          ring[w & mask] = src[i];
          const p2 = ph < 0.5 ? ph + 0.5 : ph - 0.5;
          // Two taps half a window apart, crossfaded with sin² windows (they sum to 1).
          const g1 = Math.sin(Math.PI * ph) ** 2;
          dst[i] = read(ring, w - ph * window - 1) * g1 + read(ring, w - p2 * window - 1) * (1 - g1);
          ph += step;
          if (ph >= 1) ph -= 1; else if (ph < 0) ph += 1;
        }
        if (c === 1) phase = ph;
      }
      write = (write + n) & mask;
    };
    return node;
  };

  const impulse = (ctx, decay, preDelay) => {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.round(rate * (decay + preDelay)));
    const start = Math.round(rate * preDelay);
    const buffer = ctx.createBuffer(2, length, rate);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = start; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - (i - start) / (length - start), 3.2);
      }
    }
    return buffer;
  };

  const buildFx = (video) => {
    FX.ctx = FX.ctx ?? new AudioContext({ latencyHint: "playback" });
    const ctx = FX.ctx;
    const n = {
      source: ctx.createMediaElementSource(video),
      shifter: makeShifter(ctx),
      eq: EQ_BANDS.map((f, i) => {
        const b = ctx.createBiquadFilter();
        b.type = i === 0 ? "lowshelf" : (i === EQ_BANDS.length - 1 ? "highshelf" : "peaking");
        b.frequency.value = f;
        b.Q.value = 1.1;
        return b;
      }),
      dry: ctx.createGain(),
      convolver: ctx.createConvolver(),
      wet: ctx.createGain(),
      sum: ctx.createGain(),
      compressor: ctx.createDynamicsCompressor(),
      out: ctx.createGain(),
    };
    for (let i = 0; i < n.eq.length - 1; i++) n.eq[i].connect(n.eq[i + 1]);
    const last = n.eq[n.eq.length - 1];
    last.connect(n.dry);
    last.connect(n.convolver);
    n.convolver.connect(n.wet);
    n.dry.connect(n.sum);
    n.wet.connect(n.sum);
    n.out.connect(ctx.destination);
    const c = n.compressor;
    c.threshold.value = -22; c.knee.value = 24; c.ratio.value = 3.5; c.attack.value = 0.004; c.release.value = 0.25;
    FX.video = video;
    FX.nodes = n;
    FX.irKey = null;
    FX.wired = null;
  };

  // Connects the optional stages (shifter, compressor) that are in use.
  const wire = (p) => {
    const n = FX.nodes;
    const shift = p.pitch !== 0 && !p.link;
    const key = `${shift}|${p.loudness}`;
    if (FX.wired === key) return;
    FX.wired = key;
    for (const node of [n.source, n.shifter, n.sum, n.compressor]) node.disconnect();
    if (shift) { n.source.connect(n.shifter); n.shifter.connect(n.eq[0]); } else n.source.connect(n.eq[0]);
    if (p.loudness) { n.sum.connect(n.compressor); n.compressor.connect(n.out); } else n.sum.connect(n.out);
  };

  const applyFx = () => {
    const p = FX.params;
    const video = YTM.video();
    if (!video) return;
    // Speed is the element's own playback rate; "link" lets pitch follow it.
    if (Math.abs(video.playbackRate - p.speed) > 0.001) video.playbackRate = p.speed;
    if (video.preservesPitch !== !p.link) video.preservesPitch = !p.link;
    if (!FX.nodes && neutral(p)) return;
    if (!FX.nodes || FX.video !== video) buildFx(video);
    if (FX.ctx.state === "suspended") FX.ctx.resume();
    const n = FX.nodes;
    const t = FX.ctx.currentTime;
    wire(p);
    n.shifter.ratio = Math.pow(2, p.pitch / 12);
    let boost = 0;
    p.eq.forEach((g, i) => { n.eq[i].gain.setTargetAtTime(g, t, 0.03); boost = Math.max(boost, g); });
    const irKey = `${p.decay}|${p.preDelay}`;
    if (p.reverb > 0 && FX.irKey !== irKey) {
      n.convolver.buffer = impulse(FX.ctx, p.decay, p.preDelay);
      FX.irKey = irKey;
    }
    // Equal-power wet / dry mix.
    n.dry.gain.setTargetAtTime(Math.cos(p.reverb * Math.PI / 2), t, 0.03);
    n.wet.gain.setTargetAtTime(Math.sin(p.reverb * Math.PI / 2) * 1.4, t, 0.03);
    // Pre-amp, minus half the largest EQ boost as headroom, plus make-up gain
    // for the compressor, times the sleep-timer fade.
    const db = p.preamp - boost / 2 + (p.loudness ? 4 : 0);
    n.out.gain.setTargetAtTime(Math.pow(10, db / 20) * p.fade, t, p.fadeTime ?? 0.03);
  };

  const fx = (params) => {
    const p = FX.params;
    for (const key of Object.keys(p)) {
      if (params[key] === undefined) continue;
      if (key === "eq") {
        if (Array.isArray(params.eq)) p.eq = EQ_BANDS.map((_, i) => Math.max(-12, Math.min(12, Number(params.eq[i]) || 0)));
      } else if (key === "link" || key === "loudness") {
        p[key] = params[key] === true;
      } else {
        const v = Number(params[key]);
        if (Number.isFinite(v)) p[key] = v;
      }
    }
    p.speed = Math.max(0.5, Math.min(2, p.speed));
    p.pitch = Math.max(-12, Math.min(12, p.pitch));
    p.reverb = Math.max(0, Math.min(1, p.reverb));
    p.decay = Math.max(0.3, Math.min(8, p.decay));
    p.preDelay = Math.max(0, Math.min(0.2, p.preDelay));
    p.fade = Math.max(0, Math.min(1, p.fade));
    p.fadeTime = Number(params.fadeTime) || 0.03;
    applyFx();
    return { graph: FX.nodes !== null, state: FX.ctx?.state ?? null };
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
    queue: () => queueSnapshot(),
    queueAdd: (args) => queueAdd(args),
    queuePlay: (args) => queuePlay(args),
    queueRemove: ({ index }) => queueDispatch({ type: "REMOVE_ITEM", payload: index }),
    queueMove: ({ from, to }) => queueDispatch({ type: "MOVE_ITEM", payload: { fromIndex: from, toIndex: to } }),
    queueClear: () => queueClear(),
    repeat: (args) => setRepeat(args),
    shuffle: (args) => setShuffle(args),
    fx: (params) => fx(params ?? {}),
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
  let lastQueue = null;
  setInterval(() => {
    if (silenced()) for (const video of document.querySelectorAll("video")) video.muted = true;
    const s = state();
    if (!s.ready) return;
    const key = `${s.videoId}|${s.playerState}|${Math.floor(s.position)}`;
    if (key !== last) {
      last = key;
      post({ type: "state", ...s });
    }
    // The store replaces its queue object on every change.
    const q = YTM.queueState();
    if (q && q !== lastQueue) {
      lastQueue = q;
      post({ type: "queue", ...queueSnapshot() });
    }
    // Keep the speed and the FX graph on whatever <video> the page uses now.
    applyFx();
  }, 250);
})();
