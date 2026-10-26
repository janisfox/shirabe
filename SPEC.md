# shirabe — design spec

A desktop YouTube Music player written in **Neyuki** (≥ 0.6.1), visually modelled on Liner. Everything below was
decided with the owner on 2026-10-25. Where something is still a guess or a risk, it says so.

---

## 1. Goals and non-goals

**Goals**
- YouTube Music only. **All playback goes through the real `music.youtube.com`**, so history, recommendations,
  "Recap"/Wrapped and listening time are recorded by Google exactly as in the browser. Shirabe never downloads or
  re-streams audio itself.
- A modern, animated UI with blurred-glass panels over a fully customizable background (images, animated GIF/WebP).
- Pitch and speed (independent, with a link toggle), reverb, equalizer and loudness normalization.
- Full brand-account support, with likes, playlists and library **synced both ways with YTM** (unlike Liner, which
  keeps liked songs locally).
- Synced lyrics, Discord Rich Presence ("Listening to <artist>"), OS media controls.

**Non-goals for v1**
- macOS and Linux. Windows 11 first; keep code portable but untested elsewhere.
- The Liner-style always-on-top overlay. Postponed; it needs Neyuki window features that don't exist yet
  (always-on-top, skip-taskbar, positioning, global hotkeys).
- Ad handling. The owner has **YouTube Music Premium**; the page plays no ads.
- Downloads/offline, video mode, crossfade.
- Layout or typography customization and theme presets (maybe later).

---

## 2. Architecture

```
┌──────────────────────────── shirabe.exe (neyuki build) ───────────────────────────┐
│                                                                                    │
│  @neyuki/ui window (frameless, CPU canvas)        hidden @neyuki/webview window    │
│  ┌──────────────────────────────┐                ┌──────────────────────────────┐  │
│  │ app/   router, pages, widgets│                │ https://music.youtube.com    │  │
│  │ theme/ background, glass, fx │   view:send()  │  + bridge.js (initScript)    │  │
│  │ state/ store + tweens        │ ─────────────▶ │    · player control          │  │
│  │ services/                    │                │    · in-page /youtubei/v1/*  │  │
│  │   ytm (bridge client)        │ ◀───────────── │    · Web Audio FX graph      │  │
│  │   lyrics (YTM + LRCLIB)      │  postMessage   │    · state events (4 Hz)     │  │
│  │   discord (net.connectPipe)  │                └──────────────────────────────┘  │
│  │   media session, settings    │                                                  │
│  └──────────────────────────────┘                                                  │
└────────────────────────────────────────────────────────────────────────────────────┘
        │ http (LRCLIB, thumbnails)        │ \\.\pipe\discord-ipc-N
```

- **UI:** drawn entirely with `@neyuki/ui` (decided: no HTML UI). Frameless window with a custom title bar.
  Everything runs inside `ui.run`; blocking work goes in `task.spawn` (http yields inside tasks in 0.5).
- **Player host:** one `webview.open` window with `url = "https://music.youtube.com"`,
  `dataDir = os.dataDir("shirabe") .. "/webview"`, `autoplay = true`, `backgroundThrottling = false`,
  `visible = false`, and `initScript = bridge.js` (shipped in `assets/`).
  It is **shown** only for Google sign-in (and as a debug option), then hidden again.
- **Data source (decided):** all YTM data (home, search, browse, library, likes, playlists, accounts, lyrics)
  comes from **fetches made inside the YTM page** to `/youtubei/v1/*`, so they use the page's own cookies,
  `ytcfg` context and brand-account identity. Neyuki never handles Google cookies.
- **Third-party HTTP from Neyuki:** LRCLIB lyrics, thumbnail images (`i.ytimg.com`, `lh3.googleusercontent.com`),
  nothing else.

### 2.1 Bridge protocol (Neyuki ⇄ page)

All messages are JSON strings.

