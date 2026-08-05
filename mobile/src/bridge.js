// Capacitor stand-in for preload.js's `window.electronAPI`. renderer.js is
// loaded unmodified after this file, so every method it calls has to exist —
// LAN methods are real (backed by localStorage + fetch, mirroring lan.js's
// own client code that renderer.js already runs against desktop peers),
// local files are a minimal same-session fallback, everything else that
// needs a native binary or desktop shell integration is a named stub.
// ponytail: filename-only local tracks, no tag/cover parsing or persistence —
// add @capacitor/filesystem + music-metadata-browser when offline library
// needs to survive an app restart.
(function () {
  // renderer.js's track-list virtualizer absolutely-positions each row via a
  // fixed ROW_HEIGHT constant (renderer.js:2895) — it has to match .trow's
  // real rendered height or rows overlap. mobile.css's leading-thumbnail
  // two-line row is taller than desktop's one-line row: measured at 85px
  // (10px padding top+bottom + the 40px cover, which is the tallest thing in
  // the row). Verified empirically (headless-Chrome getBoundingClientRect),
  // not derived from the CSS automatically — re-measure if mobile.css's
  // .trow padding/cover size changes.
  window.AUDEX_ROW_HEIGHT = 85;

  const LAN_KEY = 'audex-mobile-lan';
  const unavailable = (error) => ({ success: false, error: error || 'not available on mobile' });

  function loadLan() {
    let cfg;
    try { cfg = { name: '', key: '', enabled: false, peers: [], deviceId: '', ...JSON.parse(localStorage.getItem(LAN_KEY) || '{}') }; }
    catch (_) { cfg = { name: '', key: '', enabled: false, peers: [], deviceId: '' }; }
    // Each phone needs a stable identity of its own — a literal 'mobile' would
    // collide if more than one phone pairs with the same desktop, each
    // overwriting the other's entry in lan.js's peers map.
    if (!cfg.deviceId) { cfg.deviceId = `mobile:${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`; saveLan(cfg); }
    return cfg;
  }
  function saveLan(cfg) { localStorage.setItem(LAN_KEY, JSON.stringify(cfg)); }
  function lanStatusFromCfg(cfg) {
    return {
      // No server to start on mobile (see lanWsConnectAll below) — having a
      // key configured is the whole of "on" here, there's nothing else to flip.
      enabled: !!cfg.key, hasKey: !!cfg.key, key: cfg.key || '', name: cfg.name || '',
      deviceId: cfg.deviceId, port: 8422, running: false, error: '',
      addresses: [], peers: cfg.peers || [],
    };
  }
  // Same address parsing as lan.js's addManualPeer, so a pasted "host:port"
  // behaves identically to pairing two desktops.
  function parsePeerAddr(addr) {
    const s = String(addr || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!s) return null;
    const i = s.lastIndexOf(':');
    const host = i > 0 && !s.slice(i + 1).includes(']') ? s.slice(0, i) : s;
    const port = i > 0 ? (parseInt(s.slice(i + 1), 10) || 8422) : 8422;
    const deviceId = `manual:${host}:${port}`;
    return { deviceId, name: host, host, port, manual: true, base: `http://${host}:${port}` };
  }

  // ── LAN: WebSocket link to a paired desktop ──
  //
  // Mirrors lan.js's "mobile clients" section on the other end: a phone can't
  // receive an inbound push or answer a take-over the way a desktop peer's
  // HTTP server does (no listening socket in a WebView without new native
  // code), but it can hold a normal client WebSocket open to a desktop peer's
  // existing HTTP server — the desktop upgrades that connection and treats it
  // as a live peer. Same bearer key as everything else in lan.js; sent as the
  // first message rather than a header since the browser WebSocket API can't
  // set one.
  let cachedLanState = null;      // last snapshot.state from lanPublish() below
  let onLanCommandCb = null;      // set by renderer.js via onLanCommand()
  const wsSockets = new Map();    // deviceId -> WebSocket

  // Same shape as lan.js's publicState(), built from what renderer.js already
  // sends this device's own lanPublish() calls.
  function myLanState() {
    const s = cachedLanState || {};
    const describe = (path) => {
      // Our own playable paths are either a peer's absolute http(s) LAN URL
      // (shareable as-is) or a blob: from the local file picker, which lives
      // only in this WebView's memory — nothing else can stream it, so it
      // can't be handed to a take-over.
      if (!/^https?:/.test(String(path || ''))) return null;
      return { id: path, title: s.title || '', artist: s.artist || '', album: s.album || '', duration: s.duration || 0, url: path, coverUrl: s.coverUrl || null };
    };
    const cfg = loadLan();
    return {
      deviceId: cfg.deviceId, name: cfg.name || 'Mobile',
      playing: !!s.playing, position: s.position || 0, duration: s.duration || 0,
      volume: s.volume, shuffle: !!s.shuffle, repeat: s.repeat || 0,
      track: s.path ? describe(s.path) : null,
      queue: (Array.isArray(s.queue) ? s.queue : []).map(describe).filter(Boolean),
    };
  }

  // ── diagnostics ──
  // These failure paths were completely silent before — the only symptom on
  // a real device was "nothing happens," with no way for us or the user to
  // tell whether it's the wrong key, an unreachable host, a rejected
  // handshake, or a network-layer block, short of guessing blind. Capacitor
  // forwards WebView console.* to `adb logcat` (Capacitor's WebChromeClient
  // hook), so this is the debuggable surface a real device actually has.
  const wsLog = (...args) => console.error('[audex:lan-ws]', ...args);

  function wsConnectPeer(peer) {
    if (wsSockets.has(peer.deviceId)) return;
    const cfg = loadLan();
    if (!cfg.key || !peer.host) return;
    const url = `ws://${peer.host}:${peer.port}/api/ws`;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { wsLog('failed to construct WebSocket for', url, e); return; }
    wsSockets.set(peer.deviceId, ws);
    ws.onopen = () => {
      try { ws.send(JSON.stringify({ type: 'auth', key: cfg.key, deviceId: cfg.deviceId, name: cfg.name || 'Mobile' })); } catch (e) { wsLog('failed to send auth to', url, e); }
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { wsLog('unparseable message from', url, ev.data, e); return; }
      if (msg.type === 'auth-ok') {
        wsLog('connected and authed:', url);
      } else if (msg.type === 'req-state') {
        try { ws.send(JSON.stringify({ type: 'state', reqId: msg.reqId, state: myLanState() })); } catch (e) { wsLog('failed to reply to req-state from', url, e); }
        // A take-over stops playback here too, same as lan.js does for an
        // HTTP peer being taken from.
        if (onLanCommandCb) onLanCommandCb({ type: 'pause' });
      } else if (msg.type === 'command' && onLanCommandCb) {
        onLanCommandCb(msg.cmd);
      }
    };
    const drop = (why) => {
      if (wsSockets.get(peer.deviceId) === ws) wsSockets.delete(peer.deviceId);
      wsLog('disconnected from', url, why);
    };
    // Close code 4001 is lan.js's own "bad key" rejection (handleUpgrade's
    // wsCloseUnauthorized) — everything else is a lower-level network/TCP
    // failure (unreachable host, refused/reset connection, timeout).
    ws.onclose = (ev) => drop(`close code=${ev.code} reason=${ev.reason || '(none)'}`);
    ws.onerror = () => drop('error event (see close event above for the actual reason, if any)');
  }

  // ponytail: fixed-interval retry, no backoff/jitter — reasonable for a
  // handful of peers on one phone; revisit if this ever needs to scale past
  // "the user's own devices".
  function wsConnectAll() {
    const cfg = loadLan();
    if (!cfg.key) return;
    for (const peer of cfg.peers) wsConnectPeer(peer);
  }
  setInterval(wsConnectAll, 4000);

  // ── local files (session-only fallback) ──
  const localFiles = new Map(); // blob url -> File
  let filePicker = null;
  function ensurePicker() {
    if (filePicker) return filePicker;
    filePicker = document.createElement('input');
    filePicker.type = 'file';
    filePicker.multiple = true;
    filePicker.accept = 'audio/*';
    filePicker.style.display = 'none';
    document.body.appendChild(filePicker);
    return filePicker;
  }

  window.electronAPI = {
    // ── window/zoom: no-ops, mobile has no chrome zoom ──
    setZoomFactor: () => {},
    getZoomFactor: () => 1,
    setPortrait: () => {},

    // ── local files: system picker, filename-derived metadata only ──
    openFiles: () => new Promise((resolve) => {
      const input = ensurePicker();
      input.value = '';
      input.onchange = () => {
        const paths = [];
        for (const file of input.files) {
          const url = URL.createObjectURL(file);
          localFiles.set(url, file);
          paths.push(url);
        }
        resolve(paths);
      };
      input.click();
    }),
    chooseFolder: async () => null, // no folder concept behind a file picker
    scanFolder: async () => [],
    parseMetadata: async (filePath) => {
      const file = localFiles.get(filePath);
      if (!file) return unavailable('file gone');
      const base = file.name.replace(/\.[^./]+$/, '');
      return {
        title: base, artist: 'Unknown Artist', album: 'Unknown Album', albumArtist: '',
        year: '', genre: '', trackNo: '', discNo: '', comment: '', duration: 0,
        quality: null, hasCover: false, cover: null, path: filePath,
      };
    },
    loadCoverCache: async () => ({}),
    readAudioFile: async () => null,
    trimAudio: async () => unavailable('editing needs the desktop app'),
    writeMetadata: async () => unavailable('tag writes need the desktop app'),
    writeCover: async () => unavailable('tag writes need the desktop app'),
    revealInFolder: async () => unavailable(),
    deleteFile: async () => unavailable(),
    openExternal: async (url) => { window.open(url, '_blank'); },

    // ── app/build ──
    getBuildInfo: async () => ({ commit: 'mobile' }),
    getHardwareAcceleration: async () => ({ enabled: true }),
    setHardwareAcceleration: async () => unavailable(),
    openLogsFolder: async () => unavailable(),
    logError: async (where, message) => { console.error('[audex]', where, message); },
    checkForUpdate: async () => ({ available: false }),
    downloadUpdate: async () => {},
    installUpdate: async () => {},
    onUpdateDownloadProgress: () => () => {},
    onUpdateDownloaded: () => () => {},

    // ── downloads / trending / spotify / youtube: need yt-dlp, desktop-only ──
    ytSearch: async () => unavailable('downloads need the desktop app'),
    ytDownload: async () => unavailable('downloads need the desktop app'),
    ytDownloadByQuery: async () => unavailable('downloads need the desktop app'),
    onYtDownloadProgress: () => () => {},
    getDownloadsDir: async () => unavailable(),
    ytMusicParse: async () => unavailable('downloads need the desktop app'),
    spotifyParse: async () => unavailable('downloads need the desktop app'),
    youtubeLogin: async () => unavailable(),
    youtubeCookiesStatus: async () => ({ loggedIn: false }),
    onSpotifyParseProgress: () => () => {},
    trendingFetch: async () => unavailable('trending needs the desktop app'),

    // ── cover/lyrics lookup: pure network calls, same APIs main.js hits ──
    lookupCover: async (query) => {
      try {
        const q = encodeURIComponent(`${query.artist || ''} ${query.album || query.title || ''}`.trim());
        const res = await fetch(`https://itunes.apple.com/search?term=${q}&entity=album&limit=1`);
        const data = await res.json();
        const hit = data.results && data.results[0];
        return hit ? { success: true, url: hit.artworkUrl100.replace('100x100', '600x600') } : unavailable('no match');
      } catch (e) { return unavailable(String(e && e.message || e)); }
    },
    lookupLyrics: async (query) => {
      try {
        const params = new URLSearchParams({ artist_name: query.artist || '', track_name: query.title || '' });
        const res = await fetch(`https://lrclib.net/api/get?${params}`);
        if (!res.ok) return unavailable('no match');
        const data = await res.json();
        return { success: true, lyrics: data.plainLyrics || data.syncedLyrics || '' };
      } catch (e) { return unavailable(String(e && e.message || e)); }
    },
    identifyTrack: async () => unavailable('fingerprinting needs the desktop app'),

    // ── Discord / tray / hotkeys: desktop shell only ──
    discordConnect: async () => unavailable(),
    discordDisconnect: async () => {},
    discordSetActivity: async () => {},
    discordGetStatus: async () => ({ connected: false }),
    onDiscordStatus: () => () => {},
    updateTrayState: async () => {},
    onTrayCommand: () => () => {},
    registerGlobalHotkeys: async () => {},
    onGlobalHotkey: () => () => {},

    // ── appearance ──
    pickBackground: async () => unavailable(),
    clearBackground: async () => {},

    // ── LAN: the real thing, backed by localStorage instead of main.js ──
    lanStatus: async () => lanStatusFromCfg(loadLan()),
    lanSetConfig: async (next) => {
      const cfg = { ...loadLan(), ...next };
      saveLan(cfg);
      // Open sockets were authed with the old key — drop them so wsConnectAll's
      // next sweep reconnects and re-auths with the new one.
      if (next.key !== undefined) {
        for (const ws of wsSockets.values()) { try { ws.close(); } catch (_) {} }
        wsSockets.clear();
      }
      return lanStatusFromCfg(cfg);
    },
    lanPublish: async (snap) => { if (snap && snap.state !== undefined) cachedLanState = snap.state; },
    lanAddPeer: async (addr) => {
      const peer = parsePeerAddr(addr);
      if (!peer) return loadLan().peers;
      const cfg = loadLan();
      if (!cfg.peers.some(p => p.deviceId === peer.deviceId)) cfg.peers = [...cfg.peers, peer];
      saveLan(cfg);
      wsConnectPeer(peer);
      return cfg.peers;
    },
    lanRemovePeer: async (id) => {
      const cfg = loadLan();
      cfg.peers = cfg.peers.filter(p => p.deviceId !== id);
      saveLan(cfg);
      const ws = wsSockets.get(id);
      if (ws) { try { ws.close(); } catch (_) {} wsSockets.delete(id); }
      return cfg.peers;
    },
    onLanPeers: () => () => {}, // no discovery push channel; add/remove already re-poll lanStatus
    onLanCommand: (cb) => { onLanCommandCb = cb; return () => { onLanCommandCb = null; }; },
  };

  // ── peer cover cache ──
  //
  // A remote track's `cover` (renderer.js's lanRemoteAsTrack) is a plain
  // http(s) URL, rendered as a CSS `background-image` — which has no retry
  // or persistence of its own: one dropped packet on a flaky phone Wi-Fi
  // link and that thumbnail is just gone, silently, forever (no onerror
  // hook exists for a failed background-image load), and it's re-fetched
  // from scratch over the network on every cold start since nothing local
  // remembers it. The fix isn't a database — the Cache Storage API (a
  // standard, already-available Web Platform API, not a Capacitor plugin;
  // Capacitor serves Android over `https://localhost` by default, a secure
  // context, so it's available with zero setup) is exactly a persistent
  // URL-keyed blob store, which is all a thumbnail cache actually needs to
  // be: no schema, no queries, no native dependency.
  //
  // ponytail: unbounded cache (relies on the WebView's own storage-eviction
  // policy under pressure) and no revocation of superseded blob: URLs across
  // a session — fine for a personal library's worth of cover art; add an
  // LRU sweep if this ever needs a hard size cap.
  const COVER_CACHE = 'audex-covers-v1';
  async function cachedCoverUrl(url) {
    if (!window.caches || !/^https?:/.test(url)) return url;
    try {
      const cache = await caches.open(COVER_CACHE);
      let res = await cache.match(url);
      if (!res) {
        const fetched = await fetch(url);
        if (!fetched.ok) { console.error('[audex:cover]', 'non-OK response', fetched.status, url); return url; }
        await cache.put(url, fetched.clone());
        res = fetched;
      }
      return URL.createObjectURL(await res.blob());
    } catch (e) {
      console.error('[audex:cover]', 'failed to fetch/cache', url, e);
      return url; // offline / cache unavailable — the raw URL still might load
    }
  }

  // Small concurrent batches rather than the whole library at once, so a
  // big peer library doesn't open hundreds of connections in one burst.
  async function cacheCoversFor(lib) {
    const tracks = (lib && lib.tracks || []).filter(t => /^https?:/.test(t.cover || ''));
    let changed = false;
    for (let i = 0; i < tracks.length; i += 6) {
      const batch = tracks.slice(i, i + 6);
      await Promise.all(batch.map(async (t) => {
        const cached = await cachedCoverUrl(t.cover);
        if (cached !== t.cover) { t.cover = cached; changed = true; }
      }));
    }
    if (changed && window.refreshCurrentViewRows) refreshCurrentViewRows();
  }

  // The portrait now-playing layout only exists as `.fs-overlay.is-portrait`
  // CSS (style.css:2935+); desktop only adds that class via the manual
  // portrait toggle. On mobile it's the only sane layout, so force it on.
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.fs-overlay').forEach(el => el.classList.add('is-portrait'));
    buildMoreSheet();
    // renderer.js only wires up onLanCommand/publishing when settings.lanSharing
    // is on (renderer.js:11045) — that toggle lives in the desktop-only
    // "Sidebar" settings tab, which mobile.css hides entirely. The mobile
    // Devices nav is force-shown regardless (mobile.css's #nav-devices[hidden]
    // override) — enable the feature itself to match, rather than leaving it
    // permanently unreachable behind a hidden toggle.
    if (window.lanEnableFeature) window.lanEnableFeature();
    wsConnectAll();
    // Wrap rather than edit renderer.js: it's a plain top-level function, so
    // reassigning window.lanSyncPeerLibrary redefines the same global every
    // other call site (including the 30s peer-repoll timer) already calls by
    // its bare name — same trick electronAPI itself is built on.
    if (window.lanSyncPeerLibrary) {
      const originalSync = window.lanSyncPeerLibrary;
      window.lanSyncPeerLibrary = async function (peer) {
        await originalSync(peer);
        // lanPeerLibraries is a top-level `let` in renderer.js, not a
        // window property (only function declarations become those) — the
        // bare identifier still resolves through the shared global scope.
        cacheCoversFor(typeof lanPeerLibraries !== 'undefined' ? lanPeerLibraries[peer.deviceId] : null);
      };
    }
    // Only #mini-cover-wrapper opens fullscreen by default (renderer.js:8184)
    // — on a phone the whole bar is the "now playing" affordance, not just
    // the thumbnail. #btn-play/#btn-next keep their own behavior instead of
    // also launching fullscreen out from under a tap meant to skip a track.
    const playbar = document.querySelector('.playbar');
    if (playbar) {
      playbar.addEventListener('click', (e) => {
        if (e.target.closest('#btn-play, #btn-next')) return;
        if (window.openFullscreen) openFullscreen();
      });
    }
  });

  // The desktop sidebar has 9 destinations; a phone tab bar only has room for
  // ~4. Library/Search/Devices stay put, everything else (Albums, Artists,
  // Playlists, Favorites, Settings, Open files) gets physically relocated
  // into a slide-up sheet behind a "More" tab — moving the existing DOM
  // nodes (not cloning them) so the click listeners renderer.js already
  // bound to them (renderer.js:3128, 3149 — both re-query the live DOM per
  // click, not a cached list) keep working with zero renderer.js changes.
  function buildMoreSheet() {
    const nav = document.querySelector('.nav-menu');
    const sidebarActions = document.querySelector('.sidebar-actions');
    if (!nav) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'mobile-more-backdrop';
    const sheet = document.createElement('div');
    sheet.className = 'mobile-more-sheet';
    sheet.innerHTML = '<div class="mobile-more-handle"></div>';
    document.body.append(backdrop, sheet);

    // #btn-connect (renderer.js's Spotify-Connect-style take-over/push menu,
    // renderer.js:9002-9013) stays `hidden` forever on mobile otherwise: it's
    // only un-hidden by applyLanSharingVisibility() when settings.lanSharing
    // is on, and that toggle lives in the desktop-only "Sidebar" settings tab
    // mobile.css hides entirely — same gate lanEnableFeature() above already
    // bypasses. renderConnectMenu() already lists mobile peers (phone icon,
    // take/push buttons) same as desktop ones, so reusing it here needs zero
    // new renderer.js code, just a working way to reach it.
    const connectBtn = document.getElementById('btn-connect');
    if (connectBtn) {
      connectBtn.hidden = false;
      connectBtn.classList.add('nav-item');
      const label = document.createElement('span');
      label.textContent = window.tr ? tr('lan.connect') : 'Connect to a device';
      connectBtn.appendChild(label);
    }

    const moved = [
      ...nav.querySelectorAll('[data-view="albums"], [data-view="artists"], [data-view="playlists"], [data-view="favorites"]'),
      sidebarActions && sidebarActions.querySelector('#btn-add-files'),
      sidebarActions && sidebarActions.querySelector('.nav-settings'),
      connectBtn,
    ].filter(Boolean);
    moved.forEach(el => sheet.appendChild(el));

    const moreBtn = document.createElement('button');
    moreBtn.className = 'nav-item';
    moreBtn.id = 'mobile-more-btn';
    moreBtn.innerHTML = '<svg class="i" width="14" height="14"><use href="#i-more"/></svg><span>More</span>';
    nav.appendChild(moreBtn);

    const close = () => { sheet.classList.remove('open'); backdrop.classList.remove('open'); };
    moreBtn.addEventListener('click', () => {
      sheet.classList.toggle('open');
      backdrop.classList.toggle('open');
    });
    backdrop.addEventListener('click', close);
    // Any tap inside the sheet is either a navigation (view is about to
    // change, nothing left to show here) or Open files (dialog takes over) —
    // close either way instead of leaving a stale sheet on top. #btn-connect
    // opens a popover instead (renderer.js's own listener, which stops
    // propagation) — stays open otherwise since this handler never sees the
    // click.
    sheet.addEventListener('click', (e) => { if (e.target !== sheet) close(); });
    if (connectBtn) connectBtn.addEventListener('click', close);
  }

  setUpNativeAudio();

  // ── ExoPlayer (Media3) native audio for LAN streams, replacing HTML5
  // <audio> ──
  //
  // window.Capacitor.Plugins.<Name> is auto-injected by Capacitor's native
  // Android bridge for every registered plugin — nothing to import, nothing
  // to bundle. It's simply absent when this page is opened in a plain
  // browser (e.g. testing mobile/www/ directly), so the guard below leaves
  // the real <audio> element completely untouched in that case, same as
  // before this function existed.
  //
  // renderer.js only ever touches one real <audio id="audio-player">
  // element: .paused/.currentTime/.duration/.volume/.muted/.src,
  // .play()/.pause(), and the events play/pause/seeked/timeupdate/ended/
  // loadedmetadata/volumechange — nothing else (no .load()/.readyState/
  // .buffered/canplay*). This keeps that element real (so every existing
  // audio.addEventListener(...) call in renderer.js keeps working
  // unchanged) but redirects its accessors to the native plugin for http(s)
  // sources — LAN streaming, the normal case. blob: sources (the mobile
  // local-file-picker fallback, openFiles() above) fall through to genuine
  // HTML5 audio unchanged: native ExoPlayer can't read a WebView blob: URL,
  // and that fallback was already scoped as session-only/foreground-use.
  function setUpNativeAudio() {
    const AudioPlayer = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AudioPlayer;
    const el = document.getElementById('audio-player');
    if (!AudioPlayer || !el) return;

    const AUDIO_ID = 'audex';
    const p = { audioId: AUDIO_ID };

    // Snapshot the real HTMLMediaElement behavior before shadowing it below,
    // so blob: (local file) playback can still use it untouched.
    const proto = HTMLMediaElement.prototype;
    const native = {
      src: Object.getOwnPropertyDescriptor(proto, 'src'),
      currentTime: Object.getOwnPropertyDescriptor(proto, 'currentTime'),
      duration: Object.getOwnPropertyDescriptor(proto, 'duration'),
      paused: Object.getOwnPropertyDescriptor(proto, 'paused'),
      volume: Object.getOwnPropertyDescriptor(proto, 'volume'),
      muted: Object.getOwnPropertyDescriptor(proto, 'muted'),
      play: proto.play,
      pause: proto.pause,
    };

    let usingNative = false;   // true once an http(s) source has been assigned
    let loadToken = 0;         // guards a stale async create() from a superseded track
    let nativeReady = false;   // create()+initialize() accepted for the current source
    let nativeSrc = '';
    let nativeDuration = 0;
    let nativeCurrentTime = 0;
    let nativePaused = true;
    let nativeVolume = 1;
    let nativeMuted = false;
    let volumeBeforeMute = 1;
    let pollTimer = null;
    let meta = { title: '', artist: '', album: '', artwork: '' };
    let loadPromise = Promise.resolve(); // the in-flight loadNative() for the current src

    const dispatch = (name) => el.dispatchEvent(new Event(name));

    function startPolling() {
      if (pollTimer) return;
      // The plugin has no periodic time event — poll instead. 250ms is
      // plenty for a percentage-width progress bar.
      pollTimer = setInterval(async () => {
        try {
          const r = await AudioPlayer.getCurrentTime(p);
          nativeCurrentTime = r.currentTime;
          dispatch('timeupdate');
        } catch (_) {}
      }, 250);
    }
    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }
    function setNativePaused(next) {
      if (nativePaused === next) return;
      nativePaused = next;
      dispatch(next ? 'pause' : 'play');
      if (next) stopPolling(); else startPolling();
    }

    async function loadNative(src) {
      const token = ++loadToken;
      nativeSrc = src;
      nativeReady = false;
      nativeDuration = 0;
      nativeCurrentTime = 0;
      stopPolling();
      try { await AudioPlayer.destroy(p); } catch (_) { /* nothing created yet the first time */ }
      if (token !== loadToken) return;
      // navigator.mediaSession isn't implemented by Android's WebView (only by
      // standalone Chrome), so the metadata setter below never fires there and
      // meta.title/artist stay '' forever — every track's notification showed
      // the 'Audex' fallback and nothing else. renderer.js updates the mini-
      // player DOM (#track-title/#track-artist) synchronously right after
      // audio.src/play() for every track change (renderer.js:6963-6964), before
      // any promise here can resolve, so it's a reliable, always-available
      // source of the current track's real title/artist.
      const domTitle = document.getElementById('track-title');
      const domArtist = document.getElementById('track-artist');
      const domAlbum = document.getElementById('fs-album'); // always kept in sync, fs-overlay need not be open
      if (domTitle && domTitle.textContent) meta.title = domTitle.textContent;
      if (domArtist && domArtist.textContent) meta.artist = domArtist.textContent;
      if (domAlbum && domAlbum.textContent) meta.album = domAlbum.textContent;
      try {
        await AudioPlayer.create({
          ...p,
          audioSource: src,
          friendlyTitle: meta.title || 'Audex',
          artistName: meta.artist || '',
          albumTitle: meta.album || '',
          // The plugin's own Java only treats a literal "https:"-prefixed
          // string as a URL to fetch (AudioSource.java) — anything else it
          // tries to read as a bundled app asset path instead, which fails
          // silently for our http:// LAN cover URLs. lan.js never serves
          // covers over https, so artwork just won't show on mobile for now
          // rather than risk hitting that broken fallback path.
          artworkSource: /^https:/.test(meta.artwork) ? meta.artwork : undefined,
          useForNotification: true,
        });
        if (token !== loadToken) return;
        await AudioPlayer.initialize(p);
        nativeReady = true;
        // Actual readiness (buffered enough to report a real duration)
        // comes from the onAudioReady event below, not this promise.
      } catch (e) {
        dispatch('error');
      }
    }

    // Mirror renderer.js's existing navigator.mediaSession.metadata updates
    // (renderer.js:7044, updateMediaSessionMetadata — already fires on every
    // track change for desktop's OS media-key integration) into the
    // plugin's notification metadata, instead of adding a second,
    // renderer.js-side hook for the same information.
    if ('mediaSession' in navigator) {
      try {
        Object.defineProperty(navigator.mediaSession, 'metadata', {
          configurable: true,
          get() { return meta._raw || null; },
          set(v) {
            meta._raw = v;
            meta.title = (v && v.title) || '';
            meta.artist = (v && v.artist) || '';
            meta.album = (v && v.album) || '';
            const art = v && v.artwork && v.artwork[0];
            // A blob: cover (renderer.js's file:// re-wrap for desktop's disk
            // cache — never produced for a mobile LAN track) isn't fetchable
            // from native code either; only pass through http(s) artwork.
            meta.artwork = (art && art.src) || '';
            if (nativeReady) {
              AudioPlayer.changeMetadata({
                ...p,
                friendlyTitle: meta.title,
                artistName: meta.artist,
                albumTitle: meta.album,
                artworkSource: /^https:/.test(meta.artwork) ? meta.artwork : undefined, // see loadNative()
              }).catch(() => {});
            }
          },
        });
      } catch (_) { /* not implemented on this WebView build — title/artwork just stay default */ }
    }

    // Registered once: the plugin reuses the same audioId across create()
    // calls for every track change, so these persist rather than needing
    // re-registration per track.
    AudioPlayer.onAudioReady(p, async () => {
      if (!usingNative) return;
      try {
        const d = await AudioPlayer.getDuration(p);
        nativeDuration = d.duration || 0;
      } catch (_) {}
      dispatch('loadedmetadata');
    });
    AudioPlayer.onAudioEnd(p, () => { setNativePaused(true); dispatch('ended'); });
    // Fires for both app- and lock-screen/notification-initiated changes —
    // the plugin can't tell them apart on Android — so this one path
    // handles external control for free, no separate code needed.
    AudioPlayer.onPlaybackStatusChange(p, (r) => { setNativePaused(r.status !== 'playing'); });

    Object.defineProperty(el, 'src', {
      configurable: true,
      get() { return usingNative ? nativeSrc : native.src.get.call(el); },
      set(v) {
        const value = String(v || '');
        if (/^blob:/.test(value)) {
          if (usingNative) { try { AudioPlayer.pause(p); } catch (_) {} }
          usingNative = false;
          stopPolling();
          native.src.set.call(el, value);
        } else {
          usingNative = true;
          loadPromise = loadNative(value);
        }
      },
    });
    Object.defineProperty(el, 'currentTime', {
      configurable: true,
      get() { return usingNative ? nativeCurrentTime : native.currentTime.get.call(el); },
      set(v) {
        if (usingNative) {
          nativeCurrentTime = Number(v) || 0;
          AudioPlayer.seek({ ...p, timeInSeconds: nativeCurrentTime }).then(() => dispatch('seeked')).catch(() => {});
        } else {
          native.currentTime.set.call(el, v);
        }
      },
    });
    Object.defineProperty(el, 'duration', {
      configurable: true,
      get() { return usingNative ? nativeDuration : native.duration.get.call(el); },
    });
    Object.defineProperty(el, 'paused', {
      configurable: true,
      get() { return usingNative ? nativePaused : native.paused.get.call(el); },
    });
    Object.defineProperty(el, 'volume', {
      configurable: true,
      get() { return usingNative ? nativeVolume : native.volume.get.call(el); },
      set(v) {
        if (usingNative) {
          nativeVolume = Number(v);
          AudioPlayer.setVolume({ ...p, volume: nativeVolume }).then(() => dispatch('volumechange')).catch(() => {});
        } else {
          native.volume.set.call(el, v);
        }
      },
    });
    Object.defineProperty(el, 'muted', {
      configurable: true,
      get() { return usingNative ? nativeMuted : native.muted.get.call(el); },
      set(v) {
        if (usingNative) {
          const next = !!v;
          if (next === nativeMuted) return;
          nativeMuted = next;
          if (next) { volumeBeforeMute = nativeVolume; el.volume = 0; }
          else { el.volume = volumeBeforeMute; }
        } else {
          native.muted.set.call(el, v);
        }
      },
    });
    el.play = function () {
      // renderer.js sets .src then calls .play() in the same synchronous tick
      // (renderer.js:6717/6724) — loadNative() is async (create()+initialize()
      // round-trip to native), so without waiting for it here, play() used to
      // race ahead and call AudioPlayer.play() on a player that didn't exist
      // yet. It silently no-op'd/rejected, leaving the track "playing" in the
      // UI but actually paused in ExoPlayer until something (a manual pause/
      // play, the notification) nudged it once the player was finally ready.
      if (usingNative) return loadPromise.then(() => AudioPlayer.play(p)).then(() => setNativePaused(false));
      return native.play.call(el);
    };
    el.pause = function () {
      if (usingNative) { AudioPlayer.pause(p).then(() => setNativePaused(true)).catch(() => {}); return; }
      return native.pause.call(el);
    };
  }
})();