- Neyuki → page: `view:send({ id, op, args })`. The page listens to `window.addEventListener("neyuki", e => …)`.
- Page → Neyuki: `window.neyuki.postMessage(JSON.stringify({ id?, type, ... }))`.
  - Replies: `{ id, type = "result", ok, value | error }`, matched by a `services/ytm` request table. A
    `ytm.call(op, args)` helper yields the calling task until the reply arrives or a timeout fires (10 s).
  - Pushed events: `ready`, `signedIn` / `signedOut`, `state` (≈4 Hz while playing:
    `{ videoId, title, artists, album, thumbnail, duration, position, playing, buffering, volume, liked, queueVersion }`),
    `trackChanged`, `queueChanged`, `error`.
- **Treat every page message as untrusted** (parse defensively; the page is a remote site). The bridge exposes no
  file or process access.

### 2.2 Bridge operations (page side, `assets/bridge.js`)

| op | does |
|---|---|
| `api(endpoint, body)` | `fetch("/youtubei/v1/" + endpoint + "?prettyPrint=false", { method: "POST", credentials: "include" })` with the page's `ytcfg` context (`INNERTUBE_CONTEXT`), `X-Goog-AuthUser`, `X-Goog-PageId` (brand), `X-Origin`, and `Authorization: SAPISIDHASH` computed in the page from the `SAPISID` cookie. Returns the raw JSON; **parsing happens in Neyuki** (`services/ytm/parse/*.nyk`). |
| `play(videoId, { playlistId?, params?, index? })` | Starts playback through YTM's own navigation/player (so the queue, radio and automix are YTM's). Prefer the app's internal navigation (`ytmusic-app` `navigate` with a `watchEndpoint`) over a full page load. |
| `toggle`, `pause`, `resume`, `next`, `prev`, `seek(s)`, `volume(v)`, `shuffle`, `repeat(mode)` | Through the `movie_player` API / player bar. |
| `queue()` / `queueAdd(videoIds, "next" \| "end")` / `queueRemove(i)` / `queueMove(from, to)` / `radio(videoId)` | YTM's queue is the **source of truth**; Shirabe mirrors it. |
| `like(videoId, "LIKE" \| "DISLIKE" \| "INDIFFERENT")` | `like/like`, `like/dislike`, `like/removelike`. |
| `fx(params)` | Updates the audio graph (see §5). |
| `accounts()` / `switchAccount(pageId \| null)` | See §4. |

DOM selectors and internal player APIs **will break** when YTM updates. Keep them in one file section
(`bridge.js` → `const YTM = { … }`) with a self-test on `ready` that reports which hooks are missing.

---

## 3. Pages and UI

Reference: the two Liner screenshots (library grid, settings modal). Layout:
- Left rail (64 px): logo (`.logos/shirabe-mark-white.svg` → PNG), Home, Search, Library, and the settings gear
  at the bottom. The **account avatar** sits at the bottom too and opens a quick account switcher.
- Title bar: draggable empty area, plus app-drawn minimize/maximize/close on the right (`win:startDrag`, `startResize`).
- Player bar (bottom, glass): cover, title/artist (ellipsis), like, transport, and on the right
  shuffle/repeat/lyrics/FX/volume/queue toggles. A progress bar runs along its top edge.
- Content area: blurred background + glass cards.

v1 pages (all decided):
1. **Home:** YTM home shelves (`browse FEmusic_home`) with continuation paging; horizontal carousels.
2. **Search:** suggestions while typing (`music/get_search_suggestions`), results with filter chips
   (Songs / Albums / Artists / Playlists / Videos).
3. **Library:** chips All / Playlists / Albums / Artists, a grid/list toggle, search-in-library, and "Create playlist".
   Liked Songs is the YTM `LM` playlist, shown as a heart tile as in the screenshot.
4. **Playlist / Album:** header (cover, title, owner, count, duration, play/shuffle/like-playlist), track list,
   context menu (play next, add to queue, add to playlist, remove from playlist, go to artist/album, start radio).
   Editing uses `browse/edit_playlist`; creating uses `playlist/create`.
5. **Artist:** header image, subscribe, top songs, albums, singles, videos, related artists.
6. **Now playing:** full-screen, with a big cover, synced lyrics (active line highlighted, smooth scroll, click a line
   to seek) and a slide-in queue panel.
7. **Settings** (modal like the screenshot) with search:
   - Player: Playback (crossfade off, sleep timer, loudness), Audio FX (pitch/speed/reverb/EQ), Shortcuts.
   - Interface: Appearance (accent, glass, radius, text tone), Background.
   - Integrations: YouTube (accounts, sign-in/out), Discord RPC.
   - Application: Cache & Storage, Stats, About (version from `os.app()`, Check for updates later).

### 3.1 Motion

- Use `ui.animate` with `outCubic` / `outExpo` for slides and fades and `outBack` sparingly (popovers).
  Page transitions are a 180–240 ms cross-fade plus an 8 px slide.
- Hover: 120 ms color/scale tweens. Press: 0.97 scale.
- Lists: virtualized (draw only visible rows) and clipped with `pushClip`. Use momentum scrolling (velocity + friction).
- Keep frames cheap: cache the blurred background per GIF frame or per still in a `ui.canvas`, use
  `blurRegion` only for glass panels, watch `ui.stats()` and drop blur quality automatically if frame time exceeds 14 ms.
  Use `ui.run({ fps = "auto" })`-style idle throttling when nothing animates. (Check what 0.5 offers.)

### 3.2 Typography

- Display (headings, page titles, big now-playing title): **Builder Extended** (Light/Regular/SemiBold/Bold/ExtraBold
  in `assets/fonts`). Its licence file says "© Roblox Corporation. All rights reserved": fine for personal
  builds, **check the licence before any public release**.
- Body/UI: **Inter** (OFL; to be added to `assets/fonts`, static weights 400/500/600/700).
- Fallbacks via `ui.setFallbackFonts`: **Noto Sans JP** (+ KR/SC if needed, OFL), then the bundled Noto Sans.
  Monochrome emoji only.

---

## 4. Accounts and brand accounts

- **Sign-in:** if the page reports `signedOut`, show a "Sign in with Google" screen. Clicking it shows the webview
  window at `accounts.google.com/ServiceLogin?continue=https://music.youtube.com`. Once the page reports
  `signedIn`, hide it. **Risk:** Google sometimes blocks embedded browsers. WebView2 with the Edge UA is normally
  accepted. Test this first (milestone 1).
- **Listing:** `account/accounts_list` (port the logic from Liner `feat/youtube-brand-accounts`:
  `src/shared/youtube/auth/youtubeAccount.ts`, `youtubeAuthSession.ts`, `innertube/innertubeClient.ts`, including
  the fixes "ask accounts_list for brand accounts", "forget a selected brand account that accounts_list no longer
  returns", and "keep a brand account picked while accounts_list was loading").
- **Switching:** must switch **the page's own identity**, not just a request header. Otherwise playback history would
  land on the wrong account. Use YTM's own account-switch mechanism (the `selectActiveIdentityEndpoint` /
  `signin?...&pageid=` flow the site uses), then reload the page and refresh home, library and likes. Persist the selected
  `pageId` in settings and re-apply it on startup. **Verify** with a test listen that history lands on the brand account.
- UI: avatar + name at the bottom of the rail opens a popover listing accounts (current one checked). Settings >
  YouTube has the full list, sign out (`view:clearData()`) and re-sign-in.

---

## 5. Audio FX (inside the YTM page)

YTM plays through a `<video>` fed by MediaSource (same-origin blob), so `createMediaElementSource` is not CORS-tainted.

```
video ─▶ MediaElementSource ─▶ PitchShifter (AudioWorklet) ─▶ EQ (10× BiquadFilter, peaking; low/high shelf at ends)
      ─▶ split: dry gain ─────────────────────────────┐
              wet: ConvolverNode (generated IR) ─▶ gain ─▶ sum ─▶ DynamicsCompressor (loudness) ─▶ GainNode (pre-amp) ─▶ destination
```

- **Speed:** `video.playbackRate` (0.5–2.0) with `preservesPitch = true`.
- **Pitch:** semitones −12…+12 via an AudioWorklet pitch shifter (a SoundTouch/WSOLA port bundled in `bridge.js`).
- **Link toggle (nightcore/slowed):** `preservesPitch = false`, so the worklet is bypassed and pitch follows speed.
- **Reverb:** generated impulse response (decay, pre-delay, size) and wet/dry mix; presets Off / Room / Hall /
  Cathedral / "Slowed + reverb".
- **EQ:** 10 bands (31 Hz–16 kHz), ±12 dB, presets (Flat, Bass boost, Vocal, Treble, Loudness, custom saved).
- **Loudness normalization:** a compressor at gentle settings plus YTM's own loudness value if exposed (`loudnessDb` in
  the player response); toggle in Settings.
- The graph is built lazily on the first `fx` call and **rebuilt** if YTM swaps the `<video>` element. Settings
  persist and are re-applied on every `trackChanged`.
- FX must never change what YouTube counts: playback still runs through the YTM player in real time (a speed change
  is a normal YTM playback-rate change).

---

## 6. Lyrics (decided: YTM + LRCLIB)

Provider chain, first hit wins (with a provider switcher like Liner's island to pick another result):
1. **YTM:** from `next` (watch endpoint) → lyrics tab `browseId` → `browse` for the lyrics. Timed lyrics are
   available only for some tracks and some clients. Try the web response first, and if the page can fetch with a mobile
   client context (`ANDROID_MUSIC`), use its `timedLyricsData`. Plain lyrics are kept as a fallback display.
2. **LRCLIB:** `GET https://lrclib.net/api/get?track_name&artist_name&album_name&duration` from Neyuki http
   (User-Agent `shirabe/<version>`), falling back to `/api/search`. Prefer `syncedLyrics`. Parse enhanced LRC `<mm:ss.xx>`
   word tags into word-level timing when present.

Parsing: LRC → `{ lines = { { t, endT, text, words? } } }`. Apply a per-track offset (±, saved). Cache by
`videoId` under `os.cacheDir("shirabe")/lyrics`. Liner's `WORD_LEVEL_LYRICS_REFERENCE.md` has the
syllable-grouping math if word-level animation is added.

---

## 7. Discord Rich Presence

- `net.connectPipe("discord-ipc-" .. n)` for n = 0..9, inside a task. Frames: `u32 op, u32 len (LE), JSON`.
  Handshake `{ v = 1, client_id }`, then `SET_ACTIVITY`.
- Activity: `type = 2` (Listening), `status_display_type = 1` so the member list shows **"Listening to
  <artist>"**, `details = title`, `state = artist`, `assets.large_image = <cover URL>`, `large_text = album`,
  `timestamps = { start, end }` from position/duration, and a button "Listen on YouTube Music" → `music.youtube.com/watch?v=…`.
- On pause: clear the activity (setting) or show paused without timestamps. Reconnect with back-off if Discord
  restarts. Throttle updates (track change, play/pause, seek > 2 s).
- **Client ID:** the owner will create a Discord application named "shirabe" (with the logo as an art asset).
  Until then, `config.discordClientId = nil` disables RPC.

---

## 8. Customization (v1 scope: background + accent/theme)

Settings live in `os.configDir("shirabe")/settings.json` (versioned, with migrations). The UI updates live.

- **Background source:** none (solid), solid color, gradient (2–3 stops plus angle), image file, **animated GIF/WebP**
  (`ui.loadImage` + `ui.animation`), or **current cover art**. User files are copied into
  `os.dataDir("shirabe")/backgrounds/`.
- Background controls: blur (0–80), dim (0–90 %), saturation (if cheap), fit (cover/contain/fill), position, and
  "animate GIF" on/off (battery saver).
- **Accent:** manual color, or **auto from cover art** (dominant/vibrant color from a downscaled thumbnail, contrast-
  checked against the text tone). Tween between accents on track change.
- Glass opacity, glass blur, corner radius, light/dark text tone.

---

## 9. Other features (decided extras)

- **Queue + radio:** a queue panel mirroring YTM's queue (reorder, remove, play next, clear upcoming), "Start radio"
  everywhere, and YTM autoplay/automix left on.
- **Equalizer + loudness:** §5.
- **Sleep timer:** after N minutes or at the end of the current track/queue, with a fade-out over 10 s (gain ramp).
- **Local stats:** each play of ≥ 30 s appends to `os.dataDir("shirabe")/stats.jsonl`. The Stats page shows top
  tracks and artists and listening time by day/week/month (this is local, separate from Google's Recap).
- **OS media controls:** `ui.mediaSession` with title/artist/artwork/position and handling of `mediakey`/`mediasession`
  events.
- **Shortcuts:** Space play/pause, ←/→ seek 5 s, Ctrl+←/→ prev/next, Ctrl+L like, Ctrl+K search, Ctrl+, settings,
  F11 now-playing full screen. Configurable later.

---

## 10. Project layout

```
shirabe/
  neyuki.toml            [app] name = "shirabe", identifier, icon = ".logos/…ico", assets = "assets"
  main.nyk               entry: settings → window → webview → ui.run
  app/                   router.nyk, layout.nyk, titlebar.nyk, rail.nyk, playerbar.nyk
  pages/                 home, search, library, collection (playlist/album), artist, nowplaying, settings/*
  widgets/               button, card, list (virtualized), scroll, chips, slider, toggle, menu, modal, toast, textinput
  theme/                 tokens.nyk, fonts.nyk, background.nyk, glass.nyk, accent.nyk, motion.nyk
  state/                 store.nyk (observable state + tweens), settings.nyk (load/save/migrate)
  services/
    ytm/                 bridge.nyk (request/response, events), api.nyk, parse/*.nyk, accounts.nyk
    lyrics/              ytm.nyk, lrclib.nyk, lrc.nyk, cache.nyk
    discord.nyk, media.nyk, images.nyk (thumbnail fetch + LRU cache), stats.nyk, sleep.nyk
  assets/
    bridge.js            injected into music.youtube.com
    fonts/               BuilderExtended-*.otf, Inter-*.ttf, NotoSansJP-*.otf
    icons/               UI icons as PNG (rendered from SVG at 1×/2×)
    logos/               copied from .logos
  tests/                 parser tests against saved YTM JSON fixtures (no network)
```

---

## 11. Milestones

1. **Spike (de-risk):** hidden webview signs in to Google, plays a track by ID, reports state, and the play shows up in
   YTM history; the brand-account switch is verified the same way. *If sign-in or history fails, stop and revisit
   the architecture.*
2. Shell: frameless window, title bar, rail, player bar, background + glass, fonts, router, motion primitives.
3. Bridge + parsers: home, search, browse (playlist/album/artist), library, likes, with JSON fixtures and tests.
4. Pages: Home, Search, Library, Playlist/Album, Artist.
5. Now playing + lyrics + queue.
6. Audio FX (pitch/speed/link, reverb, EQ, loudness).
7. Settings modal, customization, accounts UI.
8. Discord RPC, media session, sleep timer, stats, shortcuts.
9. Packaging with `neyuki build` (icon, no console), performance pass, polish.

### 11.1 Milestone 1 results (2026-10-25, `spike/m1.nyk` + `assets/bridge.js`)

All passed on Windows 11 / WebView2 with Neyuki 0.5.0 plus the fixes that shipped in 0.6.0 (neyuki-lang PRs #36–#38);
re-checked on the 0.6.0 release.

- **Sign-in:** Google accepted sign-in in the embedded WebView2 window. The session persists in
  `os.dataDir("shirabe")/webview`.
- **EU consent wall:** signed-out or new profiles are redirected to `consent.youtube.com`. The bridge is not active
  there. Shirabe must show the window and let the user choose; it must never click it for them. Test profiles reject
  non-essential cookies automatically (`SHIRABE_TEST_REJECT_CONSENT`).
- **Playback:** `dispatch("yt-navigate", { endpoint: { watchEndpoint } })` on `ytmusic-app` loads a track without a page
  reload. `ytmusic-app.navigate` does not exist. A hidden window gets no user gesture, so `autoStart` calls
  `playVideo()` once the requested video reaches state -1/5. Signed out, pre-roll ads play first
  (`#movie_player.ad-showing`); with Premium there are none.
- **History:** a hidden, **muted** playback of about 40 s moves the track to the top of `FEmusic_history`. Recording
  doesn't need audible output.
- **Brand accounts:** `account/accounts_list` fetched in-page lists the owner and brand accounts. Switching does
  **not** work through `yt-navigate` with `selectActiveIdentityEndpoint`. It works by navigating to the item's
  `accountSigninToken.signinUrl` (`/signin?action_handle_signin=true&authuser=0&pageid=…&next=%2F…`), which moves
  the whole cookie session. After that, `ytcfg.DELEGATED_SESSION_ID` equals the page ID, the selection **persists
  across restarts**, and playback lands in **that account's** history while the owner's history is untouched. The
  page's UI language follows the selected account, so parsers must not rely on English strings.
- **Neyuki gotchas found:** a `task.wait` inside `pcall` blocks instead of yielding and starves `ui.run`, so
  long-running flows must not be wrapped in `pcall`. (Fixed in 0.6: the windows-gnu WebView2 loader, a GC stack overflow
  on self-recursive closures, and `??` evaluating its right side eagerly.)

### 11.2 Milestone 2 results (2026-10-26)

The shell runs on Neyuki 0.6.1: `main.nyk` + `app/` (layout, title bar, rail, player bar, router), `pages/` (home,
search, library: layout with placeholders), `kit/` (immediate-mode input, smoothing, widgets with an IME-aware text
field), `theme/` (tokens, fonts, vector icons, the logo drawn from its SVG pixel grid, background, glass) and
`state/` (settings JSON, player shape).

- Verified with `dev/flows/m2-shell.txt` (scripted synthetic input + snapshots, run with `SHIRABE_SCRIPT` and
  `SHIRABE_SNAPSHOT`): rail navigation and its sliding highlight, Ctrl+3, chip pill animation, grid/list toggle, tile
  hover, search typing (Japanese included), backspace, enter, filter chips, wheel scrolling with clamping, toasts.
  Not covered by the script (it can't fake the OS side): window drag/resize/maximize, and dropping a file to set the
  background.
- Performance at 1280 × 800, scale 1: about 11 ms of work per frame and about 59 fps on every page (`SHIRABE_TOUR=1`).
  Lessons: cache static layers (background, shadows) in `ui.canvas`; skip `blurRegion` where only the background is
  underneath; don't use `ui.run`, which waits a whole frame *before* the work (capping at ~33 fps); `main.nyk` has its
  own paced loop.
- Neyuki limits to remember: strings are UTF-8 only, so binary HTTP bodies and file writes are corrupted. Thumbnails
  must come through the bridge as base64 (`buffer.frombase64` → `ui.decodeImage`). `fs` paths (assets) resolve
  from the working directory, so run from the shirabe folder.
- Fonts: Builder Extended (bundled) for display; Segoe UI stands in for Inter until the Inter files are added to
  `assets/fonts`; CJK and emoji come from Yu Gothic UI, Malgun Gothic, YaHei and Segoe UI Emoji.

### 11.3 Milestone 3 results (2026-10-26)

- `services/ytm/bridge.nyk` owns the hidden page: request/response correlation for tasks, identity and player
  state, consent detection, sign-in window. `services/ytm/api.nyk` has one function per page plus the synced writes
  (rate, save, create / edit / delete playlist, subscribe). The writes are implemented but **not yet exercised**
  against the live account.
- `services/ytm/parse/common.nyk` normalizes every item renderer (list rows, cards, multi-row episodes, queue
  entries) into one `Item` shape. Kinds come from `pageType` / `musicVideoType` only; localized type labels in
  unfiltered search subtitles are dropped by position. `parse/pages.nyk` covers home (+ continuation, moods), search
  (top result, sections, filters with params, continuation), collections (album / playlist / Liked Music: header,
  owner, tracks, continuation, related), artist (header, top songs, carousels, about), library sections, watch
  (queue, lyrics / related tabs by page type), lyrics and accounts.
- Live check (`dev/live_check.nyk`, read-only): every call works through the page, at 120–830 ms each. Artwork from
  `yt3/lh3.googleusercontent.com` and `i.ytimg.com` comes back base64 and decodes with `ui.decodeImage`.
- Tests: `neyuki tests/run.nyk`, 22 passing. `test_common` uses synthetic data; `test_pages` uses the recorded
  fixtures of both accounts (English and German UI). Fixtures are private (see `tests/fixtures/ytm/README.md`).
- Findings: the owner account's library is empty, so the user's music lives on the `@janis.ishere` brand account
  and Shirabe should remember and restore the last selected account. Web lyrics are plain text (Musixmatch) without
  timing, so synced lyrics come from LRCLIB (milestone 5). A track's queue entry can wrap a song/video pair
  (`playlistPanelVideoWrapperRenderer`); the primary one is used.

### 11.4 Milestone 4 results (2026-10-26)

- The app runs on live data: `state/session.nyk` (page lifecycle, consent, sign-in, restoring the chosen account,
  switching), `state/loader.nyk` (async entries per account generation; requests wait until the page is ready, since
  an early `browse` fails with "Precondition check failed"), `services/images.nyk` (artwork through the page, 6 at a
  time, LRU of 220, fade-in), `state/playback.nyk` (play / pause / next / prev / seek through the page, player bar
  synced from page state, details of autoplayed tracks via `next`, OS media session and media keys).
- Pages: Home (real shelves, quick picks as row grids, carousels with arrows, feed continuation), Search
  (suggestions, YTM's filter chips, top result card, results, paging), Library (playlists / albums / artists / songs
  with filter, grid / list), Album & Playlist (`pages/collection.nyk`: header, Play / Shuffle, tracks with
  continuation, related shelves), Artist (banner, Play / Radio, top songs, carousels, about). The router has route
  params, back history (back button, Alt+Left, Backspace) and per-route scroll. The rail avatar shows the account photo
  and opens an account switcher.
- Verified with `dev/flows/m4-data.txt` and `m4-pages.txt` (muted, `SHIRABE_TEST_MUTE=1`): home feed, search,
  playback and pause, artist page, Liked Music page. Not yet verified live: the account switcher UI, the like button
  (it writes to the account), Shuffle on collections, the library on the brand account.
- **Needs neyuki-lang PR #40** (GC: tables reachable only through a spared table were cleared). Without it, loaded
  fonts get emptied a few seconds after data starts loading. Until it ships, run with a Neyuki built from that branch.
- Known gaps: the owner account's "Liked Music" reports 2 songs but returns no rows; the artist banner uses the
  low-resolution thumbnail when that is all YTM offers; shuffle / repeat / lyrics / queue buttons only show a toast
  (milestone 5).

## 12. Known risks

- ~~Google sign-in blocked in the embedded webview~~: worked in milestone 1, but Google can change this at any time.
- YTM DOM/internal API changes break the bridge. Keep it isolated, self-testing and easy to patch.
- CPU rendering cost at high resolution with blur + GIF. Use the caching rules in §3.1 and measure with `ui.stats()`.
- Builder Extended licence for public distribution.
- Shirabe needs Neyuki ≥ 0.6.1 plus neyuki-lang PR #40 (GC sparing fix): 0.6.0 re-runs a file module on every `require` (so modules never share state) and
  parses `??` tighter than the spec. 0.5.0 crashes on the next full GC once any self-recursive closure exists, and its
  windows-gnu builds don't start without `WebView2Loader.dll`.
