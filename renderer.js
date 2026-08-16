// ── Audex renderer ──

// No menu bar and no DevTools shortcut means an uncaught renderer error has
// nowhere to surface — forward it to main's app.log (see logAppError there).
if (window.electronAPI && typeof window.electronAPI.logError === 'function') {
  window.addEventListener('error', (e) => {
    window.electronAPI.logError('renderer:error', e.error && e.error.stack || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    window.electronAPI.logError('renderer:unhandledrejection', e.reason && e.reason.stack || e.reason);
  });
}

// Storage keys (kept "ambevor-*" for the library so existing users don't lose state;
// new keys use the audex- prefix).
const LS = {
  libraryMeta: 'ambevor-library-meta',
  favorites: 'ambevor-favorites',
  playlists: 'audex-playlists',
  settings: 'audex-settings',
  recents: 'audex-recents',
  updateDismiss: 'audex-update-dismiss',
  ytmState: 'audex-dl-ytm-state',
  spState: 'audex-dl-sp-state',
  queue: 'audex-dl-queue',
  playLog: 'audex-play-log',
  qualityCache: 'audex-quality-cache',
  healthReport: 'audex-health-report',
  session: 'audex-session',
};

// ── Big-state store ──
// The library index and the play log live in <userData>/store (see main.js).
// They outgrow localStorage — a 10k-track library is ~4MB of JSON against a
// ~5MB origin cap — and localStorage answers that by throwing, which used to
// mean the library silently stopped persisting. Anything small enough to fit
// (settings, playlists, favorites, caches) stays in localStorage. An older
// preload without the store IPC keeps using localStorage for everything.
const hasStore = !!(window.electronAPI && window.electronAPI.readStoreSync);
function readStore(name, lsKey) {
  if (hasStore) {
    const raw = window.electronAPI.readStoreSync(name);
    // No file yet: read the localStorage copy this version replaced. The first
    // write moves it into the file and drops the stale key.
    if (raw != null) { try { return JSON.parse(raw); } catch (_) { return null; } }
  }
  try { return JSON.parse(localStorage.getItem(lsKey) || 'null'); } catch (_) { return null; }
}
// ponytail: rewrites the whole store on every save, same as localStorage did.
// Debounce (or append-only) if a big import starts feeling slow.
function writeStore(name, value, lsKey) {
  const json = JSON.stringify(value);
  if (!hasStore) {
    try { localStorage.setItem(lsKey, json); } catch (e) { warnSaveFailed(lsKey, e); }
    return;
  }
  window.electronAPI.writeStore(name, json)
    .then(res => {
      if (res && res.success) localStorage.removeItem(lsKey);  // migrated — reclaim the quota
      else warnSaveFailed(lsKey, res && res.error);
    })
    .catch(e => warnSaveFailed(lsKey, e));
}
// A failed save used to be a console.warn nobody sees. Toast it — but once per
// store per session, since a full disk or a blown quota fails on every save and
// a wall of identical toasts helps nobody.
const saveFailedOnce = new Set();
function warnSaveFailed(what, err) {
  console.warn('save failed:', what, err);
  if (saveFailedOnce.has(what)) return;
  saveFailedOnce.add(what);
  toast(tr('toast.saveFailed'), { type: 'error' });
}

// Equalizer band frequencies (Hz), matching Spotify's 6-band graphic EQ. The
// first band is a low shelf, the last a high shelf, the rest peaking bells.
const EQ_BANDS = [60, 150, 400, 1000, 2400, 15000];
const EQ_GAIN_MAX = 12;   // dB, slider range is ±this
// Preset name → per-band gain (dB), ordered to EQ_BANDS. 'custom' is implicit:
// dragging any slider stops matching a named preset.
const EQ_PRESETS = {
  flat:            [0, 0, 0, 0, 0, 0],
  'bass-booster':  [6, 5, 3, 1, 0, 0],
  'bass-reducer':  [-6, -5, -3, -1, 0, 0],
  'treble-booster':[0, 0, 0, 2, 4, 6],
  'treble-reducer':[0, 0, 0, -2, -4, -6],
  'vocal-booster': [-2, -3, 3, 4, 3, -1],
  acoustic:        [4, 3, 1, 0, 2, 3],
  classical:       [5, 4, 3, -1, -1, 4],
  dance:           [4, 6, 2, 0, 3, 4],
  deep:            [5, 3, 1, 2, -2, -4],
  electronic:      [4, 3, 0, -2, 2, 5],
  'hip-hop':       [5, 4, 1, 2, -1, 3],
  jazz:            [4, 2, -1, 1, 3, 4],
  latin:           [4, 0, -2, -2, 0, 5],
  loudness:        [6, 4, 0, 0, 2, 5],
  lounge:          [-3, -1, 1, 3, 0, -2],
  piano:           [3, 1, 2, 3, 4, 3],
  pop:             [-1, 2, 4, 3, 0, -1],
  rnb:             [5, 6, 2, -2, 2, 4],
  rock:            [5, 3, -1, -1, 2, 4],
  'small-speakers':[5, 4, 2, 0, -2, -3],
  'spoken-word':   [-3, -1, 2, 4, 2, -2],
};
const EQ_PRESET_LABELS = {
  flat: 'Flat', 'bass-booster': 'Bass booster', 'bass-reducer': 'Bass reducer',
  'treble-booster': 'Treble booster', 'treble-reducer': 'Treble reducer',
  'vocal-booster': 'Vocal booster', acoustic: 'Acoustic', classical: 'Classical',
  dance: 'Dance', deep: 'Deep', electronic: 'Electronic', 'hip-hop': 'Hip-Hop',
  jazz: 'Jazz', latin: 'Latin', loudness: 'Loudness', lounge: 'Lounge',
  piano: 'Piano', pop: 'Pop', rnb: 'R&B', rock: 'Rock',
  'small-speakers': 'Small speakers', 'spoken-word': 'Spoken word', custom: 'Custom',
};

// State
let libraryMeta = readStore('library-meta', LS.libraryMeta) || [];
let favorites = JSON.parse(localStorage.getItem(LS.favorites) || '[]');
let playlists = JSON.parse(localStorage.getItem(LS.playlists) || '[]');
let settings = Object.assign({
  theme: 'dark',          // 'dark' | 'light' | 'system' | 'rose-pine' | 'rose-pine-moon' | 'rose-pine-dawn'
  accent: '',             // '' = theme default; otherwise a hex like '#5b9eff'
  randomTheme: false,     // pick a random palette on every launch
  language: 'en',
  defaultFolder: '',
  defaultView: 'library',    // view shown on startup: library | artists | albums | favorites | playlist-detail
  defaultPlaylistId: null,   // used when defaultView === 'playlist-detail'
  dlFormat: 'opus',       // yt-dlp --audio-format: opus | flac | m4a
  scanSubdirs: true,
  albumsSort: 'alpha',    // Albums view filter chip: alpha | tracks | recent
  artistMinTracksEnabled: false,
  artistMinTracks: 2,     // artists with fewer tracks than this are hidden from the Artists view when the toggle above is on
  healthCheck: false,
  reports: false,
  editor: false,
  crossfade: false,
  crossfadeSec: 3,        // 0–10, length of the blend; 0 = instant switch
  repeatOneResetOnSkip: true, // manually skipping while "repeat one" is on drops it to "repeat"
  volumeWheelStep: 0.05,  // 0.01–0.2, volume change per mouse-wheel notch on the slider
  eq: { enabled: false, preset: 'flat', gains: [0, 0, 0, 0, 0, 0] },  // graphic equalizer
  downloads: true,
  ytMusic: false,        // "YouTube Music" sidebar tab (the in-app browser)
  lanSharing: false,     // master switch for Devices/LAN sharing — off by default, opens a network port
  showParserBrowser: true,
  uiScale: 1,
  settingsTab: 'appearance', // active tab in the Settings view
  hotkeys: {},               // only user overrides; see HOTKEY_DEFAULTS
  hotkeysGlobal: {},         // action id -> true when registered system-wide
  bgSource: 'none',          // 'none' | 'image' | 'cover'
  bgImage: '',               // file:// URL of the copy in <userData>/backgrounds
  bgImageName: '',           // original filename, shown in Settings
  bgBlur: 0,                 // px
  bgDim: 35,                 // % of the theme background laid over the image
  bgFit: 'cover',            // cover | contain | center | tile
  surfaceAlpha: 100,         // % opacity of sidebar/playbar/cards over the image
}, JSON.parse(localStorage.getItem(LS.settings) || '{}'));
// Shallow-merge above replaces `eq` wholesale — normalize so an old/partial
// saved object still has a valid gains array of the right length.
settings.eq = Object.assign({ enabled: false, preset: 'flat', gains: [] }, settings.eq || {});
if (!Array.isArray(settings.eq.gains) || settings.eq.gains.length !== EQ_BANDS.length) {
  settings.eq.gains = new Array(EQ_BANDS.length).fill(0);
}
let recents = JSON.parse(localStorage.getItem(LS.recents) || '[]');
// Format names are the same in every language, so they stay out of the i18n tables.
const DL_FORMAT_LABELS = { opus: 'Opus', flac: 'FLAC', m4a: 'M4A' };
const DEFAULT_VIEW_LABELS = {
  library: 'nav.library', artists: 'nav.artists', albums: 'nav.albums',
  favorites: 'nav.favorites', 'playlist-detail': 'setting.defaultViewPlaylist',
};

// ── Discord Rich Presence ──
// Paste your Discord Application Client ID here (https://discord.com/developers
// → New Application → copy the Application ID). Until it's set, the integration
// stays inert: the Settings panel shows but "Connect" reports a missing ID.
// Album covers are resolved as public https URLs from the iTunes Search API and
// passed straight into the activity's large_image — no art-asset upload needed.
const DISCORD_CLIENT_ID = '1518146518392115271';
// Public fallback image used as the activity's large_image when iTunes can't
// resolve an album cover (no match). Served raw from the project repo.
const AUDEX_LOGO_URL = 'https://raw.githubusercontent.com/zhotheone/audex-player/main/build/icons/512x512.png';
// Nested Discord prefs (shallow-merge above doesn't deep-merge, so normalize).
const DISCORD_DEFAULTS = {
  enabled: false,
  showTitle: true,
  showArtist: true,
  showCover: true,
  showTimer: true,
  showPaused: false,
  privacyInvisible: true,
  privacyPrivate: false,
  buttons: [
    { label: 'GitHub', url: 'https://github.com/zhotheone/audex-player' },
    { label: 'Find on YouTube', url: '' },
  ],
};
settings.discord = Object.assign({}, DISCORD_DEFAULTS, settings.discord || {});
if (!Array.isArray(settings.discord.buttons)) settings.discord.buttons = DISCORD_DEFAULTS.buttons.map(b => ({ ...b }));
// One-time relabel of the old Russian-language defaults. Only matches the exact
// legacy labels, so it never overrides a user's own edits and is idempotent
// (after relabel neither branch matches again).
(function migrateDiscordButtonLabels() {
  const [b0, b1] = settings.discord.buttons;
  let changed = false;
  if (b0 && b0.label === 'Слушать в Audex' && b0.url === 'https://github.com/MishaSok/audex-player') {
    b0.label = 'GitHub'; changed = true;
  }
  if (b1 && b1.label === 'Найти на YouTube') { b1.label = 'Find on YouTube'; changed = true; }
  if (changed) saveSettings();
})();
let discordConnected = false;
let discordUser = null;

// ── Last.fm ──
// BYO-key: the api key + shared secret are entered in Settings (feature is
// optional and off by default). A session key, once obtained via the web auth
// flow, is stored here and never expires.
const LASTFM_DEFAULTS = {
  enabled: false,
  apiKey: '',
  secret: '',
  session: '',      // session key (sk) — grants scrobble/love on the user's behalf
  user: '',         // last.fm username, for display
  scrobble: true,
  nowPlaying: true,
  loveSync: true,   // mirror the in-app favourite toggle to Last.fm love/unlove
};
settings.lastfm = Object.assign({}, LASTFM_DEFAULTS, settings.lastfm || {});

const coverCache = {};
let library = libraryMeta.map(t => ({ ...t, cover: coverCache[t.path] || null }));

// Read by saveLibrary() below (called from the top-level backfill IIFE right
// after this, i.e. before any function runs) and by lanPublish() to know when
// peers need a fresh copy of the library, not just a state tick — has to be
// declared before that IIFE, not just "early", or a fresh/legacy library
// (any track missing addedAt) hits this `let` while still in its TDZ and
// aborts the rest of the script's top-level init.
let lanTracksDirty = true;
let lanConfigDirty = true;   // same idea, for the settings subset peers can pull

// Backfill `addedAt` for tracks imported before the Listening Report shipped.
// Their real add-date is unknown, so we stamp a fixed past sentinel (1 = just
// after the epoch): they count toward the all-time "Added to collection" stat
// (window starts at 0) without inflating the day/month/year periods.
(function backfillLegacyAddedAt() {
  let changed = false;
  for (const t of library) {
    if (!t.addedAt) { t.addedAt = 1; changed = true; }
  }
  if (changed) saveLibrary();
})();

// The playbar used to decode every track into amplitude peaks for a waveform
// seek bar and cache them here; it's a plain progress line now. Drop the old
// cache so it stops eating the localStorage budget on existing installs.
try { localStorage.removeItem('audex-wave-peaks-v2'); } catch (_) {}

// Play history for the on-device Listening Report. Each entry:
// { t: startTs(ms), p: path, n: title, a: artist, b: album, s: seconds listened }.
// Capped in count and age so it can't grow unbounded (see savePlayLog / plPush).
const PLAYLOG_MAX = 4000;
const PLAYLOG_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000; // ~13 months
let playLog = (() => {
  try {
    const arr = readStore('play-log', LS.playLog);
    const cutoff = Date.now() - PLAYLOG_MAX_AGE_MS;
    return Array.isArray(arr) ? arr.filter(e => e && e.t >= cutoff) : [];
  } catch (_) { return []; }
})();

// The track that is playing right now. Held as an object, not an index into
// `library`, so a track streamed from a peer plays through the same path as a
// local one (see lanPlayTrack).
let currentTrack = null;
let currentQueue = library;          // the list we're playing through
let shuffledQueue = [];
let currentView = 'library';
let activeSort = 'date-desc';
let isPlaying = false;
let isShuffle = false;
let repeatMode = 0;                  // 0 off · 1 all · 2 one

let pendingContextTrackPath = null;
let pendingMetadataPath = null;
let pendingAddPath = null;
let activePlaylistId = null;
let activeArtistName = null;
let activeAlbumKey = null;
// A hand-edited localStorage value would otherwise leave every chip inactive.
let albumsSort = ['alpha', 'tracks', 'recent'].includes(settings.albumsSort) ? settings.albumsSort : 'alpha';
let albumsViewMode = 'cards';        // 'cards' | 'list'
let artistsSort = 'alpha';           // 'alpha' | 'tracks' | 'recent'
let artistAlbumsSort = 'year-desc';  // 'year-desc' | 'year-asc' — album order within an artist
let artistView = 'list';             // 'list' | 'cards' — album layout on the artist page
const artistYtmCache = new Map();    // artist name → { state, songs } for the "Popular on YT Music" column
let artistsList = [];                // current filtered+sorted list of artist objects
let artistsCursor = 0;               // how many of artistsList have been mounted in the grid
let artistsObserver = null;          // IntersectionObserver on the sentinel

// ── DOM ──
const $ = id => document.getElementById(id);
const audio = $('audio-player');
// Needed so the equalizer's Web Audio graph doesn't mute cross-origin sources.
// LAN peer streams send Access-Control-Allow-Origin:*, and file:/blob: are
// same-origin, so this is safe for every source we play and must be set before
// any src is assigned (changing it later forces a reload).
audio.crossOrigin = 'anonymous';
const root = document.documentElement;

// A modal opened from a click-driven action (closing a popover first, etc.)
// can still lose the focus() call to whatever the triggering click leaves
// focused — a plain "setTimeout(() => el.focus(), 50)" then races that and
// sometimes loses, leaving a field that looks editable but silently eats
// every keystroke. Verify the focus actually landed and retry once instead
// of gambling on a fixed delay being long enough.
function focusModalInput(el, { select = false } = {}) {
  if (!el) return;
  const attempt = () => { el.focus(); if (select) el.select(); };
  requestAnimationFrame(() => {
    attempt();
    setTimeout(() => { if (document.activeElement !== el) attempt(); }, 100);
  });
}

// ── Theme ──
// 'system' (= Default) follows the OS and resolves to dark/light, which are
// Rosé Pine and Rosé Pine Dawn. `emoji` shows in the menu and the trigger;
// `light` marks the palettes that need the dark-ink overrides in style.css.
const THEME_OPTIONS = [
  { id: 'system',            emoji: '🖥️', i18n: 'theme.system' },
  { id: 'light',             emoji: '🌅', i18n: 'theme.light', light: true },
  { id: 'dark',              emoji: '🌹', i18n: 'theme.dark' },
  { id: 'rose-pine-moon',    emoji: '🌒', name: 'Rosé Pine Moon' },
  { id: 'catppuccin-mocha',  emoji: '🐱', name: 'Catppuccin Mocha' },
  { id: 'catppuccin-latte',  emoji: '☕', name: 'Catppuccin Latte', light: true },
  { id: 'gruvbox-dark',      emoji: '🟫', name: 'Gruvbox Dark' },
  { id: 'gruvbox-light',     emoji: '🟨', name: 'Gruvbox Light', light: true },
  { id: 'dracula',           emoji: '🧛', name: 'Dracula' },
  { id: 'dracula-light',     emoji: '🕯️', name: 'Dracula Light (Alucard)', light: true },
  { id: 'tokyo-night',       emoji: '🗼', name: 'Tokyo Night' },
  { id: 'tokyo-night-day',   emoji: '🏙️', name: 'Tokyo Night Day', light: true },
];
function themeLabel(id) {
  const o = THEME_OPTIONS.find(t => t.id === id) || THEME_OPTIONS[0];
  return `${o.emoji} ${o.i18n ? tr(o.i18n) : o.name}`;
}
// Everything except 'system', which is not a palette of its own.
function randomThemeId() {
  const pool = THEME_OPTIONS.filter(o => o.id !== 'system');
  return pool[Math.floor(Math.random() * pool.length)].id;
}
function applyTheme(t) {
  // A theme removed since the settings were written (or synced from another
  // device) has no CSS block — fall back to dark instead of losing every var.
  const opt = THEME_OPTIONS.find(o => o.id === t) || THEME_OPTIONS[2];
  const resolved = opt.id === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : opt.id;
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-mode', THEME_OPTIONS.find(o => o.id === resolved).light ? 'light' : 'dark');
}
if (!THEME_OPTIONS.some(o => o.id === settings.theme)) settings.theme = 'dark';
// Random only paints this launch — the picked theme is never written back, so
// the menu keeps showing (and returning to) whatever the user actually chose.
applyTheme(settings.randomTheme ? randomThemeId() : settings.theme);
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (settings.theme === 'system' && !settings.randomTheme) applyTheme('system');
});

// ── Accent color ──
// Preset palette. The first entry ('') means "use the theme's built-in accent".
const ACCENT_PRESETS = [
  { value: '',        label: 'default' },
  { value: '#5b9eff', label: 'blue'    },
  { value: '#7c8cff', label: 'indigo'  },
  { value: '#b07cff', label: 'purple'  },
  { value: '#ff6b8a', label: 'pink'    },
  { value: '#ff5577', label: 'red'     },
  { value: '#ff9a3d', label: 'orange'  },
  { value: '#e8c547', label: 'yellow'  },
  { value: '#4ecdc4', label: 'teal'    },
  { value: '#7ec9a8', label: 'green'   },
];
function isHexColor(s) {
  return typeof s === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s.trim());
}
function applyAccent(hex) {
  if (hex && isHexColor(hex)) {
    root.style.setProperty('--accent', hex);
  } else {
    root.style.removeProperty('--accent');
  }
}
applyAccent(settings.accent);

// ── Custom background ──
// bgSource: 'none' | 'image' (a file the user picked) | 'cover' (the artwork of
// whatever is playing). Everything is driven off CSS custom properties so the
// track-cover mode can repaint on each track change without rebuilding state.
const BG_FIT_CSS = {
  cover:   { size: 'cover',   repeat: 'no-repeat' },
  contain: { size: 'contain', repeat: 'no-repeat' },
  center:  { size: 'auto',    repeat: 'no-repeat' },
  tile:    { size: 'auto',    repeat: 'repeat' },
};
function currentBackgroundUrl() {
  if (settings.bgSource === 'image') return settings.bgImage || '';
  if (settings.bgSource === 'cover') {
    const t = currentTrack;
    if (!t) return '';
    return t.cover || coverCache[t.path] || '';
  }
  return '';
}
function applyAppearance() {
  const url = currentBackgroundUrl();
  const on = !!url;
  root.classList.toggle('has-custom-bg', on);
  const layer = document.getElementById('app-bg-image');
  if (layer) {
    layer.style.backgroundImage = on ? `url("${String(url).replace(/"/g, '%22')}")` : '';
    const fit = BG_FIT_CSS[settings.bgFit] || BG_FIT_CSS.cover;
    layer.style.backgroundSize = fit.size;
    layer.style.backgroundRepeat = fit.repeat;
  }
  const blur = Math.max(0, Math.min(60, Number(settings.bgBlur) || 0));
  root.style.setProperty('--bg-blur', blur + 'px');
  // A CSS blur samples past the element's edges, so scale up just enough that
  // the faded border stays off-screen.
  root.style.setProperty('--bg-scale', String(1 + blur / 100));
  root.style.setProperty('--bg-dim', String(Math.max(0, Math.min(100, Number(settings.bgDim) || 0)) / 100));
  root.style.setProperty('--surface-alpha', String(Math.max(20, Math.min(100, Number(settings.surfaceAlpha) || 100)) / 100));
}

// ── UI scale ──
const UI_SCALE_STEPS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5];
function clampUiScale(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 1;
  return Math.min(UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1], Math.max(UI_SCALE_STEPS[0], n));
}
function applyUiScale(scale) {
  const s = clampUiScale(scale);
  if (window.electronAPI && typeof window.electronAPI.setZoomFactor === 'function') {
    window.electronAPI.setZoomFactor(s);
  } else {
    // Fallback for older preloads: CSS zoom is Chromium-only but covers our target.
    document.documentElement.style.zoom = String(s);
  }
}
applyUiScale(settings.uiScale);
applyAppearance();

// ── Persistence ──
function saveLibrary() {
  lanTracksDirty = true;   // peers are serving a copy of this list
  libraryMeta = library.map(({ cover, ...rest }) => rest);
  writeStore('library-meta', libraryMeta, LS.libraryMeta);
  saveFavorites();
}
// Separate from saveLibrary on purpose: these used to share a try block, so a
// library write that blew the quota took the favorites write down with it.
function saveFavorites() {
  try { localStorage.setItem(LS.favorites, JSON.stringify(favorites)); }
  catch (e) { warnSaveFailed(LS.favorites, e); }
}
function savePlaylists() {
  try { localStorage.setItem(LS.playlists, JSON.stringify(playlists)); }
  catch (e) { warnSaveFailed(LS.playlists, e); }
}
function saveSettings() {
  lanConfigDirty = true;   // peers are serving a copy of the syncable subset
  localStorage.setItem(LS.settings, JSON.stringify(settings));
}
function saveRecents() {
  localStorage.setItem(LS.recents, JSON.stringify(recents.slice(0, 4)));
}
function savePlayLog() {
  if (playLog.length > PLAYLOG_MAX) playLog = playLog.slice(-PLAYLOG_MAX);
  writeStore('play-log', playLog, LS.playLog);
}
// ── i18n ──
// Static UI strings are translated via [data-i18n], [data-i18n-placeholder],
// [data-i18n-title] attributes on HTML elements. Dynamic strings (rendered
// from JS) go through tr() / plural() below. Adding a new string: add the key
// to every language in I18N, then either tag the HTML element with data-i18n
// or call tr('your.key') in JS.
const I18N = {
  en: {
    'nav.devices': "Devices",
    'lan.thisDevice': "This device",
    'lan.namePh': "Device name",
    'lan.keyPh': "Network key",
    'lan.generate': "Generate",
    'lan.enable': "Turn on sharing",
    'lan.disable': "Turn off sharing",
    'lan.needKey': "Set a network key first — every device of yours needs the same one.",
    'lan.hint': "Pick a network key and set it here — it acts like a Wi-Fi password: every one of your devices needs the exact same key to see each other. Turn sharing on and this device's library becomes reachable to the rest of the group.",
    'lan.hintPeers': "Devices on the same LAN with the same key show up here automatically — nothing to add. On another network (e.g. over Tailscale), add its address by hand above. On Windows, a manual add that hangs usually means the firewall rule only covers Private networks — Windows reports the Tailscale adapter as Public, so allow the app there too.",
    'lan.on': "Sharing",
    'lan.off': "Sharing is off",
    'lan.starting': "Starting…",
    'lan.error': "Error",
    'lan.peers': "Other devices",
    'lan.noPeers': "No devices found yet.",
    'lan.manual': "added by hand",
    'lan.inbound': "Connected · read-only",
    'lan.connect': "Connect to a device",
    'lan.networkBadge': "NETWORK",
    'lan.networkFrom': "From {device}",
    'lan.syncSettings': "Sync settings",
    'lan.syncSettingsHint': "Pull this device's app preferences (theme, language, download format, etc.) into yours",
    'lan.syncSettingsConfirm': "Replace your app preferences with {device}'s? This won't touch your library or files.",
    'lan.syncSettingsNone': "That device hasn't shared any settings yet.",
    'lan.takeOver': "Take over",
    'lan.takeOverHint': "Pull this device's current session over here, picking up where it left off",
    'lan.push': 'Push here',
    'lan.pushHint': "Send what's playing on this device over to it",
    'lan.remove': "Remove",
    'lan.add': "Add",
    'lan.addPh': "Address, e.g. 100.90.1.2 or 192.168.1.5:8422",
    'lan.nothingPlaying': "That device is not playing anything.",
    'lan.errKey': "Wrong network key",
    'lan.errReach': "Can't reach that device:",
    'nav.library': 'Library',
    'update.available': 'Update available',
    'update.download': 'Download',
    'update.downloading': 'Downloading… {pct}%',
    'update.restart': 'Restart to install',
    'update.failed': 'Download failed — opening release page',
    'update.dismiss': 'Dismiss',
    'import.progress': 'Importing tracks…',
    'nav.albums': 'Albums',
    'nav.artists': 'Artists',
    'nav.playlists': 'Playlists',
    'nav.favorites': 'Favorites',
    'nav.downloads': 'Downloads',
    'nav.ytmusic': 'YouTube Music',
    'ytm.sub': 'Search an artist, then add albums or singles to the queue',
    'ytm.searchPh': 'Search artists on YouTube Music…',
    'ytm.results': 'Results for “{q}”',
    'ytm.searching': 'Searching…',
    'ytm.searchFailed': 'Search failed',
    'ytm.noArtists': 'No artists found',
    'ytm.releases': 'Albums & singles',
    'ytm.loadingReleases': 'Loading releases…',
    'ytm.releasesFailed': 'Failed to load releases',
    'ytm.noReleases': 'No releases found',
    'ytm.albums': 'Albums',
    'ytm.singles': 'Singles & EPs',
    'ytm.loading': 'Loading…',
    'ytm.loadingName': 'Loading {name}…',
    'ytm.loadingTracks': 'Loading tracks…',
    'ytm.albumFailed': 'Failed to load album',
    'ytm.adding': 'Adding…',
    'ytm.addingName': 'Adding {name}…',
    'ytm.added': 'Added {count}',
    'ytm.addedFrom': 'Added {count} from {name}',
    'ytm.addedOne': 'Added to queue',
    'ytm.already': 'Already in queue',
    'ytm.addAll': 'Add all to queue',
    'ytm.addOne': 'Add to queue',
    'ytm.back': 'Back',
    'ytm.browseArtist': 'Browse this artist on YouTube Music',
    'nav.editor': 'Editor',
    'cm.trim': 'Trim track…',
    'setting.editor': 'Editor (track trimming)',
    'setting.editorDesc': 'The “Editor” section for trimming tracks: pick a fragment on the waveform and save it as a new file.',
    'setting.ytMusic': 'YouTube Music',
    'setting.ytMusicDesc': 'The “YouTube Music” section for searching artists and adding their albums or singles to the download queue.',
    'editor.pick': 'Choose track',
    'editor.pickSearch': 'Search by title or artist',
    'editor.pickEmpty': 'Nothing found',
    'editor.empty.title': 'Trim tracks',
    'editor.empty.text': 'Pick a track, mark the start and end of a fragment on the waveform, and save it as a separate file. The original stays untouched unless you enable overwrite.',
    'editor.start': 'Start',
    'editor.end': 'End',
    'editor.selection': 'Fragment length',
    'editor.preview': 'Preview fragment',
    'editor.previewStop': 'Stop',
    'editor.reset': 'Reset',
    'editor.fadeIn': 'Fade in, s',
    'editor.fadeOut': 'Fade out, s',
    'editor.gain': 'Volume, dB',
    'editor.gainHint': 'Minus is quieter, plus is louder. 0 dB leaves it unchanged.',
    'editor.gainClip': 'Peak will exceed 0 dB by {d} dB — clipping likely',
    'editor.overwrite': 'Overwrite original',
    'editor.overwriteDesc': 'By default a new “— (trimmed)” file is created next to it. Enable to replace the source file.',
    'editor.save': 'Trim and save',
    'editor.decoding': 'Reading audio…',
    'editor.decodeError': 'Could not read the audio',
    'editor.trimming': 'Trimming…',
    'editor.trimSaved': 'Saved: {f}',
    'editor.saveError': 'Trim failed: {e}',
    'editor.tooShort': 'Fragment is too short',
    'nav.search': 'Search',
    'nav.recents': 'Recent',
    'nav.tools': 'Tools',
    'nav.openFiles': 'Open files',
    'nav.settings': 'Settings',
    'dlErr.geo': 'This track is blocked in your country and no alternative was found.',
    'dlErr.unavailable': 'The video was removed or is unavailable, and no alternative was found.',
    'dlErr.signin': 'YouTube requires a signed-in account for this track. Sign in from Settings → Downloads.',
    'dlErr.members': 'This track is limited to channel members.',
    'dlErr.network': 'No connection to YouTube. Check your network.',
    'dlErr.transient': 'YouTube hiccuped partway through this download — usually works on a retry.',
    'nav.report': 'Report',
    'report.onDevice': 'Computed on this device',
    'report.eyebrow': 'Listening report',
    'report.period.day': 'Day',
    'report.period.week': 'Week',
    'report.period.month': 'Month',
    'report.period.year': 'Year',
    'report.period.all': 'All time',
    'report.allTime': 'All time',
    'report.today': 'Today',
    'report.thisWeek': 'This week',
    'report.listeningTime': 'Listening time',
    'report.vsPrev': 'vs previous period',
    'report.tracksPlayed': 'Tracks played',
    'report.artists': 'Artists',
    'report.added': 'Added to collection',
    'report.streak': 'Listening streak',
    'report.days': 'days',
    'report.whenListen': 'When you listen',
    'report.topArtists': 'Top artists',
    'report.topTracks': 'Top tracks',
    'report.plays': 'plays',
    'report.minUnit': 'min',
    'report.hoursUnit': 'hours',
    'report.hShort': 'h',
    'report.mShort': 'm',
    'report.empty.title': 'Your stats will appear here',
    'report.empty.text': 'Play some music — the report builds from listening history kept on this device.',
    'table.quality': 'Quality',
    'quality.kbps': 'kbps',
    'quality.note': 'A quality badge on every track · ',
    'quality.noteAmber': 'amber = suspicious transcode',
    'quality.cutoffMarker': 'cutoff',
    'health.khz': 'kHz',
    'nav.health': 'Health',
    'health.crumb': 'Library health',
    'health.lastScan': 'Last check:',
    'health.never': 'not checked yet',
    'health.rescan': 'Rescan',
    'health.scanning': 'Checking {n} of {m}…',
    'health.scoreLabel': 'Collection health',
    'health.ok': 'healthy',
    'health.okLegend': 'healthy',
    'health.flaggedLegend': 'need attention',
    'health.transcodeTitle': 'Looks like a transcode',
    'health.claimed': 'Claimed',
    'health.real': 'really ≈',
    'health.spectrumCaption': 'The spectrum cuts off at {cut} kHz, though a real high bitrate holds frequencies up to ~20 kHz.{lame}',
    'health.noLame': ' No LAME tag present.',
    'health.issuesLabel': 'Issues found',
    'health.show': 'Show',
    'health.fix': 'Fix',
    'health.allGood': 'No issues found',
    'health.allGoodText': 'Your collection is in great shape.',
    'health.noData': 'Run a check to assess your library health.',
    'health.analyzing': 'Analyzing spectrum…',
    'health.filterNote': 'Health filter: {label}',
    'health.clearFilter': 'Clear',
    'issue.transcode.title': 'Suspicious transcode',
    'issue.transcode.desc': 'Bitrate is claimed high, but the spectrum cuts off early — likely upsampled from a low-quality source.',
    'issue.lowbitrate.title': 'Low bitrate (< 192 kbps)',
    'issue.lowbitrate.desc': 'Files at 128 kbps and below. Consider replacing with better versions.',
    'issue.nocover.title': 'No cover art',
    'issue.nocover.desc': 'Tracks with no embedded album image.',
    'issue.tags.title': 'Incomplete tags',
    'issue.tags.desc': 'Empty artist, album, year, or generic "Music" genre.',
    'issue.notrackno.title': 'Missing track number',
    'issue.notrackno.desc': 'Tracks with no track-number tag, which throws off album order.',
    'issue.dupes.title': 'Possible duplicates',
    'issue.dupes.desc': 'Same artist and title across different files.',
    'section.discord': 'Discord Rich Presence',
    'discord.subtitle': 'Show friends what you are listening to right in your Discord profile — with cover art, a timer and buttons that jump to the track.',
    'discord.statusConnected': 'Connected',
    'discord.statusDisconnected': 'Not connected',
    'discord.connect': 'Connect Discord',
    'discord.disconnect': 'Disconnect',
    'discord.connectHint': 'Link your account to broadcast your listening to your profile.',
    'discord.sessionActive': 'session active',
    'discord.connecting': 'Connecting…',
    'discord.connectError': 'Could not connect. Make sure Discord is running.',
    'discord.waitingForDiscord': 'Discord isn’t running — I’ll connect automatically once it opens.',
    'discord.noClientId': 'No Discord Client ID set. Add it to DISCORD_CLIENT_ID in renderer.js.',
    'discord.show': 'What to show',
    'discord.showTitle': 'Track title',
    'discord.showTitleDesc': 'The main activity line.',
    'discord.showArtist': 'Artist and album',
    'discord.showArtistDesc': 'The second line below the title.',
    'discord.showCover': 'Album cover',
    'discord.showCoverDesc': 'The large image on the card.',
    'discord.showTimer': 'Track timer',
    'discord.showTimerDesc': 'Elapsed and total time with progress.',
    'discord.showPaused': 'Show while paused',
    'discord.showPausedDesc': 'Keep the status when playback is stopped.',
    'discord.buttons': 'Profile buttons',
    'discord.buttonsHint': 'Discord allows at most two buttons in an activity. Links must start with http(s)://',
    'discord.btnLabel': 'Label',
    'discord.btnUrl': 'Link',
    'discord.btnLabelPh': 'Button text',
    'discord.btnUrlPh': 'https://…',
    'discord.privacy': 'Privacy',
    'discord.privacyInvisible': 'Hide while «Invisible»',
    'discord.privacyInvisibleDesc': 'Do not broadcast the status while you appear offline on Discord.',
    'discord.privacyPrivate': 'Disable for private playlists',
    'discord.privacyPrivateDesc': 'Tracks from private playlists won’t reach your profile.',
    'discord.preview': 'What friends see',
    'discord.previewListening': 'Listening to Audex',
    'discord.previewPaused': 'Was listening · paused',
    'discord.previewPlaceholder': 'The status appears in your profile once Discord is connected',
    'discord.previewNote': 'The card updates live on track change, pause and seeking.',
    'discord.previewOnline': 'Online',
    'discord.previewEmptyTrack': 'Nothing playing',
    'section.lastfm': 'Last.fm',
    'lastfm.subtitle': 'Scrobble what you play, sync loved tracks, and pull genres, corrections and similar artists.',
    'lastfm.apiKey': 'API key',
    'lastfm.secret': 'Shared secret',
    'lastfm.keyHint': 'Create an API account at last.fm/api — free, takes a minute. Paste the key and secret here.',
    'lastfm.getKey': 'Get an API key',
    'lastfm.connect': 'Connect',
    'lastfm.disconnect': 'Disconnect',
    'lastfm.connecting': 'Waiting for approval in your browser…',
    'lastfm.connected': 'Connected',
    'lastfm.notConnected': 'Not connected',
    'lastfm.connectHint': 'Authorize Audex to scrobble to your account.',
    'lastfm.needKey': 'Enter your API key and secret first.',
    'lastfm.authFailed': 'Authorization timed out. Approve access in the browser, then Connect again.',
    'lastfm.scrobble': 'Scrobble tracks',
    'lastfm.scrobbleDesc': 'Send a play to Last.fm once you’ve heard past halfway or 4 minutes.',
    'lastfm.nowPlaying': 'Update Now Playing',
    'lastfm.nowPlayingDesc': 'Show the current track on your profile in real time.',
    'lastfm.loveSync': 'Sync loved tracks',
    'lastfm.loveSyncDesc': 'Favouriting a track in Audex loves it on Last.fm too.',
    'lastfm.queued': '{n} scrobble(s) waiting to send',
    'lastfm.notInLibrary': 'Not in your library',
    'crumb.collection': 'Collection',
    'search.placeholder': 'Search…',
    'search.artistPlaceholder': 'Search artist…',
    'search.albumPlaceholder': 'Search album…',
    'search.trackPlaceholder': 'Search track…',
    'filter.all': 'All',
    'filter.recent': 'Recently added',
    'filter.favorites': 'Favorites only',
    'sort.label': 'Sort:',
    'sort.dateDesc': 'Date added ↓',
    'sort.dateAsc': 'Date added ↑',
    'sort.titleAsc': 'Title A→Z',
    'sort.titleDesc': 'Title Z→A',
    'sort.artistAsc': 'Artist A→Z',
    'sort.artistDesc': 'Artist Z→A',
    'sort.durationAsc': 'Duration ↑',
    'sort.durationDesc': 'Duration ↓',
    'sort.alpha': 'Alphabetical',
    'sort.byTracks': 'By track count',
    'sort.recent': 'Recently added',
    'sort.yearDesc': 'Newest first',
    'sort.yearAsc': 'Oldest first',
    'view.cards': 'Cards',
    'view.list': 'List',
    'table.title': 'Title',
    'table.artist': 'Artist',
    'table.album': 'Album',
    'table.time': 'Time',
    'empty.library.title': 'Library is empty',
    'empty.library.text': 'Open files or a folder to get started.',
    'empty.playlists.title': 'No playlists yet',
    'empty.playlists.text': 'Create your first playlist — gather tracks by mood, time of day, or album.',
    'empty.artists.title': 'No artists yet',
    'empty.artists.text': 'Add tracks to the library to see artists here.',
    'empty.albums.title': 'No albums yet',
    'empty.albums.text': 'Add tracks to the library to see albums here.',
    'empty.favorites.title': 'No favorite tracks',
    'empty.favorites.text': 'Click the heart on any track to add it here.',
    'btn.newPlaylist': 'New playlist',
    'btn.playAll': 'Play all',
    'btn.shuffle': 'Shuffle',
    'btn.deletePlaylist': 'Delete playlist',
    'btn.choose': 'Choose…',
    'btn.signIn': 'Sign in…',
    'btn.signOut': 'Sign out',
    'btn.signingIn': 'Waiting…',
    'btn.checkUpdate': 'Check now',
    'btn.checking': 'Checking…',
    'btn.openLogs': 'Open folder',
    'btn.cancel': 'Cancel',
    'btn.confirm': 'Confirm',
    'btn.delete': 'Delete',
    'select.enter': 'Select',
    'select.count': 'Selected: {n}',
    'library.count.split': '{local} local, {network} network {tracks}',
    'select.all': 'Select all',
    'select.downloadFromHost': 'Download from Host',
    'lanDownload.progress': 'Downloading from host…',
    'lanDownload.summary': '{done} downloaded · {failed} failed ({total} total)',
    'modal.deleteTracks.title': 'Delete selected tracks?',
    'modal.deleteTracks.text': '{count} will be removed from the library and the files moved to the trash.',
    'btn.create': 'Create',
    'btn.close': 'Close',
    'btn.save': 'Save',
    'btn.minimize': 'Minimize',
    'btn.album': 'Album',
    'btn.single': 'Single',
    'artist.albums': 'Albums',
    'artist.singles': 'Singles & EPs',
    'artist.mostPlayed': 'Most played',
    'artist.popularYtm': 'Popular on YT Music',
    'artist.yourLibrary': 'Your library',
    'artist.fetched': 'Fetched',
    'artist.similar': 'Similar artists',
    'artist.inLibrary': 'In library',
    'artist.queue': 'Queue',
    'artist.queued': 'Queued',
    'artist.noPlays': 'No plays logged for this artist yet.',
    'artist.ytmEmpty': 'No results from YouTube Music.',
    'artist.ytmError': 'Couldn’t reach YouTube Music.',
    'btn.favorite': 'Favorite',
    'btn.unfavorite': 'Remove from favorites',
    'btn.favoriteOn': 'Favorited',
    'btn.addToPlaylist': 'Add to playlist',
    'tooltip.favorite': 'Favorite',
    'tooltip.shuffle': 'Shuffle',
    'tooltip.prev': 'Previous',
    'tooltip.playPause': 'Play / Pause',
    'tooltip.next': 'Next',
    'tooltip.repeat': 'Repeat',
    'tooltip.fullscreen': 'Fullscreen',
    'tooltip.volume': 'Volume',
    'tooltip.wip': 'Feature in development',
    'hint.favorites': 'Saved tracks appear here',
    'eyebrow.playlist': 'Playlist',
    'eyebrow.album': 'Album',
    'eyebrow.artist': 'Artist',
    'autoChip.artists': 'List is built automatically from your library',
    'autoChip.albums': 'List is built automatically from your library',
    'np.empty.title': 'Nothing selected',
    'np.empty.artist': '—',
    'fs.nowPlayingFrom': 'Now playing · from',
    'fs.fromLibrary': 'Library',
    'fs.nowPlaying': 'Now playing',
    'fs.queue': 'Queue',
    'fs.queueAhead': '{n} ahead',
    'fs.lyrics': 'Lyrics',
    'fs.lyricsLoading': 'Loading lyrics…',
    'fs.lyricsNone': 'No lyrics found',
    'downloads.tab.parsing': 'Parsing',
    'downloads.title': 'Download from the internet',
    'downloads.subtitle': 'The ability to save tracks by direct link will appear here. Section in development.',
    'downloads.parsing.title': 'Parsing',
    'downloads.parsing.subtitle': 'The ability to collect tracks by parsing pages will appear here. Section in development.',
    'downloads.yt.action.download': 'Download',
    'downloads.yt.action.downloading': 'Downloading…',
    'downloads.yt.action.done': 'Done',
    'downloads.yt.action.retry': 'Retry',
    'downloads.yt.downloadError': 'Failed: {e}',
    'downloads.yt.downloadOk': 'Downloaded and added to library: {t}',
    'downloads.yt.tagNote': 'After downloading, you may need to manually fix the MP3 tags (title, artist, cover) via the track context menu.',
    'downloads.parsing.start': 'Parse',
    'downloads.parsing.col.artist': 'Artist',
    'downloads.parsing.col.title': 'Title',
    'downloads.parsing.col.duration': 'Dur.',
    'downloads.parsing.subtab.ytmusic': 'YouTube Music',
    'downloads.ytm.urlPlaceholder': 'https://music.youtube.com/playlist?list=…',
    'downloads.warnPlainYoutube': '⚠ This is a youtube.com link. Use the music.youtube.com version for higher-quality (Premium 256 kbps) audio — open it in YouTube Music and copy that link.',
    'downloads.ytm.hint': 'Link to an album, single, or artist on YouTube Music. No login or browser needed.',
    'downloads.ytm.idle.title': 'YouTube Music parsing',
    'downloads.ytm.idle.text': 'Paste a link to an album, single, or artist page from YouTube Music. The app will collect the track list and you can download any of them in one click.',
    'downloads.parsing.subtab.spotify': 'Spotify',
    'downloads.sp.urlPlaceholder': 'https://open.spotify.com/playlist/…',
    'downloads.sp.hint': 'Link to a playlist, album, or artist on Spotify. The parser runs in the background.',
    'downloads.sp.idle.title': 'Spotify parsing',
    'downloads.sp.idle.text': 'Paste a playlist or album link from Spotify. The app will open a browser, collect the track list, and let you download any of them in one click.',
    'downloads.parsing.starting': 'Starting parser…',
    'downloads.parsing.done': 'Done — {n} tracks collected',
    'downloads.parsing.error': 'Parsing error: {e}',
    'settings.title': 'Settings',
    'settings.subtitle': 'Appearance, music sources, and app behavior.',
    'section.appearance': 'Appearance',
    'section.background': 'Background',
    'setting.bgSource': 'Background image',
    'setting.bgSourceDesc': 'Your own picture, or the current track artwork, behind the interface.',
    'bg.none': 'None',
    'bg.image': 'Image',
    'bg.cover': 'Artwork',
    'setting.bgFile': 'File',
    'setting.bgFileDesc': 'Copied into the app, so you can move the original afterwards.',
    'bg.noFile': 'No file chosen',
    'bg.clear': 'Remove',
    'setting.bgFit': 'Fit',
    'bg.fit.cover': 'Fill',
    'bg.fit.contain': 'Whole',
    'bg.fit.center': 'Centre',
    'bg.fit.tile': 'Tile',
    'setting.bgBlur': 'Blur',
    'setting.bgDim': 'Dim',
    'setting.bgDimDesc': 'The higher it is, the more readable text stays over the picture.',
    'setting.surfaceAlpha': 'Panel opacity',
    'setting.surfaceAlphaDesc': 'How much of the background shows through the sidebar and player bar.',
    'section.music': 'Music',
    'section.library': 'Library',
    'section.playback': 'Playback',
    'section.equalizer': 'Equalizer',
    'section.integrations': 'Integrations',
    'setting.eqEnable': 'Equalizer',
    'setting.eqEnableDesc': 'Shape the sound with a graphic equalizer. Pick a preset or drag the bands. Applies to everything you play.',
    'setting.eqPreset': 'Preset',
    'section.downloads': 'Download from the internet',
    'section.sidebar': 'Sidebar',
    'section.language': 'Language',
    'section.about': 'About',
    'section.contacts': 'Contacts',
    'setting.github': 'GitHub',
    'setting.githubDesc': 'Project source code on GitHub.',
    'setting.telegram': 'Telegram',
    'setting.telegramDesc': 'Found a bug or have a suggestion — write on Telegram.',
    'theme.dark': 'Dark (Rosé Pine)',
    'theme.light': 'Light (Rosé Pine Dawn)',
    'theme.system': 'Default',
    'setting.theme': 'Theme',
    'setting.themeDesc': 'Application color scheme.',
    'toast.saveFailed': "Couldn't save your changes to disk — they may be lost when the app closes.",
    'setting.randomTheme': 'Random theme',
    'setting.randomThemeDesc': 'Pick a random palette every time the app starts.',
    'setting.accent': 'Accent color',
    'setting.accentDesc': 'Highlights active items and the currently playing track.',
    'setting.accentDefault': 'Default',
    'setting.accentCustom': 'Custom color',
    'setting.serviceColors': 'Network services',
    'setting.serviceColorsDesc': 'Predefined accent colors identify data sources across the app.',
    'service.ytm': 'YouTube Music',
    'service.ytmDesc': 'Browse, popularity charts, parsing & downloads (Red)',
    'service.lastfm': 'Last.fm',
    'service.lastfmDesc': 'Scrobbling, genre tags, corrections & similar artists (Purple)',
    'service.musicbrainz': 'MusicBrainz',
    'service.musicbrainzDesc': 'Track metadata lookup & release matches (Blue)',
    'setting.defaultFolder': 'Default folder',
    'setting.defaultFolderDesc': 'Where to load tracks from on startup.',
    'setting.defaultView': 'Default page',
    'setting.defaultViewDesc': 'Which page opens when the app starts.',
    'setting.defaultViewPlaylist': 'Custom playlist…',
    'setting.defaultPlaylist': 'Playlist',
    'setting.uiScale': 'Interface scale',
    'setting.uiScaleDesc': 'Makes the entire UI larger or smaller. Applies instantly.',
    'setting.uiScaleReset': 'Reset',
    'setting.scanSubdirs': 'Scan subfolders',
    'setting.scanSubdirsDesc': 'Include nested directories during indexing.',
    'setting.artistMinTracks': 'Hide small artists',
    'setting.artistMinTracksDesc': 'Leave out artists with only a track or two in the Artists view — usually a stray feature credit rather than someone worth a whole entry.',
    'setting.artistMinTracksN': 'Minimum tracks',
    'setting.healthCheck': 'Quality check (Health-check)',
    'setting.healthCheckDesc': 'The “Library health” section and the “Quality” column in track lists. When off, the column and section are hidden entirely.',
    'setting.reports': 'Listening report',
    'setting.reportsDesc': 'The “Report” section with listening statistics. Stats are always collected, even while the section is hidden.',
    'setting.crossfadeLen': 'Crossfade length',
    'setting.volWheelStep': 'Volume scroll step',
    'setting.volWheelStepDesc': 'How much each mouse-wheel notch changes the volume while hovering the slider.',
    'unit.sec': 's',
    'setting.crossfade': 'Crossfade between tracks',
    'setting.crossfadeDesc': 'Tracks blend into each other: the current one fades out while the next fades in. Applies both at the end of a track and when switching manually.',
    'setting.repeatOneReset': 'Reset "repeat one" on skip',
    'setting.repeatOneResetDesc': 'Manually skipping to the next or previous track while "repeat one" is on switches it to "repeat" instead of looping the new track too.',
    'setting.showDownloads': 'Show the “Downloads” tab',
    'setting.showDownloadsDesc': 'Adds a section to the sidebar for downloading tracks by URL.',
    'setting.showDevices': 'Show the “Devices” tab',
    'setting.showDevicesDesc': 'Lets this app be found and controlled by your other devices on the same LAN or Tailscale network. Opens a local network port; off by default.',
    'setting.showParserBrowser': 'Show the browser window while parsing',
    'setting.showParserBrowserDesc': 'Useful for signing in to Spotify on the first run, solving a captcha, or seeing where the parser got stuck. Turn off to run the browser silently in the background.',
    'setting.ytLogin': 'Sign in to YouTube',
    'setting.ytLoginDesc': 'Fixes "Sign in to confirm you\'re not a bot" download errors. Opens a browser window — sign in, then close it.',
    'setting.ytLogin.signedIn': 'Signed in',
    'setting.ytLogin.notSignedIn': 'Not signed in',
    'setting.ytLogin.waiting': 'Waiting for the browser window to close…',
    'setting.ytPremium.checking': 'Checking Premium…',
    'setting.ytPremium.active': 'YouTube Premium · 256 kbps',
    'setting.ytPremium.none': 'No Premium · up to 160 kbps',
    'setting.ytPremium.unknown': 'Premium status unknown',
    'setting.dlFormat': 'Download format',
    'setting.dlFormatDesc': 'Files are saved as {default folder}/{artist}/{album}/{artist} - {track}. Opus gives the best quality per megabyte; pick M4A if a device of yours cannot play it.',
    'downloads.noFolder': 'Pick a default folder first — downloads are filed into it by artist and album.',
    'section.system': 'System',
    'section.hotkeys': 'Hotkeys',
    'hotkeys.intro': 'Click a shortcut, then press a key or a mouse button. Esc cancels, Backspace clears it.',
    'hotkeys.globalNote': 'The monitor icon makes a shortcut work while the window is minimised. It needs a modifier (Ctrl, Alt or Shift); mouse buttons cannot do this.',
    'hotkeys.escNote': 'Esc always closes the topmost window and cannot be rebound.',
    'hotkeys.resetAll': 'Reset all',
    'hotkeys.press': 'Press keys…',
    'hotkeys.revert': 'Restore default',
    'hotkeys.global': 'Works while the window is minimised (system-wide)',
    'hotkeys.globalNeedsMod': 'A global shortcut needs a modifier: Ctrl, Alt or Shift',
    'hotkeys.globalNoMouse': 'Mouse buttons cannot work globally',
    'hotkeys.globalUnsupported': 'This key cannot be registered globally',
    'hotkeys.globalFailed': 'Combo already taken by another application',
    'hotkeys.globalUnavailable': 'Global shortcuts are unavailable on a Wayland session. Use the media keys — they work through MPRIS.',
    'mouse.middle': 'Middle click',
    'mouse.back': 'Mouse Back',
    'mouse.forward': 'Mouse Fwd',
    'mouse.other': 'Mouse {n}',
    'hotkey.playPause': 'Play / pause',
    'hotkey.nextTrack': 'Next track',
    'hotkey.prevTrack': 'Previous track',
    'hotkey.seekForward': 'Seek forward 5 s',
    'hotkey.seekBackward': 'Seek back 5 s',
    'hotkey.volumeUp': 'Volume up',
    'hotkey.volumeDown': 'Volume down',
    'hotkey.mute': 'Mute',
    'hotkey.favorite': 'Add to favorites',
    'hotkey.shuffle': 'Shuffle',
    'hotkey.repeat': 'Repeat mode',
    'hotkey.fullscreen': 'Fullscreen player',
    'hotkey.palette': 'Command palette',
    'hotkey.editTags': 'Edit tags',
    'hotkey.settings': 'Open settings',
    'setting.hardwareAcceleration': 'Hardware acceleration',
    'setting.hardwareAccelerationDesc': 'Uses the GPU to render the interface. If the app hangs on launch or shows graphical glitches, turn this off. Takes effect after a restart.',
    'setting.uiLanguage': 'Interface language',
    'setting.uiLanguageDesc': 'Applied immediately.',
    'setting.version': 'Version',
    'setting.checkUpdate': 'Check for updates',
    'setting.checkUpdateDesc': 'Looks for a newer build on GitHub right now.',
    'setting.openLogs': 'Logs',
    'setting.openLogsDesc': 'Opens the folder with error logs, for troubleshooting a failed update.',
    'update.checkFailed': 'Could not check for updates.',
    'update.upToDate': 'You\'re on the latest version ({v}).',
    'badge.wip': 'in development',
    'placeholder.noFolder': '— not selected —',
    'placeholder.noPlaylists': 'No playlists yet',
    'placeholder.choosePlaylist': 'Choose a playlist…',
    'modal.deleteTrack.title': 'Delete track?',
    'modal.deleteTrack.text': 'The track will be removed from the library and the file moved to the trash.',
    'modal.deleteTrackFull.text': '“{title}” by {artist} will be removed from the library and the file moved to the trash.',
    'modal.deletePlaylist.title': 'Delete playlist?',
    'modal.deletePlaylist.text': 'Playlist “{name}” will be deleted. Tracks remain in the library.',
    'modal.deleteAlbum.title': 'Delete album?',
    'modal.deleteAlbum.text': '“{name}” ({count}) will be removed from the library and the files moved to the trash.',
    'modal.deleteArtist.title': 'Delete artist?',
    'modal.deleteArtist.text': 'Every track by “{name}” ({count}) will be removed from the library and the files moved to the trash.',
    'modal.clearLibrary.title': 'Clear the whole library?',
    'modal.clearLibrary.text': 'All tracks will be removed from Audex. The files themselves are not touched.',
    'modal.newPlaylist.title': 'New playlist',
    'modal.newPlaylist.namePh': 'Playlist name',
    'modal.newPlaylist.descPh': 'Description (optional)',
    'modal.editPlaylist.title': 'Edit playlist',
    'modal.editPlaylist.avatarChoose': 'Choose image',
    'modal.editPlaylist.avatarRemove': 'Remove cover',
    'cm.plEdit': 'Edit playlist…',
    'splash.loading': 'Loading interface',
    'splash.covers': 'Loading covers',
    'splash.caching': 'Caching covers {n} / {total}',
    'splash.scanning': 'Scanning library',
    'cm.plDelete': 'Delete playlist',
    'modal.addToPlaylist.title': 'Add to playlist',
    'modal.addToPlaylist.empty': 'Create a playlist on the “Playlists” tab first.',
    'modal.addToPlaylist.alreadyAdded': 'already added',
    'editor.title': 'Edit tags',
    'editor.cover': 'Cover',
    'editor.field.title': 'Title',
    'editor.field.artist': 'Artist',
    'editor.field.album': 'Album',
    'editor.field.albumArtist': 'Album artist',
    'editor.field.year': 'Year',
    'editor.field.genre': 'Genre',
    'editor.field.trackNo': 'Track №',
    'editor.field.discNo': 'Disc №',
    'editor.field.comment': 'Comment',
    'editor.commentPh': 'Note about the track…',
    'editor.coverEmbed': 'Embedded cover',
    'editor.coverNew': 'New cover',
    'editor.setCover': 'Set from file…',
    'editor.noCover': 'No cover',
    'editor.saving': 'Saving…',
    'cm.applySelectedCover': 'Apply selected cover',
    'cm.applyCoverFromFile': 'Apply cover from local file',
    'cm.setGenre': 'Set genre tags',
    'fixMenu.cover': 'Cover Image',
    'fixMenu.metadata': 'Bulk metadata',
    'genre.prompt': 'Set the genre for every selected track:',
    'genre.progress': 'Updating genres…',
    'editor.musicbrainz': 'MusicBrainz',
    'editor.musicbrainzHint': 'Look up track metadata on MusicBrainz',
    'editor.mbSearching': 'Searching MusicBrainz…',
    'editor.mbNoMatch': 'No matches found on MusicBrainz',
    'editor.mbChoose': 'MusicBrainz matches (click to apply):',
    'editor.mbApplied': 'Applied MusicBrainz metadata — review and save',
    'editor.lastfm': 'Last.fm',
    'editor.lastfmHint': 'Fetch name corrections and genre tags from Last.fm',
    'editor.lastfmNeedKey': 'Add a Last.fm API key in Settings first',
    'editor.lastfmFetching': 'Asking Last.fm…',
    'editor.lastfmCorrected': 'Applied Last.fm correction — review and save',
    'editor.lastfmTags': 'Tap a genre to use it',
    'editor.lastfmNothing': 'Last.fm had nothing to add',
    'cm.useAsAlbumCover': 'Use as album cover',
    'cm.setCoverFromFile': 'Set cover from file…',
    'cm.applyCoverToAlbum': 'Apply cover to album…',
    'cm.mbRelease': 'Match release on MusicBrainz…',
    'mbRelease.title': 'MusicBrainz Release Matches',
    'mbRelease.progress': 'Applying MusicBrainz metadata…',
    'mbRelease.applied': 'Updated {count} tracks from MusicBrainz',
    'editor.mbManualPrompt': 'Search MusicBrainz (title, artist, etc.):',
    'mbRelease.manualPrompt': 'Search MusicBrainz Release (album, artist, etc.):',
    'fs.lyricsSearchManual': 'Search lyrics manually…',
    'cm.fixYear': 'Set release year',
    'cm.fixTrackNumbers': 'Fix track numbers',
    'cm.deleteAlbum': 'Delete album…',
    'cm.deleteArtist': 'Delete artist…',
    'btn.albumMenuTooltip': 'Fix tags, cover, release year & track numbers…',
    'albumCover.needSource': 'Right-click a track with the correct cover and choose "Use as album cover" first.',
    'albumCover.badSource': "This track has no cover art loaded — scroll it into view (or open it) so its art loads, then try again.",
    'albumCover.confirm': 'Apply the cover from "{track}" to the other {count} track(s) in this album?',
    'albumCover.progress': 'Updating album covers…',
    'coverFile.progress': 'Setting cover…',
    'coverFile.confirm': 'Set this image as the cover for all {count} tracks?',
    'coverFile.error': 'Could not read that image: {e}',
    'albumCover.summary': '{updated} updated · {failed} failed ({total} total)',
    'albumYear.prompt': 'Set the release year for every track in this album:',
    'albumYear.progress': 'Updating release years…',
    'albumYear.summary': '{updated} updated · {failed} failed ({total} total)',
    'albumTrackNo.pickTitle': 'Click tracks in listening order — first click is track 1',
    'albumTrackNo.writeFailed': 'Could not update the track number.',
    'editor.lockedWhilePlaying': 'Cannot edit tags while this track is playing',
    'editor.saved': 'Saved ✓',
    'editor.errorSave': 'Save error',
    'cm.play': 'Play',
    'cm.addToPlaylist': 'Add to playlist',
    'cm.removeFromPlaylist': 'Remove from playlist',
    'cm.reveal': 'Show in folder',
    'cm.editTags': 'Edit tags…',
    'cm.delete': 'Remove from library',
    'palette.placeholder': 'Search tracks, albums, actions…',
    'palette.nav': '↑↓ navigate',
    'palette.choose': '↵ select',
    'palette.close': 'ESC close',
    'palette.tracks': 'Tracks',
    'palette.group.general': 'General',
    'palette.group.nav': 'Navigation',
    'palette.group.music': 'Music',
    'palette.itemHint': '↵ play',
    'palette.empty': 'Nothing found',
    'palette.action.openFiles': 'Open files…',
    'palette.action.gotoSettings': 'Go to Settings',
    'palette.action.gotoLibrary': 'Go to Library',
    'palette.action.gotoDownloads': 'Go to Downloads',
    'palette.action.gotoYtMusic': 'Go to YouTube Music',
    'palette.action.gotoArtists': 'Go to Artists',
    'palette.action.gotoAlbums': 'Go to Albums',
    'palette.action.gotoDevices': 'Go to Devices',
    'palette.action.gotoReport': 'Go to Stats',
    'palette.action.gotoHealth': 'Go to Health',
    'palette.action.gotoPlaylists': 'Go to Playlists',
    'palette.action.gotoFavorites': 'Go to Favorites',
    'palette.action.clearLibrary': 'Clear library…',
    'palette.action.volumeUp': 'Volume up',
    'palette.action.volumeDown': 'Volume down',
    'palette.action.reloadApp': 'Refresh the app',
    'label.unknownArtist': 'Unknown artist',
    'label.noAlbum': 'No album',
    'label.tracksShort': 'tr.',
    'error.deleteFile': 'Could not delete file from disk: ',
    'error.unknown': 'unknown error',
    'library.ghostsRemoved': '{count} track(s) no longer found on disk — removed from your library.',
    'library.purgedOnError': '{count} track(s) removed from your library — couldn\'t be read or written (missing or damaged file).',
    'downloads.tab.queue': 'Queue',
    'downloads.queue.add': 'Queue',
    'downloads.queue.queued': 'Queued',
    'downloads.queue.addAll': 'Queue all tracks',
    'downloads.queue.remove': 'Remove from queue',
    'downloads.queue.clearDone': 'Clear finished',
    'downloads.queue.clearAll': 'Clear all',
    'downloads.queue.empty.title': 'Queue is empty',
    'downloads.queue.empty.text': 'Add tracks from the Parsing tab and they will be downloaded one after another.',
    'downloads.queue.status.queued': 'Waiting',
    'downloads.queue.status.downloading': 'Downloading',
    'downloads.queue.status.done': 'Done',
    'downloads.queue.status.error': 'Failed',
    'downloads.queue.stats.downloading': 'downloading: {n}',
    'downloads.queue.stats.queued': 'queued: {n}',
    'downloads.queue.stats.done': 'done: {n}',
    'downloads.queue.stats.error': 'errors: {n}',
    'downloads.queue.stats.paused': 'paused',
    'downloads.queue.pause': 'Pause',
    'downloads.queue.resume': 'Resume',
  },
  uk: {
    'nav.devices': "Пристрої",
    'lan.thisDevice': "Цей пристрій",
    'lan.namePh': "Назва пристрою",
    'lan.keyPh': "Мережевий ключ",
    'lan.generate': "Згенерувати",
    'lan.enable': "Увімкнути доступ",
    'lan.disable': "Вимкнути доступ",
    'lan.needKey': "Спочатку задайте мережевий ключ — він має бути однаковий на всіх ваших пристроях.",
    'lan.hint': "Виберіть тут мережевий ключ — він працює як пароль Wi-Fi: одне одного бачать лише пристрої з точно однаковим ключем. Увімкніть доступ, і бібліотека цього пристрою стане доступною решті групи.",
    'lan.hintPeers': "Пристрої в тій самій локальній мережі з тим самим ключем з'являються тут самі — нічого додавати не треба. В іншій мережі (наприклад, через Tailscale) додайте адресу вручну вище. Якщо в Windows ручне додавання зависає — правило фаєрвола, ймовірно, дозволяє лише приватні мережі, а адаптер Tailscale Windows визначає як публічний: дозвольте застосунок і для нього.",
    'lan.on': "Доступ увімкнено",
    'lan.off': "Доступ вимкнено",
    'lan.starting': "Запуск…",
    'lan.error': "Помилка",
    'lan.peers': "Інші пристрої",
    'lan.noPeers': "Пристроїв поки не знайдено.",
    'lan.manual': "додано вручну",
    'lan.connect': "Підключитися до пристрою",
    'lan.networkBadge': "МЕРЕЖА",
    'lan.networkFrom': "З {device}",
    'lan.syncSettings': "Синхронізувати налаштування",
    'lan.syncSettingsHint': "Перейняти налаштування застосунку цього пристрою (тема, мова, формат завантаження тощо)",
    'lan.syncSettingsConfirm': "Замінити ваші налаштування на налаштування {device}? Бібліотеку й файли це не торкнеться.",
    'lan.syncSettingsNone': "Цей пристрій ще не поділився налаштуваннями.",
    'lan.takeOver': "Перехопити",
    'lan.takeOverHint': "Перехопити поточний сеанс цього пристрою сюди, з того самого місця",
    'lan.push': 'Надіслати сюди',
    'lan.pushHint': "Надіслати те, що зараз грає тут, на цей пристрій",
    'lan.remove': "Прибрати",
    'lan.add': "Додати",
    'lan.addPh': "Адреса, напр. 100.90.1.2 або 192.168.1.5:8422",
    'lan.nothingPlaying': "Цей пристрій нічого не відтворює.",
    'lan.errKey': "Невірний мережевий ключ",
    'lan.errReach': "Не вдається зʼєднатися з пристроєм:",
    'nav.library': 'Бібліотека',
    'update.available': 'Доступне оновлення',
    'update.download': 'Завантажити',
    'update.downloading': 'Завантаження… {pct}%',
    'update.restart': 'Перезапустити для встановлення',
    'update.failed': 'Не вдалося завантажити — відкриваємо сторінку релізу',
    'update.dismiss': 'Закрити',
    'import.progress': 'Імпортуємо треки…',
    'nav.albums': 'Альбоми',
    'nav.artists': 'Виконавці',
    'nav.playlists': 'Плейлисти',
    'nav.favorites': 'Улюблене',
    'nav.downloads': 'Завантаження',
    'nav.ytmusic': 'YouTube Music',
    'ytm.sub': 'Знайдіть виконавця, а потім додайте його альбоми чи сингли в чергу завантажень.',
    'ytm.searchPh': 'Пошук виконавців на YouTube Music…',
    'ytm.results': 'Результати для «{q}»',
    'ytm.searching': 'Шукаємо…',
    'ytm.searchFailed': 'Не вдалося виконати пошук',
    'ytm.noArtists': 'Виконавців не знайдено',
    'ytm.releases': 'Альбоми та сингли',
    'ytm.loadingReleases': 'Завантажуємо релізи…',
    'ytm.releasesFailed': 'Не вдалося завантажити релізи',
    'ytm.noReleases': 'Релізів не знайдено',
    'ytm.albums': 'Альбоми',
    'ytm.singles': 'Сингли та EP',
    'ytm.loading': 'Завантаження…',
    'ytm.loadingName': 'Завантажуємо {name}…',
    'ytm.loadingTracks': 'Завантажуємо треки…',
    'ytm.albumFailed': 'Не вдалося завантажити альбом',
    'ytm.adding': 'Додаємо…',
    'ytm.addingName': 'Додаємо {name}…',
    'ytm.added': 'Додано {count}',
    'ytm.addedFrom': 'Додано {count} з {name}',
    'ytm.addedOne': 'Додано в чергу',
    'ytm.already': 'Уже в черзі',
    'ytm.addAll': 'Додати всі в чергу',
    'ytm.addOne': 'Додати в чергу',
    'ytm.back': 'Назад',
    'ytm.browseArtist': 'Переглянути цього виконавця на YouTube Music',
    'nav.editor': 'Редактор',
    'cm.trim': 'Обрізати трек…',
    'setting.editor': 'Редактор (обрізання треків)',
    'setting.editorDesc': 'Розділ «Редактор» для обрізання треків: обираєте фрагмент на хвилі та зберігаєте його в новий файл.',
    'setting.ytMusic': 'YouTube Music',
    'setting.ytMusicDesc': 'Розділ «YouTube Music» для пошуку виконавців і додавання їхніх альбомів чи синглів у чергу завантажень.',
    'editor.pick': 'Вибрати трек',
    'editor.pickSearch': 'Пошук за назвою або виконавцем',
    'editor.pickEmpty': 'Нічого не знайдено',
    'editor.empty.title': 'Обрізання треків',
    'editor.empty.text': 'Виберіть трек, позначте початок і кінець фрагмента на хвилі та збережіть його окремим файлом. Оригінал лишається недоторканим, якщо не увімкнути перезапис.',
    'editor.start': 'Початок',
    'editor.end': 'Кінець',
    'editor.selection': 'Тривалість фрагмента',
    'editor.preview': 'Прослухати фрагмент',
    'editor.previewStop': 'Зупинити',
    'editor.reset': 'Скинути',
    'editor.fadeIn': 'Наростання, с',
    'editor.fadeOut': 'Затухання, с',
    'editor.gain': 'Гучність, дБ',
    'editor.gainHint': 'Мінус — тихіше, плюс — гучніше. 0 дБ — без змін.',
    'editor.gainClip': 'Пік перевищить 0 дБ на {d} дБ — можливі спотворення',
    'editor.overwrite': 'Перезаписати оригінал',
    'editor.overwriteDesc': 'Типово поруч створюється новий файл «— (trimmed)». Увімкніть, щоб замінити вихідний файл.',
    'editor.save': 'Обрізати та зберегти',
    'editor.decoding': 'Читаємо аудіо…',
    'editor.decodeError': 'Не вдалося прочитати аудіо',
    'editor.trimming': 'Обрізаємо…',
    'editor.trimSaved': 'Збережено: {f}',
    'editor.saveError': 'Помилка обрізання: {e}',
    'editor.tooShort': 'Фрагмент занадто короткий',
    'nav.search': 'Пошук',
    'nav.recents': 'Нещодавнє',
    'nav.tools': 'Інструменти',
    'nav.openFiles': 'Відкрити файли',
    'nav.settings': 'Налаштування',
    'dlErr.geo': 'Цей трек заблоковано для вашої країни, і заміни не знайдено.',
    'dlErr.unavailable': 'Відео видалено або недоступне, заміни не знайдено.',
    'dlErr.signin': 'YouTube вимагає вхід в акаунт для цього треку. Увійдіть у Налаштування → Завантаження.',
    'dlErr.members': 'Трек доступний лише підписникам каналу.',
    'dlErr.network': 'Немає зв’язку з YouTube. Перевірте підключення.',
    'dlErr.transient': 'YouTube дало збій посеред завантаження — зазвичай допомагає повторна спроба.',
    'nav.report': 'Звіт',
    'report.onDevice': 'Обчислюється на пристрої',
    'report.eyebrow': 'Звіт про прослуховування',
    'report.period.day': 'День',
    'report.period.week': 'Тиждень',
    'report.period.month': 'Місяць',
    'report.period.year': 'Рік',
    'report.period.all': 'Увесь час',
    'report.allTime': 'За увесь час',
    'report.today': 'Сьогодні',
    'report.thisWeek': 'Цей тиждень',
    'report.listeningTime': 'Час прослуховування',
    'report.vsPrev': 'до минулого періоду',
    'report.tracksPlayed': 'Треків зіграно',
    'report.artists': 'Виконавців',
    'report.added': 'Додано до колекції',
    'report.streak': 'Серія прослуховувань',
    'report.days': 'днів',
    'report.whenListen': 'Коли ти слухаєш',
    'report.topArtists': 'Топ-виконавці',
    'report.topTracks': 'Топ-треки',
    'report.plays': 'просл.',
    'report.minUnit': 'хв',
    'report.hoursUnit': 'годин',
    'report.hShort': 'г',
    'report.mShort': 'хв',
    'report.empty.title': 'Тут зʼявиться твоя статистика',
    'report.empty.text': 'Слухай музику — звіт збереться з історії прослуховування на цьому пристрої.',
    'table.quality': 'Якість',
    'quality.kbps': 'кбіт/с',
    'quality.note': 'Бейдж якості на кожному треку · ',
    'quality.noteAmber': 'бурштиновий = підозра на перекодування',
    'quality.cutoffMarker': 'зріз',
    'health.khz': 'кГц',
    'nav.health': 'Стан',
    'health.crumb': 'Стан бібліотеки',
    'health.lastScan': 'Остання перевірка:',
    'health.never': 'ще не перевірялося',
    'health.rescan': 'Пересканувати',
    'health.scanning': 'Перевірка {n} з {m}…',
    'health.scoreLabel': "Здоров'я колекції",
    'health.ok': 'у порядку',
    'health.okLegend': 'у порядку',
    'health.flaggedLegend': 'потребують уваги',
    'health.transcodeTitle': 'Схоже на перекодування',
    'health.claimed': 'Заявлено',
    'health.real': 'реально ≈',
    'health.spectrumCaption': 'Спектр обривається на {cut} кГц, хоча високий бітрейт тримає частоти до ~20 кГц.{lame}',
    'health.noLame': ' LAME-тег відсутній.',
    'health.issuesLabel': 'Знайдені проблеми',
    'health.show': 'Показати',
    'health.fix': 'Виправити',
    'health.allGood': 'Проблем не знайдено',
    'health.allGoodText': 'Колекція у чудовому стані.',
    'health.noData': 'Запусти перевірку, щоб оцінити стан бібліотеки.',
    'health.analyzing': 'Аналіз спектра…',
    'health.filterNote': 'Фільтр стану: {label}',
    'health.clearFilter': 'Скинути',
    'issue.transcode.title': 'Підозра на перекодування',
    'issue.transcode.desc': 'Бітрейт заявлено високим, але спектр обривається рано — імовірно, перекодовано з низької якості.',
    'issue.lowbitrate.title': 'Низький бітрейт (< 192 кбіт/с)',
    'issue.lowbitrate.desc': 'Файли 192 кбіт/с і нижче. Можна замінити на кращі версії.',
    'issue.nocover.title': 'Без обкладинки',
    'issue.nocover.desc': 'Треки без вбудованого зображення альбому.',
    'issue.tags.title': 'Неповні теги',
    'issue.tags.desc': 'Порожні поля виконавця, альбому, року або загальний жанр "Music".',
    'issue.notrackno.title': 'Немає номера треку',
    'issue.notrackno.desc': 'Треки без тегу номера треку — через це порядок в альбомі збивається.',
    'issue.dupes.title': 'Можливі дублікати',
    'issue.dupes.desc': 'Збігаються виконавець і назва за різних файлів.',
    'section.discord': 'Discord Rich Presence',
    'discord.subtitle': 'Показуйте друзям, що ви слухаєте, прямо в профілі Discord — з обкладинкою, таймером і кнопками для переходу до треку.',
    'discord.statusConnected': 'Підключено',
    'discord.statusDisconnected': 'Не підключено',
    'discord.connect': 'Підключити Discord',
    'discord.disconnect': 'Відключити',
    'discord.connectHint': "Прив'яжіть акаунт, щоб транслювати прослуховування у профіль.",
    'discord.sessionActive': 'сесія активна',
    'discord.connecting': 'Підключення…',
    'discord.connectError': 'Не вдалося підключитися. Переконайтеся, що Discord запущено.',
    'discord.waitingForDiscord': 'Discord не запущено — підключуся автоматично, коли він відкриється.',
    'discord.noClientId': 'Не задано Discord Client ID. Вкажіть його в DISCORD_CLIENT_ID у renderer.js.',
    'discord.show': 'Що показувати',
    'discord.showTitle': 'Назва треку',
    'discord.showTitleDesc': 'Основний рядок активності.',
    'discord.showArtist': 'Виконавець та альбом',
    'discord.showArtistDesc': 'Другий рядок під назвою.',
    'discord.showCover': 'Обкладинка альбому',
    'discord.showCoverDesc': 'Велике зображення картки.',
    'discord.showTimer': 'Таймер треку',
    'discord.showTimerDesc': 'Минулий і загальний час із прогресом.',
    'discord.showPaused': 'Показувати на паузі',
    'discord.showPausedDesc': 'Залишати статус, коли відтворення зупинено.',
    'discord.buttons': 'Кнопки у профілі',
    'discord.buttonsHint': 'Discord дозволяє не більше двох кнопок в активності. Посилання мають починатися з http(s)://',
    'discord.btnLabel': 'Підпис',
    'discord.btnUrl': 'Посилання',
    'discord.btnLabelPh': 'Текст кнопки',
    'discord.btnUrlPh': 'https://…',
    'discord.privacy': 'Приватність',
    'discord.privacyInvisible': 'Приховувати в режимі «Невидимий»',
    'discord.privacyInvisibleDesc': 'Не транслювати статус, коли ви офлайн у Discord.',
    'discord.privacyPrivate': 'Вимикати для приватних плейлистів',
    'discord.privacyPrivateDesc': 'Треки із закритих плейлистів не потраплять у профіль.',
    'discord.preview': 'Як бачать друзі',
    'discord.previewListening': 'Слухає Audex',
    'discord.previewPaused': 'Слухав · на паузі',
    'discord.previewPlaceholder': 'Статус з’явиться у профілі після підключення Discord',
    'discord.previewNote': 'Картка оновлюється в реальному часі при зміні треку, паузі та перемотуванні.',
    'discord.previewOnline': 'У мережі',
    'discord.previewEmptyTrack': 'Нічого не грає',
    'section.lastfm': 'Last.fm',
    'lastfm.subtitle': 'Скроблінг прослуханого, синхронізація улюблених та жанри, виправлення й схожі виконавці.',
    'lastfm.apiKey': 'API-ключ',
    'lastfm.secret': 'Спільний секрет',
    'lastfm.keyHint': 'Створіть API-акаунт на last.fm/api — безкоштовно, за хвилину. Вставте ключ і секрет сюди.',
    'lastfm.getKey': 'Отримати API-ключ',
    'lastfm.connect': 'Підключити',
    'lastfm.disconnect': 'Відключити',
    'lastfm.connecting': 'Очікування підтвердження у браузері…',
    'lastfm.connected': 'Підключено',
    'lastfm.notConnected': 'Не підключено',
    'lastfm.connectHint': 'Дозвольте Audex скроблити у ваш акаунт.',
    'lastfm.needKey': 'Спершу введіть API-ключ і секрет.',
    'lastfm.authFailed': 'Час авторизації вичерпано. Підтвердьте доступ у браузері та натисніть «Підключити» ще раз.',
    'lastfm.scrobble': 'Скроблити треки',
    'lastfm.scrobbleDesc': 'Надсилати прослуховування на Last.fm після половини треку або 4 хвилин.',
    'lastfm.nowPlaying': 'Оновлювати «Зараз грає»',
    'lastfm.nowPlayingDesc': 'Показувати поточний трек у вашому профілі в реальному часі.',
    'lastfm.loveSync': 'Синхронізувати улюблені',
    'lastfm.loveSyncDesc': 'Додавання в улюблені в Audex додає трек до улюблених на Last.fm.',
    'lastfm.queued': 'В черзі на надсилання: {n}',
    'lastfm.notInLibrary': 'Немає у вашій бібліотеці',
    'crumb.collection': 'Колекція',
    'search.placeholder': 'Пошук…',
    'search.artistPlaceholder': 'Пошук виконавця…',
    'search.albumPlaceholder': 'Пошук альбому…',
    'search.trackPlaceholder': 'Пошук треку…',
    'filter.all': 'Усі',
    'filter.recent': 'Нещодавно додані',
    'filter.favorites': 'Тільки улюблене',
    'sort.label': 'Сортування:',
    'sort.dateDesc': 'Дата додавання ↓',
    'sort.dateAsc': 'Дата додавання ↑',
    'sort.titleAsc': 'Назва А→Я',
    'sort.titleDesc': 'Назва Я→А',
    'sort.artistAsc': 'Виконавець А→Я',
    'sort.artistDesc': 'Виконавець Я→А',
    'sort.durationAsc': 'Тривалість ↑',
    'sort.durationDesc': 'Тривалість ↓',
    'sort.alpha': 'За алфавітом',
    'sort.byTracks': 'За кількістю треків',
    'sort.recent': 'Нещодавно додані',
    'sort.yearDesc': 'Спочатку нові',
    'sort.yearAsc': 'Спочатку старі',
    'view.cards': 'Картки',
    'view.list': 'Список',
    'table.title': 'Назва',
    'table.artist': 'Виконавець',
    'table.album': 'Альбом',
    'table.time': 'Час',
    'empty.library.title': 'Бібліотека порожня',
    'empty.library.text': 'Відкрий файли або теку, щоб почати.',
    'empty.playlists.title': 'Плейлистів поки немає',
    'empty.playlists.text': 'Створи свій перший плейлист — збери треки за настроєм, часом доби чи альбомом.',
    'empty.artists.title': 'Виконавців поки немає',
    'empty.artists.text': 'Додай треки до бібліотеки, щоб побачити тут перелік виконавців.',
    'empty.albums.title': 'Альбомів поки немає',
    'empty.albums.text': 'Додай треки до бібліотеки, щоб побачити тут альбоми.',
    'empty.favorites.title': 'Немає улюблених треків',
    'empty.favorites.text': 'Натисни сердечко на будь-якому треку, щоб додати його сюди.',
    'btn.newPlaylist': 'Новий плейлист',
    'btn.playAll': 'Грати все',
    'btn.shuffle': 'Перемішати',
    'btn.deletePlaylist': 'Видалити плейлист',
    'btn.choose': 'Обрати…',
    'btn.signIn': 'Увійти…',
    'btn.signOut': 'Вийти',
    'btn.signingIn': 'Очікування…',
    'btn.checkUpdate': 'Перевірити зараз',
    'btn.checking': 'Перевірка…',
    'btn.openLogs': 'Відкрити папку',
    'btn.cancel': 'Скасувати',
    'btn.confirm': 'Підтвердити',
    'btn.delete': 'Видалити',
    'select.enter': 'Вибрати',
    'select.count': 'Вибрано: {n}',
    'library.count.split': '{local} локальних, {network} мережевих {tracks}',
    'select.all': 'Вибрати всі',
    'select.downloadFromHost': 'Завантажити з хоста',
    'lanDownload.progress': 'Завантаження з хоста…',
    'lanDownload.summary': '{done} завантажено · {failed} не вдалося (усього {total})',
    'modal.deleteTracks.title': 'Видалити вибрані треки?',
    'modal.deleteTracks.text': '{count} буде вилучено з бібліотеки, а файли — переміщено у смітник.',
    'btn.create': 'Створити',
    'btn.close': 'Закрити',
    'btn.save': 'Зберегти',
    'btn.minimize': 'Згорнути',
    'btn.album': 'Альбом',
    'btn.single': 'Сингл',
    'artist.albums': 'Альбоми',
    'artist.singles': 'Сингли та EP',
    'artist.mostPlayed': 'Найпрослуханіші',
    'artist.popularYtm': 'Популярне на YT Music',
    'artist.yourLibrary': 'Ваша бібліотека',
    'artist.fetched': 'Отримано',
    'artist.similar': 'Схожі виконавці',
    'artist.inLibrary': 'У бібліотеці',
    'artist.queue': 'У чергу',
    'artist.queued': 'Додано',
    'artist.noPlays': 'Ще немає прослуховувань цього виконавця.',
    'artist.ytmEmpty': 'Немає результатів з YouTube Music.',
    'artist.ytmError': 'Не вдалося зʼєднатися з YouTube Music.',
    'btn.favorite': 'До улюбленого',
    'btn.unfavorite': 'Прибрати з улюбленого',
    'btn.favoriteOn': 'В улюбленому',
    'btn.addToPlaylist': 'До плейлиста',
    'tooltip.favorite': 'До улюбленого',
    'tooltip.shuffle': 'Випадковий порядок',
    'tooltip.prev': 'Попередній',
    'tooltip.playPause': 'Відтворення/Пауза',
    'tooltip.next': 'Наступний',
    'tooltip.repeat': 'Повтор',
    'tooltip.fullscreen': 'На весь екран',
    'tooltip.volume': 'Звук',
    'tooltip.wip': 'Розділ у розробці',
    'hint.favorites': 'Збережені треки з\'являються тут',
    'eyebrow.playlist': 'Плейлист',
    'eyebrow.album': 'Альбом',
    'eyebrow.artist': 'Виконавець',
    'autoChip.artists': 'Список збирається автоматично з бібліотеки',
    'autoChip.albums': 'Список збирається автоматично з бібліотеки',
    'np.empty.title': 'Не обрано',
    'np.empty.artist': '—',
    'fs.nowPlayingFrom': 'Зараз грає · з',
    'fs.fromLibrary': 'Бібліотеки',
    'fs.nowPlaying': 'Зараз грає',
    'fs.queue': 'Черга',
    'fs.queueAhead': '{n} попереду',
    'fs.lyrics': 'Текст пісні',
    'fs.lyricsLoading': 'Завантаження тексту…',
    'fs.lyricsNone': 'Текст не знайдено',
    'downloads.tab.parsing': 'Парсинг',
    'downloads.title': 'Завантаження з інтернету',
    'downloads.subtitle': 'Тут з\'явиться можливість зберігати треки за прямим посиланням. Розділ у розробці.',
    'downloads.parsing.title': 'Парсинг',
    'downloads.parsing.subtitle': 'Тут з\'явиться можливість збирати треки парсингом зі сторінок. Розділ у розробці.',
    'downloads.yt.action.download': 'Завантажити',
    'downloads.yt.action.downloading': 'Завантаження…',
    'downloads.yt.action.done': 'Готово',
    'downloads.yt.action.retry': 'Повторити',
    'downloads.yt.downloadError': 'Не вдалося: {e}',
    'downloads.yt.downloadOk': 'Завантажено і додано до бібліотеки: {t}',
    'downloads.yt.tagNote': 'Після завантаження, можливо, доведеться вручну виправити MP3-теги (назва, виконавець, обкладинка) через контекстне меню треку.',
    'downloads.parsing.start': 'Парсити',
    'downloads.parsing.col.artist': 'Виконавець',
    'downloads.parsing.col.title': 'Назва',
    'downloads.parsing.col.duration': 'Трив.',
    'downloads.parsing.subtab.ytmusic': 'YouTube Music',
    'downloads.ytm.urlPlaceholder': 'https://music.youtube.com/playlist?list=…',
    'downloads.warnPlainYoutube': '⚠ Це посилання youtube.com. Використайте версію music.youtube.com для вищої якості (Premium 256 кбіт/с) — відкрийте у YouTube Music і скопіюйте це посилання.',
    'downloads.ytm.hint': 'Посилання на альбом, сингл або виконавця з YouTube Music. Логін і браузер не потрібні.',
    'downloads.ytm.idle.title': 'Парсинг YouTube Music',
    'downloads.ytm.idle.text': 'Вставте посилання на альбом, сингл або сторінку виконавця з YouTube Music. Застосунок збере список треків, і ви зможете завантажити будь-який одним кліком.',
    'downloads.parsing.subtab.spotify': 'Spotify',
    'downloads.sp.urlPlaceholder': 'https://open.spotify.com/playlist/…',
    'downloads.sp.hint': 'Посилання на плейлист, альбом або виконавця зі Spotify. Парсер працює у фоні.',
    'downloads.sp.idle.title': 'Парсинг Spotify',
    'downloads.sp.idle.text': 'Вставте посилання на плейлист або альбом зі Spotify. Застосунок відкриє браузер, збере список треків, і ви зможете завантажити будь-який одним кліком.',
    'downloads.parsing.starting': 'Запускаємо парсер…',
    'downloads.parsing.done': 'Готово — зібрано треків: {n}',
    'downloads.parsing.error': 'Помилка парсингу: {e}',
    'settings.title': 'Налаштування',
    'settings.subtitle': 'Зовнішній вигляд, джерела музики та поведінка застосунку.',
    'section.appearance': 'Зовнішній вигляд',
    'section.background': 'Тло',
    'setting.bgSource': 'Фонове зображення',
    'setting.bgSourceDesc': 'Власна картинка або обкладинка поточного треку під інтерфейсом.',
    'bg.none': 'Немає',
    'bg.image': 'Картинка',
    'bg.cover': 'Обкладинка',
    'setting.bgFile': 'Файл',
    'setting.bgFileDesc': 'Копіюється всередину програми, тож оригінал можна переміщувати.',
    'bg.noFile': 'Файл не вибрано',
    'bg.clear': 'Прибрати',
    'setting.bgFit': 'Вписування',
    'bg.fit.cover': 'Заповнити',
    'bg.fit.contain': 'Цілком',
    'bg.fit.center': 'По центру',
    'bg.fit.tile': 'Плитка',
    'setting.bgBlur': 'Розмиття',
    'setting.bgDim': 'Затемнення',
    'setting.bgDimDesc': 'Що більше, то читабельніший текст поверх картинки.',
    'setting.surfaceAlpha': 'Непрозорість панелей',
    'setting.surfaceAlphaDesc': 'Наскільки крізь бічне меню та панель плеєра видно тло.',
    'section.music': 'Музика',
    'section.library': 'Бібліотека',
    'section.playback': 'Відтворення',
    'section.equalizer': 'Еквалайзер',
    'section.integrations': 'Інтеграції',
    'setting.eqEnable': 'Еквалайзер',
    'setting.eqEnableDesc': 'Налаштуйте звучання графічним еквалайзером. Оберіть пресет або перетягніть смуги. Діє на все, що ви відтворюєте.',
    'setting.eqPreset': 'Пресет',
    'section.downloads': 'Завантаження з інтернету',
    'section.sidebar': 'Бічна панель',
    'section.language': 'Мова',
    'section.about': 'Про застосунок',
    'section.contacts': 'Контакти',
    'setting.github': 'GitHub',
    'setting.githubDesc': 'Вихідний код проєкту на GitHub.',
    'setting.telegram': 'Telegram',
    'setting.telegramDesc': 'Знайшли баг або є пропозиція — пишіть у Telegram.',
    'theme.dark': 'Темна (Rosé Pine)',
    'theme.light': 'Світла (Rosé Pine Dawn)',
    'theme.system': 'Типова',
    'setting.theme': 'Тема',
    'setting.themeDesc': 'Колірна схема застосунку.',
    'toast.saveFailed': 'Не вдалося зберегти зміни на диск — вони можуть втратитися після закриття застосунку.',
    'setting.randomTheme': 'Випадкова тема',
    'setting.randomThemeDesc': 'Обирати випадкову палітру під час кожного запуску.',
    'setting.accent': 'Колір акценту',
    'setting.accentDesc': 'Підсвічування активних елементів і поточного треку.',
    'setting.accentDefault': 'За замовчуванням',
    'setting.accentCustom': 'Власний колір',
    'setting.serviceColors': 'Мережеві сервіси',
    'setting.serviceColorsDesc': 'Фіксовані кольори акцентів для розрізнення джерел даних.',
    'service.ytm': 'YouTube Music',
    'service.ytmDesc': 'Перегляд, рейтинг популярності, парсинг і завантаження (Червоний)',
    'service.lastfm': 'Last.fm',
    'service.lastfmDesc': 'Скробблінг, жанрові теги, виправлення та схожі виконавці (Фіолетовий)',
    'service.musicbrainz': 'MusicBrainz',
    'service.musicbrainzDesc': 'Пошук метаданих треку та зіставлення релізів (Синій)',
    'setting.defaultFolder': 'Тека за замовчуванням',
    'setting.defaultFolderDesc': 'Звідки завантажувати треки під час запуску.',
    'setting.defaultView': 'Початкова сторінка',
    'setting.defaultViewDesc': 'Яка сторінка відкривається при запуску застосунку.',
    'setting.defaultViewPlaylist': 'Свій плейлист…',
    'setting.defaultPlaylist': 'Плейлист',
    'setting.uiScale': 'Масштаб інтерфейсу',
    'setting.uiScaleDesc': 'Збільшує або зменшує весь інтерфейс. Застосовується одразу.',
    'setting.uiScaleReset': 'Скинути',
    'setting.scanSubdirs': 'Сканувати підтеки',
    'setting.scanSubdirsDesc': 'Враховувати вкладені каталоги під час індексації.',
    'setting.artistMinTracks': 'Приховати малих виконавців',
    'setting.artistMinTracksDesc': 'Не показувати у розділі «Виконавці» тих, у кого лише один-два треки — зазвичай це випадковий фіт, а не виконавець, вартий окремого запису.',
    'setting.artistMinTracksN': 'Мінімум треків',
    'setting.healthCheck': 'Перевірка якості (Health-check)',
    'setting.healthCheckDesc': 'Розділ «Стан бібліотеки» та стовпець «Якість» у списках треків. Коли вимкнено — стовпець і розділ повністю приховані.',
    'setting.reports': 'Звіт про прослуховування',
    'setting.reportsDesc': 'Розділ «Звіт» зі статистикою прослуховування. Статистика збирається завжди, навіть коли розділ прихований.',
    'setting.crossfadeLen': 'Тривалість переходу',
    'setting.volWheelStep': 'Крок гучності колесом миші',
    'setting.volWheelStepDesc': 'Наскільки змінюється гучність на один клік колеса миші, коли курсор над повзунком.',
    'unit.sec': 'с',
    'setting.crossfade': 'Плавний перехід між треками',
    'setting.crossfadeDesc': 'Треки перетікають один в одного: кінець поточного стихає, поки наступний наростає. Діє і в кінці треку, і під час ручного перемикання.',
    'setting.repeatOneReset': 'Скидати «повтор треку» при перемиканні',
    'setting.repeatOneResetDesc': 'Ручне перемикання на наступний або попередній трек, коли ввімкнено «повтор треку», перемикає режим на «повтор» замість зациклення і нового треку теж.',
    'setting.showDownloads': 'Показати вкладку «Завантаження»',
    'setting.showDownloadsDesc': 'Відкриє в боковому меню розділ для завантаження треків за посиланням.',
    'setting.showDevices': 'Показати вкладку «Пристрої»',
    'setting.showDevicesDesc': 'Дозволяє іншим вашим пристроям у тій самій локальній мережі чи Tailscale знаходити цей застосунок і керувати ним. Відкриває локальний мережевий порт; вимкнено за замовчуванням.',
    'setting.showParserBrowser': 'Показувати вікно браузера під час парсингу',
    'setting.showParserBrowserDesc': 'Потрібно, щоб увійти в Spotify при першому запуску, пройти капчу або побачити, на чому парсер спіткнувся. Якщо вимкнути — браузер запуститься у фоні і вікно не з\'явиться.',
    'setting.ytLogin': 'Увійти в YouTube',
    'setting.ytLoginDesc': 'Виправляє помилку завантаження «Sign in to confirm you\'re not a bot». Відкриває вікно браузера — увійдіть, потім закрийте його.',
    'setting.ytLogin.signedIn': 'Виконано вхід',
    'setting.ytLogin.notSignedIn': 'Вхід не виконано',
    'setting.ytLogin.waiting': 'Очікуємо закриття вікна браузера…',
    'setting.ytPremium.checking': 'Перевірка Premium…',
    'setting.ytPremium.active': 'YouTube Premium · 256 кбіт/с',
    'setting.ytPremium.none': 'Без Premium · до 160 кбіт/с',
    'setting.ytPremium.unknown': 'Статус Premium невідомий',
    'setting.dlFormat': 'Формат завантаження',
    'setting.dlFormatDesc': 'Файли зберігаються як {тека за замовчуванням}/{виконавець}/{альбом}/{виконавець} - {трек}. Opus дає найкращу якість на мегабайт; обери M4A, якщо якийсь із твоїх пристроїв його не програє.',
    'downloads.noFolder': 'Спершу обери теку за замовчуванням — завантаження розкладаються в ній за виконавцем і альбомом.',
    'section.system': 'Система',
    'section.hotkeys': 'Гарячі клавіші',
    'hotkeys.intro': 'Натисніть на сполучення, потім — клавішу або кнопку миші. Esc — скасувати, Backspace — очистити.',
    'hotkeys.globalNote': 'Значок монітора вмикає роботу сполучення, коли вікно згорнуте. Потрібен модифікатор (Ctrl, Alt або Shift); кнопки миші так не працюють.',
    'hotkeys.escNote': 'Esc завжди закриває відкрите вікно і не перепризначається.',
    'hotkeys.resetAll': 'Скинути все',
    'hotkeys.press': 'Натисніть клавіші…',
    'hotkeys.revert': 'Повернути типове',
    'hotkeys.global': 'Працює, коли вікно згорнуте (глобально в системі)',
    'hotkeys.globalNeedsMod': 'Для глобальної роботи потрібен модифікатор: Ctrl, Alt або Shift',
    'hotkeys.globalNoMouse': 'Кнопки миші не можуть працювати глобально',
    'hotkeys.globalUnsupported': 'Цю клавішу не можна зареєструвати глобально',
    'hotkeys.globalFailed': 'Сполучення зайняте іншою програмою',
    'hotkeys.globalUnavailable': 'Глобальні сполучення недоступні в сесії Wayland. Використовуйте медіаклавіші — вони працюють через MPRIS.',
    'mouse.middle': 'Сер. кнопка',
    'mouse.back': 'Миша «Назад»',
    'mouse.forward': 'Миша «Вперед»',
    'mouse.other': 'Миша {n}',
    'hotkey.playPause': 'Відтворення / пауза',
    'hotkey.nextTrack': 'Наступний трек',
    'hotkey.prevTrack': 'Попередній трек',
    'hotkey.seekForward': 'Перемотати вперед на 5 с',
    'hotkey.seekBackward': 'Перемотати назад на 5 с',
    'hotkey.volumeUp': 'Гучніше',
    'hotkey.volumeDown': 'Тихіше',
    'hotkey.mute': 'Вимкнути звук',
    'hotkey.favorite': 'До обраного',
    'hotkey.shuffle': 'Випадковий порядок',
    'hotkey.repeat': 'Режим повтору',
    'hotkey.fullscreen': 'Повноекранний програвач',
    'hotkey.palette': 'Палітра команд',
    'hotkey.editTags': 'Редагувати теги',
    'hotkey.settings': 'Відкрити налаштування',
    'setting.hardwareAcceleration': 'Апаратне прискорення',
    'setting.hardwareAccelerationDesc': 'Використовує відеокарту для відмалювання інтерфейсу. Якщо застосунок зависає при запуску або працює з артефактами — вимкніть. Зміна застосується після перезапуску.',
    'setting.uiLanguage': 'Мова інтерфейсу',
    'setting.uiLanguageDesc': 'Застосовується одразу.',
    'setting.version': 'Версія',
    'setting.checkUpdate': 'Перевірити оновлення',
    'setting.checkUpdateDesc': 'Перевіряє наявність новішої версії на GitHub прямо зараз.',
    'setting.openLogs': 'Журнали',
    'setting.openLogsDesc': 'Відкриває папку з журналами помилок для діагностики помилок.',
    'update.checkFailed': 'Не вдалося перевірити оновлення.',
    'update.upToDate': 'У вас уже остання версія ({v}).',
    'badge.wip': 'у розробці',
    'placeholder.noFolder': '— не обрано —',
    'placeholder.noPlaylists': 'Плейлистів ще немає',
    'placeholder.choosePlaylist': 'Обрати плейлист…',
    'modal.deleteTrack.title': 'Видалити трек?',
    'modal.deleteTrack.text': 'Трек буде вилучено з бібліотеки, а файл — переміщено у смітник.',
    'modal.deleteTrackFull.text': '«{title}» від {artist} буде вилучено з бібліотеки, а файл — переміщено у смітник.',
    'modal.deletePlaylist.title': 'Видалити плейлист?',
    'modal.deletePlaylist.text': 'Плейлист «{name}» буде вилучено. Треки в бібліотеці залишаться.',
    'modal.deleteAlbum.title': 'Видалити альбом?',
    'modal.deleteAlbum.text': '«{name}» ({count}) буде вилучено з бібліотеки, а файли — переміщено у смітник.',
    'modal.deleteArtist.title': 'Видалити виконавця?',
    'modal.deleteArtist.text': 'Усі треки виконавця «{name}» ({count}) буде вилучено з бібліотеки, а файли — переміщено у смітник.',
    'modal.clearLibrary.title': 'Очистити всю бібліотеку?',
    'modal.clearLibrary.text': 'Усі треки буде вилучено з Audex. Самі файли не постраждають.',
    'modal.newPlaylist.title': 'Новий плейлист',
    'modal.newPlaylist.namePh': 'Назва плейлиста',
    'modal.newPlaylist.descPh': 'Опис (необов\'язково)',
    'modal.editPlaylist.title': 'Змінити плейлист',
    'modal.editPlaylist.avatarChoose': 'Вибрати зображення',
    'modal.editPlaylist.avatarRemove': 'Прибрати обкладинку',
    'cm.plEdit': 'Змінити плейлист…',
    'splash.loading': 'Завантаження інтерфейсу',
    'splash.covers': 'Завантаження обкладинок',
    'splash.caching': 'Кешування обкладинок {n} / {total}',
    'splash.scanning': 'Сканування бібліотеки',
    'cm.plDelete': 'Видалити плейлист',
    'modal.addToPlaylist.title': 'Додати до плейлиста',
    'modal.addToPlaylist.empty': 'Спершу створи плейлист на вкладці «Плейлисти».',
    'modal.addToPlaylist.alreadyAdded': 'вже додано',
    'editor.title': 'Редагувати теги',
    'editor.cover': 'Обкладинка',
    'editor.field.title': 'Назва',
    'editor.field.artist': 'Виконавець',
    'editor.field.album': 'Альбом',
    'editor.field.albumArtist': 'Викон. альбому',
    'editor.field.year': 'Рік',
    'editor.field.genre': 'Жанр',
    'editor.field.trackNo': 'Трек №',
    'editor.field.discNo': 'Диск №',
    'editor.field.comment': 'Коментар',
    'editor.commentPh': 'Нотатка про трек…',
    'editor.coverEmbed': 'Вбудована обкладинка',
    'editor.coverNew': 'Нова обкладинка',
    'editor.setCover': 'Вибрати файл…',
    'editor.noCover': 'Немає обкладинки',
    'editor.saving': 'Збереження…',
    'cm.applySelectedCover': 'Застосувати вибрану обкладинку',
    'cm.applyCoverFromFile': 'Обкладинка з локального файлу',
    'cm.setGenre': 'Встановити жанр',
    'fixMenu.cover': 'Обкладинка',
    'fixMenu.metadata': 'Масові теги',
    'genre.prompt': 'Встановити жанр для всіх вибраних треків:',
    'genre.progress': 'Оновлюємо жанри…',
    'editor.musicbrainz': 'MusicBrainz',
    'editor.musicbrainzHint': 'Знайти метадані треку в MusicBrainz',
    'editor.mbSearching': 'Пошук у MusicBrainz…',
    'editor.mbNoMatch': 'У MusicBrainz збігів не знайдено',
    'editor.mbChoose': 'Збіги MusicBrainz (натисніть для застосування):',
    'editor.mbApplied': 'Застосовано дані з MusicBrainz — перевірте та збережіть',
    'editor.lastfm': 'Last.fm',
    'editor.lastfmHint': 'Отримати виправлення назв і жанри з Last.fm',
    'editor.lastfmNeedKey': 'Спершу додайте API-ключ Last.fm у налаштуваннях',
    'editor.lastfmFetching': 'Запит до Last.fm…',
    'editor.lastfmCorrected': 'Застосовано виправлення Last.fm — перевірте та збережіть',
    'editor.lastfmTags': 'Торкніться жанру, щоб додати',
    'editor.lastfmNothing': 'Last.fm не має що додати',
    'cm.useAsAlbumCover': 'Використати як обкладинку альбому',
    'cm.setCoverFromFile': 'Вибрати обкладинку з файлу…',
    'cm.applyCoverToAlbum': 'Застосувати обкладинку до альбому…',
    'cm.fixYear': 'Встановити рік випуску',
    'cm.fixTrackNumbers': 'Виправити номери треків',
    'cm.deleteAlbum': 'Видалити альбом…',
    'cm.deleteArtist': 'Видалити виконавця…',
    'btn.albumMenuTooltip': 'Виправити теги, обкладинку, рік випуску та номери треків…',
    'albumCover.needSource': 'Спершу клацніть правою кнопкою на трек із правильною обкладинкою та оберіть «Використати як обкладинку альбому».',
    'albumCover.badSource': 'Для цього треку ще не завантажено обкладинку — прогорніть до нього список (або відкрийте трек), щоб вона завантажилась, і спробуйте ще раз.',
    'albumCover.confirm': 'Застосувати обкладинку з «{track}» до решти {count} трек(ів) цього альбому?',
    'albumCover.progress': 'Оновлюємо обкладинки альбому…',
    'cm.mbRelease': 'Зіставити реліз у MusicBrainz…',
    'mbRelease.title': 'Релізи MusicBrainz',
    'mbRelease.progress': 'Застосування метаданих MusicBrainz…',
    'mbRelease.applied': 'Оновлено {count} треків з MusicBrainz',
    'editor.mbManualPrompt': 'Пошук у MusicBrainz (назва, виконавець тощо):',
    'mbRelease.manualPrompt': 'Пошук релізу MusicBrainz (альбом, виконавець тощо):',
    'fs.lyricsSearchManual': 'Знайти текст вручну…',
    'coverFile.progress': 'Встановлення обкладинки…',
    'coverFile.confirm': 'Встановити це зображення як обкладинку для всіх {count} треків?',
    'coverFile.error': 'Не вдалося прочитати зображення: {e}',
    'albumCover.summary': '{updated} оновлено · {failed} невдало ({total} усього)',
    'albumYear.prompt': 'Встановити рік випуску для всіх треків цього альбому:',
    'albumYear.progress': 'Оновлюємо роки випуску…',
    'albumYear.summary': '{updated} оновлено · {failed} невдало ({total} усього)',
    'albumTrackNo.pickTitle': 'Клацайте треки у порядку прослуховування — перший клік стане треком 1',
    'albumTrackNo.writeFailed': 'Не вдалося оновити номер треку.',
    'editor.lockedWhilePlaying': 'Неможливо редагувати теги під час відтворення цього треку',
    'editor.saved': 'Збережено ✓',
    'editor.errorSave': 'Помилка збереження',
    'cm.play': 'Грати',
    'cm.addToPlaylist': 'Додати до плейлиста',
    'cm.removeFromPlaylist': 'Прибрати з плейлиста',
    'cm.reveal': 'Показати у теці',
    'cm.editTags': 'Редагувати теги…',
    'cm.delete': 'Вилучити з бібліотеки',
    'palette.placeholder': 'Пошук треку, альбому, дії…',
    'palette.nav': '↑↓ навігація',
    'palette.choose': '↵ обрати',
    'palette.close': 'ESC закрити',
    'palette.tracks': 'Треки',
    'palette.group.general': 'Загальне',
    'palette.group.nav': 'Навігація',
    'palette.group.music': 'Музика',
    'palette.itemHint': '↵ грати',
    'palette.empty': 'Нічого не знайдено',
    'palette.action.openFiles': 'Відкрити файли…',
    'palette.action.gotoSettings': 'Перейти в Налаштування',
    'palette.action.gotoLibrary': 'Перейти в Бібліотеку',
    'palette.action.gotoDownloads': 'Перейти в Завантаження',
    'palette.action.gotoYtMusic': 'Перейти в YouTube Music',
    'palette.action.gotoArtists': 'Перейти у Виконавців',
    'palette.action.gotoAlbums': 'Перейти в Альбоми',
    'palette.action.gotoDevices': 'Перейти в Пристрої',
    'palette.action.gotoReport': 'Перейти в Статистику',
    'palette.action.gotoHealth': 'Перейти в Стан бібліотеки',
    'palette.action.gotoPlaylists': 'Перейти в Плейлисти',
    'palette.action.gotoFavorites': 'Перейти в Улюблене',
    'palette.action.clearLibrary': 'Очистити бібліотеку…',
    'palette.action.volumeUp': 'Гучніше',
    'palette.action.volumeDown': 'Тихіше',
    'palette.action.reloadApp': 'Оновити застосунок',
    'label.unknownArtist': 'Невідомий виконавець',
    'label.noAlbum': 'Без альбому',
    'label.tracksShort': 'тр.',
    'error.deleteFile': 'Не вдалося видалити файл з диска: ',
    'error.unknown': 'невідома помилка',
    'library.ghostsRemoved': '{count} трек(и) більше не знайдено на диску — видалено з бібліотеки.',
    'library.purgedOnError': '{count} трек(и) видалено з бібліотеки — не вдалося прочитати або записати (файл відсутній або пошкоджений).',
    'downloads.tab.queue': 'Черга',
    'downloads.queue.add': 'В чергу',
    'downloads.queue.queued': 'В черзі',
    'downloads.queue.addAll': 'Усі треки в чергу',
    'downloads.queue.remove': 'Прибрати з черги',
    'downloads.queue.clearDone': 'Очистити завершені',
    'downloads.queue.clearAll': 'Очистити все',
    'downloads.queue.empty.title': 'Черга порожня',
    'downloads.queue.empty.text': 'Додайте треки з вкладки «Парсинг», і вони почнуть завантажуватися один за одним.',
    'downloads.queue.status.queued': 'Очікує',
    'downloads.queue.status.downloading': 'Завантаження',
    'downloads.queue.status.done': 'Готово',
    'downloads.queue.status.error': 'Помилка',
    'downloads.queue.stats.downloading': 'завантажується: {n}',
    'downloads.queue.stats.queued': 'у черзі: {n}',
    'downloads.queue.stats.done': 'готово: {n}',
    'downloads.queue.stats.error': 'помилок: {n}',
    'downloads.queue.stats.paused': 'на паузі',
    'downloads.queue.pause': 'Пауза',
    'downloads.queue.resume': 'Продовжити',
  },
};

// Pluralized noun forms for "tracks/albums/artists/playlists", keyed by the
// CLDR plural category Intl.PluralRules picks for the count — so uk's
// one/few/many and en's one/other come out of the same lookup with no
// per-language index maths here.
const PLURAL_FORMS = {
  uk: {
    tracks:    { one: 'трек', few: 'треки', many: 'треків' },
    albums:    { one: 'альбом', few: 'альбоми', many: 'альбомів' },
    artists:   { one: 'виконавець', few: 'виконавці', many: 'виконавців' },
    playlists: { one: 'плейлист', few: 'плейлисти', many: 'плейлистів' },
  },
  en: {
    tracks:    { one: 'track', other: 'tracks' },
    albums:    { one: 'album', other: 'albums' },
    artists:   { one: 'artist', other: 'artists' },
    playlists: { one: 'playlist', other: 'playlists' },
  },
};
// "h X min" / "X min" — total duration formatting.
const DURATION_UNITS = {
  uk: { h: 'год', m: 'хв' },
  en: { h: 'h', m: 'min' },
};

let currentLang = I18N[settings.language] ? settings.language : 'en';

function tr(key, params) {
  const dict = I18N[currentLang] || I18N.en;
  let s = dict[key];
  if (s == null) s = I18N.en[key] != null ? I18N.en[key] : key;
  if (params) {
    for (const k in params) s = s.split('{' + k + '}').join(params[k]);
  }
  return s;
}

function plural(kind, n) {
  const forms = (PLURAL_FORMS[currentLang] || PLURAL_FORMS.en)[kind];
  const cat = new Intl.PluralRules(currentLang).select(n);
  // uk has no 'other' below 1e6 and en has no 'few' — fall back to the form
  // every language in the table does define.
  return forms[cat] || forms.other || forms.many;
}
function withCount(kind, n) { return `${n} ${plural(kind, n)}`; }

function applyLanguage(lang) {
  if (!I18N[lang]) lang = 'en';
  currentLang = lang;
  document.documentElement.setAttribute('lang', lang);
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = tr(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = tr(el.getAttribute('data-i18n-placeholder'));
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = tr(el.getAttribute('data-i18n-title'));
  });
}

// ── Utils ──
function formatTime(seconds) {
  if (!isFinite(seconds) || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
function formatTotalDuration(tracks) {
  const total = tracks.reduce((a, t) => a + (t.duration || 0), 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const u = DURATION_UNITS[currentLang] || DURATION_UNITS.en;
  return h > 0 ? `${h} ${u.h} ${m} ${u.m}` : `${m} ${u.m}`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ── Virtual list ──
// Only renders rows visible in the scroll viewport (+ overscan buffer).
// `listEl` is the row container; rows are absolutely positioned inside it.
// `scrollEl` is the actual scroll container (here: .main-content).
// Fixed-height virtualizer — has to match .trow's actual rendered height (see
// style.css's own padding/line-height math) or rows overlap.
const ROW_HEIGHT = 42;
const OVERSCAN = 8;

function createVirtualList({ listEl, scrollEl, rowHeight = ROW_HEIGHT, overscan = OVERSCAN }) {
  let items = [];
  let renderRow = () => document.createElement('div');
  const nodes = new Map(); // index -> element
  let rafPending = false;
  let lastScrollTop = scrollEl.scrollTop;

  // listEl's offset within the scroll container's content (header/topbar above it).
  // It's constant while scrolling, so cache it and avoid a forced layout every frame.
  let listOffset = 0;
  let offsetValid = false;
  function measureOffset() {
    listOffset = listEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
    offsetValid = true;
  }

  function placeNode(node, index) {
    node.style.position = 'absolute';
    node.style.top = `${index * rowHeight}px`;
    node.style.left = '0';
    node.style.right = '0';
  }

  function update() {
    rafPending = false;
    const total = items.length;
    listEl.style.position = 'relative';
    listEl.style.paddingTop = '0';
    listEl.style.height = `${total * rowHeight}px`;
    if (total === 0) {
      for (const [, node] of nodes) node.remove();
      nodes.clear();
      return;
    }
    const scrollTop = scrollEl.scrollTop;
    const viewportH = scrollEl.clientHeight;
    if (!offsetValid) measureOffset();
    // Velocity-aware buffer: a fast fling can jump far more than `overscan` rows
    // between frames, leaving the newly-revealed area unmounted (blank rows). Extend
    // the render range in the scroll direction by the per-frame travel so rows are
    // mounted ahead of the viewport. Capped to bound per-frame work.
    const delta = scrollTop - lastScrollTop;
    lastScrollTop = scrollTop;
    const velRows = Math.min(80, Math.ceil(Math.abs(delta) / rowHeight));
    const aheadExtra = delta >= 0 ? velRows : 0;
    const behindExtra = delta < 0 ? velRows : 0;
    const visibleStart = (scrollTop - listOffset) / rowHeight;
    const visibleEnd = (scrollTop - listOffset + viewportH) / rowHeight;
    const start = Math.max(0, Math.floor(visibleStart) - overscan - behindExtra);
    const end = Math.min(total, Math.ceil(visibleEnd) + overscan + aheadExtra);

    for (const [i, node] of nodes) {
      if (i < start || i >= end) {
        node.remove();
        nodes.delete(i);
      }
    }
    for (let i = start; i < end; i++) {
      if (!nodes.has(i)) {
        const node = renderRow(items[i], i, items);
        placeNode(node, i);
        listEl.appendChild(node);
        nodes.set(i, node);
      }
    }
  }

  function schedule() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(update);
  }

  const onScroll = () => schedule();
  scrollEl.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => { offsetValid = false; schedule(); });

  return {
    setItems(newItems, renderRowFn) {
      items = newItems;
      if (renderRowFn) renderRow = renderRowFn;
      for (const [, node] of nodes) node.remove();
      nodes.clear();
      offsetValid = false; // list may have moved (view switch / count change)
      lastScrollTop = scrollEl.scrollTop;
      update();
    },
    // Re-render all currently mounted rows in place (used when only row visuals change, e.g. playing/favorite).
    refreshVisible() {
      for (const [i, oldNode] of nodes) {
        const node = renderRow(items[i], i, items);
        placeNode(node, i);
        oldNode.replaceWith(node);
        nodes.set(i, node);
      }
    },
    // Re-render a single row if it's currently visible (used when one row's data changes, e.g. cover loaded).
    updateRow(index) {
      const old = nodes.get(index);
      if (!old) return;
      const node = renderRow(items[index], index, items);
      placeNode(node, index);
      old.replaceWith(node);
      nodes.set(index, node);
    },
    // Locate index of a row by predicate, for partial updates.
    findIndex(pred) { return items.findIndex(pred); },
    getItems() { return items; },
  };
}

const scrollEl = document.querySelector('.main-content');
let libraryVList = null;
let librarySelectMode = false;      // library-view multi-select (bulk delete)
const selectedPaths = new Set();
let lastSelectedPath = null;        // anchor for shift-click range selection
let favoritesVList = null;
let playlistVList = null;
let albumVList = null;

// ── Lazy cover loading ──
// Covers can be heavy (base64 data URLs). Only fetch them for tracks that actually become visible.
const pendingCoverLoad = new Set();
let coverRefreshPending = false;
function scheduleCoverRefresh() {
  if (coverRefreshPending) return;
  coverRefreshPending = true;
  requestAnimationFrame(() => {
    coverRefreshPending = false;
    refreshPlayingHighlight();
    renderRecents();
    if (currentView === 'artists') refreshArtistsCoversInPlace();
    else if (currentView === 'artist-detail') renderArtistDetail(activeArtistName);
    else if (currentView === 'albums') refreshAlbumsCoversInPlace();
    else if (currentView === 'album-detail') renderAlbumDetail(activeAlbumKey);
    if ($('fullscreen-overlay').classList.contains('active')) updateFullscreenQueue();
    if ($('palette-overlay').classList.contains('active')) renderPaletteResults($('palette-input').value);
  });
}
// `quiet` skips the visible-row refresh — used by the boot-time background
// warmer, whose per-batch refreshes rebuilt the rows under the cursor and made
// the hover background flicker. Quietly-loaded covers appear when rows
// re-render naturally (scroll, track change, or the warmer's final refresh).
async function ensureCoverFor(track, quiet = false) {
  if (!track || pendingCoverLoad.has(track.path)) return;
  // A track confirmed to have no embedded art (hasCover === false) will never
  // grow a `cover`, so it's excluded here rather than retried forever below.
  const needCover = !track.cover && track.hasCover !== false;
  const needQuality = track.quality === undefined || track.hasCover === undefined;
  if (!needCover && !needQuality) return;
  pendingCoverLoad.add(track.path);
  try {
    const md = await window.electronAPI.parseMetadata(track.path);
    if (md) {
      let touched = false;
      if (needQuality) {
        track.quality = md.quality;
        track.hasCover = md.hasCover;
        touched = true;
        scheduleLibrarySave();
      }
      if (md.cover) {
        track.cover = md.cover;
        coverCache[track.path] = md.cover;
        touched = true;
        if (currentTrack && currentTrack.path === track.path) {
          updateNowPlayingUI(currentTrack);
        }
      }
      if (touched && !quiet) scheduleCoverRefresh();
    }
  } catch (e) { /* file moved / unreadable */
  } finally {
    // A failed/unreadable attempt must not permanently blacklist the path —
    // this Set is also an in-flight guard, and until now it never cleared,
    // so one transient parse error (busy IPC, locked file) killed the
    // thumbnail for the rest of the session with no way to retry.
    pendingCoverLoad.delete(track.path);
  }
}

// Coalesce the many small library writes from lazy quality/cover backfill into
// one localStorage write.
let _libSaveTimer = null;
function scheduleLibrarySave() {
  clearTimeout(_libSaveTimer);
  _libSaveTimer = setTimeout(() => { _libSaveTimer = null; saveLibrary(); }, 1500);
}

// ── Library track helpers ──
function trackByPath(path) { return library.find(t => t.path === path); }
function trackIndexByPath(path) { return library.findIndex(t => t.path === path); }

function sortedFilteredLibrary() {
  let arr = library.slice();
  const byTitle = (a, b) => (a.title || '').localeCompare(b.title || '');
  // Same artist -> group by album -> track order within it, so an artist's
  // albums stay intact instead of interleaving alphabetically by title.
  const byArtist = (a, b) => (a.artist || '').localeCompare(b.artist || '')
    || (a.album || '').localeCompare(b.album || '') || compareTrackOrder(a, b);
  const byDuration = (a, b) => (a.duration || 0) - (b.duration || 0);
  switch (activeSort) {
    case 'title-asc': arr.sort(byTitle); break;
    case 'title-desc': arr.sort((a, b) => -byTitle(a, b)); break;
    case 'artist-asc': arr.sort(byArtist); break;
    case 'artist-desc': arr.sort((a, b) => -byArtist(a, b)); break;
    case 'duration-asc': arr.sort(byDuration); break;
    case 'duration-desc': arr.sort((a, b) => -byDuration(a, b)); break;
    case 'date-asc': break;
    case 'date-desc':
    default:
      arr.reverse();
      break;
  }
  return arr;
}

// ── Render: navigation ──
function setView(view) {
  if (librarySelectMode && view !== 'library') setLibrarySelectMode(false);
  if (currentView === 'editor' && view !== 'editor') stopEditorPreview();
  currentView = view;
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === view);
  });
  document.querySelectorAll('.view-section').forEach(s => {
    s.classList.toggle('active', s.id === `view-${view}`);
  });
  // All view-sections share one scroller (.main-content), so without this a
  // navigation lands wherever the previous, possibly-taller view happened to
  // be scrolled. Callers that need to land on a specific row (e.g. scrolling
  // to the current track) override this afterwards via requestAnimationFrame.
  scrollEl.scrollTop = 0;
  if (view === 'library') renderLibrary();
  else if (view === 'favorites') renderFavorites();
  else if (view === 'playlists') renderPlaylists();
  else if (view === 'playlist-detail') renderPlaylistDetail(activePlaylistId);
  else if (view === 'artists') renderArtists();
  else if (view === 'artist-detail') renderArtistDetail(activeArtistName);
  else if (view === 'albums') renderAlbums();
  else if (view === 'album-detail') renderAlbumDetail(activeAlbumKey);
  else if (view === 'report') renderReport();
  else if (view === 'health') renderHealth();
  else if (view === 'devices') { renderDevices(); lanRefresh(); }
}

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault();
    if (item.dataset.action === 'open-palette') {
      // Replay the icon-ping animation by toggling the class off and back on.
      item.classList.remove('is-pinging');
      void item.offsetWidth;
      item.classList.add('is-pinging');
      setTimeout(() => item.classList.remove('is-pinging'), 600);
      return openPalette();
    }
    if (item.dataset.action === 'open-settings') return openSettings();
    if (item.dataset.view) {
      // A direct click on the Library nav item shows the full library, not a
      // lingering Health-check result filter.
      if (item.dataset.view === 'library') clearHealthFilter();
      // The YT Music view is inert until the browser resets its header/search,
      // so go through its own entry point rather than a bare setView.
      if (item.dataset.view === 'ytmusic') return ytmBrowser.open();
      setView(item.dataset.view);
    }
  });
});
document.querySelectorAll('.crumb-item.link').forEach(el => {
  el.addEventListener('click', () => {
    if (!el.dataset.view) return; // dynamic crumbs (e.g. album→artist) wire their own click
    if (el.dataset.view === 'library') clearHealthFilter();
    setView(el.dataset.view);
  });
});

// ── Editor (track trimming) ──
// Gated by settings.editor. Decodes the track once into a dense peak array,
// paints it as bars, and lets the user drag two handles to pick [start, end].
// The actual cut happens in the main process (ffmpeg, 'audio:trim'); preview
// uses its own Audio element so it can never disturb the main playback state.
const ED_BARS = 260;
let edTrack = null;        // library track being edited
let edPeaks = null;        // Float32Array-like, ED_BARS entries
let edDuration = 0;        // seconds
let edStart = 0;
let edEnd = 0;
let edPreview = null;      // transient Audio for previewing the selection
let edPreviewRaf = null;
let edLoadToken = 0;       // guards against a slow decode landing after a switch
let edPeakAmp = 0;         // true sample peak of the loaded track, 0..1
let edGainDb = 0;          // gain applied on save, in dB (0 = untouched)
let edGainCtx = null;      // shared AudioContext used to preview the gain
let edGainNode = null;     // gain node of the current preview, if any

function edFormatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

// Accepts "m:ss.d", "ss.d" or plain seconds; returns null when unparseable.
function edParseTime(text) {
  const t = String(text || '').trim().replace(',', '.');
  if (!t) return null;
  const parts = t.split(':');
  let sec;
  if (parts.length === 2) {
    const m = parseFloat(parts[0]), s = parseFloat(parts[1]);
    if (isNaN(m) || isNaN(s)) return null;
    sec = m * 60 + s;
  } else {
    sec = parseFloat(t);
    if (isNaN(sec)) return null;
  }
  return Math.max(0, sec);
}

function setEdStatus(text, kind) {
  const el = $('ed-status');
  if (!el) return;
  el.classList.remove('is-error', 'is-ok');
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  if (kind === 'error') el.classList.add('is-error');
  else if (kind === 'ok') el.classList.add('is-ok');
  el.hidden = false;
  el.textContent = text;
}

// Decode the track into `bars` amplitude peaks for the trim waveform. A
// low-rate OfflineAudioContext makes decodeAudioData resample down — only the
// loudness envelope matters here, so 8 kHz keeps memory small on long tracks.
let edDecodeCtx = null;
async function edDecodePeaks(arrayBuffer, bars) {
  if (!edDecodeCtx) {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) throw new Error('OfflineAudioContext unavailable');
    edDecodeCtx = new Ctx(1, 1, 8000);
  }
  const buf = await edDecodeCtx.decodeAudioData(arrayBuffer);
  const chCount = buf.numberOfChannels;
  const len = buf.length;
  const channels = [];
  for (let c = 0; c < chCount; c++) channels.push(buf.getChannelData(c));
  const peaks = new Float32Array(bars);
  const bucket = Math.max(1, Math.floor(len / bars));
  let globalMax = 0;
  for (let i = 0; i < bars; i++) {
    const s = i * bucket;
    const e = i === bars - 1 ? len : Math.min(len, s + bucket);
    let max = 0;
    for (let j = s; j < e; j++) {
      for (let c = 0; c < chCount; c++) {
        const v = Math.abs(channels[c][j]);
        if (v > max) max = v;
      }
    }
    peaks[i] = max;
    if (max > globalMax) globalMax = max;
  }
  const norm = globalMax > 0 ? 1 / globalMax : 0;
  const out = new Array(bars);
  for (let i = 0; i < bars; i++) {
    out[i] = Math.max(0.04, Math.min(1, Math.pow(peaks[i] * norm, 0.7)));
  }
  // `peak` is the true (un-normalised) sample peak, 0..1 — the gain control
  // needs it to work out how much headroom is left before clipping.
  return { peaks: out, duration: buf.duration, peak: globalMax };
}

function edPaintBars() {
  const host = $('ed-wave-bars');
  if (!host) return;
  if (!edPeaks) {
    host.innerHTML = `<i style="height:6%"></i>`.repeat(60);
    return;
  }
  const sPct = edDuration > 0 ? edStart / edDuration : 0;
  const ePct = edDuration > 0 ? edEnd / edDuration : 1;
  host.innerHTML = edPeaks.map((p, i) => {
    const at = (i + 0.5) / edPeaks.length;
    const cls = at >= sPct && at <= ePct ? ' class="in-sel"' : '';
    return `<i${cls} style="height:${(p * 100).toFixed(1)}%"></i>`;
  }).join('');
}

function edPaintSelection() {
  const wave = $('ed-wave');
  if (!wave || edDuration <= 0) return;
  const sPct = (edStart / edDuration) * 100;
  const ePct = (edEnd / edDuration) * 100;
  $('ed-dim-left').style.width = `${sPct}%`;
  $('ed-dim-right').style.width = `${100 - ePct}%`;
  $('ed-handle-start').style.left = `${sPct}%`;
  $('ed-handle-end').style.left = `${ePct}%`;
  $('ed-start').value = edFormatTime(edStart);
  $('ed-end').value = edFormatTime(edEnd);
  $('ed-duration').textContent = edFormatTime(Math.max(0, edEnd - edStart));
}

function edPaintRuler() {
  const el = $('ed-ruler');
  if (!el || edDuration <= 0) return;
  const marks = 5;
  let html = '';
  for (let i = 0; i <= marks; i++) {
    const t = (edDuration * i) / marks;
    html += `<span style="left:${(i / marks) * 100}%">${edFormatTime(t)}</span>`;
  }
  el.innerHTML = html;
}

// Gain, in dB, applied to the cut on save. Negative attenuates, positive
// amplifies. The readout and the clipping warning are refreshed together; the
// warning compares the boost against the track's remaining headroom
// (-20·log10(peak)), so it only fires when the result would actually clip.
function edSetGain(db, opts) {
  edGainDb = Math.max(-24, Math.min(24, Math.round((Number(db) || 0) * 2) / 2));
  const slider = $('ed-gain');
  if (slider && !(opts && opts.fromSlider)) slider.value = String(edGainDb);
  const val = $('ed-gain-val');
  if (val) val.textContent = `${edGainDb > 0 ? '+' : ''}${edGainDb.toFixed(1)} dB`;
  // Keep an in-flight preview in sync with the slider. With a gain node any dB
  // works; without one we can only attenuate (an element's volume caps at 1).
  const ratio = Math.pow(10, edGainDb / 20);
  if (edGainNode) edGainNode.gain.value = ratio;
  else if (edPreview) edPreview.volume = Math.min(1, ratio);
  const warn = $('ed-gain-warn');
  if (warn) {
    const headroom = edPeakAmp > 0 ? -20 * Math.log10(edPeakAmp) : Infinity;
    const over = edGainDb - headroom;
    // Only ever warn about a boost. Loud masters routinely decode to a peak
    // just above 1.0 (inter-sample overshoot), so headroom is often slightly
    // negative — that must not raise a warning at 0 dB, where we stream-copy
    // and change nothing at all, nor when the user is attenuating.
    if (edGainDb > 0 && isFinite(over) && over > 0.05) {
      warn.textContent = tr('editor.gainClip', { d: over.toFixed(1) });
      warn.hidden = false;
    } else {
      warn.hidden = true;
      warn.textContent = '';
    }
  }
}

// Paints the editor header artwork, falling back to the track's initial when
// there is none. Safe to call repeatedly — used both on open and once a lazily
// fetched cover arrives.
function edPaintCover() {
  const el = $('ed-cover');
  const letter = $('ed-cover-letter');
  if (!el || !edTrack) return;
  const cover = edTrack.cover || coverCache[edTrack.path] || '';
  el.style.backgroundImage = cover ? `url('${cover}')` : '';
  if (letter) letter.textContent = cover ? '' : (edTrack.title || '?').trim()[0] || '?';
}

function edRepaint() {
  edPaintBars();
  edPaintSelection();
}

async function openEditorFor(track) {
  if (!track) return;
  if (settings.editor === false) { settings.editor = true; saveSettings(); applyEditorVisibility(); renderSettings(); }
  edTrack = track;
  stopEditorPreview();
  setView('editor');
  $('ed-empty').classList.remove('show');
  $('ed-workspace').hidden = false;
  $('ed-track-title').textContent = track.title || '—';
  $('ed-track-artist').textContent = track.artist || '—';
  $('ed-track-file').textContent = track.path || '';
  edPaintCover();
  // The cover may not be cached yet (the disk-cache warm and the background
  // backfill are both async). Pull it on demand and repaint when it lands —
  // guarded so a track switched mid-fetch doesn't get the wrong artwork.
  if (!edTrack.cover && !coverCache[track.path] && track.hasCover !== false) {
    ensureCoverFor(track, true).then(() => { if (edTrack === track) edPaintCover(); });
  }
  // Provisional bounds from tag duration so the UI is usable while decoding.
  edDuration = Number(track.duration) || 0;
  edStart = 0;
  edEnd = edDuration;
  edPeaks = null;
  // Reset gain per track; headroom is unknown until the decode lands.
  edPeakAmp = 0;
  edSetGain(0);
  edRepaint();
  edPaintRuler();
  setEdStatus(tr('editor.decoding'));

  const token = ++edLoadToken;
  try {
    const bytes = await window.electronAPI.readAudioFile(track.path);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const res = await edDecodePeaks(ab, ED_BARS);
    if (token !== edLoadToken) return; // user switched tracks mid-decode
    edPeaks = res.peaks;
    edPeakAmp = Number(res.peak) || 0;
    edSetGain(edGainDb); // re-evaluate the clipping warning now headroom is known
    if (res.duration > 0) {
      // Decoded duration is authoritative — tag duration is often rounded.
      const keepFull = Math.abs(edEnd - edDuration) < 0.05;
      edDuration = res.duration;
      if (keepFull) edEnd = edDuration;
      edEnd = Math.min(edEnd, edDuration);
    }
    edRepaint();
    edPaintRuler();
    setEdStatus('');
  } catch (err) {
    if (token !== edLoadToken) return;
    setEdStatus(tr('editor.decodeError'), 'error');
  }
}

function edSetStart(sec) {
  edStart = Math.max(0, Math.min(sec, edEnd - 0.1));
  edRepaint();
}
function edSetEnd(sec) {
  edEnd = Math.min(edDuration, Math.max(sec, edStart + 0.1));
  edRepaint();
}

function edPosFromEvent(e) {
  const wave = $('ed-wave');
  const rect = wave.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  return pct * edDuration;
}

function stopEditorPreview() {
  if (edPreviewRaf) { cancelAnimationFrame(edPreviewRaf); edPreviewRaf = null; }
  if (edPreview) {
    try { edPreview.pause(); edPreview.src = ''; } catch (_) {}
    edPreview = null;
  }
  if (edGainNode) {
    try { edGainNode.disconnect(); } catch (_) {}
    edGainNode = null;
  }
  const ph = $('ed-playhead');
  if (ph) ph.hidden = true;
  const lbl = $('ed-preview-label');
  if (lbl) lbl.textContent = tr('editor.preview');
}

function toggleEditorPreview() {
  if (edPreview) { stopEditorPreview(); return; }
  if (!edTrack || edEnd <= edStart) return;
  // Pause main playback so the two don't overlap.
  if (!audio.paused) { audio.pause(); isPlaying = false; stopCrossfadeTail(); updatePlayButtonUI(); }
  const a = new Audio();
  edPreview = a;
  // Amplifying past 1.0 needs a WebAudio gain node; attenuating doesn't. Only
  // take the WebAudio path when actually boosting, so the common gain-free
  // preview keeps working exactly as it did even if routing were to fail.
  const ratio = Math.pow(10, edGainDb / 20);
  edGainNode = null;
  if (edGainDb > 0) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!edGainCtx) edGainCtx = new Ctx();
      if (edGainCtx.state === 'suspended') edGainCtx.resume().catch(() => {});
      const node = edGainCtx.createGain();
      node.gain.value = ratio;
      edGainCtx.createMediaElementSource(a).connect(node).connect(edGainCtx.destination);
      edGainNode = node;
    } catch (_) {
      edGainNode = null; // fall back to unamplified preview
    }
  } else {
    a.volume = Math.min(1, ratio);
  }
  a.addEventListener('loadedmetadata', () => {
    if (edPreview !== a) return;
    try { a.currentTime = edStart; } catch (_) {}
    a.play().catch(() => stopEditorPreview());
  }, { once: true });
  a.src = 'file://' + edTrack.path;
  const lbl = $('ed-preview-label');
  if (lbl) lbl.textContent = tr('editor.previewStop');
  const ph = $('ed-playhead');
  if (ph) ph.hidden = false;
  const tick = () => {
    if (edPreview !== a) return;
    if (a.currentTime >= edEnd) { stopEditorPreview(); return; }
    if (ph && edDuration > 0) ph.style.left = `${(a.currentTime / edDuration) * 100}%`;
    edPreviewRaf = requestAnimationFrame(tick);
  };
  edPreviewRaf = requestAnimationFrame(tick);
}

async function saveEditorTrim() {
  if (!edTrack) return;
  const saveBtn = $('ed-save-btn');
  if (edEnd - edStart < 0.1) { setEdStatus(tr('editor.tooShort'), 'error'); return; }
  const overwrite = $('ed-overwrite-toggle').classList.contains('on');
  const fadeIn = Math.max(0, parseFloat($('ed-fade-in').value) || 0);
  const fadeOut = Math.max(0, parseFloat($('ed-fade-out').value) || 0);
  stopEditorPreview();
  if (saveBtn) saveBtn.disabled = true;
  setEdStatus(tr('editor.trimming'));
  try {
    const res = await window.electronAPI.trimAudio({
      filePath: edTrack.path,
      start: edStart,
      end: edEnd,
      fadeIn,
      fadeOut,
      gain: edGainDb,
      overwrite,
    });
    if (!res || !res.success) {
      setEdStatus(tr('editor.saveError', { e: (res && res.error) || 'unknown' }), 'error');
      return;
    }
    if (overwrite) {
      // The file changed underneath us: re-read its tags.
      const fresh = await window.electronAPI.parseMetadata(edTrack.path);
      if (fresh) {
        Object.assign(edTrack, fresh, { cover: fresh.cover || edTrack.cover });
        const meta = libraryMeta.find(m => m.path === edTrack.path);
        if (meta) Object.assign(meta, { ...fresh, cover: undefined });
        saveLibrary();
      }
      refreshCurrentViewRows();
    } else {
      await importPaths([res.filePath]);
    }
    setEdStatus(tr('editor.trimSaved', { f: res.filePath.split('/').pop() }), 'ok');
    if (overwrite) openEditorFor(edTrack); // re-decode the shortened file
  } catch (err) {
    setEdStatus(tr('editor.saveError', { e: String(err) }), 'error');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

// Track picker modal
function renderEdPickList(filter) {
  const list = $('ed-pick-list');
  if (!list) return;
  const q = (filter || '').trim().toLowerCase();
  const items = library
    .filter(t => !q || (t.title || '').toLowerCase().includes(q) || (t.artist || '').toLowerCase().includes(q))
    .slice(0, 200);
  if (!items.length) {
    list.innerHTML = `<div class="sl-empty">${escapeHtml(tr('editor.pickEmpty'))}</div>`;
    return;
  }
  list.innerHTML = items.map(t => {
    const c = t.cover || coverCache[t.path] || '';
    const thumb = c
      ? `<span class="ed-pick-cover" style="background-image:url('${c}')"></span>`
      : `<span class="ed-pick-cover">${escapeHtml((t.title || '?').trim()[0] || '?')}</span>`;
    return `
    <div class="sl-item" data-ed-pick="${escapeHtml(t.path)}">
      ${thumb}
      <span class="ed-pick-text">
        ${escapeHtml(t.title || '—')}
        <span style="color:var(--text-dim);font-size:11px;margin-left:6px">${escapeHtml(t.artist || '—')}</span>
      </span>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-ed-pick]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = trackByPath(btn.getAttribute('data-ed-pick'));
      $('ed-pick-modal').classList.remove('active');
      if (t) openEditorFor(t);
    });
  });
}

(function wireEditor() {
  const wave = $('ed-wave');
  if (!wave) return;

  // Handle dragging
  let dragging = null; // 'start' | 'end'
  const onDown = (which) => (e) => { e.preventDefault(); e.stopPropagation(); dragging = which; };
  $('ed-handle-start').addEventListener('mousedown', onDown('start'));
  $('ed-handle-end').addEventListener('mousedown', onDown('end'));
  window.addEventListener('mousemove', e => {
    if (!dragging || edDuration <= 0) return;
    const pos = edPosFromEvent(e);
    if (dragging === 'start') edSetStart(pos); else edSetEnd(pos);
  });
  window.addEventListener('mouseup', () => { dragging = null; });

  // Click on the waveform moves the nearer handle — quicker than grabbing it.
  wave.addEventListener('mousedown', e => {
    if (dragging || edDuration <= 0) return;
    const pos = edPosFromEvent(e);
    if (Math.abs(pos - edStart) <= Math.abs(pos - edEnd)) edSetStart(pos);
    else edSetEnd(pos);
  });

  const commitStart = () => {
    const v = edParseTime($('ed-start').value);
    if (v === null) { edPaintSelection(); return; }
    edSetStart(Math.min(v, edDuration));
  };
  const commitEnd = () => {
    const v = edParseTime($('ed-end').value);
    if (v === null) { edPaintSelection(); return; }
    edSetEnd(Math.min(v, edDuration));
  };
  $('ed-start').addEventListener('change', commitStart);
  $('ed-start').addEventListener('keydown', e => { if (e.key === 'Enter') commitStart(); });
  $('ed-end').addEventListener('change', commitEnd);
  $('ed-end').addEventListener('keydown', e => { if (e.key === 'Enter') commitEnd(); });

  $('ed-preview-btn').addEventListener('click', toggleEditorPreview);
  $('ed-reset-btn').addEventListener('click', () => {
    edStart = 0;
    edEnd = edDuration;
    edSetGain(0);
    edRepaint();
    setEdStatus('');
  });
  $('ed-gain').addEventListener('input', e => edSetGain(e.target.value, { fromSlider: true }));
  $('ed-gain-reset').addEventListener('click', () => edSetGain(0));
  $('ed-save-btn').addEventListener('click', saveEditorTrim);
  $('ed-overwrite-toggle').addEventListener('click', () => {
    $('ed-overwrite-toggle').classList.toggle('on');
  });

  $('ed-pick-btn').addEventListener('click', () => {
    $('ed-pick-search').value = '';
    renderEdPickList('');
    $('ed-pick-modal').classList.add('active');
    focusModalInput($('ed-pick-search'));
  });
  $('ed-pick-cancel').addEventListener('click', () => $('ed-pick-modal').classList.remove('active'));
  $('ed-pick-search').addEventListener('input', e => renderEdPickList(e.target.value));
})();

// ── Downloads tabs ──
document.querySelectorAll('.dl-tabs .dl-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    activateDlTab(btn.dataset.dlTab);
  });
});

// A youtube.com / youtu.be link that isn't the music.youtube.com variant —
// those miss the 256kbps Premium audio tier that only music.youtube.com URLs
// expose, so warn the user to grab the YouTube Music link instead.
function isPlainYoutubeUrl(v) {
  let host;
  try { host = new URL(String(v || '').trim()).hostname.toLowerCase(); } catch (_) { return false; }
  if (host === 'music.youtube.com') return false;
  return host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
}
function updatePlainYtWarning(value, setStatus, statusId) {
  if (isPlainYoutubeUrl(value)) { setStatus(tr('downloads.warnPlainYoutube'), 'warn'); return; }
  const el = $(statusId);
  if (el && el.classList.contains('is-warn')) setStatus(null);
}

// Prefer a plain explanation over yt-dlp's raw English output — the geo case
// ends by suggesting a --proxy flag the user cannot pass here, and a
// "transient" failure (a bare errno/traceback fragment from yt-dlp's own
// postprocessing) reads like a crash when it usually just means "try again".
// Shared by the yt-dlp-backed download flows (YouTube Music parser,
// Spotify-via-YouTube) instead of each one showing the raw error.
function ytErrorText(res, fallbackKey) {
  const reason = res && res.reason;
  if (reason === 'geo') return tr('dlErr.geo');
  if (reason === 'unavailable') return tr('dlErr.unavailable');
  if (reason === 'signin') return tr('dlErr.signin');
  if (reason === 'members') return tr('dlErr.members');
  if (reason === 'network') return tr('dlErr.network');
  if (reason === 'transient') return tr('dlErr.transient');
  return tr(fallbackKey, { e: (res && res.error) || 'unknown' });
}

function explicitBadge(flag) {
  return flag === true ? '<span class="explicit-badge" title="Explicit">E</span>' : '';
}

// ── Downloads: Parsing sub-tabs ──
document.querySelectorAll('.dl-subtabs .dl-subtab').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.dlSubtab;
    document.querySelectorAll('.dl-subtabs .dl-subtab').forEach(t => {
      const on = t.dataset.dlSubtab === target;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.dl-subpane').forEach(p => {
      p.hidden = p.dataset.dlSubpane !== target;
    });
  });
});

// ── Downloads: YouTube Music parsing ──
// Mirrors the Spotify parser UI, but enumeration goes through yt-dlp (no browser)
// and downloads use the exact video id via the shared 'youtube' queue source, so
// dedup and progress routing are shared with the YouTube search tab.
let ytmParseActive = false;
let ytmTracks = [];
let ytmDownloadReqSeq = 0;
const ytmActiveDownloads = new Map(); // requestId -> rowEl (direct, non-queue downloads)

function setYtmStatus(text, kind) {
  const el = $('dl-ytm-status');
  if (!el) return;
  el.classList.remove('is-error', 'is-ok', 'is-warn');
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  if (kind === 'error') el.classList.add('is-error');
  else if (kind === 'ok') el.classList.add('is-ok');
  else if (kind === 'warn') el.classList.add('is-warn');
  el.hidden = false;
  el.textContent = text;
}

function saveYtmState() {
  try {
    const u = $('dl-ytm-url');
    localStorage.setItem(LS.ytmState, JSON.stringify({
      url: u ? u.value : '',
      tracks: ytmTracks,
    }));
  } catch (_) { /* ignore */ }
}

function isYtmTrackInQueue(t) {
  return t ? isYtResultInQueue({ id: t.id, url: t.url }) : false;
}

function renderYtmResults(tracks) {
  ytmTracks = tracks || [];
  saveYtmState();
  const wrap = $('dl-ytm-results');
  const rows = $('dl-ytm-rows');
  const empty = $('dl-ytm-empty');
  const note = $('dl-ytm-tag-note');
  const queueAllBtn = $('dl-ytm-queue-all');
  if (!wrap || !rows) return;
  if (!ytmTracks.length) {
    wrap.hidden = true;
    if (note) note.hidden = true;
    if (empty) empty.classList.add('show');
    if (queueAllBtn) queueAllBtn.hidden = true;
    return;
  }
  if (empty) empty.classList.remove('show');
  if (note) note.hidden = false;
  if (queueAllBtn) {
    queueAllBtn.hidden = false;
    queueAllBtn.disabled = ytmParseActive;
  }
  const disabledAttr = ytmParseActive ? ' disabled' : '';
  rows.innerHTML = ytmTracks.map((t, i) => {
    const queued = isYtmTrackInQueue(t);
    const queuedCls = queued ? ' is-done' : '';
    const queueDis = ytmParseActive || queued ? ' disabled' : '';
    const queueLabel = queued ? tr('downloads.queue.queued') : tr('downloads.queue.add');
    const coverStyle = t.cover ? `background-image:url('${escapeHtml(t.cover)}')` : '';
    return `
      <div class="dl-row-parse dl-row-ytm" data-ytm-row="${i}">
        <div class="num">${i + 1}</div>
        <div class="cover" style="${coverStyle}"></div>
        <div class="artist" title="${escapeHtml(t.artist || '')}">${escapeHtml(t.artist || '')}</div>
        <div class="title" title="${escapeHtml(t.title || '')}">${explicitBadge(t.explicit)}${escapeHtml(t.title || '')}</div>
        <div class="duration">${escapeHtml(t.duration || '')}</div>
        <div class="action">
          <button type="button" class="dl-download-btn dl-queue-btn${queuedCls}" data-ytm-queue="${i}"${queueDis} title="${escapeHtml(queueLabel)}">
            <svg class="i" width="12" height="12"><use href="#i-plus"/></svg>
            <span>${escapeHtml(queueLabel)}</span>
          </button>
          <button type="button" class="dl-download-btn" data-ytm-dl="${i}"${disabledAttr}>
            <svg class="i" width="12" height="12"><use href="#i-download"/></svg>
            <span>${escapeHtml(tr('downloads.yt.action.download'))}</span>
          </button>
        </div>
      </div>
    `;
  }).join('');
  wrap.hidden = false;
  rows.querySelectorAll('[data-ytm-dl]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-ytm-dl'), 10);
      if (!isNaN(idx)) downloadYtmTrack(idx, btn);
    });
  });
  rows.querySelectorAll('[data-ytm-queue]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-ytm-queue'), 10);
      if (!isNaN(idx)) enqueueYtmTrack(idx);
    });
  });
}

function restoreYtmDownloadButton(actionEl, idx, labelKey, cls) {
  actionEl.innerHTML = `
    <button type="button" class="dl-download-btn ${cls || ''}" data-ytm-dl="${idx}">
      <svg class="i" width="12" height="12"><use href="#i-download"/></svg>
      <span>${escapeHtml(tr(labelKey))}</span>
    </button>
  `;
  const newBtn = actionEl.querySelector('[data-ytm-dl]');
  if (newBtn) newBtn.addEventListener('click', () => downloadYtmTrack(idx, newBtn));
  return newBtn;
}

// Shared by every download flow (YouTube Music parser, Spotify-via-YouTube,
// and the queue worker): make sure a target folder is set (prompting once if
// not) and stamp the chosen folder + format onto the args before the download.
async function ensureDownloadArgs(args) {
  if (!settings.defaultFolder) {
    const folder = await window.electronAPI.chooseFolder();
    if (!folder) return null;
    settings.defaultFolder = folder;
    saveSettings();
    renderSettings();
  }
  return { ...args, targetDir: settings.defaultFolder, format: settings.dlFormat };
}

async function ytDownload(args) {
  const full = await ensureDownloadArgs(args);
  if (!full) return { success: false, error: tr('downloads.noFolder') };
  return window.electronAPI.ytDownload(full);
}

async function ytDownloadByQuery(args) {
  const full = await ensureDownloadArgs(args);
  if (!full) return { success: false, error: tr('downloads.noFolder') };
  return window.electronAPI.ytDownloadByQuery(full);
}

async function downloadYtmTrack(idx, btn) {
  const t = ytmTracks[idx];
  if (!t || !btn) return;
  if (btn.classList.contains('is-done')) return;
  const rowEl = btn.closest('.dl-row-parse');
  if (!rowEl) return;
  const actionEl = rowEl.querySelector('.action');
  if (!actionEl) return;

  const requestId = 'ytm-' + (++ytmDownloadReqSeq);
  rowEl.dataset.requestId = requestId;
  actionEl.innerHTML = `
    <div class="dl-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="dl-progress-bar"><div class="dl-progress-fill"></div></div>
      <div class="dl-progress-pct">0%</div>
    </div>
  `;
  ytmActiveDownloads.set(requestId, rowEl);

  const suggestedName = t.artist ? `${t.artist} - ${t.title}` : t.title;

  try {
    const res = await ytDownload({ videoId: t.id, url: t.url, suggestedName, artist: t.artist || '', album: t.album || '', requestId, explicit: t.explicit });
    ytmActiveDownloads.delete(requestId);
    if (!res || !res.success) {
      restoreYtmDownloadButton(actionEl, idx, 'downloads.yt.action.retry', 'is-error');
      setYtmStatus(ytErrorText(res, 'downloads.yt.downloadError'), 'error');
      return;
    }
    await importPaths([res.filePath]);
    await fillPredictedTrackNo(res.filePath, idx + 1);
    const doneBtn = restoreYtmDownloadButton(actionEl, idx, 'downloads.yt.action.done', 'is-done');
    if (doneBtn) doneBtn.disabled = true;
    setYtmStatus(tr('downloads.yt.downloadOk', { t: suggestedName }), 'ok');
  } catch (err) {
    ytmActiveDownloads.delete(requestId);
    restoreYtmDownloadButton(actionEl, idx, 'downloads.yt.action.retry', 'is-error');
    setYtmStatus(tr('downloads.yt.downloadError', { e: String(err) }), 'error');
  }
}

if (window.electronAPI && window.electronAPI.onYtDownloadProgress) {
  window.electronAPI.onYtDownloadProgress(({ requestId, phase, percent }) => {
    if (!requestId) return;
    const rowEl = ytmActiveDownloads.get(requestId);
    if (!rowEl) return;
    const fill = rowEl.querySelector('.dl-progress-fill');
    const pct = rowEl.querySelector('.dl-progress-pct');
    const wrap = rowEl.querySelector('.dl-progress');
    if (!fill || !pct || !wrap) return;
    if (phase === 'postprocess') {
      wrap.classList.add('is-indeterminate');
      pct.textContent = '…';
      return;
    }
    if (typeof percent === 'number' && !isNaN(percent)) {
      wrap.classList.remove('is-indeterminate');
      fill.style.width = percent.toFixed(1) + '%';
      pct.textContent = Math.round(percent) + '%';
    }
  });
}

// yt-dlp's --add-metadata rarely carries a real track-number tag for YouTube
// sources, but the position on the parsed album/playlist page is a reasonable
// stand-in. Only fills the tag when the file didn't already come with one, so
// a real embedded track number (or a later manual edit) is never overwritten.
async function fillPredictedTrackNo(filePath, predictedNo) {
  if (!predictedNo) return;
  const t = trackByPath(filePath);
  if (!t || t.trackNo) return;
  try {
    const res = await window.electronAPI.writeMetadata(filePath, { trackNo: String(predictedNo) });
    if (res && res.success) {
      t.trackNo = String(predictedNo);
      saveLibrary();
      refreshCurrentViewRows();
    }
  } catch (_) { /* leave the tag blank — not worth surfacing an error for a guess */ }
}

function buildQueueItemFromYtm(t, albumTrackNo) {
  return {
    id: 'q-' + (++queueIdSeq),
    source: 'youtube',
    key: ytTrackKey({ id: t.id, url: t.url }),
    artist: t.artist || '',
    title: t.title || '',
    album: t.album || '',
    duration: t.duration || '',
    query: t.artist ? `${t.artist} ${t.title}` : (t.title || ''),
    suggestedName: t.artist ? `${t.artist} - ${t.title}` : (t.title || ''),
    videoId: t.id || '',
    url: t.url || '',
    explicit: (t.explicit === true || t.explicit === false) ? t.explicit : null,
    status: 'queued',
    percent: 0,
    indeterminate: false,
    filePath: '',
    error: '',
    requestId: '',
    // Position on the parsed album/playlist page — used to fill in a missing
    // track-number tag after download (see fillPredictedTrackNo). Not set for
    // queue items from plain YouTube search or Spotify, which have no such order.
    albumTrackNo,
  };
}

function enqueueYtmTrack(idx) {
  const t = ytmTracks[idx];
  if (!t || isYtmTrackInQueue(t)) return;
  downloadQueue.push(buildQueueItemFromYtm(t, idx + 1));
  renderQueue();
  renderYtmResults(ytmTracks);
  updateQueueTabBadge();
  startQueueWorker();
}

function enqueueAllYtmTracks() {
  if (!ytmTracks || !ytmTracks.length) return;
  let added = 0;
  ytmTracks.forEach((t, i) => {
    if (isYtmTrackInQueue(t)) return;
    downloadQueue.push(buildQueueItemFromYtm(t, i + 1));
    added++;
  });
  if (added > 0) {
    renderQueue();
    renderYtmResults(ytmTracks);
    updateQueueTabBadge();
    startQueueWorker();
  }
}

async function runYtmParse() {
  if (ytmParseActive) return;
  const urlEl = $('dl-ytm-url');
  const startBtn = $('dl-ytm-parse-btn');
  if (!urlEl) return;
  const url = urlEl.value.trim();
  if (!url) { urlEl.focus(); return; }
  ytmParseActive = true;
  if (startBtn) startBtn.disabled = true;
  renderYtmResults([]);
  setYtmStatus(tr('downloads.parsing.starting'));
  try {
    const res = await window.electronAPI.ytMusicParse({ url });
    if (!res || !res.success) {
      setYtmStatus(tr('downloads.parsing.error', { e: (res && res.error) || 'unknown' }), 'error');
    } else {
      setYtmStatus(tr('downloads.parsing.done', { n: res.tracks.length }), 'ok');
      renderYtmResults(res.tracks);
    }
  } catch (err) {
    setYtmStatus(tr('downloads.parsing.error', { e: String(err) }), 'error');
  } finally {
    ytmParseActive = false;
    if (startBtn) startBtn.disabled = false;
    if (ytmTracks && ytmTracks.length) renderYtmResults(ytmTracks);
  }
}

(function wireYtmControls() {
  const start = $('dl-ytm-parse-btn');
  const url = $('dl-ytm-url');
  const queueAll = $('dl-ytm-queue-all');
  if (start) start.addEventListener('click', runYtmParse);
  if (queueAll) queueAll.addEventListener('click', enqueueAllYtmTracks);
  if (url) {
    url.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); runYtmParse(); }
    });
    url.addEventListener('input', saveYtmState);
    url.addEventListener('input', () => updatePlainYtWarning(url.value, setYtmStatus, 'dl-ytm-status'));
  }
})();

// ── Downloads: Spotify parsing ──
// Track lists come from a background BrowserWindow scraping the
// Spotify web player, downloads go through ytsearch1: by "artist title" query
// (Spotify itself serves no downloadable audio). Rows reuse the YTM layout
// because Spotify pages give us per-track covers.
let spParseActive = false;
let spTracks = [];
let spDownloadReqSeq = 0;
const spActiveDownloads = new Map(); // requestId -> rowEl

function setSpStatus(text, kind) {
  const el = $('dl-sp-status');
  if (!el) return;
  el.classList.remove('is-error', 'is-ok');
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  if (kind === 'error') el.classList.add('is-error');
  else if (kind === 'ok') el.classList.add('is-ok');
  el.hidden = false;
  el.textContent = text;
}

function saveSpState() {
  try {
    const u = $('dl-sp-url');
    localStorage.setItem(LS.spState, JSON.stringify({
      url: u ? u.value : '',
      tracks: spTracks,
    }));
  } catch (_) { /* ignore */ }
}

function renderSpResults(tracks) {
  spTracks = tracks || [];
  saveSpState();
  const wrap = $('dl-sp-results');
  const rows = $('dl-sp-rows');
  const empty = $('dl-sp-empty');
  const note = $('dl-sp-tag-note');
  const queueAllBtn = $('dl-sp-queue-all');
  if (!wrap || !rows) return;
  if (!spTracks.length) {
    wrap.hidden = true;
    if (note) note.hidden = true;
    if (empty) empty.classList.add('show');
    if (queueAllBtn) queueAllBtn.hidden = true;
    return;
  }
  if (empty) empty.classList.remove('show');
  if (note) note.hidden = false;
  if (queueAllBtn) {
    queueAllBtn.hidden = false;
    queueAllBtn.disabled = spParseActive;
  }
  const disabledAttr = spParseActive ? ' disabled' : '';
  rows.innerHTML = spTracks.map((t, i) => {
    const queued = isSpTrackInQueue(t);
    const queuedCls = queued ? ' is-done' : '';
    const queueDis = spParseActive || queued ? ' disabled' : '';
    const queueLabel = queued ? tr('downloads.queue.queued') : tr('downloads.queue.add');
    const coverStyle = t.cover_url ? `background-image:url('${escapeHtml(t.cover_url)}')` : '';
    return `
      <div class="dl-row-parse dl-row-ytm" data-sp-row="${i}">
        <div class="num">${i + 1}</div>
        <div class="cover" style="${coverStyle}"></div>
        <div class="artist" title="${escapeHtml(t.artist || '')}">${escapeHtml(t.artist || '')}</div>
        <div class="title" title="${escapeHtml(t.title || '')}">${escapeHtml(t.title || '')}</div>
        <div class="duration">${escapeHtml(t.duration || '')}</div>
        <div class="action">
          <button type="button" class="dl-download-btn dl-queue-btn${queuedCls}" data-sp-queue="${i}"${queueDis} title="${escapeHtml(queueLabel)}">
            <svg class="i" width="12" height="12"><use href="#i-plus"/></svg>
            <span>${escapeHtml(queueLabel)}</span>
          </button>
          <button type="button" class="dl-download-btn" data-sp-dl="${i}"${disabledAttr}>
            <svg class="i" width="12" height="12"><use href="#i-download"/></svg>
            <span>${escapeHtml(tr('downloads.yt.action.download'))}</span>
          </button>
        </div>
      </div>
    `;
  }).join('');
  wrap.hidden = false;
  rows.querySelectorAll('[data-sp-dl]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-sp-dl'), 10);
      if (!isNaN(idx)) downloadSpTrack(idx, btn);
    });
  });
  rows.querySelectorAll('[data-sp-queue]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-sp-queue'), 10);
      if (!isNaN(idx)) enqueueSpTrack(idx);
    });
  });
}

function restoreSpDownloadButton(actionEl, idx, labelKey, cls) {
  actionEl.innerHTML = `
    <button type="button" class="dl-download-btn ${cls || ''}" data-sp-dl="${idx}">
      <svg class="i" width="12" height="12"><use href="#i-download"/></svg>
      <span>${escapeHtml(tr(labelKey))}</span>
    </button>
  `;
  const newBtn = actionEl.querySelector('[data-sp-dl]');
  if (newBtn) newBtn.addEventListener('click', () => downloadSpTrack(idx, newBtn));
  return newBtn;
}

async function downloadSpTrack(idx, btn) {
  const t = spTracks[idx];
  if (!t || !btn) return;
  if (btn.classList.contains('is-done')) return;
  const rowEl = btn.closest('.dl-row-parse');
  if (!rowEl) return;
  const actionEl = rowEl.querySelector('.action');
  if (!actionEl) return;

  const requestId = 'sp-' + (++spDownloadReqSeq);
  rowEl.dataset.requestId = requestId;
  actionEl.innerHTML = `
    <div class="dl-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="dl-progress-bar"><div class="dl-progress-fill"></div></div>
      <div class="dl-progress-pct">0%</div>
    </div>
  `;
  spActiveDownloads.set(requestId, rowEl);

  const query = `${t.artist} ${t.title}`.replace(/—/g, '').trim();
  const suggestedName = `${t.artist} - ${t.title}`;

  try {
    const res = await ytDownloadByQuery({ query, suggestedName, artist: t.artist || '', requestId });
    spActiveDownloads.delete(requestId);
    if (!res || !res.success) {
      restoreSpDownloadButton(actionEl, idx, 'downloads.yt.action.retry', 'is-error');
      setSpStatus(ytErrorText(res, 'downloads.yt.downloadError'), 'error');
      return;
    }
    await importPaths([res.filePath]);
    const doneBtn = restoreSpDownloadButton(actionEl, idx, 'downloads.yt.action.done', 'is-done');
    if (doneBtn) doneBtn.disabled = true;
    setSpStatus(tr('downloads.yt.downloadOk', { t: suggestedName }), 'ok');
  } catch (err) {
    spActiveDownloads.delete(requestId);
    restoreSpDownloadButton(actionEl, idx, 'downloads.yt.action.retry', 'is-error');
    setSpStatus(tr('downloads.yt.downloadError', { e: String(err) }), 'error');
  }
}

if (window.electronAPI && window.electronAPI.onYtDownloadProgress) {
  window.electronAPI.onYtDownloadProgress(({ requestId, phase, percent }) => {
    if (!requestId) return;
    const rowEl = spActiveDownloads.get(requestId);
    if (!rowEl) return;
    const fill = rowEl.querySelector('.dl-progress-fill');
    const pct = rowEl.querySelector('.dl-progress-pct');
    const wrap = rowEl.querySelector('.dl-progress');
    if (!fill || !pct || !wrap) return;
    if (phase === 'postprocess') {
      wrap.classList.add('is-indeterminate');
      pct.textContent = '…';
      return;
    }
    if (typeof percent === 'number' && !isNaN(percent)) {
      wrap.classList.remove('is-indeterminate');
      fill.style.width = percent.toFixed(1) + '%';
      pct.textContent = Math.round(percent) + '%';
    }
  });
}

if (window.electronAPI && window.electronAPI.onSpotifyParseProgress) {
  window.electronAPI.onSpotifyParseProgress((data) => {
    if (!data) return;
    if (data.message) {
      const total = typeof data.total === 'number' ? ` · ${data.total}` : '';
      setSpStatus(data.message + total, data.phase === 'error' ? 'error' : null);
    }
    if (Array.isArray(data.tracks)) {
      renderSpResults(data.tracks);
    }
  });
}

function isSpTrackInQueue(t) {
  if (!t) return false;
  const key = textTrackKey(t);
  return downloadQueue.some(it => it.source === 'spotify' && it.key === key && it.status !== 'error');
}

function buildQueueItemFromSp(t, albumTrackNo) {
  return {
    id: 'q-' + (++queueIdSeq),
    source: 'spotify',
    key: textTrackKey(t),
    artist: t.artist || '',
    title: t.title || '',
    duration: t.duration || '',
    query: `${t.artist || ''} ${t.title || ''}`.replace(/—/g, '').trim(),
    suggestedName: `${t.artist || ''} - ${t.title || ''}`,
    videoId: '',
    url: '',
    status: 'queued',
    percent: 0,
    indeterminate: false,
    filePath: '',
    error: '',
    requestId: '',
    // Position on the parsed Spotify playlist page — same use as
    // buildQueueItemFromYtm's albumTrackNo, see fillPredictedTrackNo.
    albumTrackNo,
  };
}

function enqueueSpTrack(idx) {
  const t = spTracks[idx];
  if (!t || isSpTrackInQueue(t)) return;
  downloadQueue.push(buildQueueItemFromSp(t, idx + 1));
  renderQueue();
  renderSpResults(spTracks);
  updateQueueTabBadge();
  startQueueWorker();
}

function enqueueAllSpTracks() {
  if (!spTracks || !spTracks.length) return;
  let added = 0;
  spTracks.forEach((t, idx) => {
    if (isSpTrackInQueue(t)) return;
    downloadQueue.push(buildQueueItemFromSp(t, idx + 1));
    added++;
  });
  if (added > 0) {
    renderQueue();
    renderSpResults(spTracks);
    updateQueueTabBadge();
    startQueueWorker();
  }
}

async function runSpParse() {
  if (spParseActive) return;
  const urlEl = $('dl-sp-url');
  const startBtn = $('dl-sp-parse-btn');
  if (!urlEl) return;
  const url = urlEl.value.trim();
  if (!url) { urlEl.focus(); return; }
  spParseActive = true;
  if (startBtn) startBtn.disabled = true;
  renderSpResults([]);
  setSpStatus(tr('downloads.parsing.starting'));
  try {
    const res = await window.electronAPI.spotifyParse({ url, showBrowser: !!settings.showParserBrowser });
    if (!res || !res.success) {
      setSpStatus(tr('downloads.parsing.error', { e: (res && res.error) || 'unknown' }), 'error');
      if (res && Array.isArray(res.tracks) && res.tracks.length) renderSpResults(res.tracks);
    } else {
      setSpStatus(tr('downloads.parsing.done', { n: res.tracks.length }), 'ok');
      renderSpResults(res.tracks);
    }
  } catch (err) {
    setSpStatus(tr('downloads.parsing.error', { e: String(err) }), 'error');
  } finally {
    spParseActive = false;
    if (startBtn) startBtn.disabled = false;
    if (spTracks && spTracks.length) renderSpResults(spTracks);
  }
}

(function wireSpControls() {
  const start = $('dl-sp-parse-btn');
  const url = $('dl-sp-url');
  const queueAll = $('dl-sp-queue-all');
  if (start) start.addEventListener('click', runSpParse);
  if (queueAll) queueAll.addEventListener('click', enqueueAllSpTracks);
  if (url) {
    url.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); runSpParse(); }
    });
    url.addEventListener('input', saveSpState);
  }
})();

// ── Downloads: Queue ──
// In-memory queue (per session). Items move queued → downloading → done|error.
// One concurrent download keeps things simple and predictable.
const downloadQueue = [];
const queueByRequestId = new Map(); // requestId → item.id (for progress routing)
let queueWorkerRunning = false;
let queueIdSeq = 0;
let queuePaused = false;

function textTrackKey(t) {
  return `${(t.artist || '').trim().toLowerCase()}|${(t.title || '').trim().toLowerCase()}`;
}

function ytTrackKey(r) {
  return r && r.id ? `yt:${r.id}` : `yt:${(r && r.url) || ''}`;
}

function isYtResultInQueue(r) {
  if (!r) return false;
  const key = ytTrackKey(r);
  return downloadQueue.some(it => it.source === 'youtube' && it.key === key && it.status !== 'error');
}

function nextQueuedItem() {
  if (queuePaused) return null;
  return downloadQueue.find(it => it.status === 'queued');
}

async function startQueueWorker() {
  if (queueWorkerRunning) return;
  queueWorkerRunning = true;
  try {
    while (true) {
      const item = nextQueuedItem();
      if (!item) break;
      await processQueueItem(item);
    }
  } finally {
    queueWorkerRunning = false;
  }
}

function setQueuePaused(paused) {
  queuePaused = !!paused;
  saveQueueState();
  renderQueue();
  updateQueueTabBadge();
  if (!queuePaused) startQueueWorker();
}

async function processQueueItem(item) {
  item.status = 'downloading';
  item.percent = 0;
  item.indeterminate = false;
  item.requestId = item.id; // reuse our item id as requestId for progress routing
  queueByRequestId.set(item.requestId, item.id);
  renderQueue();
  try {
    let res;
    if (item.source === 'youtube' && (item.videoId || item.url)) {
      // YouTube items have a concrete video id — download that exact video.
      res = await ytDownload({
        videoId: item.videoId,
        url: item.url,
        suggestedName: item.suggestedName,
        artist: item.artist || '',
        album: item.album || '',
        requestId: item.requestId,
        explicit: item.explicit,
      });
    } else {
      // Spotify (and any text-only source) goes through ytsearch1: by query.
      res = await ytDownloadByQuery({
        query: item.query,
        suggestedName: item.suggestedName,
        artist: item.artist || '',
        requestId: item.requestId,
      });
    }
    queueByRequestId.delete(item.requestId);
    if (!res || !res.success) {
      item.status = 'error';
      item.error = (res && res.error) || tr('error.unknown');
    } else {
      item.status = 'done';
      item.percent = 100;
      item.filePath = res.filePath;
      try {
        await importPaths([res.filePath]);
        if (item.albumTrackNo) await fillPredictedTrackNo(res.filePath, item.albumTrackNo);
      } catch (_) { /* ignore */ }
    }
  } catch (err) {
    queueByRequestId.delete(item.requestId);
    item.status = 'error';
    item.error = String(err);
  }
  renderQueue();
  renderYtmResults(ytmTracks);
  renderSpResults(spTracks);
  updateQueueTabBadge();
}

function handleQueueProgress(requestId, phase, percent) {
  const itemId = queueByRequestId.get(requestId);
  if (!itemId) return false;
  const item = downloadQueue.find(it => it.id === itemId);
  if (!item || item.status !== 'downloading') return true;
  if (phase === 'postprocess') {
    item.indeterminate = true;
  } else if (typeof percent === 'number' && !isNaN(percent)) {
    item.indeterminate = false;
    item.percent = percent;
  }
  // Patch the visible row in place rather than re-rendering the whole list.
  patchQueueRowProgress(item);
  return true;
}

if (window.electronAPI && window.electronAPI.onYtDownloadProgress) {
  // Layer queue routing on top of the existing YT/YM progress listeners.
  // The earlier listeners only act if they recognise the requestId, so this
  // additional handler simply claims queue-owned ids without conflict.
  window.electronAPI.onYtDownloadProgress(({ requestId, phase, percent }) => {
    if (!requestId) return;
    handleQueueProgress(requestId, phase, percent);
  });
}

function queueStatusLabel(item) {
  switch (item.status) {
    case 'queued': return tr('downloads.queue.status.queued');
    case 'downloading': return tr('downloads.queue.status.downloading');
    case 'done': return tr('downloads.queue.status.done');
    case 'error': return tr('downloads.queue.status.error');
    default: return '';
  }
}

function saveQueueState() {
  try {
    // Persist a normalised snapshot. An in-flight item is recorded as 'queued' so
    // a reload re-attempts the download rather than leaving an orphaned row that
    // never finishes (the actual yt-dlp spawn dies with the renderer anyway).
    const items = downloadQueue.map(it => ({
      id: it.id,
      source: it.source,
      key: it.key,
      artist: it.artist,
      title: it.title,
      duration: it.duration,
      query: it.query,
      suggestedName: it.suggestedName,
      videoId: it.videoId || '',
      url: it.url || '',
      status: it.status === 'downloading' ? 'queued' : it.status,
      filePath: it.filePath || '',
      error: it.error || '',
    }));
    localStorage.setItem(LS.queue, JSON.stringify({ paused: queuePaused, items }));
  } catch (_) { /* ignore */ }
}

function renderQueue() {
  saveQueueState();
  const list = $('dl-queue-list');
  const empty = $('dl-queue-empty');
  const stats = $('dl-queue-stats');
  const clearBtn = $('dl-queue-clear-done');
  const clearAllBtn = $('dl-queue-clear-all');
  const pauseBtn = $('dl-queue-pause');
  const pauseLabel = $('dl-queue-pause-label');
  if (!list) return;

  // Pause button: shown whenever there are queued/downloading items; otherwise
  // pausing has no effect and just adds noise.
  const hasActive = downloadQueue.some(it => it.status === 'queued' || it.status === 'downloading');
  if (pauseBtn) {
    pauseBtn.hidden = !hasActive;
    pauseBtn.classList.toggle('is-paused', queuePaused);
    const useEl = pauseBtn.querySelector('use');
    if (useEl) useEl.setAttribute('href', queuePaused ? '#i-play' : '#i-pause');
  }
  if (pauseLabel) pauseLabel.textContent = queuePaused ? tr('downloads.queue.resume') : tr('downloads.queue.pause');

  if (!downloadQueue.length) {
    list.innerHTML = '';
    if (empty) empty.classList.add('show');
    if (stats) stats.textContent = '';
    if (clearBtn) clearBtn.hidden = true;
    if (clearAllBtn) clearAllBtn.hidden = true;
    return;
  }
  if (empty) empty.classList.remove('show');

  const counts = { queued: 0, downloading: 0, done: 0, error: 0 };
  for (const it of downloadQueue) counts[it.status]++;
  if (stats) {
    const parts = [];
    if (queuePaused) parts.push(tr('downloads.queue.stats.paused'));
    if (counts.downloading) parts.push(tr('downloads.queue.stats.downloading', { n: counts.downloading }));
    if (counts.queued) parts.push(tr('downloads.queue.stats.queued', { n: counts.queued }));
    if (counts.done) parts.push(tr('downloads.queue.stats.done', { n: counts.done }));
    if (counts.error) parts.push(tr('downloads.queue.stats.error', { n: counts.error }));
    stats.textContent = parts.join(' · ');
  }
  if (clearBtn) clearBtn.hidden = !(counts.done || counts.error);
  if (clearAllBtn) clearAllBtn.hidden = false;

  list.innerHTML = downloadQueue.map(it => renderQueueRow(it)).join('');
  list.querySelectorAll('[data-q-retry]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-q-retry');
      const item = downloadQueue.find(x => x.id === id);
      if (!item) return;
      item.status = 'queued';
      item.error = '';
      item.percent = 0;
      renderQueue();
      updateQueueTabBadge();
      startQueueWorker();
    });
  });
  list.querySelectorAll('[data-q-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-q-remove');
      const idx = downloadQueue.findIndex(x => x.id === id);
      if (idx < 0) return;
      const item = downloadQueue[idx];
      // Don't allow removing an active download mid-flight; cancellation isn't wired.
      if (item.status === 'downloading') return;
      downloadQueue.splice(idx, 1);
      renderQueue();
      renderYtmResults(ytmTracks);
      renderSpResults(spTracks);
      updateQueueTabBadge();
    });
  });
}

function renderQueueRow(item) {
  const showProgress = item.status === 'downloading';
  const indetCls = item.indeterminate ? ' is-indeterminate' : '';
  const pctText = item.indeterminate ? '…' : (Math.round(item.percent) + '%');
  const removeDis = item.status === 'downloading' ? ' disabled' : '';
  const errorLine = item.status === 'error' && item.error
    ? `<div class="dl-queue-error" title="${escapeHtml(item.error)}">${escapeHtml(item.error)}</div>`
    : '';
  const retryBtn = item.status === 'error'
    ? `<button type="button" class="dl-download-btn" data-q-retry="${item.id}" title="${escapeHtml(tr('downloads.yt.action.retry'))}">
         <svg class="i" width="12" height="12"><use href="#i-download"/></svg>
         <span>${escapeHtml(tr('downloads.yt.action.retry'))}</span>
       </button>`
    : '';
  const progressBlock = showProgress
    ? `<div class="dl-queue-progress" data-q-row-progress="${item.id}">
         <div class="dl-progress${indetCls}">
           <div class="dl-progress-bar"><div class="dl-progress-fill" style="width:${item.indeterminate ? 40 : item.percent.toFixed(1)}%"></div></div>
           <div class="dl-progress-pct">${escapeHtml(pctText)}</div>
         </div>
       </div>`
    : '';
  return `
    <div class="dl-queue-row dl-queue-${item.status}" data-q-row="${item.id}">
      <div class="dl-queue-info">
        <div class="dl-queue-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title || '—')}</div>
        <div class="dl-queue-artist" title="${escapeHtml(item.artist)}">${escapeHtml(item.artist || '—')}</div>
        ${errorLine}
      </div>
      <div class="dl-queue-mid">
        <span class="dl-queue-badge dl-queue-badge-${item.status}">${escapeHtml(queueStatusLabel(item))}</span>
        ${progressBlock}
      </div>
      <div class="dl-queue-actions">
        ${retryBtn}
        <button type="button" class="dl-icon-btn" data-q-remove="${item.id}"${removeDis} title="${escapeHtml(tr('downloads.queue.remove'))}">
          <svg class="i" width="12" height="12"><use href="#i-close"/></svg>
        </button>
      </div>
    </div>
  `;
}

function patchQueueRowProgress(item) {
  const list = $('dl-queue-list');
  if (!list) return;
  const row = list.querySelector(`[data-q-row="${item.id}"]`);
  if (!row) {
    // Row not on screen — full re-render handles transitions.
    renderQueue();
    return;
  }
  const wrap = row.querySelector('.dl-progress');
  if (!wrap) { renderQueue(); return; }
  const fill = wrap.querySelector('.dl-progress-fill');
  const pct = wrap.querySelector('.dl-progress-pct');
  if (item.indeterminate) {
    wrap.classList.add('is-indeterminate');
    if (pct) pct.textContent = '…';
  } else {
    wrap.classList.remove('is-indeterminate');
    if (fill) fill.style.width = item.percent.toFixed(1) + '%';
    if (pct) pct.textContent = Math.round(item.percent) + '%';
  }
}

function updateQueueTabBadge() {
  const active = downloadQueue.filter(it => it.status === 'queued' || it.status === 'downloading').length;
  const badge = $('dl-queue-tab-count');
  if (badge) {
    badge.hidden = active === 0;
    badge.textContent = String(active);
  }
  const sideBadge = $('count-downloads');
  if (sideBadge) {
    sideBadge.hidden = active === 0;
    sideBadge.textContent = String(active);
  }
}

function clearFinishedFromQueue() {
  for (let i = downloadQueue.length - 1; i >= 0; i--) {
    if (downloadQueue[i].status === 'done' || downloadQueue[i].status === 'error') {
      downloadQueue.splice(i, 1);
    }
  }
  renderQueue();
  renderYtmResults(ytmTracks);
  renderSpResults(spTracks);
  updateQueueTabBadge();
}

function clearAllFromQueue() {
  // Keep the in-flight download alive — cancellation isn't wired through yt-dlp.
  // Removing the active row would orphan its progress events and leave the file
  // half-downloaded on disk.
  for (let i = downloadQueue.length - 1; i >= 0; i--) {
    if (downloadQueue[i].status !== 'downloading') {
      downloadQueue.splice(i, 1);
    }
  }
  renderQueue();
  renderYtmResults(ytmTracks);
  renderSpResults(spTracks);
  updateQueueTabBadge();
}

function activateDlTab(target) {
  document.querySelectorAll('.dl-tabs .dl-tab').forEach(t => {
    const on = t.dataset.dlTab === target;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.dl-pane').forEach(p => {
    p.hidden = p.dataset.dlPane !== target;
  });
  if (target === 'queue') renderQueue();
}

(function wireQueueControls() {
  const clearBtn = $('dl-queue-clear-done');
  if (clearBtn) clearBtn.addEventListener('click', clearFinishedFromQueue);
  const clearAllBtn = $('dl-queue-clear-all');
  if (clearAllBtn) clearAllBtn.addEventListener('click', clearAllFromQueue);
  const pauseBtn = $('dl-queue-pause');
  if (pauseBtn) pauseBtn.addEventListener('click', () => setQueuePaused(!queuePaused));
})();

// ── Downloads: session restore ──
// Restores YouTube Music / Spotify parsed tracks and the download queue from
// localStorage. Items that were mid-download when the session ended are reset
// to 'queued' so the worker re-attempts them.
function restoreDownloadsState() {
  try {
    const raw = localStorage.getItem(LS.ytmState);
    if (raw) {
      const ytm = JSON.parse(raw);
      const urlEl = $('dl-ytm-url');
      if (urlEl && typeof ytm.url === 'string') urlEl.value = ytm.url;
      if (Array.isArray(ytm.tracks) && ytm.tracks.length) renderYtmResults(ytm.tracks);
    }
  } catch (_) { /* ignore */ }
  try {
    const raw = localStorage.getItem(LS.spState);
    if (raw) {
      const sp = JSON.parse(raw);
      const urlEl = $('dl-sp-url');
      if (urlEl && typeof sp.url === 'string') urlEl.value = sp.url;
      if (Array.isArray(sp.tracks) && sp.tracks.length) renderSpResults(sp.tracks);
    }
  } catch (_) { /* ignore */ }
  try {
    const raw = localStorage.getItem(LS.queue);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    // Accept both the legacy plain-array shape and the new {paused, items} shape.
    const items = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : []);
    if (parsed && !Array.isArray(parsed)) queuePaused = !!parsed.paused;
    if (!items.length) return;
    for (const it of items) {
      const id = typeof it.id === 'string' ? it.id : ('q-' + (++queueIdSeq));
      const m = id.match(/^q-(\d+)$/);
      if (m) queueIdSeq = Math.max(queueIdSeq, parseInt(m[1], 10));
      downloadQueue.push({
        id,
        source: it.source || 'spotify',
        key: it.key || '',
        artist: it.artist || '',
        title: it.title || '',
        duration: it.duration || '',
        query: it.query || '',
        suggestedName: it.suggestedName || '',
        videoId: it.videoId || '',
        url: it.url || '',
        status: it.status === 'downloading' ? 'queued' : (it.status || 'queued'),
        percent: 0,
        indeterminate: false,
        filePath: it.filePath || '',
        error: it.error || '',
        requestId: '',
      });
    }
    renderQueue();
    // Re-render result rows so any "queued" badges reflect the restored queue.
    if (ytmTracks && ytmTracks.length) renderYtmResults(ytmTracks);
    if (spTracks && spTracks.length) renderSpResults(spTracks);
    updateQueueTabBadge();
    startQueueWorker();
  } catch (_) { /* ignore */ }
}

// ── Render: sidebar counts + recents ──
function renderCounts() {
  $('count-library').textContent = library.length;
  $('count-playlists').textContent = playlists.length;
  $('count-favorites').textContent = favorites.length;
  const artistsCountEl = $('count-artists');
  if (artistsCountEl) artistsCountEl.textContent = visibleArtists().length;
  const albumsCountEl = $('count-albums');
  if (albumsCountEl) albumsCountEl.textContent = buildAlbumsIndex().length;
  updateQueueTabBadge();
}
function renderRecents() {
  const list = $('recents-list');
  list.innerHTML = '';
  recents.slice(0, 4).forEach(path => {
    const t = trackByPath(path);
    if (!t) return;
    if (!t.cover) ensureCoverFor(t);
    const el = document.createElement('div');
    el.className = 'recent-item';
    const cover = t.cover ? `background-image:url('${t.cover}')` : '';
    el.innerHTML = `
      <div class="recent-swatch" style="${cover}"></div>
      <div class="recent-body">
        <div class="recent-name">${escapeHtml(t.title)}</div>
        <div class="recent-meta">${escapeHtml(t.artist)}</div>
      </div>
    `;
    el.addEventListener('click', () => playTrackByPath(path, library));
    list.appendChild(el);
  });
}

// ── Track quality ──
// Two-tier quality info per track. Tier 1 (`track.quality`) is decoded from the
// file header in main.js at parse time. Tier 2 (spectral transcode detection)
// runs in the renderer and is cached here per path; it can upgrade a track's
// tier to 'suspicious'. See design_handoff_track_quality/README.md.
const QUALITY_TIER_CLASS = {
  lossless: 'q-lossless', high: 'q-high', good: 'q-good', low: 'q-low', suspicious: 'q-suspicious',
};

let qualityCache = (() => {
  try { return JSON.parse(localStorage.getItem(LS.qualityCache) || '{}'); }
  catch (_) { return {}; }
})();
function saveQualityCache() {
  try { localStorage.setItem(LS.qualityCache, JSON.stringify(qualityCache)); }
  catch (e) { console.warn('quality cache save failed:', e); }
}

// Combine a track's Tier-1 header quality with any cached Tier-2 spectral result.
function qualityFor(track) {
  const q = track && track.quality;
  if (!q) return null;
  const spec = qualityCache[track.path];
  if (!spec) return q;
  return { ...q, cutoffKHz: spec.cutoffKHz, tier: spec.tier || q.tier,
    claimed: spec.claimed, estReal: spec.estReal };
}

// Short label inside the badge: FLAC/ALAC/WAV keep the format; VBR shows the
// LAME preset (V0/V1/V2…); everything else shows the bitrate number.
function qualityBadgeLabel(q) {
  if (q.format === 'FLAC') return 'FLAC';
  if (q.format === 'ALAC' || q.format === 'WAV') return q.format;
  if (q.preset && q.preset.startsWith('-V')) return 'V' + q.preset.replace('-V', '').trim();
  return q.bitrate ? String(q.bitrate) : (q.format || '—');
}

function qualityBadgeHtml(q) {
  if (!q) return '';
  const cls = QUALITY_TIER_CLASS[q.tier] || 'q-good';
  const label = escapeHtml(qualityBadgeLabel(q));
  const warn = q.tier === 'suspicious'
    ? `<svg class="i" width="10.5" height="10.5"><use href="#i-alert-triangle"/></svg>` : '';
  const suffix = q.tier === 'suspicious' ? `<span class="q-badge-q">?</span>` : '';
  const bits = q.bitrate ? `${q.bitrate} ${tr('quality.kbps')} · ` : '';
  const title = escapeHtml(`${q.format} · ${bits}${q.mode}`);
  return `<span class="q-badge ${cls}" title="${title}">${warn}${label}${suffix}</span>`;
}

function networkBadgeHtml(track) {
  if (!track.remote) return '';
  const title = escapeHtml(tr('lan.networkFrom', { device: track.deviceName || '' }));
  return `<span class="q-badge net-badge" title="${title}">${tr('lan.networkBadge')}</span>`;
}

// ── Track quality: spectral analysis (Tier 2) ──
// The transcode detector. Decodes a window of PCM at full rate, runs an FFT
// over overlapping Hann-windowed frames, averages the magnitude spectra, and
// finds the frequency where energy drops into the noise floor. A file that
// *claims* 320 kbps but whose spectrum dies at ~16 kHz was almost certainly
// upsampled from a ~128 kbps source. See design_handoff_track_quality/README.md.
const SPEC_FFT = 4096;                 // FFT window size (power of two)
const SPEC_SR = 44100;                 // force decode sample rate → Nyquist 22.05 kHz
const SPEC_WIN_SEC = 25;               // analyse a ~25 s loud middle section
const SPEC_POINTS = 128;               // spectrum points stored for the graph

let specDecodeCtx = null;
function getSpecCtx() {
  if (!specDecodeCtx) {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) throw new Error('OfflineAudioContext unavailable');
    specDecodeCtx = new Ctx(1, 1, SPEC_SR);
  }
  return specDecodeCtx;
}

// In-place iterative radix-2 Cooley–Tukey FFT.
function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = cr * re[b] - ci * im[b];
        const xi = cr * im[b] + ci * re[b];
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// Estimate the true source bitrate from the spectral cutoff (README table).
function estBitrateFromCutoff(cutoffKHz) {
  if (cutoffKHz <= 16.5) return 128;
  if (cutoffKHz <= 18) return 192;
  if (cutoffKHz <= 19.5) return 256;
  return 320;
}

// Analyse one track. Returns { cutoffKHz, tier, claimed?, estReal?, spectrum? }
// or null if it couldn't be decoded. Does not touch the cache; caller stores it.
async function analyzeSpectrum(track) {
  if (!window.electronAPI || !window.electronAPI.readAudioFile) return null;
  const q = track.quality;
  if (!q) return null;
  const bytes = await window.electronAPI.readAudioFile(track.path);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const buf = await getSpecCtx().decodeAudioData(ab);
  const sr = buf.sampleRate;
  const data = buf.getChannelData(0);
  const total = data.length;
  if (total < SPEC_FFT) return null;

  const N = SPEC_FFT, half = N >> 1;
  const hann = new Float64Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  const winLen = Math.min(total, Math.floor(SPEC_WIN_SEC * sr));
  const start = Math.max(0, Math.floor((total - winLen) / 2));
  const end = Math.min(total, start + winLen);
  const hop = N >> 1; // 50% overlap

  const mag = new Float64Array(half);
  const re = new Float64Array(N), im = new Float64Array(N);
  let frames = 0;
  for (let off = start; off + N <= end; off += hop) {
    for (let i = 0; i < N; i++) { re[i] = data[off + i] * hann[i]; im[i] = 0; }
    fftRadix2(re, im);
    for (let k = 0; k < half; k++) mag[k] += Math.hypot(re[k], im[k]);
    frames++;
  }
  if (frames === 0) return null;
  for (let k = 0; k < half; k++) mag[k] /= frames;

  // dB spectrum, smoothed over a few bins to suppress lone spikes.
  const eps = 1e-9;
  const db = new Float64Array(half);
  for (let k = 0; k < half; k++) db[k] = 20 * Math.log10(mag[k] + eps);
  const sm = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    let s = 0, c = 0;
    for (let d = -2; d <= 2; d++) { const j = k + d; if (j >= 0 && j < half) { s += db[j]; c++; } }
    sm[k] = s / c;
  }

  // Reference level = mean dB in the 300 Hz .. 2 kHz band.
  const binHz = sr / N;
  const lo = Math.max(1, Math.floor(300 / binHz));
  const hi = Math.min(half - 1, Math.floor(2000 / binHz));
  let ref = 0, rc = 0;
  for (let k = lo; k <= hi; k++) { ref += sm[k]; rc++; }
  ref = rc ? ref / rc : 0;
  const thr = ref - 40; // within ~40 dB of the reference = still real signal

  // Walk down from Nyquist; cutoff = highest freq with 3 consecutive bins above thr.
  let cutBin = half - 1;
  for (let k = half - 1; k >= 2; k--) {
    if (sm[k] > thr && sm[k - 1] > thr && sm[k - 2] > thr) { cutBin = k; break; }
  }
  const nyquist = sr / 2;
  const cutoffKHz = Math.min(nyquist, cutBin * binHz) / 1000;

  // Downsampled spectrum (0..1) for the graph, normalised to the reference peak.
  const spectrum = new Array(SPEC_POINTS);
  const peak = Math.max(...mag) || 1;
  for (let p = 0; p < SPEC_POINTS; p++) {
    const k = Math.min(half - 1, Math.floor((p / (SPEC_POINTS - 1)) * (half - 1)));
    spectrum[p] = Math.round(Math.min(1, mag[k] / peak) * 1000) / 1000;
  }

  // Classify.
  const roundCut = Math.round(cutoffKHz * 10) / 10;
  const result = { cutoffKHz: roundCut, tier: q.tier, analyzedAt: Date.now() };
  const claimedHigh = q.lossless || q.bitrate >= 256;
  if (claimedHigh && roundCut <= 16.6) {
    result.tier = 'suspicious';
    result.claimed = q.lossless ? q.bitrate : q.bitrate;
    result.estReal = estBitrateFromCutoff(roundCut);
    result.spectrum = spectrum; // keep the real curve for the inspector graph
  }
  return result;
}

// ── Health-check ──
// Library-scanning dashboard. Cheap issues (bitrate, missing cover, incomplete
// tags, duplicates) are computed instantly from Tier-1 metadata every render;
// the transcode count comes from the cached Tier-2 spectral verdicts and is
// (re)populated by the on-demand "Rescan" scan.
let healthReport = (() => {
  try { return JSON.parse(localStorage.getItem(LS.healthReport) || 'null'); }
  catch (_) { return null; }
})();
let healthScanning = false;
let healthFilterPaths = null;   // Set<path> when the library is filtered to a result
let healthFilterLabel = '';

function saveHealthReport() {
  try { localStorage.setItem(LS.healthReport, JSON.stringify(healthReport)); }
  catch (e) { console.warn('health report save failed:', e); }
}

function normDupKey(t) {
  return `${(t.artist || '').trim().toLowerCase()}|${(t.title || '').trim().toLowerCase()}`;
}

// Compute the five issue buckets from the current library + spectral cache.
function computeHealthIssues() {
  const unknownArtist = tr('label.unknownArtist');
  const transcode = [], lowbitrate = [], nocover = [], tags = [], dupes = [], notrackno = [];
  const notracknoAlbums = new Set();
  const dupMap = new Map();
  for (const t of library) {
    const q = qualityFor(t);
    if (q && q.tier === 'suspicious') transcode.push(t.path);
    if (q && !q.lossless && q.bitrate > 0 && q.bitrate < 192) lowbitrate.push(t.path);
    // Only count a missing cover when we actually know the file has none
    // (hasCover backfilled). Unknown (pre-scan) tracks aren't flagged.
    if (typeof t.hasCover === 'boolean' && !t.hasCover && !coverCache[t.path]) nocover.push(t.path);
    const artistBad = !t.artist || t.artist === 'Unknown Artist' || t.artist === unknownArtist;
    const albumBad = !t.album || t.album === 'Unknown Album';
    const genreBad = !t.genre || !t.genre.trim() || t.genre.trim().toLowerCase() === 'music';
    if (artistBad || albumBad || !t.year || genreBad) tags.push(t.path);
    // A track number only means something in the context of an album — a
    // single with no album tag has nothing to be out of order relative to.
    if (!t.trackNo && t.album) {
      notrackno.push(t.path);
      notracknoAlbums.add(t.album);
    }
    const key = normDupKey(t);
    if (!dupMap.has(key)) dupMap.set(key, []);
    dupMap.get(key).push(t.path);
  }
  for (const paths of dupMap.values()) {
    if (paths.length >= 2) dupes.push(...paths);
  }
  return [
    { id: 'transcode', tone: 'alert', icon: 'i-alert-triangle', paths: transcode },
    { id: 'lowbitrate', tone: 'warn', icon: 'i-activity', paths: lowbitrate },
    { id: 'nocover', tone: 'warn', icon: 'i-image', paths: nocover },
    { id: 'tags', tone: 'warn', icon: 'i-edit', paths: tags },
    { id: 'notrackno', tone: 'warn', icon: 'i-list', paths: notrackno, albums: [...notracknoAlbums].sort() },
    { id: 'dupes', tone: 'neutral', icon: 'i-copy', paths: dupes },
  ];
}

// SVG area chart of the frequency spectrum. Feeds on a real spectrum (0..1
// array) when available, else synthesises the envelope from the cutoff.
function buildSpectrumSvg({ spectrum, cutoffKHz = 20, suspicious = false, width = 296, height = 130 }) {
  const nyq = SPEC_SR / 2000;          // ~22.05 kHz on the X axis
  const pad = { l: 6, r: 6, t: 8, b: 20 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const N = SPEC_POINTS - 1;
  const accent = suspicious ? '#e8a045' : '#8fd6c4';
  const gid = 'spec-' + (suspicious ? 's' : 'h');

  // Deterministic jitter so the synthetic fallback isn't a dead-flat line.
  let seed = Math.round(cutoffKHz * 97) >>> 0;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  const pts = [];
  for (let i = 0; i <= N; i++) {
    const f = (i / N) * nyq;
    let e;
    if (spectrum && spectrum.length) {
      e = spectrum[Math.min(spectrum.length - 1, i)];
    } else {
      e = Math.pow(1 - f / (nyq + 4), 0.75) * (0.72 + 0.28 * rand());
      if (f > cutoffKHz) {
        const over = f - cutoffKHz;
        e *= suspicious ? Math.exp(-over * 4.5) : Math.exp(-over * 1.1);
        e = Math.max(e, 0.02 + 0.015 * rand());
      }
    }
    const x = pad.l + (f / nyq) * w;
    const y = pad.t + h - Math.max(0.015, Math.min(1, e)) * h;
    pts.push([x, y]);
  }

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${(pad.l + w).toFixed(1)},${pad.t + h} L${pad.l},${pad.t + h} Z`;
  const cutX = pad.l + (cutoffKHz / nyq) * w;
  const ticks = [0, 5, 10, 15, 20];
  const grid = ticks.map(k => {
    const x = pad.l + (k / nyq) * w;
    return `<line x1="${x.toFixed(1)}" y1="${pad.t}" x2="${x.toFixed(1)}" y2="${pad.t + h}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>`;
  }).join('');
  const axis = ticks.map(k => {
    const x = pad.l + (k / nyq) * w;
    return `<text x="${x.toFixed(1)}" y="${height - 6}" fill="var(--text-faint)" font-size="9.5" font-family="'Roboto Mono', ui-monospace, monospace" text-anchor="middle">${k}</text>`;
  }).join('');
  const unit = tr('health.khz');
  const marker = suspicious ? `
    <line x1="${cutX.toFixed(1)}" y1="${pad.t}" x2="${cutX.toFixed(1)}" y2="${pad.t + h}" stroke="#e8a045" stroke-width="1.5" stroke-dasharray="4 3"/>
    <rect x="${(cutX + 4).toFixed(1)}" y="${pad.t + 2}" width="88" height="18" rx="4" fill="rgba(232,160,69,0.15)"/>
    <text x="${(cutX + 10).toFixed(1)}" y="${pad.t + 14.5}" fill="#e8a045" font-size="10.5" font-family="'Roboto Mono', ui-monospace, monospace" font-weight="600">${escapeHtml(tr('quality.cutoffMarker'))} ${cutoffKHz} ${escapeHtml(unit)}</text>` : '';

  return `<svg class="spectrum" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.35"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0.02"/>
    </linearGradient></defs>
    ${grid}
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${line}" fill="none" stroke="${accent}" stroke-width="1.5" stroke-linejoin="round"/>
    ${marker}
    <text x="${(pad.l + w).toFixed(1)}" y="${height - 6}" fill="var(--text-faint)" font-size="9.5" font-family="'Roboto Mono', ui-monospace, monospace" text-anchor="end">${escapeHtml(unit)}</text>
    ${axis}
  </svg>`;
}

function firstSuspicious() {
  for (const t of library) {
    const q = qualityFor(t);
    if (q && q.tier === 'suspicious') return { track: t, q };
  }
  return null;
}

function renderHealth() {
  const el = $('health-content');
  if (!el) return;
  // Topbar bits.
  const lastEl = $('health-lastscan');
  if (lastEl) {
    if (healthScanning) lastEl.textContent = '';
    else if (healthReport && healthReport.lastScan) {
      lastEl.textContent = `${tr('health.lastScan')} ${formatScanDate(healthReport.lastScan)}`;
    } else lastEl.textContent = `${tr('health.lastScan')} ${tr('health.never')}`;
  }

  if (library.length === 0) {
    el.innerHTML = `<div class="health-nodata">${escapeHtml(tr('health.noData'))}</div>`;
    return;
  }

  const issues = computeHealthIssues();
  const total = library.length;
  const flaggedSet = new Set();
  issues.forEach(i => i.paths.forEach(p => flaggedSet.add(p)));
  const flagged = flaggedSet.size;
  const ok = Math.max(0, total - flagged);
  const okPct = total ? Math.round((ok / total) * 100) : 100;

  // Featured inspector: the first suspicious track, else a healthy/prompt card.
  const sus = firstSuspicious();
  let inspector;
  if (sus) {
    const spec = qualityCache[sus.track.path] || {};
    const claimed = sus.q.claimed || sus.q.bitrate;
    const estReal = sus.q.estReal || estBitrateFromCutoff(sus.q.cutoffKHz || 16);
    const cut = sus.q.cutoffKHz != null ? sus.q.cutoffKHz : 16;
    const lame = sus.q.hasLame ? '' : tr('health.noLame');
    inspector = `
      <div class="health-inspector">
        <div class="health-inspector-head">
          <svg class="i" width="14" height="14"><use href="#i-alert-triangle"/></svg>
          <span>${escapeHtml(tr('health.transcodeTitle'))}</span>
        </div>
        <div class="health-inspector-track">${escapeHtml(sus.track.title)} — ${escapeHtml(sus.track.artist)}</div>
        <div class="health-inspector-nums">${escapeHtml(tr('health.claimed'))} ${claimed} ${tr('quality.kbps')} · ${escapeHtml(tr('health.real'))} ${estReal} ${tr('quality.kbps')}</div>
        ${buildSpectrumSvg({ spectrum: spec.spectrum, cutoffKHz: cut, suspicious: true })}
        <div class="health-inspector-caption">${escapeHtml(tr('health.spectrumCaption', { cut, lame })).replace(String(cut), `<b>${cut}</b>`)}</div>
      </div>`;
  } else {
    const scanned = healthReport && healthReport.lastScan;
    inspector = `
      <div class="health-inspector" style="border-color:var(--border-strong)">
        <div class="health-inspector-head" style="color:var(--text-strong)">
          <svg class="i" width="14" height="14" style="color:#8fd6c4"><use href="#i-shield"/></svg>
          <span>${escapeHtml(scanned ? tr('health.allGood') : tr('health.transcodeTitle'))}</span>
        </div>
        ${buildSpectrumSvg({ cutoffKHz: 20.5, suspicious: false })}
        <div class="health-inspector-caption">${escapeHtml(scanned ? tr('health.allGoodText') : tr('health.noData'))}</div>
      </div>`;
  }

  const issuesHtml = issues.map(iss => {
    const count = iss.paths.length;
    const fixable = iss.id === 'tags' || iss.id === 'nocover' || iss.id === 'notrackno';
    const btn = fixable
      ? `<svg class="i" width="11" height="11"><use href="#i-sparkle"/></svg> ${escapeHtml(tr('health.fix'))}`
      : escapeHtml(tr('health.show'));
    // Naming the affected albums is more actionable here than a static
    // description — this issue only exists in the context of an album.
    const desc = (iss.id === 'notrackno' && iss.albums && iss.albums.length)
      ? iss.albums.slice(0, 4).join(', ') + (iss.albums.length > 4 ? ` +${iss.albums.length - 4}` : '')
      : tr('issue.' + iss.id + '.desc');
    return `
      <div class="health-issue tone-${iss.tone}" data-issue="${iss.id}" ${count === 0 ? 'style="opacity:0.5"' : ''}>
        <div class="health-issue-icon"><svg class="i" width="15" height="15"><use href="#${iss.icon}"/></svg></div>
        <div class="health-issue-body">
          <div class="health-issue-top">
            <span class="health-issue-title">${escapeHtml(tr('issue.' + iss.id + '.title'))}</span>
            <span class="health-issue-count">${count}</span>
          </div>
          <div class="health-issue-desc">${escapeHtml(desc)}</div>
        </div>
        <button class="health-issue-btn" data-issue-action="${iss.id}" ${count === 0 ? 'disabled style="opacity:0.4;cursor:default"' : ''}>${btn}</button>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="health-grid">
      <div class="health-left">
        <div class="health-score">
          <div class="health-score-label">${escapeHtml(tr('health.scoreLabel'))}</div>
          <div class="health-score-big">
            <span class="health-score-pct">${okPct}%</span>
            <span class="health-score-cap">${escapeHtml(tr('health.ok'))}</span>
          </div>
          <div class="health-bar">
            <div class="health-bar-ok" style="width:${okPct}%"></div>
            <div class="health-bar-flag"></div>
          </div>
          <div class="health-legend">
            <span><span class="dot-ok">●</span> ${ok} ${escapeHtml(tr('health.okLegend'))}</span>
            <span><span class="dot-flag">●</span> ${flagged} ${escapeHtml(tr('health.flaggedLegend'))}</span>
          </div>
        </div>
        ${inspector}
      </div>
      <div class="health-issues">
        <div class="health-issues-label">${escapeHtml(tr('health.issuesLabel'))}</div>
        ${issuesHtml}
      </div>
    </div>`;

  // Wire issue action buttons.
  el.querySelectorAll('[data-issue-action]').forEach(btn => {
    if (btn.disabled) return;
    btn.addEventListener('click', () => {
      const id = btn.dataset.issueAction;
      const iss = issues.find(x => x.id === id);
      if (!iss || iss.paths.length === 0) return;
      const fixable = id === 'tags' || id === 'nocover' || id === 'notrackno';
      applyHealthFilter(iss.paths, tr('issue.' + id + '.title'));
      if (fixable && iss.paths[0]) openMetadataEditor(iss.paths[0]);
    });
  });
}

function formatScanDate(ts) {
  try {
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString(currentLang, { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return `${tr('report.today').toLowerCase()}, ${time}`;
    return `${d.toLocaleDateString(currentLang)}, ${time}`;
  } catch (_) { return ''; }
}

// Filter the library view to a set of paths (from a Health-check issue).
function applyHealthFilter(paths, label) {
  healthFilterPaths = new Set(paths);
  healthFilterLabel = label || '';
  setView('library');
}
function clearHealthFilter() {
  healthFilterPaths = null;
  healthFilterLabel = '';
  const bar = $('library-health-filter');
  if (bar) bar.hidden = true;
}
function updateHealthFilterBar() {
  const bar = $('library-health-filter');
  if (!bar) return;
  if (healthFilterPaths) {
    bar.hidden = false;
    const lbl = $('library-health-filter-label');
    if (lbl) lbl.textContent = tr('health.filterNote', { label: healthFilterLabel });
  } else {
    bar.hidden = true;
  }
}

// On-demand full scan: refresh Tier 1 (cover/tags/bitrate) then run Tier 2
// spectral analysis on every track, reporting progress on the button.
async function runHealthScan() {
  if (healthScanning || library.length === 0) return;
  healthScanning = true;
  const btn = $('health-rescan-btn');
  const label = btn ? btn.querySelector('span') : null;
  const origLabel = label ? label.textContent : '';
  if (btn) btn.classList.add('is-scanning');

  const snapshot = library.slice();
  let done = 0;
  for (const track of snapshot) {
    done++;
    if (label) label.textContent = tr('health.scanning', { n: done, m: snapshot.length });
    // Refresh Tier 1 so cover/tag/bitrate issues reflect the file on disk.
    try {
      const fresh = await window.electronAPI.parseMetadata(track.path);
      if (fresh) {
        const live = trackByPath(track.path);
        if (live) {
          live.quality = fresh.quality;
          live.hasCover = fresh.hasCover;
          if (fresh.cover) coverCache[track.path] = fresh.cover;
        }
      }
    } catch (_) { /* file may be gone; skip */ }
    // Tier 2 spectral.
    try {
      const live = trackByPath(track.path);
      if (live && live.quality) {
        const res = await analyzeSpectrum(live);
        if (res) { qualityCache[track.path] = res; }
      }
    } catch (e) { console.warn('spectral analysis failed for', track.path, e); }
    // Yield so the UI can paint the progress label.
    await new Promise(r => setTimeout(r, 0));
  }

  saveQualityCache();
  saveLibrary();
  healthReport = { lastScan: Date.now(), total: library.length };
  saveHealthReport();
  healthScanning = false;
  if (btn) { btn.classList.remove('is-scanning'); }
  if (label) label.textContent = origLabel || tr('health.rescan');
  refreshCurrentViewRows();
  if (currentView === 'health') renderHealth();
}

// ── Render: track row ──
function renderTrackRow(track, displayIndex, queue) {
  if (!track) return document.createElement('div');
  // Backfill covers and (for libraries saved before this feature) Tier-1 quality
  // lazily as rows scroll into view. A peer's track already carries what it has —
  // there's no local file here to read tags from.
  if (!track.remote && (!track.cover || track.quality === undefined)) ensureCoverFor(track);
  const realIndex = trackIndexByPath(track.path);
  const isPlayingRow = !!currentTrack
    && currentTrack.path === track.path;
  const selectable = librarySelectMode && currentView === 'library';
  const isSelected = selectable && selectedPaths.has(track.path);
  const tr = document.createElement('div');
  tr.className = 'trow' + (isPlayingRow ? ' playing' : '') + (isSelected ? ' selected' : '');
  tr.dataset.path = track.path;
  const numCell = selectable
    ? `<span class="trow-check${isSelected ? ' checked' : ''}"></span>`
    : isPlayingRow
      ? `<span class="equalizer"><span></span><span></span><span></span></span>`
      : String(displayIndex + 1).padStart(2, '0');
  const coverStyle = track.cover ? `background-image:url('${track.cover}')` : '';
  tr.innerHTML = `
    <div class="trow-num">${numCell}</div>
    <div class="trow-title-cell">
      <div class="trow-cover" style="${coverStyle}"></div>
      <span class="trow-title">${escapeHtml(track.title)}</span>
      ${networkBadgeHtml(track)}
    </div>
    <div class="trow-muted" data-link="artist">${artistLinksHtml(track.artist)}</div>
    <div class="trow-muted trow-link" data-link="album">${escapeHtml(track.album || '—')}</div>
    <div class="trow-dur">${formatTime(track.duration)}</div>
    <div class="trow-more"><svg class="i" width="13" height="13"><use href="#i-more"/></svg></div>
  `;
  // Select mode repurposes a row click for selection — don't hijack that with
  // navigation, so let it fall through to the row's own click handler below.
  tr.querySelectorAll('[data-artist]').forEach(el => {
    el.addEventListener('click', e => {
      if (currentView === 'library' && librarySelectMode) return;
      e.stopPropagation();
      activeArtistName = el.dataset.artist;
      setView('artist-detail');
    });
  });
  tr.querySelector('[data-link="album"]').addEventListener('click', e => {
    if (currentView === 'library' && librarySelectMode) return;
    e.stopPropagation();
    activeAlbumKey = albumKeyFor(track);
    setView('album-detail');
  });
  tr.addEventListener('click', e => {
    if (currentView === 'library') {
      if (librarySelectMode) {
        toggleRowSelection(track.path, e.shiftKey);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+Click is a shortcut into select mode.
        setLibrarySelectMode(true);
        toggleRowSelection(track.path, false);
        return;
      }
    }
    if (e.target.closest('.trow-more')) {
      e.stopPropagation();
      openContextMenu(e, track.path);
      return;
    }
    playTrackByPath(track.path, queue);
  });
  tr.addEventListener('contextmenu', e => {
    e.preventDefault();
    openContextMenu(e, track.path);
  });
  return tr;
}

// ── Render: library ──
function currentLibraryTracks() {
  const q = ($('library-search').value || '').trim().toLowerCase();
  // A Health-check result filter narrows the library to a specific set of files,
  // preserving library order; a search box query narrows within it.
  const base = healthFilterPaths
    ? library.filter(t => healthFilterPaths.has(t.path))
    : sortedFilteredLibrary();
  // Peers' libraries sync automatically and show up right in this list — tagged
  // with a badge rather than tucked away behind a separate "Browse" screen.
  const remote = !healthFilterPaths ? lanAllRemoteTracks() : [];
  const all = remote.length ? base.concat(remote) : base;
  if (q) {
    return all.filter(t =>
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q) ||
      t.album.toLowerCase().includes(q));
  }
  return all;
}

function renderLibrary() {
  const list = $('library-list');
  const empty = $('library-empty');
  updateHealthFilterBar();
  const tracks = currentLibraryTracks();
  const networkCount = !healthFilterPaths ? lanAllRemoteTracks().length : 0;
  $('library-count-label').textContent = networkCount
    ? tr('library.count.split', { local: library.length, network: networkCount, tracks: pluralTracks(library.length + networkCount) })
    : `${library.length} ${pluralTracks(library.length)}`;
  if (tracks.length === 0) {
    list.innerHTML = '';
    list.style.height = '';
    empty.classList.add('show');
  } else {
    empty.classList.remove('show');
    if (!libraryVList) {
      libraryVList = createVirtualList({ listEl: list, scrollEl });
    }
    libraryVList.setItems(tracks, (t, i, queue) => renderTrackRow(t, i, queue));
  }
  renderCounts();
}

function pluralTracks(n) { return plural('tracks', n); }

// ── Library multi-select ──
function setLibrarySelectMode(on) {
  if (librarySelectMode === on) return;
  librarySelectMode = on;
  selectedPaths.clear();
  lastSelectedPath = null;
  $('btn-select-mode').classList.toggle('active', on);
  $('library-select-bar').hidden = !on;
  updateSelectBar();
  if (currentView === 'library') renderLibrary();
}

function updateSelectBar() {
  $('select-count-label').textContent =
    tr('select.count', { n: withCount('tracks', selectedPaths.size) });
  const paths = [...selectedPaths];
  // Delete only ever touches local files (remote ones aren't ours to delete);
  // download only ever touches remote ones (a local file is already local).
  $('btn-delete-selected').disabled = !paths.some(p => !isRemotePath(p));
  const hasRemote = paths.some(isRemotePath);
  $('btn-download-selected').hidden = !hasRemote;
  $('btn-download-selected').disabled = !hasRemote;
}

function toggleRowSelection(path, shiftRange) {
  if (shiftRange && lastSelectedPath && lastSelectedPath !== path) {
    // Shift-click selects the visible range between the last-clicked row and this one.
    const tracks = currentLibraryTracks();
    const a = tracks.findIndex(t => t.path === lastSelectedPath);
    const b = tracks.findIndex(t => t.path === path);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) selectedPaths.add(tracks[i].path);
    } else {
      selectedPaths.add(path);
    }
  } else if (selectedPaths.has(path)) {
    selectedPaths.delete(path);
  } else {
    selectedPaths.add(path);
  }
  lastSelectedPath = path;
  updateSelectBar();
  if (libraryVList) libraryVList.refreshVisible();
}

$('btn-select-mode').addEventListener('click', () => setLibrarySelectMode(!librarySelectMode));
$('btn-cancel-select').addEventListener('click', () => setLibrarySelectMode(false));
$('btn-select-all').addEventListener('click', () => {
  currentLibraryTracks().forEach(t => selectedPaths.add(t.path));
  updateSelectBar();
  if (libraryVList) libraryVList.refreshVisible();
});
$('btn-download-selected').addEventListener('click', () => {
  const remoteByPath = new Map(lanAllRemoteTracks().map(t => [t.path, t]));
  downloadTracksFromHost([...selectedPaths].map(p => remoteByPath.get(p)).filter(Boolean));
});
$('btn-delete-selected').addEventListener('click', async () => {
  const paths = [...selectedPaths].filter(p => !isRemotePath(p));
  if (paths.length === 0) return;
  if (await confirmDelete('modal.deleteTracks.title',
    tr('modal.deleteTracks.text', { count: withCount('tracks', paths.length) }))) deleteTracks(paths);
});

// ── Render: favorites ──
function renderFavorites() {
  const list = $('favorites-list');
  const empty = $('favorites-empty');
  const tracks = library.filter(t => favorites.includes(t.path));
  $('favorites-count-label').textContent = `${tracks.length} ${pluralTracks(tracks.length)}`;
  if (tracks.length === 0) {
    list.innerHTML = '';
    list.style.height = '';
    empty.classList.add('show');
  } else {
    empty.classList.remove('show');
    if (!favoritesVList) {
      favoritesVList = createVirtualList({ listEl: list, scrollEl });
    }
    favoritesVList.setItems(tracks, (t, i, queue) => renderTrackRow(t, i, queue));
  }
  renderCounts();
}

// ── Playlists ──
const PL_COVERS = [
  'linear-gradient(135deg, #d4377a 0%, #2a1a3d 100%)',
  'linear-gradient(135deg, #c4a872 0%, #3d2f15 100%)',
  'linear-gradient(135deg, #3a5a3a 0%, #0f1f0f 100%)',
  'linear-gradient(135deg, #4a7fc1 0%, #1a2a4d 100%)',
  'linear-gradient(135deg, #7a3a3a 0%, #2a0f0f 100%)',
  'linear-gradient(135deg, #6a4a8a 0%, #1f1535 100%)',
];

function renderPlaylists() {
  const grid = $('playlists-grid');
  const empty = $('playlists-empty');
  grid.innerHTML = '';
  $('playlists-count-label').textContent = `${playlists.length} ${plural('playlists', playlists.length)}`;
  if (playlists.length === 0) {
    grid.style.display = 'none';
    empty.classList.add('show');
  } else {
    grid.style.display = 'grid';
    empty.classList.remove('show');
    playlists.forEach((pl, i) => {
      const card = document.createElement('div');
      card.className = 'playlist-card';
      const tracks = pl.trackPaths.map(trackByPath).filter(Boolean);
      const coverStyle = pl.cover
        ? `background:url(${pl.cover}) center/cover`
        : `background:${pl.color || PL_COVERS[i % PL_COVERS.length]}`;
      card.innerHTML = `
        <div class="playlist-cover" style="${coverStyle}">
          ${pl.cover ? '' : `<span class="playlist-letter">${escapeHtml((pl.name || '?')[0])}</span>`}
        </div>
        <div class="playlist-name">${escapeHtml(pl.name)}</div>
        <div class="playlist-desc">${escapeHtml(pl.desc || '')}</div>
        <div class="playlist-stats">
          <span>${tracks.length} ${pluralTracks(tracks.length)}</span>
          <span>·</span>
          <span>${formatTotalDuration(tracks)}</span>
        </div>
      `;
      card.addEventListener('click', () => {
        activePlaylistId = pl.id;
        setView('playlist-detail');
      });
      card.addEventListener('contextmenu', e => {
        e.preventDefault();
        openPlaylistContextMenu(e, pl.id);
      });
      grid.appendChild(card);
    });
  }
  renderCounts();
}

function renderPlaylistDetail(plId) {
  const pl = playlists.find(p => p.id === plId);
  if (!pl) { setView('playlists'); return; }
  $('pl-detail-crumb').textContent = pl.name;
  $('pl-detail-title').textContent = pl.name;
  if (pl.cover) {
    $('pl-hero-letter').textContent = '';
    $('pl-hero-cover').style.background = `url(${pl.cover}) center/cover`;
  } else {
    $('pl-hero-letter').textContent = (pl.name || '?')[0];
    $('pl-hero-cover').style.background = pl.color || PL_COVERS[0];
  }
  const tracks = pl.trackPaths.map(trackByPath).filter(Boolean);
  const meta = $('pl-detail-meta');
  meta.innerHTML = `
    <span>${tracks.length} ${pluralTracks(tracks.length)}</span>
    <span>·</span>
    <span>${formatTotalDuration(tracks)}</span>
  `;
  const list = $('pl-detail-list');
  if (tracks.length === 0) {
    list.innerHTML = '';
    list.style.height = '';
  } else {
    if (!playlistVList) {
      playlistVList = createVirtualList({ listEl: list, scrollEl });
    }
    playlistVList.setItems(tracks, (t, i, queue) => renderTrackRow(t, i, queue));
  }

  $('btn-pl-play').onclick = () => {
    if (tracks.length > 0) playTrackByPath(tracks[0].path, tracks);
  };
  $('btn-pl-shuffle').onclick = () => {
    if (tracks.length > 0) {
      isShuffle = true;
      updateShuffleUI();
      const random = tracks[Math.floor(Math.random() * tracks.length)];
      playTrackByPath(random.path, tracks);
    }
  };
  $('btn-pl-delete').onclick = async () => {
    if (await confirmDelete('modal.deletePlaylist.title',
      tr('modal.deletePlaylist.text', { name: pl.name }))) deletePlaylist(pl.id);
  };
}

// ── Artists ──
// A track's `artist` field may list multiple performers joined by " & ", ",",
// ";", "feat."/"ft." (with or without the trailing period). Each side counts as
// a separate artist; the same track shows up on every artist's page. "feat"/"ft"
// only counts as a separator when followed by whitespace, so it doesn't fire
// inside ordinary words like "Featherweight" or "Deftones".
const ARTIST_SEP = /\s*(?:&|,|;|\bfeat\.?(?=\s)|\bft\.?(?=\s))\s*/i;

function splitArtists(s) {
  const unknown = tr('label.unknownArtist');
  if (!s) return [unknown];
  const parts = s.split(ARTIST_SEP).map(p => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [unknown];
}

// A row's artist cell used to link the whole "A, B" string to just the first
// name — clicking anywhere always went to A. Each name gets its own span so a
// click lands on the artist actually under the cursor.
function artistLinksHtml(s) {
  return splitArtists(s)
    .map(name => `<span class="trow-artist-link" data-artist="${escapeHtml(name)}">${escapeHtml(name)}</span>`)
    .join('<span class="trow-artist-sep">, </span>');
}

function artistInitials(name) {
  const stop = new Set(['the', 'of', 'a', 'an', 'and', 'і', 'та']);
  const parts = name.split(/\s+/).filter(p => !stop.has(p.toLowerCase()));
  if (parts.length === 0) return (name[0] || '?').toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function pluralAlbums(n) { return plural('albums', n); }
function pluralArtists(n) { return plural('artists', n); }

// Network tracks slot into the same artist/album grouping as local ones —
// otherwise a peer's whole library sits stranded in the flat list view.
function libraryWithNetwork() { return library.concat(lanAllRemoteTracks()); }

function buildArtistsIndex() {
  const map = new Map();
  libraryWithNetwork().forEach((t, idx) => {
    const names = splitArtists(t.artist);
    for (const name of names) {
      let a = map.get(name);
      if (!a) {
        a = { name, tracks: [], lastIdx: idx };
        map.set(name, a);
      }
      a.tracks.push(t);
      if (idx > a.lastIdx) a.lastIdx = idx;
    }
  });
  const out = [];
  for (const a of map.values()) {
    const albums = new Set(a.tracks.map(t => t.album));
    const cover = (a.tracks.find(t => t.cover) || {}).cover || null;
    out.push({
      name: a.name,
      tracks: a.tracks,
      trackCount: a.tracks.length,
      albumCount: albums.size,
      lastIdx: a.lastIdx,
      cover,
    });
  }
  return out;
}

function sortArtists(arr) {
  const c = arr.slice();
  if (artistsSort === 'tracks') c.sort((a, b) => b.trackCount - a.trackCount || a.name.localeCompare(b.name));
  else if (artistsSort === 'recent') c.sort((a, b) => b.lastIdx - a.lastIdx);
  else c.sort((a, b) => a.name.localeCompare(b.name));
  return c;
}

// Page size = enough rows to fill a typical viewport so the first paint is
// always visually complete. Subsequent rows stream in as the user scrolls.
const ARTISTS_PAGE_SIZE = 36;

function buildArtistCard(a) {
  // Trigger cover load lazily for cards as they mount — first track without
  // a cover is enough; ensureCoverFor is idempotent.
  if (!a.cover) {
    const t = a.tracks.find(t => !t.cover);
    if (t) ensureCoverFor(t);
  }
  const card = document.createElement('div');
  card.className = 'artist-card';
  card.dataset.artist = a.name;
  const cover = a.cover ? `background-image:url('${a.cover}')` : '';
  card.innerHTML = `
    <div class="artist-avatar" style="${cover}">
      ${a.cover ? '' : `<span class="artist-avatar-letter">${escapeHtml(artistInitials(a.name))}</span>`}
    </div>
    <div class="artist-card-name">${escapeHtml(a.name)}</div>
    <div class="artist-card-stats">
      <span>${a.trackCount} ${escapeHtml(tr('label.tracksShort'))}</span>
      <span>·</span>
      <span>${a.albumCount} ${pluralAlbums(a.albumCount)}</span>
    </div>
  `;
  card.addEventListener('click', () => {
    activeArtistName = a.name;
    setView('artist-detail');
  });
  return card;
}

function appendArtistsBatch() {
  const grid = $('artists-grid');
  // Remove any previous sentinel so it doesn't end up mid-grid.
  const oldSentinel = grid.querySelector('.artists-sentinel');
  if (oldSentinel) oldSentinel.remove();

  const end = Math.min(artistsCursor + ARTISTS_PAGE_SIZE, artistsList.length);
  const frag = document.createDocumentFragment();
  for (let i = artistsCursor; i < end; i++) {
    frag.appendChild(buildArtistCard(artistsList[i]));
  }
  grid.appendChild(frag);
  artistsCursor = end;

  if (artistsCursor < artistsList.length) {
    const sentinel = document.createElement('div');
    sentinel.className = 'artists-sentinel';
    grid.appendChild(sentinel);
    if (!artistsObserver) {
      artistsObserver = new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting)) appendArtistsBatch();
      }, { root: scrollEl, rootMargin: '400px 0px' });
    }
    artistsObserver.observe(sentinel);
  } else if (artistsObserver) {
    artistsObserver.disconnect();
    artistsObserver = null;
  }
}

// Shared by renderArtists and the sidebar nav count so they never disagree
// on how many artists there "are" once small ones are hidden.
function visibleArtists() {
  const all = buildArtistsIndex();
  if (!settings.artistMinTracksEnabled) return all;
  const min = Math.max(1, Number(settings.artistMinTracks) || 1);
  return all.filter(a => a.trackCount >= min);
}

function renderArtists() {
  const all = visibleArtists();
  const q = ($('artists-search').value || '').trim().toLowerCase();
  const filtered = q ? all.filter(a => a.name.toLowerCase().includes(q)) : all;
  const sorted = sortArtists(filtered);

  $('artists-count-label').textContent = `${all.length} ${pluralArtists(all.length)}`;
  const grid = $('artists-grid');
  const empty = $('artists-empty');

  // Reset previous batch state — any new render starts fresh.
  if (artistsObserver) { artistsObserver.disconnect(); artistsObserver = null; }
  grid.innerHTML = '';
  artistsCursor = 0;

  if (all.length === 0) {
    grid.style.display = 'none';
    empty.classList.add('show');
    artistsList = [];
    renderCounts();
    return;
  }
  empty.classList.remove('show');
  grid.style.display = 'grid';

  artistsList = sorted;
  appendArtistsBatch();
  renderCounts();
}

// Cover loads should update existing cards in place — re-rendering would reset
// the scroll position and the lazy-load cursor.
function refreshArtistsCoversInPlace() {
  const grid = $('artists-grid');
  if (!grid) return;
  const cards = grid.querySelectorAll('.artist-card');
  if (cards.length === 0) return;
  // Recompute covers from current library state.
  const byName = new Map();
  for (let i = 0; i < library.length; i++) {
    const t = library[i];
    if (!t.cover) continue;
    for (const name of splitArtists(t.artist)) {
      if (!byName.has(name)) byName.set(name, t.cover);
    }
  }
  cards.forEach(card => {
    const avatar = card.querySelector('.artist-avatar');
    if (!avatar || avatar.style.backgroundImage) return;
    const cover = byName.get(card.dataset.artist);
    if (!cover) return;
    avatar.style.backgroundImage = `url('${cover}')`;
    const letter = avatar.querySelector('.artist-avatar-letter');
    if (letter) letter.remove();
  });
}

function renderArtistDetail(name) {
  const all = buildArtistsIndex();
  const artist = all.find(a => a.name === name);
  if (!artist) { setView('artists'); return; }

  $('artist-detail-crumb').textContent = artist.name;
  $('artist-detail-title').textContent = artist.name;
  const avatar = $('artist-hero-avatar');
  if (artist.cover) {
    avatar.style.backgroundImage = `url('${artist.cover}')`;
    $('artist-hero-letter').textContent = '';
  } else {
    avatar.style.backgroundImage = '';
    $('artist-hero-letter').textContent = artistInitials(artist.name);
    // Try to populate a cover from any track for next render.
    const t = artist.tracks.find(t => !t.cover);
    if (t) ensureCoverFor(t);
  }
  $('artist-detail-meta').innerHTML = `
    <span>${artist.trackCount} ${pluralTracks(artist.trackCount)}</span>
    <span>·</span>
    <span>${artist.albumCount} ${pluralAlbums(artist.albumCount)}</span>
    <span>·</span>
    <span>${formatTotalDuration(artist.tracks)}</span>
  `;

  // Filter by search input
  const q = ($('artist-detail-search').value || '').trim().toLowerCase();
  const tracks = q
    ? artist.tracks.filter(t =>
        t.title.toLowerCase().includes(q) ||
        (t.album || '').toLowerCase().includes(q))
    : artist.tracks;

  // Group by album, preserving insertion order.
  const byAlbum = [];
  const seen = new Map();
  tracks.forEach(t => {
    const key = t.album || '';
    if (!seen.has(key)) {
      seen.set(key, byAlbum.length);
      byAlbum.push({ album: t.album || tr('label.noAlbum'), year: t.year, cover: t.cover, tracks: [] });
    }
    const slot = byAlbum[seen.get(key)];
    slot.tracks.push(t);
    if (!slot.cover && t.cover) slot.cover = t.cover;
  });

  byAlbum.forEach(alb => { alb.tracks = sortAlbumTracks(alb.tracks); });

  // Sort the album blocks by release year; missing years sort to the bottom
  // either way (0 vs Infinity depending on direction).
  const yr = a => parseInt(a.year, 10) || 0;
  byAlbum.sort((a, b) => artistAlbumsSort === 'year-asc'
    ? (yr(a) || Infinity) - (yr(b) || Infinity)
    : yr(b) - yr(a));

  const container = $('artist-albums');
  container.innerHTML = '';

  const makeBlock = (alb, playLabel) => {
    const block = document.createElement('div');
    block.className = 'artist-album';
    const coverStyle = alb.cover ? `background-image:url('${alb.cover}')` : '';
    const head = document.createElement('div');
    head.className = 'artist-album-head';
    head.innerHTML = `
      <div class="artist-album-cover pl-meta-link" style="${coverStyle}" title="${escapeHtml(alb.album)}"></div>
      <div class="artist-album-info">
        <div class="artist-album-name pl-meta-link" title="${escapeHtml(alb.album)}">${escapeHtml(alb.album)}</div>
        <div class="artist-album-meta">
          ${alb.year ? `<span>${escapeHtml(String(alb.year))}</span><span>·</span>` : ''}
          <span>${alb.tracks.length} ${pluralTracks(alb.tracks.length)}</span>
        </div>
      </div>
      <button class="artist-album-play">
        <svg class="i" width="10" height="10"><use href="#i-play"/></svg>
        ${escapeHtml(playLabel)}
      </button>
    `;
    const gotoAlbum = e => {
      e.stopPropagation();
      if (!alb.tracks.length) return;
      activeAlbumKey = albumKeyFor(alb.tracks[0]);
      setView('album-detail');
    };
    head.querySelector('.artist-album-cover').addEventListener('click', gotoAlbum);
    head.querySelector('.artist-album-name').addEventListener('click', gotoAlbum);
    head.querySelector('.artist-album-play').addEventListener('click', e => {
      e.stopPropagation();
      if (alb.tracks.length > 0) playTrackByPath(alb.tracks[0].path, artist.tracks);
    });
    block.appendChild(head);

    const list = document.createElement('div');
    list.className = 'artist-album-tracks';
    alb.tracks.forEach((t, j) => {
      list.appendChild(renderTrackRow(t, j, artist.tracks));
    });
    block.appendChild(list);
    return block;
  };

  const sectionLabel = text => {
    const el = document.createElement('div');
    el.className = 'artist-section-label';
    el.textContent = text;
    return el;
  };

  // Cards mode: a compact cover grid instead of the expanded track lists.
  const makeCard = alb => {
    const card = document.createElement('div');
    card.className = 'aa-card';
    card.innerHTML = `
      <div class="aa-card-cover" style="${alb.cover ? `background-image:url('${alb.cover}')` : ''}"></div>
      <div class="aa-card-name" title="${escapeHtml(alb.album)}">${escapeHtml(alb.album)}</div>
      <div class="aa-card-meta">${[alb.year ? String(alb.year) : '', `${alb.tracks.length} ${pluralTracks(alb.tracks.length)}`].filter(Boolean).map(escapeHtml).join(' · ')}</div>
    `;
    card.addEventListener('click', () => {
      if (!alb.tracks.length) return;
      activeAlbumKey = albumKeyFor(alb.tracks[0]);
      setView('album-detail');
    });
    return card;
  };
  const cardsMode = artistView === 'cards';
  container.classList.toggle('cards-mode', cardsMode);
  const renderRelease = (alb, isSingle) =>
    cardsMode ? makeCard(alb) : makeBlock(alb, isSingle ? tr('btn.single') : tr('btn.album'));

  // A release with 1–2 tracks is a single/EP, not a full album — group them
  // under their own heading so a one-song release stops masquerading as an
  // album block. Both lists stay in the byAlbum year order.
  const albums = byAlbum.filter(a => a.tracks.length >= 3);
  const singles = byAlbum.filter(a => a.tracks.length <= 2);
  // Heading over albums only earns its keep when there's a singles group to
  // divide it from; a lone list needs no label.
  if (albums.length && singles.length) container.appendChild(sectionLabel(tr('artist.albums')));
  albums.forEach(alb => container.appendChild(renderRelease(alb, false)));
  if (singles.length) {
    container.appendChild(sectionLabel(tr('artist.singles')));
    singles.forEach(alb => container.appendChild(renderRelease(alb, true)));
  }

  renderArtistTops(artist);

  $('btn-artist-play').onclick = () => {
    if (artist.tracks.length > 0) playTrackByPath(artist.tracks[0].path, artist.tracks);
  };
  $('btn-artist-shuffle').onclick = () => {
    if (artist.tracks.length > 0) {
      isShuffle = true;
      updateShuffleUI();
      const random = artist.tracks[Math.floor(Math.random() * artist.tracks.length)];
      playTrackByPath(random.path, artist.tracks);
    }
  };
  $('btn-artist-fix-tags').onclick = (e) => openFixTagsMenu(e, artist.tracks, 'fixTags.progress', { name: artist.name });

  renderArtistLastfm(artist.name);
}

// ── Similar artists from Last.fm ──
// Cached per artist so re-renders (search typing, sort) don't re-hit the API.
const lfmArtistCache = readStore('lastfm-similar', 'audex-lfm-similar') || {};
$('artist-similar-list')?.addEventListener('wheel', e => {
  if (e.deltaY) {
    e.preventDefault();
    $('artist-similar-list').scrollLeft += e.deltaY;
  }
}, { passive: false });
async function renderArtistLastfm(name) {
  const simList = $('artist-similar-list');
  if (!simList) return;
  simList.hidden = true; simList.innerHTML = '';
  if (!lfmConfigured() || !name) return;

  const key = name.toLowerCase();
  let similar = lfmArtistCache[key];
  if (!similar) {
    similar = await lfmSimilarArtists(name);
    if (similar) {
      lfmArtistCache[key] = similar;
      writeStore('lastfm-similar', lfmArtistCache, 'audex-lfm-similar');
    }
  }
  if (activeArtistName !== name || currentView !== 'artist-detail') return;  // navigated away

  if (similar && similar.length) {
    const known = new Set(buildArtistsIndex().map(a => a.name.toLowerCase()));
    similar.forEach(n => {
      const inLib = known.has(n.toLowerCase());
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-pill';
      chip.innerHTML = inLib
        ? escapeHtml(n)
        : `<svg class="i" width="11" height="11"><use href="#i-youtube"/></svg><span>${escapeHtml(n)}</span>`;
      chip.title = inLib ? n : tr('ytm.browseArtist');
      chip.addEventListener('click', () => {
        if (inLib) {
          activeArtistName = n;
          setView('artist-detail');
        } else {
          ytmBrowser.open(n);
        }
      });
      simList.appendChild(chip);
    });
    simList.hidden = false;
  }
}

// ── Artist top-tracks columns (local plays | YouTube Music popularity) ──
const mmss = sec => { sec = Math.round(sec || 0); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };
// Loose title match for library ↔ YT Music: drop bracketed "(feat…)" / "[…]"
// noise and collapse whitespace so "Song (feat. X)" ≈ "Song".
const normTitle = s => (s || '').toLowerCase().replace(/[\(\[].*?[\)\]]/g, '').replace(/\s+/g, ' ').trim();

function renderArtistTops(artist) {
  renderArtistTopLocal(artist);
  const col = $('artist-ytm-col');
  if (!settings.ytMusic) { col.hidden = true; return; }
  col.hidden = false;
  renderArtistTopYtm(artist);
}

function renderArtistTopLocal(artist) {
  const box = $('artist-top-local');
  const paths = new Set(artist.tracks.map(t => t.path));
  const counts = new Map();
  for (const e of playLog) { if (paths.has(e.p)) counts.set(e.p, (counts.get(e.p) || 0) + 1); }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  box.innerHTML = '';
  if (!top.length) { box.innerHTML = `<div class="rk-note">${escapeHtml(tr('artist.noPlays'))}</div>`; return; }
  const max = top[0][1];
  top.forEach(([p, c], i) => {
    const t = artist.tracks.find(x => x.path === p);
    if (!t) return;
    const row = document.createElement('div');
    row.className = 'rankrow';
    row.innerHTML = `
      <span class="rk">${i + 1}</span>
      <span class="rk-cover" style="${t.cover ? `background-image:url('${t.cover}')` : ''}"></span>
      <span class="rk-body">
        <div class="rk-title">${escapeHtml(t.title)}</div>
        <div class="rk-sub">${escapeHtml([t.album, mmss(t.duration)].filter(Boolean).join(' · '))}</div>
      </span>
      <span class="rk-stat">${c} ${escapeHtml(tr('report.plays'))}<span class="rk-bar"><i style="width:${Math.round(c / max * 100)}%"></i></span></span>
    `;
    row.addEventListener('click', () => playTrackByPath(t.path, artist.tracks));
    box.appendChild(row);
  });
}

// Session cache for the "Popular on YT Music" column: one fetch per artist per
// run. Crucially the in-flight promise is cached too, so rapid re-renders (a
// keystroke in the track search, a List/Cards toggle) reuse the pending request
// instead of firing a duplicate. A resolved entry has `.state`; an entry with
// only `.promise` is a fetch still in flight.
async function renderArtistTopYtm(artist) {
  const box = $('artist-top-ytm');
  const name = artist.name;
  const entry = artistYtmCache.get(name);
  if (entry && entry.state) { paintArtistYtm(box, entry, artist); return; }   // resolved — no network
  box.innerHTML = '<div class="rk-skeleton"></div>'.repeat(4);
  const pending = (entry && entry.promise) || fetchArtistTopYtm(name);
  if (!entry) artistYtmCache.set(name, { promise: pending });
  const r = await pending;
  artistYtmCache.set(name, r);   // replace the in-flight marker with the result
  if (activeArtistName === name) paintArtistYtm(box, r, artist);
}

// One round-trip: resolve the artist's YT Music browseId, then its top songs.
// Returns a resolved cache entry ({ state, songs? }); never throws.
async function fetchArtistTopYtm(name) {
  try {
    const s = await window.electronAPI.ytmSearchArtists(name);
    const browseId = s && s.success && s.artists[0] && s.artists[0].browseId;
    if (!browseId) return { state: 'empty' };
    const res = await window.electronAPI.ytmArtistTopSongs(browseId);
    return (res && res.success && res.songs.length) ? { state: 'ok', songs: res.songs } : { state: 'empty' };
  } catch (_) {
    return { state: 'error' };
  }
}

function paintArtistYtm(box, result, artist) {
  box.innerHTML = '';
  if (result.state !== 'ok') {
    box.innerHTML = `<div class="rk-note">${escapeHtml(tr(result.state === 'error' ? 'artist.ytmError' : 'artist.ytmEmpty'))}</div>`;
    return;
  }
  const libTitles = new Set(artist.tracks.map(t => normTitle(t.title)));
  result.songs.forEach((song, i) => {
    const inLib = libTitles.has(normTitle(song.title));
    const row = document.createElement('div');
    row.className = 'rankrow';
    row.innerHTML = `
      <span class="rk">${i + 1}</span>
      <span class="rk-cover" style="${song.thumb ? `background-image:url('${song.thumb}')` : ''}"></span>
      <span class="rk-body">
        <div class="rk-title">${escapeHtml(song.title)}</div>
        <div class="rk-sub">${escapeHtml(song.sub || 'YouTube Music')}</div>
      </span>
      ${inLib
        ? `<span class="rk-inlib"><svg class="i" width="12" height="12"><use href="#i-check"/></svg>${escapeHtml(tr('artist.inLibrary'))}</span>`
        : `<button class="rk-add"><svg class="i" width="11" height="11"><use href="#i-plus"/></svg>${escapeHtml(tr('artist.queue'))}</button>`}
    `;
    if (!inLib) {
      const btn = row.querySelector('.rk-add');
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (queueArtistYtmSong(song, artist.name) !== false) {
          btn.classList.add('is-queued');
          btn.innerHTML = `<svg class="i" width="11" height="11"><use href="#i-check"/></svg>${escapeHtml(tr('artist.queued'))}`;
        }
      });
    }
    box.appendChild(row);
  });
}

// Enqueue one YT Music song through the same download path the Parsing tab uses.
function queueArtistYtmSong(song, artistName) {
  const t = { id: song.videoId, title: song.title, artist: artistName, url: `https://music.youtube.com/watch?v=${song.videoId}` };
  if (isYtmTrackInQueue(t)) return false;
  downloadQueue.push(buildQueueItemFromYtm(t, 1));
  renderQueue();
  updateQueueTabBadge();
  startQueueWorker();
  return true;
}

// ── Albums ──
// Grouped globally from the library, like Artists — not user-curated like
// Playlists. Keyed on (album title, primary artist) rather than just the
// title, since the same album name can exist under different artists. The
// grid/detail UI reuses the Playlist grid/hero/track-table classes wholesale
// (.playlist-card, .pl-hero, .track-table) rather than duplicating them.
// albumKeyFor is the single source of truth for that key — renderTrackRow's
// Album hyperlink computes the same key to jump straight to the right album
// without rebuilding the whole index just to look one up.
function albumKeyFor(t) {
  const name = t.album || tr('label.noAlbum');
  const artist = splitArtists(t.artist)[0];
  return name.toLowerCase() + ' ' + artist.toLowerCase();
}

function buildAlbumsIndex() {
  const map = new Map();
  libraryWithNetwork().forEach((t, idx) => {
    const name = t.album || tr('label.noAlbum');
    const artist = splitArtists(t.artist)[0];
    const key = albumKeyFor(t);
    let a = map.get(key);
    if (!a) { a = { key, name, artist, year: t.year, tracks: [], lastIdx: idx }; map.set(key, a); }
    a.tracks.push(t);
    if (idx > a.lastIdx) a.lastIdx = idx;
    if (!a.year && t.year) a.year = t.year;
  });
  const out = [];
  for (const a of map.values()) {
    out.push({
      key: a.key, name: a.name, artist: a.artist, year: a.year,
      tracks: a.tracks, trackCount: a.tracks.length, lastIdx: a.lastIdx,
      cover: (a.tracks.find(t => t.cover) || {}).cover || null,
    });
  }
  return out;
}

function sortAlbums(arr) {
  const c = arr.slice();
  if (albumsSort === 'tracks') c.sort((a, b) => b.trackCount - a.trackCount || a.name.localeCompare(b.name));
  else if (albumsSort === 'recent') c.sort((a, b) => b.lastIdx - a.lastIdx);
  else c.sort((a, b) => a.name.localeCompare(b.name));
  return c;
}

// Disc/track-number listening order; falls back to title when tags are missing.
// Shared by every list that represents an album (album detail, artist detail's
// per-album grouping, and the library's by-artist sort tie-break below).
function compareTrackOrder(a, b) {
  const da = parseInt(a.discNo, 10) || 0, db = parseInt(b.discNo, 10) || 0;
  if (da !== db) return da - db;
  const ta = parseInt(a.trackNo, 10) || 0, tb = parseInt(b.trackNo, 10) || 0;
  if (ta !== tb) return ta - tb;
  return a.title.localeCompare(b.title);
}
function sortAlbumTracks(tracks) {
  return tracks.slice().sort(compareTrackOrder);
}

function renderAlbums() {
  // The active chip is markup-default in index.html, so restore the stored one
  // here — this runs on every entry to the view, boot included.
  document.querySelectorAll('#view-albums .chip').forEach(c => {
    c.classList.toggle('active', c.dataset.albumsSort === albumsSort);
  });
  const all = buildAlbumsIndex();
  const q = ($('albums-search').value || '').trim().toLowerCase();
  const filtered = q
    ? all.filter(a => a.name.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q))
    : all;
  const sorted = sortAlbums(filtered);

  $('albums-count-label').textContent = `${all.length} ${pluralAlbums(all.length)}`;
  const grid = $('albums-grid');
  const empty = $('albums-empty');
  grid.innerHTML = '';
  grid.classList.toggle('list-mode', albumsViewMode === 'list');

  if (all.length === 0) {
    grid.style.display = 'none';
    empty.classList.add('show');
    renderCounts();
    return;
  }
  empty.classList.remove('show');
  grid.style.display = albumsViewMode === 'list' ? 'flex' : 'grid';

  const listMode = albumsViewMode === 'list';

  const makeCard = (a, i) => {
    const card = document.createElement('div');
    card.className = 'playlist-card';
    card.dataset.album = a.key;
    const coverStyle = a.cover ? `background:url('${a.cover}') center/cover` : `background:${PL_COVERS[i % PL_COVERS.length]}`;
    card.innerHTML = `
      <div class="playlist-cover" style="${coverStyle}">
        ${a.cover ? '' : `<span class="playlist-letter">${escapeHtml((a.name || '?')[0])}</span>`}
      </div>
      <div class="playlist-text">
        <div class="playlist-name">${escapeHtml(a.name)}</div>
        <div class="playlist-desc">${escapeHtml(a.artist)}</div>
      </div>
      <div class="playlist-stats">
        <span>${a.trackCount} ${pluralTracks(a.trackCount)}</span>
        <span>·</span>
        <span>${formatTotalDuration(a.tracks)}</span>
      </div>
    `;
    card.addEventListener('click', () => { activeAlbumKey = a.key; setView('album-detail'); });
    return card;
  };

  // List mode reuses the artist page's expandable album block: header + the
  // album's full track list, so tracks are browsable without opening the album.
  const makeListBlock = a => {
    const block = document.createElement('div');
    block.className = 'artist-album';
    block.dataset.album = a.key;
    const tracks = sortAlbumTracks(a.tracks);
    const head = document.createElement('div');
    head.className = 'artist-album-head';
    head.innerHTML = `
      <div class="artist-album-cover pl-meta-link" style="${a.cover ? `background-image:url('${a.cover}')` : ''}" title="${escapeHtml(a.name)}"></div>
      <div class="artist-album-info">
        <div class="artist-album-name pl-meta-link" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</div>
        <div class="artist-album-meta">
          <span>${escapeHtml(a.artist)}</span><span>·</span>
          ${a.year ? `<span>${escapeHtml(String(a.year))}</span><span>·</span>` : ''}
          <span>${a.trackCount} ${pluralTracks(a.trackCount)}</span>
        </div>
      </div>
      <button class="artist-album-play">
        <svg class="i" width="10" height="10"><use href="#i-play"/></svg>
        ${escapeHtml(tr('btn.album'))}
      </button>
    `;
    const goto = e => { e.stopPropagation(); activeAlbumKey = a.key; setView('album-detail'); };
    head.querySelector('.artist-album-cover').addEventListener('click', goto);
    head.querySelector('.artist-album-name').addEventListener('click', goto);
    head.querySelector('.artist-album-play').addEventListener('click', e => {
      e.stopPropagation();
      if (tracks.length) playTrackByPath(tracks[0].path, tracks);
    });
    block.appendChild(head);
    const list = document.createElement('div');
    list.className = 'artist-album-tracks';
    tracks.forEach((t, j) => list.appendChild(renderTrackRow(t, j, tracks)));
    block.appendChild(list);
    return block;
  };

  sorted.forEach((a, i) => {
    if (!a.cover) {
      const t = a.tracks.find(t => !t.cover);
      if (t) ensureCoverFor(t);
    }
    grid.appendChild(listMode ? makeListBlock(a) : makeCard(a, i));
  });
  renderCounts();
}

// Cover loads should update existing cards in place — mirrors refreshArtistsCoversInPlace.
function refreshAlbumsCoversInPlace() {
  const grid = $('albums-grid');
  if (!grid) return;
  const cards = grid.querySelectorAll('[data-album]');   // .playlist-card (cards) or .artist-album (list)
  if (cards.length === 0) return;
  const byKey = new Map();
  buildAlbumsIndex().forEach(a => { if (a.cover) byKey.set(a.key, a.cover); });
  cards.forEach(card => {
    const url = byKey.get(card.dataset.album);
    if (!url) return;
    const tile = card.querySelector('.playlist-cover');
    if (tile) {
      if (/url\(/.test(tile.style.background)) return;
      tile.style.background = `url('${url}') center/cover`;
      const letter = tile.querySelector('.playlist-letter');
      if (letter) letter.remove();
      return;
    }
    const aac = card.querySelector('.artist-album-cover');   // list-mode block
    if (aac && !/url\(/.test(aac.style.backgroundImage)) aac.style.backgroundImage = `url('${url}')`;
  });
}

function renderAlbumDetail(key) {
  const all = buildAlbumsIndex();
  const album = all.find(a => a.key === key);
  if (!album) { setView('albums'); return; }

  $('album-detail-crumb').textContent = album.name;
  const artistCrumb = $('album-detail-artist-crumb');
  artistCrumb.textContent = album.artist;
  artistCrumb.onclick = () => { activeArtistName = album.artist; setView('artist-detail'); };
  $('album-detail-title').textContent = album.name;
  if (album.cover) {
    $('album-hero-letter').textContent = '';
    $('album-hero-cover').style.background = `url('${album.cover}') center/cover`;
  } else {
    $('album-hero-letter').textContent = (album.name || '?')[0];
    $('album-hero-cover').style.background = PL_COVERS[0];
    const t = album.tracks.find(t => !t.cover);
    if (t) ensureCoverFor(t);
  }
  $('album-detail-meta').innerHTML = `
    <span class="pl-meta-link" id="album-detail-artist-link">${escapeHtml(album.artist)}</span>
    <span>·</span>
    <span>${album.trackCount} ${pluralTracks(album.trackCount)}</span>
    <span>·</span>
    <span>${formatTotalDuration(album.tracks)}</span>
    ${album.year ? `<span>·</span><span>${escapeHtml(String(album.year))}</span>` : ''}
  `;
  $('album-detail-artist-link').addEventListener('click', () => {
    activeArtistName = album.artist;
    setView('artist-detail');
  });

  const tracks = sortAlbumTracks(album.tracks);
  const list = $('album-detail-list');
  if (tracks.length === 0) {
    list.innerHTML = '';
    list.style.height = '';
  } else {
    if (!albumVList) albumVList = createVirtualList({ listEl: list, scrollEl });
    albumVList.setItems(tracks, (t, i, queue) => renderTrackRow(t, i, queue));
  }

  $('btn-album-play').onclick = () => {
    if (tracks.length > 0) playTrackByPath(tracks[0].path, tracks);
  };
  $('btn-album-shuffle').onclick = () => {
    if (tracks.length > 0) {
      isShuffle = true;
      updateShuffleUI();
      const random = tracks[Math.floor(Math.random() * tracks.length)];
      playTrackByPath(random.path, tracks);
    }
  };
  $('btn-album-fix-tags').onclick = (e) => openFixTagsMenu(e, tracks, 'fixTags.progress', { albumActions: true, name: album.name });
}

// ── Crossfade ──
// Gated by settings.crossfade. The main <audio> element stays the single source
// of truth for everything else (progress, seek, MediaSession); the
// outgoing track is handed to a transient Audio object that plays only its tail
// while the main element fades the new track in. That way no existing wiring has
// to learn about a second element.
// Read live from settings so a drag of the slider applies to the next switch
// without a reload. Clamped to the slider's own 0–10 s range.
function crossfadeMs() {
  const s = Number(settings.crossfadeSec);
  return (Number.isFinite(s) ? Math.max(0, Math.min(10, s)) : 3) * 1000;
}
let crossfadeTail = null;      // transient Audio playing the outgoing track
let crossfadeTailTimer = null;
let crossfadeRampId = null;    // rAF id of the incoming fade-in
let crossfadeArmed = false;    // per-track guard for the end-of-track trigger
// The user's chosen volume. audio.volume is transient while a fade runs, so the
// slider, the mute icon, and the fade ceiling all read this instead.
let targetVolume = 1;

function rampVolume(el, to, ms, onDone) {
  const from = el.volume;
  const rising = to >= from;
  const start = performance.now();
  let id = 0;
  const step = (now) => {
    // ms === 0 (crossfade length 0) would make this NaN — jump straight to the end.
    const k = ms > 0 ? Math.min(1, (now - start) / ms) : 1;
    // Equal-power (sin/cos) curve, not linear: an outgoing cos and incoming sin
    // ramp keep a²+b² constant, so perceived loudness holds steady through the
    // crossover. A linear amplitude ramp instead dips to ~71% at the midpoint —
    // that mid-fade dip is the audible "switch".
    const g = rising ? Math.sin(k * Math.PI / 2) : Math.cos(k * Math.PI / 2);
    const v = rising ? from + (to - from) * g : to + (from - to) * g;
    try { el.volume = Math.max(0, Math.min(1, v)); } catch (_) {}
    if (k < 1) id = requestAnimationFrame(step);
    else if (onDone) onDone();
  };
  id = requestAnimationFrame(step);
  return () => cancelAnimationFrame(id);
}

function stopCrossfadeTail() {
  if (crossfadeTailTimer) { clearTimeout(crossfadeTailTimer); crossfadeTailTimer = null; }
  if (crossfadeTail) {
    try { crossfadeTail.pause(); crossfadeTail.src = ''; } catch (_) {}
    crossfadeTail = null;
  }
}

// Hand the currently playing track to a transient element and fade it out.
// `onReady` fires once the tail has actually taken over playback (or failed
// to) — the caller must not touch audio.src before then, or the outgoing
// track's sound dies while the tail is still loading, leaving a silent gap.
function startCrossfadeTail(onReady) {
  stopCrossfadeTail();
  if (!audio.src || audio.paused || audio.muted) { onReady(); return; }
  const pos = audio.currentTime;
  const tail = new Audio();
  crossfadeTail = tail;
  tail.volume = audio.volume;
  // currentTime only sticks once metadata is in (local files: a few ms) —
  // setting it right after .src assignment is silently dropped and the tail
  // would restart the outgoing track from 0:00.
  tail.addEventListener('loadedmetadata', () => {
    if (crossfadeTail !== tail) return;
    try { tail.currentTime = pos; } catch (_) {}
    tail.play().then(() => {
      if (crossfadeTail !== tail) { try { tail.pause(); } catch (_) {} return; }
      rampVolume(tail, 0, crossfadeMs());
      onReady();
    }).catch(() => { if (crossfadeTail === tail) stopCrossfadeTail(); onReady(); });
  }, { once: true });
  tail.src = audio.src;
  // Hard stop so a tail can never outlive its fade (e.g. if the ramp is lost).
  crossfadeTailTimer = setTimeout(() => {
    if (crossfadeTail === tail) stopCrossfadeTail();
  }, crossfadeMs() + 1500);
}

// ── Playback ──
// A remote track's `path` is the peer's signed stream URL, so it plays through
// exactly the same code as a local file — only the src prefix differs.
// `blob:` is a local-session file (mobile's file-picker fallback, no disk
// path behind it) — it behaves exactly like a remote track everywhere here:
// playable as-is, but no tag edits/cover lookups/reveal-in-folder.
function isRemotePath(p) { return /^(https?|blob):/.test(String(p || '')); }
function isTagEditingLocked(p) {
  if (!p || !currentTrack || currentTrack.path !== p) return false;
  const ext = (String(p).split('.').pop() || '').toLowerCase();
  return ext !== 'opus' && ext !== 'ogg';
}
function srcFor(track) { return isRemotePath(track.path) ? track.path : 'file://' + track.path; }

// Resolve against the queue before the library: a queue of peer tracks has no
// entries in `library`, and next/prev/shuffle all route through here.
function playTrackByPath(path, queue) {
  const q = queue && queue.length > 0 ? queue : library;
  const track = q.find(t => t.path === path) || trackByPath(path);
  if (!track) return;
  currentTrack = track;
  currentQueue = q;
  if (!track.cover && !isRemotePath(track.path)) ensureCoverFor(track);
  const fade = !!settings.crossfade && !audio.paused && !!audio.src;
  // The swap (killing the old track's sound by reassigning audio.src) must wait
  // until the tail has actually taken over — otherwise there's a silent gap
  // between the old track dying and the tail loading in.
  const swap = () => {
    if (crossfadeRampId) { crossfadeRampId(); crossfadeRampId = null; }
    crossfadeArmed = false;
    audio.src = srcFor(track);
    if (fade) {
      audio.volume = 0;
      crossfadeRampId = rampVolume(audio, targetVolume, crossfadeMs(), () => { crossfadeRampId = null; });
    } else {
      audio.volume = targetVolume;
    }
    audio.play().catch(e => console.warn('play error:', e));
    isPlaying = true;
    // recent — a peer's URL is not something a later session could reopen.
    if (!isRemotePath(path)) {
      recents = [path, ...recents.filter(p => p !== path)].slice(0, 4);
      saveRecents();
      renderRecents();
    }
    updateNowPlayingUI(track);
    refreshPlayingHighlight();
  };
  if (fade) startCrossfadeTail(swap); else swap();
}

// ── Session ──
// recents[0] already survived a restart, but only as "which track was loaded" —
// position, shuffle, repeat and volume were lost. This keeps the rest of it.
// Written on a 5 s throttle while playing (so a crash costs at most 5 s of
// position) and forced on pause and on window teardown, which also covers
// closing to tray, where no unload event fires.
let lastSessionSave = 0;
function saveSession(force) {
  const now = Date.now();
  if (!force && now - lastSessionSave < 5000) return;
  lastSessionSave = now;
  try {
    const track = currentTrack;
    localStorage.setItem(LS.session, JSON.stringify({
      path: track ? track.path : '',
      position: Number(audio.currentTime) || 0,
      shuffle: isShuffle,
      repeat: repeatMode,
      volume: targetVolume,
    }));
  } catch (_) { /* quota or private mode — the session is not worth failing over */ }
}
function readSession() {
  try { return JSON.parse(localStorage.getItem(LS.session) || 'null'); }
  catch (_) { return null; }
}
window.addEventListener('pagehide', () => saveSession(true));
audio.addEventListener('pause', () => saveSession(true));

function loadLastTrack() {
  const sess = readSession();
  if (sess) {
    // Modes are independent of whether the track still exists on disk.
    isShuffle = !!sess.shuffle;
    repeatMode = [0, 1, 2].includes(sess.repeat) ? sess.repeat : 0;
    updateShuffleUI();
    updateRepeatUI();
    if (Number.isFinite(sess.volume)) setVolume(sess.volume);
  }
  const lastPath = (sess && sess.path) || recents[0];
  if (!lastPath) return;
  const realIndex = trackIndexByPath(lastPath);
  if (realIndex < 0) return;
  const track = library[realIndex];
  currentTrack = track;
  currentQueue = library;
  if (!track.cover) ensureCoverFor(track);
  audio.src = 'file://' + track.path;
  // Deliberately paused: restoring where you were is helpful, starting music on
  // its own is not. currentTime only sticks once metadata is in.
  const pos = sess && Number(sess.position) > 0 ? Number(sess.position) : 0;
  if (pos > 0) {
    audio.addEventListener('loadedmetadata', () => {
      if (pos < audio.duration - 1) { try { audio.currentTime = pos; } catch (_) {} }
    }, { once: true });
  }
  isPlaying = false;
  updateNowPlayingUI(track);
  refreshPlayingHighlight();
}

function refreshCurrentViewRows() {
  if (currentView === 'library') renderLibrary();
  else if (currentView === 'favorites') renderFavorites();
  else if (currentView === 'playlist-detail') renderPlaylistDetail(activePlaylistId);
  else if (currentView === 'artists') renderArtists();
  else if (currentView === 'artist-detail') renderArtistDetail(activeArtistName);
  else if (currentView === 'album-detail') renderAlbumDetail(activeAlbumKey);
}

// Cheap path: only the .playing/equalizer indicator changes — repaint visible rows in place.
// Refreshes every track-row surface unconditionally rather than matching
// currentView to one virtual list — refreshVisible()/querySelectorAll only
// touch rows that are actually mounted, so this stays cheap, and it removes
// the "forgot to wire in the new view" trap that let a new detail view's
// highlight go stale silently (as Album's briefly did).
function refreshPlayingHighlight() {
  [libraryVList, favoritesVList, playlistVList, albumVList].forEach(v => v && v.refreshVisible());
  // Artist detail renders rows directly (no virtual list) — patch them in place.
  refreshPlainListHighlight($('artist-albums'));
}

function refreshPlainListHighlight(container) {
  if (!container) return;
  const playingPath = currentTrack ? currentTrack.path : null;
  container.querySelectorAll('.trow').forEach(row => {
    const isPlayingRow = row.dataset.path === playingPath;
    const wasPlaying = row.classList.contains('playing');
    if (isPlayingRow === wasPlaying) return;
    row.classList.toggle('playing', isPlayingRow);
    const numCell = row.querySelector('.trow-num');
    if (!numCell) return;
    if (isPlayingRow) {
      numCell.innerHTML = `<span class="equalizer"><span></span><span></span><span></span></span>`;
    } else {
      const parent = row.parentElement;
      const idx = parent ? Array.prototype.indexOf.call(parent.children, row) : 0;
      numCell.textContent = String(idx + 1).padStart(2, '0');
    }
  });
}

// ── Track-change animation ──
let trackChangeDirection = 0;   // +1 = next, -1 = prev, 0 = direct pick (fade)
let lastNowPlayingPath = null;
const swapState = new WeakMap();

function cancelSwap(el) {
  const s = swapState.get(el);
  if (!s) return;
  try { s.cloneAnim && s.cloneAnim.cancel(); } catch {}
  try { s.targetAnim && s.targetAnim.cancel(); } catch {}
  if (s.clone && s.clone.parentNode) s.clone.remove();
  swapState.delete(el);
}

function cloneForSwap(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  const clone = el.cloneNode(true);
  clone.removeAttribute('id');
  clone.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
  const cs = getComputedStyle(el);
  if (cs.backgroundImage && cs.backgroundImage !== 'none') {
    clone.style.backgroundImage = cs.backgroundImage;
  }
  clone.style.position = 'fixed';
  clone.style.left = rect.left + 'px';
  clone.style.top = rect.top + 'px';
  clone.style.width = rect.width + 'px';
  clone.style.height = rect.height + 'px';
  clone.style.margin = '0';
  clone.style.pointerEvents = 'none';
  clone.style.zIndex = '500';
  return { clone, originalEl: el, rect };
}

function animateSwap(snap, direction, kind) {
  if (!snap) return;
  const { clone, originalEl, rect } = snap;
  cancelSwap(originalEl);
  document.body.appendChild(clone);

  let outFrames, inFrames, outDuration, inDuration, inDelay;
  if (kind === 'cover') {
    const dist = Math.max(24, rect.width * 0.28);
    if (direction > 0) {
      outFrames = [{ transform: 'translate(0,0)', opacity: 1 }, { transform: `translateX(${-dist}px)`, opacity: 0 }];
      inFrames  = [{ transform: `translateX(${dist}px)`, opacity: 0 }, { transform: 'translate(0,0)', opacity: 1 }];
    } else if (direction < 0) {
      outFrames = [{ transform: 'translate(0,0)', opacity: 1 }, { transform: `translateX(${dist}px)`, opacity: 0 }];
      inFrames  = [{ transform: `translateX(${-dist}px)`, opacity: 0 }, { transform: 'translate(0,0)', opacity: 1 }];
    } else {
      outFrames = [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.92)', opacity: 0 }];
      inFrames  = [{ transform: 'scale(1.06)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }];
    }
    outDuration = 320; inDuration = 440; inDelay = 60;
  } else {
    const dy = direction === 0 ? 6 : 12;
    if (direction > 0) {
      outFrames = [{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(${-dy}px)`, opacity: 0 }];
      inFrames  = [{ transform: `translateY(${dy}px)`, opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }];
    } else if (direction < 0) {
      outFrames = [{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(${dy}px)`, opacity: 0 }];
      inFrames  = [{ transform: `translateY(${-dy}px)`, opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }];
    } else {
      outFrames = [{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(${-dy}px)`, opacity: 0 }];
      inFrames  = [{ transform: `translateY(${dy}px)`, opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }];
    }
    outDuration = 240; inDuration = 320; inDelay = 90;
  }

  const cloneAnim = clone.animate(outFrames, {
    duration: outDuration,
    easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
    fill: 'forwards',
  });
  const targetAnim = originalEl.animate(inFrames, {
    duration: inDuration,
    easing: 'cubic-bezier(0.34, 1.3, 0.64, 1)',
    fill: 'both',
    delay: inDelay,
  });

  const cleanup = () => {
    if (clone.parentNode) clone.remove();
    try { targetAnim.cancel(); } catch {}
    if (swapState.get(originalEl)?.clone === clone) swapState.delete(originalEl);
  };
  Promise.all([cloneAnim.finished, targetAnim.finished]).then(cleanup).catch(cleanup);

  swapState.set(originalEl, { clone, cloneAnim, targetAnim });
}

function updateNowPlayingUI(track) {
  // Repaint the backdrop when it follows the artwork of the playing track.
  if (settings.bgSource === 'cover') applyAppearance();
  const coverSrc = track.cover || null;
  const isTrackChange = lastNowPlayingPath !== null && lastNowPlayingPath !== track.path;
  const direction = isTrackChange ? trackChangeDirection : 0;
  trackChangeDirection = 0;
  const overlayActive = $('fullscreen-overlay').classList.contains('active');

  // Snapshot previous visuals BEFORE applying new state.
  // When the fullscreen overlay is open, the mini-player is hidden behind it —
  // skip its clones so they don't float over the overlay.
  let snaps = null;
  if (isTrackChange) {
    snaps = {
      miniCover:  overlayActive ? null : cloneForSwap($('mini-cover-wrapper')),
      miniTitle:  overlayActive ? null : cloneForSwap($('track-title')),
      miniArtist: overlayActive ? null : cloneForSwap($('track-artist')),
      fsCover:    overlayActive ? cloneForSwap($('fs-cover'))   : null,
      fsTitle:    overlayActive ? cloneForSwap($('fs-title'))   : null,
      fsArtist:   overlayActive ? cloneForSwap($('fs-artist'))  : null,
      fsAlbum:    overlayActive ? cloneForSwap($('fs-album'))   : null,
    };
  }

  // Mini cover
  const miniCover = $('mini-cover-wrapper');
  if (coverSrc) {
    miniCover.style.backgroundImage = `url('${coverSrc}')`;
    $('mini-cover-letter').textContent = '';
  } else {
    miniCover.style.backgroundImage = '';
    $('mini-cover-letter').textContent = (track.title || '?')[0];
  }
  $('track-title').textContent = track.title;
  $('track-artist').innerHTML = `<span class="artist-link">${escapeHtml(track.artist || '—')}</span>`;
  const qBadge = $('track-quality');
  if (qBadge) qBadge.innerHTML = qualityBadgeHtml(qualityFor(track));

  // Fullscreen
  const fsCover = $('fs-cover');
  const fsOverlay = $('fullscreen-overlay');
  if (coverSrc) {
    fsCover.style.backgroundImage = `url('${coverSrc}')`;
    $('fs-cover-letter').textContent = '';
    $('fs-backdrop').style.background = `url('${coverSrc}') center/cover`;
    if (fsOverlay) fsOverlay.style.setProperty('--fs-cover-img', `url('${coverSrc}')`);
    updateFsShaderTexture(coverSrc);
  } else {
    fsCover.style.backgroundImage = '';
    $('fs-cover-letter').textContent = (track.title || '?')[0];
    $('fs-backdrop').style.background = 'transparent';
    if (fsOverlay) fsOverlay.style.setProperty('--fs-cover-img', 'none');
    updateFsShaderTexture(null);
  }
  $('fs-title').textContent = track.title;
  $('fs-artist').textContent = track.artist;
  $('fs-album').textContent = track.album + (track.year ? ` · ${track.year}` : '');

  if (snaps) {
    animateSwap(snaps.miniCover,  direction, 'cover');
    animateSwap(snaps.miniTitle,  direction, 'text');
    animateSwap(snaps.miniArtist, direction, 'text');
    animateSwap(snaps.fsCover,    direction, 'cover');
    animateSwap(snaps.fsTitle,    direction, 'text');
    animateSwap(snaps.fsArtist,   direction, 'text');
    animateSwap(snaps.fsAlbum,    direction, 'text');
  }
  lastNowPlayingPath = track.path;

  setProgressUI();

  updateFavoriteUI();
  updatePlayButtonUI();
  updateFullscreenQueue();
  if (fsLyricsOpen) loadFsLyrics(track);
  updateMediaSessionMetadata(track);
  pushDiscordActivity(true);
  if (isSettingsOpen()) renderDiscordPreviewOnly();
}

function updatePlayButtonUI() {
  const playIcon = $('playIcon');
  if (playIcon) playIcon.textContent = isPlaying ? 'pause' : 'play_arrow';
  const playBtn = $('btn-play');
  if (playBtn) playBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  const fsPlayIcon = $('fsPlayIcon');
  if (fsPlayIcon) fsPlayIcon.textContent = isPlaying ? 'pause' : 'play_arrow';
  const fsPlayBtn = $('fs-btn-play');
  if (fsPlayBtn) fsPlayBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  document.documentElement.classList.toggle('is-playing', isPlaying);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }
  syncTray();
  syncWaveAnim();
}

// MediaSession (maps to MPRIS on Linux, SMTC on Windows — OS-level "now playing"
// thumbnails and lock-screen controls)
let mediaSessionArtworkUrl = null;   // last blob: URL we handed out, revoked once replaced
async function updateMediaSessionMetadata(track) {
  if (!('mediaSession' in navigator) || !track) return;
  let coverSrc = track.cover;
  // MediaImage only accepts http(s)/data/blob src. The disk cover cache hands
  // back file:// URLs (fine for <img>/background-image, silently rejected
  // here), so most tracks otherwise show no artwork in the OS thumbnail/lock
  // screen — fetch and re-wrap as a blob: URL, which the spec does accept.
  if (coverSrc && coverSrc.startsWith('file://')) {
    try {
      const res = await fetch(coverSrc);
      coverSrc = URL.createObjectURL(await res.blob());
    } catch (_) { coverSrc = null; }
    if (track !== currentTrack) {  // a newer track landed while this was in flight
      if (coverSrc) URL.revokeObjectURL(coverSrc);
      return;
    }
  }
  if (mediaSessionArtworkUrl) { URL.revokeObjectURL(mediaSessionArtworkUrl); mediaSessionArtworkUrl = null; }
  if (coverSrc && coverSrc.startsWith('blob:')) mediaSessionArtworkUrl = coverSrc;
  const mime = coverSrc && coverSrc.startsWith('data:') ? (coverSrc.match(/^data:([^;]+);/) || [])[1] : null;
  const artwork = coverSrc
    ? [{ src: coverSrc, sizes: '512x512', ...(mime ? { type: mime } : {}) }]
    : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title || '',
    artist: track.artist || '',
    album: (track.album || '') + (track.year ? ` · ${track.year}` : ''),
    artwork,
  });
}

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => { if (!isPlaying) togglePlay(); });
  navigator.mediaSession.setActionHandler('pause', () => { if (isPlaying) togglePlay(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
  navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
  navigator.mediaSession.setActionHandler('seekto', (e) => {
    if (e.seekTime != null && isFinite(audio.duration)) audio.currentTime = e.seekTime;
  });
}

function updateFavoriteUI() {
  if (!currentTrack) return;
  const t = currentTrack;
  const fav = favorites.includes(t.path);
  const heart = $('btn-favorite');
  if (heart) {
    const wasLiked = heart.classList.contains('liked');
    heart.classList.toggle('liked', fav);
    heart.classList.toggle('active', fav);
    heart.setAttribute('aria-pressed', fav);
    heart.setAttribute('aria-label', fav ? 'Unlike' : 'Like');
    heart.title = fav ? 'Unlike' : 'Like';
    const ic = heart.querySelector('.material-symbols-rounded');
    if (ic) ic.style.fontVariationSettings = fav ? "'FILL' 1, 'wght' 500" : "'FILL' 0, 'wght' 400";
    if (fav && !wasLiked) {
      heart.classList.remove('is-animating');
      void heart.offsetWidth;
      heart.classList.add('is-animating');
    }
  }

  const fsFav = $('fs-btn-favorite');
  if (fsFav) {
    fsFav.classList.toggle('liked', fav);
    fsFav.classList.toggle('active', fav);
    fsFav.setAttribute('aria-pressed', fav);
  }
  syncTray();
}

// Push current now-playing snapshot to the main-process tray so it can update
// its menu labels and tooltip. Safe to call before electronAPI is wired.
function syncTray() {
  if (!window.electronAPI || !window.electronAPI.updateTrayState) return;
  const t = currentTrack;
  window.electronAPI.updateTrayState({
    hasTrack: !!t,
    isPlaying: !!isPlaying,
    isFavorite: t ? favorites.includes(t.path) : false,
    title: t ? (t.title || '') : '',
    artist: t ? (t.artist || '') : '',
  });
}

if (window.electronAPI && window.electronAPI.onTrayCommand) {
  window.electronAPI.onTrayCommand(({ action }) => {
    switch (action) {
      case 'playPause':      togglePlay(); break;
      case 'next':           nextTrack(); break;
      case 'prev':           prevTrack(); break;
      case 'toggleFavorite': {
        if (currentTrack) toggleFavorite(currentTrack.path);
        break;
      }
    }
  });
}

function togglePlay() {
  if (typeof triggerButtonSquish === 'function') triggerButtonSquish($('btn-play'));
  if (!currentTrack && library.length > 0) {
    playTrackByPath(library[0].path, library);
    return;
  }
  if (audio.paused) { audio.play(); isPlaying = true; }
  else { audio.pause(); isPlaying = false; stopCrossfadeTail(); }
  updatePlayButtonUI();
}

function rebuildShuffleQueue() {
  if (!currentQueue || currentQueue.length <= 1) {
    shuffledQueue = currentQueue ? [...currentQueue] : [];
    return;
  }
  const curPath = currentTrack ? currentTrack.path : null;
  const others = currentQueue.filter(t => t.path !== curPath);
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  shuffledQueue = currentTrack ? [currentTrack, ...others] : others;
}

function getUpcomingQueue(limit = 8) {
  if (!currentTrack || !currentQueue.length) return [];
  if (repeatMode === 2) return [currentTrack];
  const activeQ = (isShuffle && shuffledQueue.length === currentQueue.length) ? shuffledQueue : currentQueue;
  const curPath = currentTrack.path;
  const idx = activeQ.findIndex(t => t.path === curPath);
  if (idx < 0) return [];
  const list = [];
  const total = activeQ.length;
  for (let i = 1; i < total && list.length < limit; i++) {
    const nextIdx = idx + i;
    if (nextIdx < total) {
      list.push(activeQ[nextIdx]);
    } else if (repeatMode === 1) {
      list.push(activeQ[nextIdx % total]);
    } else {
      break;
    }
  }
  return list;
}

// `manual` is true for every real skip (playbar/hotkey/media-key/remote) and
// false for the two internal auto-advances (crossfade pre-empt, 'ended').
// Repeat-one only makes sense while a track is left to loop on its own —
// a manual skip is the user choosing to move on, so (unless turned off in
// Settings) it drops back to "repeat all" instead of trapping the next track
// in the same loop.
function nextTrack({ manual = true } = {}) {
  if (manual && typeof triggerButtonSquish === 'function') triggerButtonSquish($('btn-next'));
  if (currentQueue.length === 0) return;
  if (manual && repeatMode === 2 && settings.repeatOneResetOnSkip) { repeatMode = 1; updateRepeatUI(); }
  trackChangeDirection = 1;
  const curPath = currentTrack ? currentTrack.path : null;
  const activeQ = (isShuffle && shuffledQueue.length === currentQueue.length) ? shuffledQueue : currentQueue;
  const inQueueIdx = activeQ.findIndex(t => t.path === curPath);
  let nextIdx = inQueueIdx + 1;
  if (nextIdx >= activeQ.length) {
    if (repeatMode === 0) return;
    if (isShuffle) rebuildShuffleQueue();
    nextIdx = 0;
  }
  const next = (isShuffle && shuffledQueue.length === currentQueue.length ? shuffledQueue : currentQueue)[nextIdx];
  if (next) playTrackByPath(next.path, currentQueue);
}

function prevTrack() {
  if (typeof triggerButtonSquish === 'function') triggerButtonSquish($('btn-prev'));
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (repeatMode === 2 && settings.repeatOneResetOnSkip) { repeatMode = 1; updateRepeatUI(); }
  trackChangeDirection = -1;
  const curPath = currentTrack ? currentTrack.path : null;
  const activeQ = (isShuffle && shuffledQueue.length === currentQueue.length) ? shuffledQueue : currentQueue;
  const inQueueIdx = activeQ.findIndex(t => t.path === curPath);
  let prevIdx = inQueueIdx - 1;
  if (prevIdx < 0) prevIdx = activeQ.length - 1;
  if (activeQ[prevIdx]) playTrackByPath(activeQ[prevIdx].path, currentQueue);
}

function updateShuffleUI() {
  if (isShuffle) rebuildShuffleQueue();
  const shuffleBtn = $('btn-shuffle');
  if (shuffleBtn) {
    if (typeof triggerButtonSquish === 'function') triggerButtonSquish(shuffleBtn);
    shuffleBtn.classList.toggle('selected', isShuffle);
    shuffleBtn.classList.toggle('active', isShuffle);
    shuffleBtn.setAttribute('aria-pressed', isShuffle);
  }
  $('fs-btn-shuffle')?.classList.toggle('active', isShuffle);
  if ($('fullscreen-overlay').classList.contains('active')) updateFullscreenQueue();
}

function updateRepeatUI() {
  const btn = $('btn-repeat');
  if (btn) {
    if (typeof triggerButtonSquish === 'function') triggerButtonSquish(btn);
    btn.classList.toggle('selected', repeatMode > 0);
    btn.classList.toggle('active', repeatMode > 0);
    btn.setAttribute('aria-pressed', repeatMode > 0);
    const repIcon = $('repeatIcon') || btn.querySelector('.material-symbols-rounded');
    if (repIcon) repIcon.textContent = repeatMode === 2 ? 'repeat_one' : 'repeat';
  }
  const fsBtn = $('fs-btn-repeat');
  if (fsBtn) {
    fsBtn.classList.toggle('selected', repeatMode > 0);
    fsBtn.classList.toggle('active', repeatMode > 0);
    fsBtn.setAttribute('aria-pressed', repeatMode > 0);
    const repIcon = $('fsRepeatIcon') || fsBtn.querySelector('.material-symbols-rounded');
    if (repIcon) repIcon.textContent = repeatMode === 2 ? 'repeat_one' : 'repeat';
  }
  if ($('fullscreen-overlay').classList.contains('active')) updateFullscreenQueue();
}

// ── Open files ──
$('btn-add-files').addEventListener('click', async () => {
  const paths = await window.electronAPI.openFiles();
  if (!paths || paths.length === 0) return;
  await importPaths(paths);
});

// Health-check controls.
{
  const rescanBtn = $('health-rescan-btn');
  if (rescanBtn) rescanBtn.addEventListener('click', () => runHealthScan());
  const clearBtn = $('library-health-filter-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    clearHealthFilter();
    if (currentView === 'library') renderLibrary();
  });
}

function setProgressBanner(done, total, labelKey) {
  const banner = $('progress-banner');
  if (!banner) return;
  if (done == null) { banner.hidden = true; return; }
  banner.hidden = false;
  $('progress-banner-title').textContent = tr(labelKey || 'import.progress');
  $('progress-banner-fill').style.width = Math.round((done / total) * 100) + '%';
  $('progress-banner-count').textContent = `${done}/${total}`;
}

// ── Toasts ──
// In-app, non-blocking replacement for native alert()/confirm() — bulk actions
// report their result here instead of popping an OS window. Persistent by
// default (a close button, no auto-timeout); pass { duration } to auto-dismiss.
function toast(message, { type = 'info', duration = 0 } = {}) {
  const stack = $('toast-stack');
  if (!stack) return null;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const body = document.createElement('div');
  body.className = 'toast-body';
  body.textContent = message;
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.setAttribute('aria-label', tr('btn.close'));
  close.innerHTML = '<svg class="i" width="12" height="12"><use href="#i-close"/></svg>';
  const dismiss = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 180); };
  close.addEventListener('click', dismiss);
  el.append(body, close);
  stack.appendChild(el);
  if (duration > 0) setTimeout(dismiss, duration);
  return el;
}

// Toast-based yes/no — replaces native confirm(). Resolves true/false, and
// stays until the user answers (no auto-timeout).
function confirmToast(message, { type = 'warn' } = {}) {
  return new Promise(resolve => {
    const stack = $('toast-stack');
    if (!stack) { resolve(false); return; }
    const el = document.createElement('div');
    el.className = `toast toast-${type} toast-confirm`;
    const body = document.createElement('div');
    body.className = 'toast-body';
    body.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'toast-actions';
    const no = document.createElement('button');
    no.className = 'toast-btn';
    no.textContent = tr('btn.cancel');
    const yes = document.createElement('button');
    yes.className = 'toast-btn toast-btn-primary';
    yes.textContent = tr('btn.confirm');
    const done = (v) => { el.classList.add('leaving'); setTimeout(() => el.remove(), 180); resolve(v); };
    no.addEventListener('click', () => done(false));
    yes.addEventListener('click', () => done(true));
    actions.append(no, yes);
    el.append(body, actions);
    stack.appendChild(el);
    yes.focus();
  });
}

async function importPaths(paths) {
  let added = 0;
  let sinceRefresh = 0;
  // A folder import can take a while (metadata is parsed one file at a time),
  // so show progress once there's more than a couple files to wait on.
  const showProgress = paths.length > 2;
  if (showProgress) setProgressBanner(0, paths.length);
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    if (library.some(t => t.path === p)) { if (showProgress) setProgressBanner(i + 1, paths.length); continue; }
    const metadata = await window.electronAPI.parseMetadata(p);
    if (metadata.cover) coverCache[p] = metadata.cover;
    metadata.addedAt = Date.now();   // for the Listening Report "added to collection" stat
    library.push(metadata);
    added++;
    sinceRefresh++;
    if (showProgress) setProgressBanner(i + 1, paths.length);
    // Refresh every 10 tracks instead of once at the end — a folder import can
    // take a while and the list otherwise looks frozen/empty until it's done.
    if (sinceRefresh >= 10) {
      saveLibrary();
      refreshCurrentViewRows();
      renderCounts();
      sinceRefresh = 0;
    }
  }
  if (showProgress) setProgressBanner(null);
  if (added > 0) {
    saveLibrary();
    refreshCurrentViewRows();
    renderCounts();
  }
}

// ── Fix Tags menu (Artist/Album scopes) ──
let pendingFixTagsScope = null;
// Album scope also gets the cover/year bulk actions grouped into the same
// popover — Artist scope spans multiple albums, where neither one makes sense.
function openFixTagsMenu(e, tracks, labelKey, { albumActions = false, name = '' } = {}) {
  e.stopPropagation();
  pendingFixTagsScope = { tracks, labelKey, name };
  // Cover + bulk-metadata actions are offered for both album and artist scopes
  // (they all operate on scope.tracks); only download and the delete pair vary.
  $('ftm-download').hidden = !tracks.some(t => isRemotePath(t.path));
  const hasLocal = tracks.some(t => !isRemotePath(t.path));
  $('ftm-delete-album').hidden = !albumActions || !hasLocal;
  $('ftm-delete-artist').hidden = albumActions || !hasLocal;
  const menu = $('fix-tags-menu');
  menu.classList.add('open');
  const rect = e.currentTarget.getBoundingClientRect();
  const w = 240;
  let x = rect.left;
  if (x + w > window.innerWidth) x = window.innerWidth - w - 8;
  menu.style.left = `${x}px`;
  menu.style.top = `${rect.bottom + 4}px`;
}
function closeFixTagsMenu() {
  $('fix-tags-menu').classList.remove('open');
  pendingFixTagsScope = null;
}
document.addEventListener('click', e => {
  if (!e.target.closest('#fix-tags-menu') && !e.target.closest('.btn-fix-tags-trigger')) closeFixTagsMenu();
});
document.querySelectorAll('#fix-tags-menu .cm-item').forEach(btn => {
  btn.addEventListener('click', async () => {
    const scope = pendingFixTagsScope;
    const action = btn.dataset.action;
    closeFixTagsMenu();
    if (!scope) return;
    const localTracks = scope.tracks.filter(t => !isRemotePath(t.path));
    if (action === 'apply-cover') runRegenerateAlbumCovers(scope.tracks);
    else if (action === 'set-cover-file') setCoverFromFile(scope.tracks);
    else if (action === 'mb-release') runMatchReleaseMusicBrainz(scope.tracks, scope.name);
    else if (action === 'fix-year') runFixAlbumYear(scope.tracks);
    else if (action === 'set-genre') runSetGenre(scope.tracks);
    else if (action === 'fix-tracknos') runFixAlbumTrackNumbers(scope.tracks);
    else if (action === 'download') downloadTracksFromHost(scope.tracks);
    else if (action === 'delete-album') {
      if (await confirmDelete('modal.deleteAlbum.title',
        tr('modal.deleteAlbum.text', { name: scope.name, count: withCount('tracks', localTracks.length) })))
        deleteTracks(localTracks.map(t => t.path));
    }
    else if (action === 'delete-artist') {
      if (await confirmDelete('modal.deleteArtist.title',
        tr('modal.deleteArtist.text', { name: scope.name, count: withCount('tracks', localTracks.length) })))
        deleteTracks(localTracks.map(t => t.path));
    }
  });
});

// ── Regenerate album covers ──
// A two-step, Fix-Tags-adjacent flow: right-click the one track in the album
// whose embedded art is actually correct ("Use as album cover" in the track
// context menu), then hit the hero button to stamp that same picture into
// every other track in the album. No confirmation modal — the confirm()
// below both gates the action and shows which track got picked, so a stray
// click doesn't silently overwrite art with the wrong source.
let pendingAlbumCoverSource = null;

// Stamp one cover (a data: URL) into every given local track, with progress +
// summary. Shared by "use as album cover" (source = a marked track's art) and
// "set cover from file" (source = a picked image).
async function applyCoverToTargets(targets, coverUrl, progressKey) {
  let updated = 0, failed = 0, ghosts = 0;
  for (let i = 0; i < targets.length; i++) {
    setProgressBanner(i, targets.length, progressKey);
    const t = targets[i];
    if (isTagEditingLocked(t.path)) { failed++; continue; }
    const wr = await window.electronAPI.writeCover(t.path, coverUrl);
    if (wr && wr.success) {
      t.cover = coverUrl;
      t.hasCover = true;
      coverCache[t.path] = coverUrl;
      updated++;
    } else if (await purgeOnWriteFailure(t.path, 'coverWrite', wr && wr.error)) {
      ghosts++;
    } else {
      failed++;
    }
  }
  setProgressBanner(null);
  saveLibrary();
  refreshCurrentViewRows();
  toast(tr('albumCover.summary', { updated, failed, total: targets.length })
    + (ghosts ? ' · ' + tr('library.purgedOnError', { count: ghosts }) : ''));
}

async function runRegenerateAlbumCovers(tracks) {
  const source = pendingAlbumCoverSource && tracks.find(t => t.path === pendingAlbumCoverSource);
  if (!source || !source.cover) { toast(tr('albumCover.needSource')); return; }
  const targets = tracks.filter(t => t.path !== source.path && !isRemotePath(t.path));
  if (!targets.length) return;
  if (!(await confirmToast(tr('albumCover.confirm', { track: source.title, count: targets.length })))) return;
  await applyCoverToTargets(targets, source.cover, 'albumCover.progress');
}

// Pick a local image file and set it as the cover for the given track(s) —
// one for a single song, or the whole album/artist track set.
async function setCoverFromFile(tracks) {
  const targets = (tracks || []).filter(t => !isRemotePath(t.path));
  if (!targets.length || !window.electronAPI.chooseImage) return;
  const res = await window.electronAPI.chooseImage();
  if (!res || res.canceled) return;
  if (res.error || !res.dataUrl) { toast(tr('coverFile.error', { e: (res && res.error) || 'unknown' })); return; }
  // A single song applies instantly; an album/artist overwrites many files, so
  // confirm the count first to guard against a misclick.
  if (targets.length > 1 && !(await confirmToast(tr('coverFile.confirm', { count: targets.length })))) return;
  await applyCoverToTargets(targets, res.dataUrl, 'coverFile.progress');
}

// ── Fix album release year ──
// Imports often leave one or two tracks with a stray/missing year while the
// rest of the album agrees — this stamps every track to the same value.
async function runFixAlbumYear(tracks) {
  const current = (tracks.find(t => t.year) || {}).year || '';
  const year = await promptModal(tr('albumYear.prompt'), String(current));
  if (year === null) return;
  const trimmed = year.trim();
  if (!trimmed) return;
  const targets = tracks.filter(t => !isRemotePath(t.path));
  if (!targets.length) return;

  let updated = 0, failed = 0, ghosts = 0;
  for (let i = 0; i < targets.length; i++) {
    setProgressBanner(i, targets.length, 'albumYear.progress');
    const t = targets[i];
    if (isTagEditingLocked(t.path)) { failed++; continue; }
    const wr = await window.electronAPI.writeMetadata(t.path, { year: trimmed });
    if (wr && wr.success) {
      t.year = trimmed;
      updated++;
    } else if (await purgeOnWriteFailure(t.path, 'albumYearFix', wr && wr.error)) {
      ghosts++;
    } else {
      failed++;
    }
  }
  setProgressBanner(null);
  saveLibrary();
  refreshCurrentViewRows();
  toast(tr('albumYear.summary', { updated, failed, total: targets.length })
    + (ghosts ? ' · ' + tr('library.purgedOnError', { count: ghosts }) : ''));
}

// ── Set genre (bulk) ──
// Stamp one genre onto every track of the album/artist — MusicBrainz genres
// only land on downloads, so this is the manual path for imported files.
async function runSetGenre(tracks) {
  const current = (tracks.find(t => t.genre) || {}).genre || '';
  const genre = await promptModal(tr('genre.prompt'), String(current));
  if (genre === null) return;
  const trimmed = genre.trim();
  const targets = tracks.filter(t => !isRemotePath(t.path));
  if (!targets.length) return;

  let updated = 0, failed = 0, ghosts = 0;
  for (let i = 0; i < targets.length; i++) {
    setProgressBanner(i, targets.length, 'genre.progress');
    const t = targets[i];
    if (isTagEditingLocked(t.path)) { failed++; continue; }
    const wr = await window.electronAPI.writeMetadata(t.path, { genre: trimmed });
    if (wr && wr.success) {
      t.genre = trimmed;
      updated++;
    } else if (await purgeOnWriteFailure(t.path, 'genreSet', wr && wr.error)) {
      ghosts++;
    } else {
      failed++;
    }
  }
  setProgressBanner(null);
  saveLibrary();
  refreshCurrentViewRows();
  toast(tr('albumYear.summary', { updated, failed, total: targets.length })
    + (ghosts ? ' · ' + tr('library.purgedOnError', { count: ghosts }) : ''));
}

// ── Fix album track numbers ──
// Used to ask for a typed start value and bulk-renumber the album in
// whatever order sortAlbumTracks guessed (disc/trackNo, falling back to
// title when numbers are missing) — that fallback order is often just
// alphabetical, nowhere near the real listening order, so it silently
// stamped wrong numbers onto the wrong songs. The user now picks the order
// by clicking: the first track clicked becomes #1, and each click after
// that is auto-stamped with the next number — no typing, no order guessing.
let trackNumberNext = 1;
function renderTrackNumberList(tracks) {
  const list = $('track-number-list');
  list.innerHTML = '';
  sortAlbumTracks(tracks).forEach(t => {
    const el = document.createElement('div');
    el.className = 'sl-item tn-item';
    const num = document.createElement('span');
    num.className = 'tn-num';
    num.textContent = t.trackNo || '—';
    el.appendChild(num);
    el.appendChild(document.createTextNode(t.title || '—'));
    el.addEventListener('click', async () => {
      if (el.classList.contains('tn-done')) return;
      if (isTagEditingLocked(t.path)) { toast(tr('editor.lockedWhilePlaying')); return; }
      const no = trackNumberNext;
      el.classList.add('tn-done'); // guards against a double-click burning two numbers
      const wr = await window.electronAPI.writeMetadata(t.path, { trackNo: String(no) });
      if (!wr || !wr.success) {
        if (await purgeOnWriteFailure(t.path, 'albumTrackNoFix', wr && wr.error)) {
          el.remove();
          toast(tr('library.purgedOnError', { count: 1 }));
          return;
        }
        toast(tr('albumTrackNo.writeFailed'));
        el.classList.remove('tn-done');
        return;
      }
      trackNumberNext = no + 1;
      t.trackNo = String(no);
      num.textContent = String(no);
      saveLibrary();
      refreshCurrentViewRows();
    });
    list.appendChild(el);
  });
}
function runFixAlbumTrackNumbers(tracks) {
  const targets = tracks.filter(t => !isRemotePath(t.path));
  if (!targets.length) return;
  trackNumberNext = 1;
  renderTrackNumberList(targets);
  $('track-number-modal').classList.add('active');
}
$('btn-close-track-number').addEventListener('click', () => $('track-number-modal').classList.remove('active'));

async function runMatchReleaseMusicBrainz(tracks, scopeName) {
  const targets = sortAlbumTracks(tracks.filter(t => !isRemotePath(t.path)));
  if (!targets.length) return;
  const artist = (targets.find(t => t.artist) || {}).artist || '';
  const album = scopeName || (targets.find(t => t.album) || {}).album || '';
  toast(tr('editor.mbSearching'));
  let matches = [];
  try {
    matches = await window.electronAPI.searchMusicBrainzReleases({ artist, album, query: `${artist} ${album}`.trim() });
  } catch (_) {}
  if (!matches || !matches.length) {
    const manual = await promptModal(tr('mbRelease.manualPrompt'), `${artist} ${album}`.trim());
    if (manual && manual.trim()) {
      toast(tr('editor.mbSearching'));
      try {
        matches = await window.electronAPI.searchMusicBrainzReleases({ query: manual.trim() });
      } catch (_) { matches = []; }
    }
    if (!matches || !matches.length) {
      toast(tr('editor.mbNoMatch'));
      return;
    }
  }
  const list = $('mb-release-list');
  list.innerHTML = '';
  matches.forEach(rel => {
    const el = document.createElement('div');
    el.className = 'sl-item';
    const subParts = [rel.date, rel.country, rel.trackCount ? `${rel.trackCount} tracks` : ''].filter(Boolean);
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:2px">
        <div style="font-weight:500">${escapeHtml(rel.title || 'Untitled')} <span style="font-size:11px;color:var(--text-dim)">— ${escapeHtml(rel.artist || '')}</span></div>
        ${subParts.length ? `<div style="font-size:11px;color:var(--text-dim)">${escapeHtml(subParts.join(' · '))}</div>` : ''}
      </div>
    `;
    el.addEventListener('click', async () => {
      $('mb-release-modal').classList.remove('active');
      setProgressBanner(0, targets.length, 'mbRelease.progress');
      const details = await window.electronAPI.lookupMusicBrainzRelease(rel.id);
      if (!details || !details.tracks || !details.tracks.length) {
        setProgressBanner(null);
        toast(tr('editor.mbNoMatch'));
        return;
      }
      let updated = 0, failed = 0;
      for (let i = 0; i < targets.length; i++) {
        setProgressBanner(i, targets.length, 'mbRelease.progress');
        const t = targets[i];
        if (isTagEditingLocked(t.path)) { failed++; continue; }
        const mbTrack = details.tracks[i] || details.tracks.find(mt => mt.title.toLowerCase() === (t.title || '').toLowerCase());
        if (!mbTrack) { failed++; continue; }
        const tags = {
          title: mbTrack.title || t.title,
          artist: mbTrack.artist || details.artist || t.artist,
          album: details.title || t.album,
          year: details.date || t.year,
          trackNo: String(mbTrack.position || i + 1),
          discNo: String(mbTrack.discNo || 1),
          genre: details.genre || t.genre,
        };
        const wr = await window.electronAPI.writeMetadata(t.path, tags);
        if (wr && wr.success) {
          Object.assign(t, tags);
          updated++;
        } else {
          failed++;
        }
      }
      setProgressBanner(null);
      saveLibrary();
      refreshCurrentViewRows();
      toast(tr('mbRelease.applied', { count: updated }) + (failed ? ` (${failed} failed)` : ''));
    });
    list.appendChild(el);
  });
  $('mb-release-modal').classList.add('active');
}
$('btn-close-mb-release').addEventListener('click', () => $('mb-release-modal').classList.remove('active'));

// ── Mini-player navigation ──
function gotoCurrentTrackInAlbum() {
  if (!currentTrack) return;
  const track = currentTrack;
  activeAlbumKey = albumKeyFor(track);
  setView('album-detail');
  requestAnimationFrame(() => {
    if (!albumVList) return;
    const idx = albumVList.findIndex(t => t.path === track.path);
    if (idx < 0) return;
    const listEl = $('album-detail-list');
    const listOffset = listEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
    scrollEl.scrollTop = Math.max(0, listOffset + idx * ROW_HEIGHT - scrollEl.clientHeight / 2 + ROW_HEIGHT / 2);
  });
}

function gotoCurrentTrackArtist() {
  if (!currentTrack) return;
  const track = currentTrack;
  const artists = splitArtists(track.artist);
  if (!artists.length) return;
  activeArtistName = artists[0];
  setView('artist-detail');
}

$('track-title').addEventListener('click', gotoCurrentTrackInAlbum);
$('track-artist').addEventListener('click', (e) => {
  if (e.target.closest('.album-link')) gotoCurrentTrackInAlbum();
  else gotoCurrentTrackArtist();
});

// ── Favorites ──
function toggleFavorite(path) {
  if (isRemotePath(path)) return;   // a peer's track isn't ours to file away
  const nowLoved = !favorites.includes(path);
  if (favorites.includes(path)) favorites = favorites.filter(p => p !== path);
  else favorites.push(path);
  lfmLove(trackByPath(path), nowLoved);   // mirror to Last.fm (no-op unless connected)
  saveLibrary();
  updateFavoriteUI();
  // Row visuals don't show favorite state, so only the favorites view's list changes.
  if (currentView === 'favorites') renderFavorites();
  else if (currentView === 'library' && activeFilter === 'favorites') renderLibrary();
  renderCounts();
}
$('btn-favorite').addEventListener('click', () => {
  if (!currentTrack) return;
  toggleFavorite(currentTrack.path);
});
$('fs-btn-favorite').addEventListener('click', () => {
  if (!currentTrack) return;
  toggleFavorite(currentTrack.path);
});

// ── Playback controls ──
$('btn-play').addEventListener('click', togglePlay);
$('fs-btn-play').addEventListener('click', togglePlay);
$('btn-next').addEventListener('click', nextTrack);
$('fs-btn-next').addEventListener('click', nextTrack);
$('btn-prev').addEventListener('click', prevTrack);
$('fs-btn-prev').addEventListener('click', prevTrack);

$('btn-shuffle').addEventListener('click', () => {
  isShuffle = !isShuffle;
  updateShuffleUI();
});
$('fs-btn-shuffle').addEventListener('click', () => {
  isShuffle = !isShuffle;
  updateShuffleUI();
});
$('btn-repeat').addEventListener('click', () => {
  repeatMode = (repeatMode + 1) % 3;
  updateRepeatUI();
});
$('fs-btn-repeat').addEventListener('click', () => {
  repeatMode = (repeatMode + 1) % 3;
  updateRepeatUI();
});

// ── Wavy Progress (M3 Expressive) ──
let wavePhase = 0;
let waveAnimId = null;
const AMPLITUDE = 3.0;
const WAVELENGTH = 24;
const VIEW_W = 400;
const VIEW_H = 14;
const PAD = 4;

function buildWavyPath(progressRatio, phase) {
  const midY = VIEW_H / 2;
  const progressX = PAD + progressRatio * (VIEW_W - PAD * 2);

  if (progressX <= PAD + 0.8) {
    return `M ${PAD} ${midY}`;
  }

  const ampScale = Math.min(1, progressRatio * 10);
  const amp = AMPLITUDE * ampScale;
  const steps = Math.max(24, Math.ceil((progressX - PAD) / 1.5));
  const pts = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = PAD + t * (progressX - PAD);
    const y = midY + Math.sin((x / WAVELENGTH) * Math.PI * 2 + phase) * amp;
    pts.push({ x, y });
  }

  let d = `M ${pts[0].x.toFixed(3)} ${pts[0].y.toFixed(3)}`;
  if (pts.length === 2) {
    d += ` L ${pts[1].x.toFixed(3)} ${pts[1].y.toFixed(3)}`;
    return d;
  }

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    d += ` C ${cp1x.toFixed(3)} ${cp1y.toFixed(3)} ${cp2x.toFixed(3)} ${cp2y.toFixed(3)} ${p2.x.toFixed(3)} ${p2.y.toFixed(3)}`;
  }
  return d;
}

function setProgressUI() {
  const dur = audio.duration || 0;
  const cur = audio.currentTime || 0;
  const ratio = dur > 0 ? Math.min(1, cur / dur) : 0;
  const progressX = PAD + ratio * (VIEW_W - PAD * 2);
  const pathD = buildWavyPath(ratio, wavePhase);
  const endX = VIEW_W - PAD;
  const trackD = `M ${Math.min(endX, progressX).toFixed(3)} 7 L ${endX} 7`;

  const activePath = $('activePath');
  if (activePath) activePath.setAttribute('d', pathD);
  const trackPath = $('trackPath');
  if (trackPath) trackPath.setAttribute('d', trackD);

  const fsActivePath = $('fsActivePath');
  if (fsActivePath) fsActivePath.setAttribute('d', pathD);
  const fsTrackPath = $('fsTrackPath');
  if (fsTrackPath) fsTrackPath.setAttribute('d', trackD);

  const progressTrack = $('progress-track');
  if (progressTrack) {
    progressTrack.setAttribute('aria-valuenow', Math.round(cur));
    progressTrack.setAttribute('aria-valuemax', Math.round(dur));
  }
  const fsProgressTrack = $('fs-progress-track');
  if (fsProgressTrack) {
    fsProgressTrack.setAttribute('aria-valuenow', Math.round(cur));
    fsProgressTrack.setAttribute('aria-valuemax', Math.round(dur));
  }
}

function waveTick() {
  if (!isPlaying) {
    waveAnimId = null;
    return;
  }
  wavePhase += 0.028;
  setProgressUI();
  waveAnimId = requestAnimationFrame(waveTick);
}

function syncWaveAnim() {
  if (isPlaying) {
    if (!waveAnimId) waveAnimId = requestAnimationFrame(waveTick);
  } else {
    if (waveAnimId) {
      cancelAnimationFrame(waveAnimId);
      waveAnimId = null;
    }
    setProgressUI();
  }
}

// ── Play history logging (feeds the Listening Report) ──
// One log entry per "play session" of a track; `s` accumulates real listened
// seconds via wall-clock deltas on timeupdate (robust to seeking and pausing).
let plEntry = null;     // active log entry (a reference inside playLog) or null
let plLastTick = 0;     // ms timestamp of the last accumulation tick
let plSaveAccum = 0;    // listened seconds since the last persist

function plTick() {
  if (!plEntry || !isPlaying) return;
  const now = Date.now();
  // Clamp the delta so background-tab throttling or long stalls don't inflate totals.
  const dt = Math.min((now - plLastTick) / 1000, 2);
  plEntry.s += dt;
  plSaveAccum += dt;
  plLastTick = now;
}

function plStartIfNeeded() {
  const track = currentTrack;
  if (!track) return;
  // Same track resuming after pause → keep the entry, just restart the tick clock.
  if (plEntry && plEntry.p === track.path) { plLastTick = Date.now(); return; }
  plTick(); // flush remaining seconds onto the previous entry before switching
  lfmMaybeScrobble(plEntry); // the finished session may now qualify for a scrobble
  plEntry = { t: Date.now(), p: track.path, n: track.title || '', a: track.artist || '', b: track.album || '', s: 0, d: Number(track.duration) || 0 };
  playLog.push(plEntry);
  plLastTick = plEntry.t;
  plSaveAccum = 0;
  savePlayLog();
  lfmNowPlaying(track);
  refreshReportIfActive();
}

function plFinalize() {
  plTick();
  lfmMaybeScrobble(plEntry); // stop/pause: scrobble if the rule's already met
  savePlayLog();
  refreshReportIfActive();
}

function refreshReportIfActive() {
  if (currentView === 'report') renderReport();
}

// ── Listening Report ──────────────────────────────────────────────────────────
// On-device analytics aggregated live from playLog. Nothing leaves the machine.
let reportPeriod = 'day';
const REPORT_LOCALE = { en: 'en-US', de: 'de-DE', fr: 'fr-FR', uk: 'uk-UA' };
const REPORT_PLAY_SEC = 15;   // a log entry counts as a "play" once listened ≥ this
const REPORT_STREAK_SEC = 30; // a day counts toward the streak with ≥ this much listening

function reportLocale() { return REPORT_LOCALE[currentLang] || 'en-US'; }
function repStartOfDay(ts) { const x = new Date(ts); x.setHours(0, 0, 0, 0); return x.getTime(); }
function repCap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// { start, end, prevStart, prevEnd } in epoch ms for the selected period.
function reportWindow(period, now = Date.now()) {
  const nd = new Date(now);
  if (period === 'all') {
    return { start: 0, end: now, prevStart: 0, prevEnd: 0 };
  }
  if (period === 'day') {
    const start = repStartOfDay(now);
    return { start, end: now, prevStart: start - 86400000, prevEnd: start };
  }
  if (period === 'month') {
    const start = new Date(nd.getFullYear(), nd.getMonth(), 1).getTime();
    return { start, end: now, prevStart: new Date(nd.getFullYear(), nd.getMonth() - 1, 1).getTime(), prevEnd: start };
  }
  const start = new Date(nd.getFullYear(), 0, 1).getTime();
  return { start, end: now, prevStart: new Date(nd.getFullYear() - 1, 0, 1).getTime(), prevEnd: start };
}

function reportHeading(period, now = Date.now()) {
  const loc = reportLocale();
  const nd = new Date(now);
  const dm = (d) => new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long' }).format(d);
  const monthOnly = (d) => new Intl.DateTimeFormat(loc, { month: 'long' }).format(d);
  const dmy = (d) => new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  if (period === 'all') {
    let first = now;
    for (const e of playLog) if (e.t < first) first = e.t;
    return { label: tr('report.allTime'), range: `${dmy(new Date(first))} — ${dmy(nd)}` };
  }
  if (period === 'day') return { label: tr('report.today'), range: dm(nd) };
  if (period === 'month') {
    const m = monthOnly(nd);
    return { label: repCap(m), range: `${m} ${nd.getFullYear()}` };
  }
  return { label: String(nd.getFullYear()), range: `${monthOnly(new Date(nd.getFullYear(), 0, 1))} — ${monthOnly(nd)} ${nd.getFullYear()}` };
}

function fmtListenTime(totalSec) {
  const m = Math.round(totalSec / 60);
  if (m < 60) return { value: String(m), unit: tr('report.minUnit') };
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 100) return { value: `${h}${tr('report.hShort')} ${String(mm).padStart(2, '0')}${tr('report.mShort')}`, unit: '' };
  return { value: h.toLocaleString(reportLocale()), unit: tr('report.hoursUnit') };
}

// Current streak: consecutive days (ending today, or yesterday if nothing today
// yet) with at least REPORT_STREAK_SEC of listening. Global, not period-scoped.
function computeStreak() {
  const days = new Set();
  for (const e of playLog) if (e.s >= REPORT_STREAK_SEC) days.add(repStartOfDay(e.t));
  if (!days.size) return 0;
  let cursor = repStartOfDay(Date.now());
  if (!days.has(cursor)) cursor -= 86400000; // grace: today may have no plays yet
  let streak = 0;
  while (days.has(cursor)) { streak++; cursor -= 86400000; }
  return streak;
}

function computeReport(period) {
  const w = reportWindow(period);
  let sec = 0, prevSec = 0, plays = 0;
  const clock = new Array(24).fill(0);
  const artistAgg = new Map();   // artist -> { name, plays, cover }
  const trackAgg = new Map();    // path   -> { title, artist, plays, cover }
  const artistsSet = new Set();

  for (const e of playLog) {
    if (e.t >= w.start && e.t < w.end) {
      sec += e.s;
      clock[new Date(e.t).getHours()] += e.s;
      if (e.s >= REPORT_PLAY_SEC) {
        plays++;
        const cover = coverCache[e.p] || null;
        if (e.a) artistsSet.add(e.a);
        const ak = e.a || '—';
        const a = artistAgg.get(ak) || { name: e.a || '—', plays: 0, cover: null, path: e.p };
        a.plays++; if (!a.cover) { a.cover = cover; a.path = e.p; }
        artistAgg.set(ak, a);
        const t = trackAgg.get(e.p) || { title: e.n || '—', artist: e.a || '', plays: 0, cover: null, path: e.p };
        t.plays++; if (!t.cover) t.cover = cover;
        trackAgg.set(e.p, t);
      }
    } else if (e.t >= w.prevStart && e.t < w.prevEnd) {
      prevSec += e.s;
    }
  }

  const peak = Math.max(0, ...clock);
  const clockNorm = peak > 0 ? clock.map(v => v / peak) : clock.map(() => 0);
  const minutes = sec / 60, prevMinutes = prevSec / 60;
  let deltaPct = 0;
  if (prevMinutes > 0) deltaPct = Math.round((minutes - prevMinutes) / prevMinutes * 100);
  else if (minutes > 0) deltaPct = 100;
  const newAdds = library.filter(t => t.addedAt && t.addedAt >= w.start && t.addedAt < w.end).length;

  return {
    sec, plays, artists: artistsSet.size, newAdds, deltaPct,
    streak: computeStreak(),
    clock: clockNorm,
    topArtists: [...artistAgg.values()].sort((a, b) => b.plays - a.plays).slice(0, 5),
    topTracks: [...trackAgg.values()].sort((a, b) => b.plays - a.plays).slice(0, 5),
  };
}

// Report items come from the play log, whose tracks are frequently files that
// were never rendered as a visible library row — so their cover was never parsed
// into coverCache and `computeReport` returns cover:null. Parse those covers on
// demand here and re-render the report once they land. Keyed by path; idempotent
// via pendingCoverLoad so repeated renders don't re-spawn parses.
async function ensureReportCovers(r) {
  const paths = [];
  for (const it of [...r.topArtists, ...r.topTracks]) {
    if (!it.cover && it.path && !coverCache[it.path] && !pendingCoverLoad.has(it.path)) {
      paths.push(it.path);
    }
  }
  if (!paths.length) return;
  let gotAny = false;
  await Promise.all(paths.map(async (path) => {
    pendingCoverLoad.add(path);
    try {
      const md = await window.electronAPI.parseMetadata(path);
      if (md && md.cover) { coverCache[path] = md.cover; gotAny = true; }
    } catch (e) { /* file moved / unreadable */
    } finally {
      pendingCoverLoad.delete(path);
    }
  }));
  if (gotAny && currentView === 'report') renderReport();
}

function repCoverHtml(cover, label, round) {
  const cls = `rep-cover${round ? ' rep-cover-round' : ''}`;
  if (cover) return `<div class="${cls}" style="background-image:url('${cover}')"></div>`;
  return `<div class="${cls} rep-cover-empty">${escapeHtml((label || '?')[0] || '?')}</div>`;
}

function repRankHtml(items, kind) {
  if (!items.length) return `<div class="rep-rank-empty">—</div>`;
  const max = Math.max(...items.map(i => i.plays)) || 1;
  return `<div class="rep-rank-list">${items.map((it, i) => {
    const name = kind === 'artist' ? it.name : it.title;
    return `<div class="rep-rank-row">
      <div class="rep-rank-num">${i + 1}</div>
      ${repCoverHtml(it.cover, name, kind === 'artist')}
      <div class="rep-rank-main">
        <div class="rep-rank-name">${escapeHtml(name || '—')}</div>
        ${kind === 'track' ? `<div class="rep-rank-sub">${escapeHtml(it.artist || '')}</div>` : ''}
        <div class="rep-rank-bar"><div class="rep-rank-fill" style="width:${(it.plays / max * 100).toFixed(1)}%"></div></div>
      </div>
      <div class="rep-rank-plays">${it.plays.toLocaleString(reportLocale())} ${tr('report.plays')}</div>
    </div>`;
  }).join('')}</div>`;
}

function repStatHtml(value, unit, label, kind) {
  return `<div class="rep-stat">
    <div class="rep-stat-val${kind ? ' rep-' + kind : ''}">${value}${unit ? `<span class="rep-stat-unit">${unit}</span>` : ''}</div>
    <div class="rep-stat-label">${label}</div>
  </div>`;
}

function renderReport() {
  const el = $('report-content');
  if (!el) return;
  const loc = reportLocale();
  const tabs = ['day', 'month', 'year', 'all']
    .map(k => `<button class="rep-tab${k === reportPeriod ? ' active' : ''}" data-period="${k}">${tr('report.period.' + k)}</button>`)
    .join('');

  if (!playLog.length) {
    el.innerHTML = `
      <div class="rep-head"><div><div class="rep-eyebrow">${tr('report.eyebrow')}</div></div>
        <div class="rep-tabs">${tabs}</div></div>
      <div class="empty-state">
        <div class="empty-icon"><svg class="i" width="24" height="24"><use href="#i-report"/></svg></div>
        <div class="empty-title">${tr('report.empty.title')}</div>
        <div class="empty-text">${tr('report.empty.text')}</div>
      </div>`;
    el.querySelectorAll('.rep-tab').forEach(b => { b.onclick = () => { reportPeriod = b.dataset.period; renderReport(); }; });
    return;
  }

  const r = computeReport(reportPeriod);
  const h = reportHeading(reportPeriod);
  const time = fmtListenTime(r.sec);
  const up = r.deltaPct >= 0;
  const showDelta = reportPeriod !== 'all'; // no "previous period" for all-time

  const clockBars = r.clock.map((v) => {
    const peak = v >= 0.999 && v > 0;
    return `<div class="rep-clock-col"><div class="rep-clock-bar${peak ? ' is-peak' : ''}" style="height:${Math.max(4, v * 100)}%"></div></div>`;
  }).join('');

  el.innerHTML = `
    <div class="rep-head">
      <div>
        <div class="rep-eyebrow">${tr('report.eyebrow')} · ${escapeHtml(h.range)}</div>
        <div class="rep-title">${escapeHtml(h.label)}</div>
      </div>
      <div class="rep-tabs">${tabs}</div>
    </div>

    <div class="rep-top">
      <div class="rep-hero">
        <div class="rep-hero-cap"><svg class="i" width="13" height="13"><use href="#i-clock"/></svg> ${tr('report.listeningTime')}</div>
        <div>
          <div class="rep-hero-time"><span class="rep-hero-num">${time.value}</span>${time.unit ? `<span class="rep-hero-unit">${time.unit}</span>` : ''}</div>
          ${showDelta ? `<div class="rep-hero-delta">
            <span class="rep-delta ${up ? 'up' : 'down'}">${up ? '↑' : '↓'} ${Math.abs(r.deltaPct)}%</span>
            <span class="rep-delta-note">${tr('report.vsPrev')}</span>
          </div>` : ''}
        </div>
      </div>
      <div class="rep-stats">
        ${repStatHtml(r.plays.toLocaleString(loc), '', tr('report.tracksPlayed'))}
        ${repStatHtml(r.artists.toLocaleString(loc), '', tr('report.artists'))}
        ${repStatHtml(r.newAdds.toLocaleString(loc), '', tr('report.added'), 'ok')}
        ${repStatHtml(r.streak.toLocaleString(loc), tr('report.days'), tr('report.streak'), 'accent')}
      </div>
    </div>

    <div class="rep-lower">
      <div class="rep-card">
        <div class="rep-card-title"><svg class="i" width="14" height="14"><use href="#i-clock"/></svg> ${tr('report.whenListen')}</div>
        <div class="rep-clock-bars">${clockBars}</div>
        <div class="rep-clock-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
      </div>
      <div class="rep-card">
        <div class="rep-card-title">${tr('report.topArtists')}</div>
        ${repRankHtml(r.topArtists.slice(0, 4), 'artist')}
      </div>
      <div class="rep-card">
        <div class="rep-card-title">${tr('report.topTracks')}</div>
        ${repRankHtml(r.topTracks.slice(0, 4), 'track')}
      </div>
    </div>`;

  el.querySelectorAll('.rep-tab').forEach(b => { b.onclick = () => { reportPeriod = b.dataset.period; renderReport(); }; });

  ensureReportCovers(r);
}

// ── Audio events ──
audio.addEventListener('play', () => { isPlaying = true; updatePlayButtonUI(); plStartIfNeeded(); pushDiscordActivity(true); if (isSettingsOpen()) renderDiscordPreviewOnly(); });
audio.addEventListener('pause', () => { plTick(); isPlaying = false; updatePlayButtonUI(); savePlayLog(); pushDiscordActivity(true); if (isSettingsOpen()) renderDiscordPreviewOnly(); });
audio.addEventListener('seeked', () => { pushDiscordActivity(true); if (isSettingsOpen()) renderDiscordPreviewOnly(); });
// file:// 404s (moved/deleted track) and a genuinely corrupt file both land
// here indistinguishably — revalidateLibrary() tells them apart by checking
// disk, so a codec error a still-present file doesn't wrongly get purged.
let revalidatingLibrary = false;
audio.addEventListener('error', async () => {
  if (revalidatingLibrary || !currentTrack || isRemotePath(currentTrack.path)) return;
  revalidatingLibrary = true;
  const removed = await revalidateLibrary();
  revalidatingLibrary = false;
  if (removed > 0) toast(tr('library.ghostsRemoved', { count: removed }));
});
audio.addEventListener('timeupdate', () => {
  const cur = audio.currentTime, dur = audio.duration;
  saveSession();
  const curEl = $('time-current');
  if (curEl) curEl.textContent = formatTime(cur);
  const remEl = $('time-remaining');
  if (remEl) {
    const left = !isNaN(dur) && dur >= cur ? dur - cur : 0;
    remEl.textContent = '-' + formatTime(left);
  }
  const totEl = $('time-total');
  if (totEl && !isNaN(dur)) totEl.textContent = formatTime(dur);
  const fsCur = $('fs-time-current');
  if (fsCur) fsCur.textContent = formatTime(cur);
  const fsRem = $('fs-time-remaining');
  if (fsRem) {
    const left = !isNaN(dur) && dur >= cur ? dur - cur : 0;
    fsRem.textContent = '-' + formatTime(left);
  }
  const fsTot = $('fs-time-total');
  if (fsTot && !isNaN(dur)) fsTot.textContent = formatTime(dur);
  if (!isNaN(dur)) {
    setProgressUI();
  }
  if ($('fullscreen-overlay')?.classList.contains('active')) updateFsLyricsActive(cur);
  if (settings.crossfade && !isNaN(dur) && dur > 0) {
    const left = dur - cur;
    const fadeSec = crossfadeMs() / 1000;
    if (left > fadeSec + 0.5) {
      crossfadeArmed = false;
    } else if (!crossfadeArmed && repeatMode !== 2 && fadeSec > 0 && left <= fadeSec) {
      crossfadeArmed = true;
      nextTrack({ manual: false });
      return;
    }
  }
  plTick();
  if (plSaveAccum >= 15) { plSaveAccum = 0; savePlayLog(); }
  if (isSettingsOpen() && settings.discord.showTimer) {
    const sec = Math.floor(cur);
    if (sec !== discordPreviewSec) { discordPreviewSec = sec; renderDiscordPreviewOnly(); }
  }
});
// The EQ's AudioContext starts (and can later go) suspended under the autoplay
// policy; a suspended context silences the whole graph. Resume on every play so
// no playback path — button, keyboard, crossfade swap — comes out muted.
audio.addEventListener('play', () => {
  if (eqCtx && eqCtx.state === 'suspended') eqCtx.resume().catch(() => {});
});
audio.addEventListener('ended', () => {
  plFinalize();
  if (repeatMode === 2) { audio.currentTime = 0; audio.play(); }
  else nextTrack({ manual: false });
});

// Progress track click/drag (wavy M3 progress & fullscreen bar)
function wireWavySeek(trackEl) {
  if (!trackEl) return;
  function seekFromEvent(e) {
    const rect = trackEl.getBoundingClientRect();
    if (!audio.duration || !rect.width) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
    setProgressUI();
  }

  let isDragging = false;
  trackEl.addEventListener('pointerdown', (e) => {
    isDragging = true;
    try { trackEl.setPointerCapture(e.pointerId); } catch {}
    seekFromEvent(e);
  });
  trackEl.addEventListener('pointermove', (e) => {
    if (isDragging) seekFromEvent(e);
  });
  const stopDrag = (e) => {
    if (isDragging) {
      isDragging = false;
      try { trackEl.releasePointerCapture(e.pointerId); } catch {}
    }
  };
  trackEl.addEventListener('pointerup', stopDrag);
  trackEl.addEventListener('pointercancel', stopDrag);

  trackEl.addEventListener('keydown', (e) => {
    if (!audio.duration) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
      setProgressUI();
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      audio.currentTime = Math.max(0, audio.currentTime - 5);
      setProgressUI();
      e.preventDefault();
    }
  });
}
wireWavySeek($('progress-track'));
wireWavySeek($('fs-progress-track'));

// Volume
function setVolume(v) {
  audio.muted = false;
  targetVolume = Math.max(0, Math.min(1, v));
  if (!crossfadeRampId) audio.volume = targetVolume;
  updateVolumeUI();
}

function updateVolumeUI() {
  const v = audio.muted ? 0 : targetVolume;
  const pct = `${v * 100}%`;
  const volSlider = $('vol-slider');
  if (volSlider) volSlider.value = Math.round(v * 100);
  const volFill = $('vol-fill');
  if (volFill) volFill.style.width = pct;
  const fsFill = $('fs-vol-fill');
  if (fsFill) fsFill.style.width = pct;

  const iconName = (audio.muted || v === 0) ? 'volume_off' : v < 0.35 ? 'volume_down' : 'volume_up';
  const volIcon = $('volIcon');
  if (volIcon) volIcon.textContent = iconName;
  const fsVolIcon = $('fsVolIcon');
  if (fsVolIcon) fsVolIcon.textContent = iconName;

  const btnMute = $('btn-mute');
  if (btnMute && btnMute.querySelector('use')) {
    const icon = audio.muted || v === 0 ? '#i-volume-mute'
      : v < 0.5 ? '#i-volume-low'
      : '#i-volume';
    btnMute.querySelector('use').setAttribute('href', icon);
  }
}

function toggleMute() {
  audio.muted = !audio.muted;
  updateVolumeUI();
}
$('btn-mute')?.addEventListener('click', toggleMute);
$('fs-btn-mute')?.addEventListener('click', toggleMute);

const volSlider = $('vol-slider');
if (volSlider) {
  volSlider.addEventListener('input', () => {
    setVolume(Number(volSlider.value) / 100);
  });
}
function wireVolumeTrack(trackEl) {
  if (!trackEl) return;
  const seek = e => {
    const r = trackEl.getBoundingClientRect();
    if (r.width) setVolume(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  };
  let dragging = false;
  trackEl.addEventListener('pointerdown', e => {
    dragging = true;
    try { trackEl.setPointerCapture(e.pointerId); } catch {}
    seek(e);
  });
  trackEl.addEventListener('pointermove', e => { if (dragging) seek(e); });
  const stop = e => {
    if (dragging) {
      dragging = false;
      try { trackEl.releasePointerCapture(e.pointerId); } catch {}
    }
  };
  trackEl.addEventListener('pointerup', stop);
  trackEl.addEventListener('pointercancel', stop);
}
wireVolumeTrack($('fs-vol-track'));

const volBlock = document.querySelector('.volume-block');
if (volBlock) {
  volBlock.addEventListener('wheel', e => {
    e.preventDefault();
    const step = Number(settings.volumeWheelStep) || 0.05;
    setVolume(targetVolume + (e.deltaY < 0 ? step : -step));
  }, { passive: false });
}
const fsVolBlock = document.querySelector('.fs-volume');
if (fsVolBlock) {
  fsVolBlock.addEventListener('wheel', e => {
    e.preventDefault();
    const step = Number(settings.volumeWheelStep) || 0.05;
    setVolume(targetVolume + (e.deltaY < 0 ? step : -step));
  }, { passive: false });
}

targetVolume = 1;
audio.volume = 1;
updateVolumeUI();

// ===== Standard Button Group: neighbor squish + shape morph =====
let clearSquishTimer = null;
function triggerButtonSquish(btn) {
  if (!btn) return;
  const groupBtns = Array.from(document.querySelectorAll('.button-group .icon-btn'));
  const index = groupBtns.indexOf(btn);
  if (index < 0) return;
  const growDirection = { 0: 'balanced', 1: 'right', 2: 'balanced', 3: 'left', 4: 'balanced' };
  groupBtns.forEach(b => b.classList.remove('is-expanded', 'is-compressed', 'is-compressed-left', 'is-compressed-right', 'grow-left', 'grow-right'));
  const dir = growDirection[index] || 'balanced';
  btn.classList.add('is-expanded');
  if (dir === 'right') {
    btn.classList.add('grow-right');
    if (index > 0) groupBtns[index - 1].classList.add('is-compressed');
    if (index < groupBtns.length - 1) groupBtns[index + 1].classList.add('is-compressed', 'is-compressed-right');
  } else if (dir === 'left') {
    btn.classList.add('grow-left');
    if (index > 0) groupBtns[index - 1].classList.add('is-compressed', 'is-compressed-left');
    if (index < groupBtns.length - 1) groupBtns[index + 1].classList.add('is-compressed');
  } else {
    if (index > 0) groupBtns[index - 1].classList.add('is-compressed');
    if (index < groupBtns.length - 1) groupBtns[index + 1].classList.add('is-compressed');
  }
  clearTimeout(clearSquishTimer);
  clearSquishTimer = setTimeout(() => {
    groupBtns.forEach(b => b.classList.remove('is-expanded', 'is-compressed', 'is-compressed-left', 'is-compressed-right', 'grow-left', 'grow-right'));
  }, 220);
}

function initButtonGroupSquish() {
  const groupBtns = Array.from(document.querySelectorAll('.button-group .icon-btn'));
  function clearSquish() {
    clearTimeout(clearSquishTimer);
    groupBtns.forEach(b => {
      b.classList.remove(
        'is-expanded',
        'is-compressed',
        'is-compressed-left',
        'is-compressed-right',
        'grow-left',
        'grow-right'
      );
    });
  }

  const growDirection = {
    0: 'balanced', // Shuffle
    1: 'right',    // Prev
    2: 'balanced', // Play
    3: 'left',     // Next
    4: 'balanced'  // Repeat
  };

  groupBtns.forEach((btn, index) => {
    btn.addEventListener('pointerdown', () => {
      clearSquish();
      const dir = growDirection[index] || 'balanced';
      btn.classList.add('is-expanded');
      if (dir === 'right') btn.classList.add('grow-right');
      if (dir === 'left')  btn.classList.add('grow-left');

      if (dir === 'right') {
        if (index > 0) groupBtns[index - 1].classList.add('is-compressed');
        if (index < groupBtns.length - 1) {
          groupBtns[index + 1].classList.add('is-compressed', 'is-compressed-right');
        }
      } else if (dir === 'left') {
        if (index > 0) groupBtns[index - 1].classList.add('is-compressed', 'is-compressed-left');
        if (index < groupBtns.length - 1) {
          groupBtns[index + 1].classList.add('is-compressed');
        }
      } else {
        if (index > 0) groupBtns[index - 1].classList.add('is-compressed');
        if (index < groupBtns.length - 1) groupBtns[index + 1].classList.add('is-compressed');
      }
    });

    const release = () => clearSquish();
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', (e) => {
      if (e.buttons === 0) clearSquish();
    });
  });

  document.addEventListener('pointerup', clearSquish);
}
initButtonGroupSquish();

// ── Fullscreen ──
let fsAnimating = false;
let fsCoverAnim = null;

function flipCover(direction) {
  const mini = $('mini-cover-wrapper');
  const big = $('fs-cover');
  const mr = mini.getBoundingClientRect();
  const br = big.getBoundingClientRect();
  if (!mr.width || !br.width) return null;
  const dx = (mr.left + mr.width / 2) - (br.left + br.width / 2);
  const dy = (mr.top + mr.height / 2) - (br.top + br.height / 2);
  const sx = mr.width / br.width;
  const sy = mr.height / br.height;
  const small = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
  const frames = direction === 'in'
    ? [{ transform: small }, { transform: 'translate(0, 0) scale(1, 1)' }]
    : [{ transform: 'translate(0, 0) scale(1, 1)' }, { transform: small }];
  return big.animate(frames, {
    duration: direction === 'in' ? 480 : 360,
    easing: 'cubic-bezier(0.34, 1.3, 0.64, 1)',
    fill: 'both',
  });
}

function cancelCoverAnim() {
  if (fsCoverAnim) { try { fsCoverAnim.cancel(); } catch {} }
  fsCoverAnim = null;
}

// ── Fullscreen WebGL Lava Lamp Shader ──
let fsGl = null, fsShaderProg = null, fsTex = null, fsShaderRaf = null;
let fsShaderTimeLoc = null, fsShaderResLoc = null;

function initFsShader() {
  const canvas = $('fs-canvas');
  if (!canvas) return;
  let gl = null;
  try {
    gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  } catch {}
  if (!gl) return;
  fsGl = gl;

  const vsSrc = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = (a_pos + 1.0) * 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  const fsSrc = `
    precision mediump float;
    varying vec2 v_uv;
    uniform float u_time;
    uniform vec2 u_resolution;
    uniform sampler2D u_tex;

    void main() {
      vec2 p = (gl_FragCoord.xy * 2.0 - u_resolution) / min(u_resolution.x, u_resolution.y);
      float t = u_time * 0.32;

      // 4 floating metaballs for lava lamp fluid motion
      vec2 b1 = vec2(sin(t * 0.7) * 0.65, cos(t * 0.9) * 0.55);
      vec2 b2 = vec2(cos(t * 0.8 + 1.5) * 0.6, sin(t * 0.6 + 2.0) * 0.6);
      vec2 b3 = vec2(sin(t * 0.5 + 4.0) * 0.7, cos(t * 0.7 + 3.0) * 0.5);
      vec2 b4 = vec2(cos(t * 0.6 + 5.0) * 0.5, sin(t * 0.8 + 4.5) * 0.7);

      float d1 = length(p - b1);
      float d2 = length(p - b2);
      float d3 = length(p - b3);
      float d4 = length(p - b4);

      float m = 0.28 / (d1 * d1 + 0.12)
              + 0.28 / (d2 * d2 + 0.12)
              + 0.24 / (d3 * d3 + 0.12)
              + 0.24 / (d4 * d4 + 0.12);

      vec2 warp = vec2(
        sin(m * 2.2 + t) * 0.25 + (p.x - b1.x) * 0.15,
        cos(m * 2.0 - t) * 0.25 + (p.y - b2.y) * 0.15
      );
      vec2 sampleUv = clamp(v_uv + warp * 0.4, 0.05, 0.95);

      vec4 c1 = texture2D(u_tex, sampleUv);
      vec4 c2 = texture2D(u_tex, clamp(vec2(1.0 - sampleUv.y, sampleUv.x), 0.05, 0.95));
      vec4 c3 = texture2D(u_tex, clamp(vec2(sampleUv.x, 1.0 - sampleUv.y), 0.05, 0.95));

      vec4 col = mix(c1, c2, smoothstep(0.8, 2.2, m));
      col = mix(col, c3, sin(m * 1.5 + t * 0.5) * 0.5 + 0.5);

      float vig = 1.0 - smoothstep(0.8, 2.2, length(p));
      gl_FragColor = vec4(col.rgb * (0.85 + m * 0.25) * vig, 1.0);
    }
  `;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  fsShaderProg = prog;

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1, -1,  1,
    -1,  1,  1, -1,  1,  1,
  ]), gl.STATIC_DRAW);

  const aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  fsShaderTimeLoc = gl.getUniformLocation(prog, 'u_time');
  fsShaderResLoc = gl.getUniformLocation(prog, 'u_resolution');

  fsTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, fsTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([30, 30, 40, 255]));
}

function updateFsShaderTexture(imgSrc) {
  if (!fsGl) initFsShader();
  if (!fsGl || !fsTex) return;
  if (!imgSrc) return;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (!fsGl) return;
    fsGl.bindTexture(fsGl.TEXTURE_2D, fsTex);
    fsGl.texImage2D(fsGl.TEXTURE_2D, 0, fsGl.RGBA, fsGl.RGBA, fsGl.UNSIGNED_BYTE, img);
  };
  img.src = imgSrc;
}

function startFsShader() {
  if (!fsGl) initFsShader();
  if (!fsGl || fsShaderRaf) return;
  const startTime = performance.now();
  const render = (now) => {
    if (!$('fullscreen-overlay')?.classList.contains('active')) {
      fsShaderRaf = null;
      return;
    }
    const canvas = $('fs-canvas');
    if (canvas && fsGl) {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      const w = Math.floor(canvas.clientWidth * dpr);
      const h = Math.floor(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        fsGl.viewport(0, 0, w, h);
      }
      fsGl.uniform1f(fsShaderTimeLoc, (now - startTime) * 0.001);
      fsGl.uniform2f(fsShaderResLoc, w, h);
      fsGl.drawArrays(fsGl.TRIANGLES, 0, 6);
    }
    fsShaderRaf = requestAnimationFrame(render);
  };
  fsShaderRaf = requestAnimationFrame(render);
}

function stopFsShader() {
  if (fsShaderRaf) {
    cancelAnimationFrame(fsShaderRaf);
    fsShaderRaf = null;
  }
}

function openFullscreen() {
  if (!currentTrack || fsAnimating) return;
  const overlay = $('fullscreen-overlay');
  if (overlay.classList.contains('active')) return;
  fsAnimating = true;
  cancelCoverAnim();
  overlay.classList.add('active');
  updateFullscreenQueue();
  startFsShader();
  void overlay.offsetHeight;
  $('mini-cover-wrapper')?.classList.add('is-morphing', 'is-fullscreen');
  $('mini-cover-wrapper')?.setAttribute('aria-pressed', 'true');
  const fsIcon = $('fsIcon');
  if (fsIcon) fsIcon.textContent = 'fullscreen_exit';
  fsCoverAnim = flipCover('in');
  requestAnimationFrame(() => overlay.classList.add('is-in'));
  const done = () => {
    cancelCoverAnim();
    fsAnimating = false;
    $('mini-cover-wrapper')?.classList.remove('is-morphing');
  };
  if (fsCoverAnim) fsCoverAnim.finished.then(done).catch(done);
  else done();
}

async function closeFullscreen() {
  const overlay = $('fullscreen-overlay');
  if (!overlay.classList.contains('active') || fsAnimating) return;
  if (fsLyricsOpen) closeFsLyricsPanel();
  stopFsShader();
  fsAnimating = true;
  cancelCoverAnim();
  overlay.classList.remove('is-in');
  $('mini-cover-wrapper')?.classList.add('is-morphing');
  $('mini-cover-wrapper')?.classList.remove('is-fullscreen');
  $('mini-cover-wrapper')?.setAttribute('aria-pressed', 'false');
  const fsIcon = $('fsIcon');
  if (fsIcon) fsIcon.textContent = 'fullscreen';
  fsCoverAnim = flipCover('out');
  const done = () => {
    cancelCoverAnim();
    overlay.classList.remove('active');
    fsAnimating = false;
    $('mini-cover-wrapper')?.classList.remove('is-morphing');
  };
  if (fsCoverAnim) fsCoverAnim.finished.then(done).catch(done);
  else setTimeout(done, 320);
}

$('mini-cover-wrapper')?.addEventListener('click', openFullscreen);
$('btn-fullscreen')?.addEventListener('click', openFullscreen);
$('btn-close-fullscreen')?.addEventListener('click', closeFullscreen);
$('btn-close-fullscreen-x')?.addEventListener('click', closeFullscreen);
$('btn-more')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!currentTrack) return;
  openContextMenu(e, currentTrack.path);
});

// ── Lyrics (LRCLIB) ──
// A dedicated overlay panel (toggled by #btn-fs-lyrics) rather than a queue
// tab. The panel is an absolutely-positioned child of .fs-body.
// Synced lyrics are cached per track path for the session — LRCLIB has no
// rate limit worth worrying about here, but there's no reason to re-fetch a
// track we already have. `fsLyrics` is 'loading', null (no lyrics), or
// { lines: [{ time, text }] } sorted ascending by time. Lyrics are only
// fetched once the panel is actually opened.
let fsLyricsOpen = false;
let fsLyricsTrackPath = null;
let fsLyrics = null;
let fsLyricsActiveLine = -1;
const fsLyricsCache = new Map();

function parseLRC(text) {
  const tagRe = /\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]/g;
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const times = [];
    let m;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(raw))) times.push(parseInt(m[1], 10) * 60 + parseFloat(m[2]));
    if (!times.length) continue;
    const content = raw.replace(tagRe, '').trim();
    for (const t of times) lines.push({ time: t, text: content });
  }
  return lines.sort((a, b) => a.time - b.time);
}

function renderFsLyrics() {
  const list = $('fs-lyrics-list');
  list.innerHTML = '';
  fsLyricsActiveLine = -1;
  if (fsLyrics === 'loading') {
    list.innerHTML = `<div class="fs-lyrics-empty">${tr('fs.lyricsLoading')}</div>`;
    return;
  }
  if (!fsLyrics || !fsLyrics.lines.length) {
    list.innerHTML = `<div class="fs-lyrics-empty">${escapeHtml(tr('fs.lyricsNone'))} · <button class="btn-ghost btn-sm" id="btn-manual-lyrics">${escapeHtml(tr('fs.lyricsSearchManual'))}</button></div>`;
    $('btn-manual-lyrics')?.addEventListener('click', async () => {
      const track = currentTrack;
      if (!track) return;
      const defVal = [track.artist, track.title].filter(Boolean).join(' — ');
      const manual = await promptModal(tr('fs.lyricsSearchManual'), defVal);
      if (manual && manual.trim()) {
        fsLyrics = 'loading';
        renderFsLyrics();
        let res = null;
        try {
          res = await window.electronAPI.lookupLyrics({ query: manual.trim() });
        } catch (_) {}
        const parsed = { lines: res && res.synced ? parseLRC(res.synced) : [] };
        fsLyricsCache.set(track.path, parsed);
        fsLyrics = parsed;
        renderFsLyrics();
      }
    });
    return;
  }
  fsLyrics.lines.forEach((ln) => {
    const el = document.createElement('div');
    el.className = 'fs-lyrics-line';
    el.textContent = ln.text || '♪';
    el.addEventListener('click', () => { if (isFinite(audio.duration)) audio.currentTime = ln.time; });
    list.appendChild(el);
  });
  updateFsLyricsActive(audio.currentTime || 0);
}

async function loadFsLyrics(track) {
  if (!track || fsLyricsTrackPath === track.path) return;
  fsLyricsTrackPath = track.path;
  if (fsLyricsCache.has(track.path)) {
    fsLyrics = fsLyricsCache.get(track.path);
    renderFsLyrics();
    return;
  }
  fsLyrics = 'loading';
  renderFsLyrics();
  let result = null;
  try {
    if (window.electronAPI && window.electronAPI.lookupLyrics) {
      result = await window.electronAPI.lookupLyrics({
        artist: track.artist, title: track.title, album: track.album,
        duration: Math.round(track.duration || 0),
      });
    }
  } catch (_) { result = null; }
  if (fsLyricsTrackPath !== track.path) return; // track moved on while we awaited
  const parsed = { lines: result && result.synced ? parseLRC(result.synced) : [] };
  fsLyricsCache.set(track.path, parsed);
  fsLyrics = parsed;
  renderFsLyrics();
}

function updateFsLyricsActive(cur) {
  if (!fsLyrics || fsLyrics === 'loading' || !fsLyrics.lines.length) return;
  // Default to the first line rather than -1: with no active line yet (e.g.
  // playback hasn't reached the first cue), leaving idx at -1 meant nothing
  // was highlighted and nothing scrolled, so the panel opened on a blank
  // stretch of top scroll-padding — the "broken" look reported.
  let idx = 0;
  for (let i = 0; i < fsLyrics.lines.length; i++) {
    if (fsLyrics.lines[i].time <= cur) idx = i; else break;
  }
  if (idx === fsLyricsActiveLine) return;
  const list = $('fs-lyrics-list');
  // Fade lines out with distance from the active one — Apple-Music-style
  // "focused" read instead of a flat highlighted list.
  Array.from(list.children).forEach((el, i) => {
    el.classList.toggle('active', i === idx);
    el.style.opacity = i === idx ? '' : String(Math.max(0.3, 1 - Math.abs(i - idx) * 0.16));
  });
  const next = list.children[idx];
  // Scroll `list` directly instead of next.scrollIntoView(): scrollIntoView
  // walks every scrollable ancestor to center the target, and can nudge the
  // whole app viewport (not just this panel) even though .fs-lyrics-list is
  // itself scrollable.
  if (next && fsLyricsOpen) {
    const target = list.scrollTop + (next.getBoundingClientRect().top - list.getBoundingClientRect().top)
      - (list.clientHeight - next.clientHeight) / 2;
    list.scrollTo({ top: target, behavior: 'smooth' });
  }
  fsLyricsActiveLine = idx;
}

function openFsLyricsPanel() {
  fsLyricsOpen = true;
  $('fs-lyrics-panel')?.classList.add('active');
  $('fullscreen-overlay')?.classList.add('is-lyrics');
  $('btn-fs-lyrics')?.classList.add('is-active');
  $('fs-btn-lyrics')?.classList.add('selected', 'active');
  if (currentTrack) loadFsLyrics(currentTrack);
}
function closeFsLyricsPanel() {
  fsLyricsOpen = false;
  $('fs-lyrics-panel')?.classList.remove('active');
  $('fullscreen-overlay')?.classList.remove('is-lyrics');
  $('btn-fs-lyrics')?.classList.remove('is-active');
  $('fs-btn-lyrics')?.classList.remove('selected', 'active');
}
function toggleFsLyricsPanel() { if (fsLyricsOpen) closeFsLyricsPanel(); else openFsLyricsPanel(); }
$('btn-fs-lyrics')?.addEventListener('click', toggleFsLyricsPanel);
$('fs-btn-lyrics')?.addEventListener('click', toggleFsLyricsPanel);

// Playbar shortcut: jumps straight to fullscreen + lyrics in one click instead
// of opening fullscreen first and hunting for the lyrics toggle inside it.
$('btn-lyrics')?.addEventListener('click', () => {
  if (!currentTrack) return;
  if (!$('fullscreen-overlay').classList.contains('active')) openFullscreen();
  toggleFsLyricsPanel();
});

function updateFullscreenQueue() {}

// ── Generic text-input prompt (Electron doesn't implement window.prompt()) ──
let pendingPromptResolve = null;
function promptModal(message, defaultValue) {
  return new Promise((resolve) => {
    pendingPromptResolve = resolve;
    $('text-prompt-title').textContent = message;
    const input = $('text-prompt-input');
    input.value = defaultValue != null ? String(defaultValue) : '';
    $('text-prompt-modal').classList.add('active');
    focusModalInput(input, { select: true });
  });
}
function closeTextPromptModal(result) {
  $('text-prompt-modal').classList.remove('active');
  if (pendingPromptResolve) { const r = pendingPromptResolve; pendingPromptResolve = null; r(result); }
}
$('btn-cancel-text-prompt').addEventListener('click', () => closeTextPromptModal(null));
$('btn-confirm-text-prompt').addEventListener('click', () => closeTextPromptModal($('text-prompt-input').value));
$('text-prompt-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); closeTextPromptModal($('text-prompt-input').value); }
});

// ── Confirm delete ──
// Destructive actions all have the same shape: a question, the consequence, and
// a yes/no. confirmToast() already is exactly that and resolves true/false, so
// callers just await it — no pending-action global, no second confirm dialog.
function confirmDelete(titleKey, text) {
  return confirmToast(`${tr(titleKey)} ${text}`);
}

async function deleteTrack(path) {
  if (trackIndexByPath(path) < 0) return;
  const res = await window.electronAPI.deleteFile(path);
  // Purge from the library either way: a track whose disk delete keeps
  // failing (locked, or a Shell-API path quirk — see shell:deleteFile) is
  // worse to leave stuck forever than to drop from the app while the real
  // file lingers on disk for the user to clean up by hand.
  removeTracksFromState(new Set([path]));
  refreshCurrentViewRows();
  if (!res || !res.success) {
    window.electronAPI.logError?.('deleteTrack', `${path}: ${(res && res.error) || 'no response'}`);
    toast(tr('error.deleteFile') + ((res && res.error) || tr('error.unknown')));
  }
}
// Drops `paths` from the library, current queue, favorites, recents and
// playlists, stopping playback if the current track is among them. Shared by
// deleteTracks() (after a real disk delete) and revalidateLibrary() (after
// finding files gone from under the app).
function removeTracksFromState(paths) {
  const playingPath = currentTrack ? currentTrack.path : null;
  // Mutate in place: currentQueue may alias the library array.
  for (let i = library.length - 1; i >= 0; i--) {
    if (paths.has(library[i].path)) library.splice(i, 1);
  }
  if (currentQueue !== library) {
    for (let i = currentQueue.length - 1; i >= 0; i--) {
      if (paths.has(currentQueue[i].path)) currentQueue.splice(i, 1);
    }
  }
  if (playingPath && paths.has(playingPath)) {
    audio.pause();
    stopCrossfadeTail();
    isPlaying = false;
    currentTrack = null;
    $('track-title').textContent = tr('np.empty.title');
    $('track-artist').textContent = '—';
    updatePlayButtonUI();
  }
  favorites = favorites.filter(p => !paths.has(p));
  recents = recents.filter(p => !paths.has(p));
  playlists.forEach(pl => { pl.trackPaths = pl.trackPaths.filter(p => !paths.has(p)); });
  saveLibrary(); savePlaylists(); saveRecents();
  renderCounts();
  renderRecents();
}

async function deleteTracks(paths) {
  let failed = 0, firstError = null;
  for (const path of paths) {
    const res = await window.electronAPI.deleteFile(path);
    if (!res || !res.success) {
      failed++;
      firstError = firstError || (res && res.error) || tr('error.unknown');
      window.electronAPI.logError?.('deleteTracks', `${path}: ${(res && res.error) || 'no response'}`);
    }
  }
  // Purge every requested track from the library regardless of disk-delete
  // outcome — see deleteTrack for why a stuck ghost is worse than a track
  // that's gone from the app but still needs manual cleanup on disk.
  removeTracksFromState(new Set(paths));
  setLibrarySelectMode(false); // clears selection and re-renders the library view
  refreshCurrentViewRows();
  if (firstError) {
    toast(tr('error.deleteFile') + firstError + (failed > 1 ? ` (${failed})` : ''));
  }
}

// A file moved/deleted outside the app surfaces as a native <audio> error
// indistinguishable from "corrupt file" — check every local track against
// disk and drop whichever ones are actually gone. Returns how many were removed.
async function revalidateLibrary() {
  if (!window.electronAPI || !window.electronAPI.fileExists) return 0;
  const local = library.filter(t => !isRemotePath(t.path));
  const exists = await Promise.all(local.map(t => window.electronAPI.fileExists(t.path)));
  const ghosts = new Set(local.filter((t, i) => !exists[i]).map(t => t.path));
  if (ghosts.size > 0) removeTracksFromState(ghosts);
  return ghosts.size;
}

// A metadata/cover write (ffmpeg under the hood) can fail for many reasons —
// missing file, corrupt file, locked file, permissions — and none of them
// self-heal on the next bulk-fix run, so any local write failure purges the
// track instead of leaving a dead entry to keep failing forever. Remote
// tracks are left alone: a write failure there is the server's problem, not
// a local file gone bad. Always logs the underlying error. Returns true if
// the track was purged.
async function purgeOnWriteFailure(path, opLabel, errMsg) {
  window.electronAPI.logError?.(opLabel, `${path}: ${errMsg || 'unknown error'}`);
  if (isRemotePath(path) || isTagEditingLocked(path) || /EBUSY|busy|locked|resource busy/i.test(errMsg || '')) return false;
  removeTracksFromState(new Set([path]));
  return true;
}

function deletePlaylist(id) {
  playlists = playlists.filter(pl => pl.id !== id);
  savePlaylists();
  setView('playlists');
}

// Clears the app's library index only — unlike deleteTrack(s), it never
// touches files on disk.
function clearLibrary() {
  audio.pause();
  stopCrossfadeTail();
  isPlaying = false;
  currentTrack = null;
  library.length = 0;
  currentQueue = library;
  favorites = [];
  recents = [];
  playlists.forEach(pl => { pl.trackPaths = []; });
  $('track-title').textContent = tr('np.empty.title');
  $('track-artist').textContent = '—';
  updatePlayButtonUI();
  saveLibrary(); savePlaylists(); saveRecents();
  setLibrarySelectMode(false); // clears selection and re-renders the library view
  renderCounts();
  refreshCurrentViewRows();
  renderRecents();
}

// Creating a playlist is the edit modal with nothing loaded into it — same
// fields, same avatar picker — so it opens in "create" mode instead of having
// a near-identical second modal of its own.
$('btn-new-playlist').addEventListener('click', () => openEditPlaylistModal(null));
$('btn-new-playlist-empty').addEventListener('click', () => openEditPlaylistModal(null));

// ── Playlist context menu + new/edit modal ──
// Right-clicking a card in the playlists grid opens a small menu: edit the
// name/description in a modal, or delete via the shared confirm dialog.
let pendingContextPlaylistId = null;
let editingPlaylistId = null;

function openPlaylistContextMenu(e, plId) {
  pendingContextPlaylistId = plId;
  const menu = $('playlist-context-menu');
  menu.classList.add('open');
  const rect = menu.getBoundingClientRect();
  const w = 240, h = rect.height || 90;
  let x = e.clientX, y = e.clientY;
  if (x + w > window.innerWidth) x = window.innerWidth - w - 8;
  if (y + h > window.innerHeight) y = window.innerHeight - h - 8;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}
function closePlaylistContextMenu() {
  $('playlist-context-menu').classList.remove('open');
  pendingContextPlaylistId = null;
}
document.addEventListener('click', e => {
  if (!e.target.closest('#playlist-context-menu')) closePlaylistContextMenu();
});
document.querySelectorAll('#playlist-context-menu .cm-item').forEach(btn => {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.action;
    const plId = pendingContextPlaylistId;
    closePlaylistContextMenu();
    if (!plId) return;
    const pl = playlists.find(p => p.id === plId);
    if (!pl) return;
    if (action === 'edit') openEditPlaylistModal(plId);
    else if (action === 'delete') {
      if (await confirmDelete('modal.deletePlaylist.title',
        tr('modal.deletePlaylist.text', { name: pl.name }))) deletePlaylist(plId);
    }
  });
});

// Avatar staged while the edit modal is open: undefined = keep as-is,
// '' = remove on save, non-empty string = new downscaled data URL.
let pendingEditAvatar;
function renderEditAvatarPreview() {
  const pl = playlists.find(p => p.id === editingPlaylistId);
  const preview = $('edit-playlist-avatar-preview');
  const cover = pendingEditAvatar !== undefined ? pendingEditAvatar : (pl && pl.cover) || '';
  if (cover) {
    preview.style.background = `url(${cover}) center/cover`;
    preview.innerHTML = '';
  } else {
    // Create mode has no playlist to look up — preview the swatch the new one
    // will actually get (same index newPlaylistColor() picks on save).
    const idx = pl ? playlists.indexOf(pl) : playlists.length;
    preview.style.background = (pl && pl.color) || PL_COVERS[idx % PL_COVERS.length];
    const label = (pl ? pl.name : $('edit-playlist-name').value.trim()) || '?';
    preview.innerHTML = `<span>${escapeHtml(label[0])}</span>`;
  }
  $('btn-edit-playlist-avatar-remove').hidden = !cover;
}
$('btn-edit-playlist-avatar').addEventListener('click', () => {
  $('edit-playlist-avatar-file').click();
});
$('edit-playlist-avatar-file').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      // Downscale to keep localStorage usage small (covers persist in audex-playlists).
      const max = 512;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      pendingEditAvatar = canvas.toDataURL('image/jpeg', 0.85);
      renderEditAvatarPreview();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});
$('btn-edit-playlist-avatar-remove').addEventListener('click', () => {
  pendingEditAvatar = '';
  renderEditAvatarPreview();
});
// plId === null opens the same modal in "create" mode.
function openEditPlaylistModal(plId) {
  const pl = plId ? playlists.find(p => p.id === plId) : null;
  if (plId && !pl) return;
  editingPlaylistId = pl ? plId : null;
  pendingEditAvatar = undefined;
  $('edit-playlist-name').value = pl ? (pl.name || '') : '';
  $('edit-playlist-desc').value = pl ? (pl.desc || '') : '';
  // Set data-i18n too, not just the text — applyLanguage() re-reads the
  // attribute, so a language switch while this is open keeps the right label.
  const titleEl = $('edit-playlist-title'), saveEl = $('btn-save-edit-playlist');
  titleEl.dataset.i18n = pl ? 'modal.editPlaylist.title' : 'modal.newPlaylist.title';
  saveEl.dataset.i18n = pl ? 'btn.save' : 'btn.create';
  titleEl.textContent = tr(titleEl.dataset.i18n);
  saveEl.textContent = tr(saveEl.dataset.i18n);
  renderEditAvatarPreview();
  $('edit-playlist-modal').classList.add('active');
  focusModalInput($('edit-playlist-name'));
}
$('btn-cancel-edit-playlist').addEventListener('click', () => {
  $('edit-playlist-modal').classList.remove('active');
  editingPlaylistId = null;
  pendingEditAvatar = undefined;
});
$('btn-save-edit-playlist').addEventListener('click', () => {
  const name = $('edit-playlist-name').value.trim();
  if (!name) return;
  let pl = playlists.find(p => p.id === editingPlaylistId);
  if (!pl) {
    pl = { id: crypto.randomUUID(), name, desc: '', color: PL_COVERS[playlists.length % PL_COVERS.length], trackPaths: [] };
    playlists.push(pl);
  }
  pl.name = name;
  pl.desc = $('edit-playlist-desc').value.trim();
  if (pendingEditAvatar !== undefined) {
    if (pendingEditAvatar) pl.cover = pendingEditAvatar;
    else delete pl.cover;
  }
  pendingEditAvatar = undefined;
  savePlaylists();
  $('edit-playlist-modal').classList.remove('active');
  editingPlaylistId = null;
  if (currentView === 'playlists') renderPlaylists();
  else if (currentView === 'playlist-detail' && activePlaylistId === pl.id) renderPlaylistDetail(pl.id);
  else renderPlaylists();
});

// ── Add-to-playlist modal ──
function openAddToPlaylistModal(trackPath) {
  if (isRemotePath(trackPath)) return;
  pendingAddPath = trackPath;
  const list = $('add-to-playlist-list');
  list.innerHTML = '';
  if (playlists.length === 0) {
    list.innerHTML = `<div class="sl-empty">${escapeHtml(tr('modal.addToPlaylist.empty'))}</div>`;
  } else {
    playlists.forEach(pl => {
      const el = document.createElement('div');
      el.className = 'sl-item';
      const has = pl.trackPaths.includes(trackPath);
      el.innerHTML = `${escapeHtml(pl.name)} ${has ? `<span style="color:var(--accent-ok);font-size:11px;margin-left:6px">${escapeHtml(tr('modal.addToPlaylist.alreadyAdded'))}</span>` : ''}`;
      el.addEventListener('click', () => {
        if (!has) {
          pl.trackPaths.push(trackPath);
          savePlaylists();
        }
        $('add-to-playlist-modal').classList.remove('active');
      });
      list.appendChild(el);
    });
  }
  $('add-to-playlist-modal').classList.add('active');
}
$('btn-cancel-add-pl').addEventListener('click', () => $('add-to-playlist-modal').classList.remove('active'));
$('fs-btn-add-playlist').addEventListener('click', () => {
  if (currentTrack) openAddToPlaylistModal(currentTrack.path);
});

// ── Context menu ──
function openContextMenu(e, path) {
  pendingContextTrackPath = path;
  const menu = $('track-context-menu');
  const remote = isRemotePath(path);
  $('cm-fav-label').textContent = favorites.includes(path) ? tr('btn.unfavorite') : tr('btn.favorite');
  $('cm-remove-from-pl').hidden = !(currentView === 'playlist-detail' && activePlaylistId);
  const cmTrim = $('cm-trim');
  if (cmTrim) cmTrim.hidden = !settings.editor || remote;
  $('cm-select').hidden = currentView !== 'library';
  // Only offered from inside the album whose covers a marked track can then
  // be stamped across — and only once that track actually has art to copy.
  const track = trackByPath(path);
  $('cm-use-cover').hidden = remote || currentView !== 'album-detail' || !(track && track.cover);
  // Everything below is a local-file operation — a peer's track only has a
  // stream URL, nothing on disk here to tag, reveal, or delete.
  ['reveal', 'edit-tags', 'fix-tags', 'delete'].forEach(a => {
    const el = menu.querySelector(`[data-action="${a}"]`);
    if (el) el.hidden = remote;
  });
  $('cm-div-2').hidden = remote;
  $('cm-div-3').hidden = remote;
  menu.classList.add('open');
  // position
  const rect = menu.getBoundingClientRect();
  const w = 240, h = rect.height || 280;
  let x = e.clientX, y = e.clientY;
  if (x + w > window.innerWidth) x = window.innerWidth - w - 8;
  if (y + h > window.innerHeight) y = window.innerHeight - h - 8;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}
function closeContextMenu() {
  $('track-context-menu').classList.remove('open');
  pendingContextTrackPath = null;
}
document.addEventListener('click', e => {
  if (!e.target.closest('#track-context-menu') && !e.target.closest('.trow-more') && !e.target.closest('#btn-more')) {
    closeContextMenu();
  }
});
document.querySelectorAll('#track-context-menu .cm-item').forEach(btn => {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.action;
    const path = pendingContextTrackPath;
    closeContextMenu();
    if (!path) return;
    const track = trackByPath(path);
    if (action === 'play') playTrackByPath(path, currentQueue.length ? currentQueue : library);
    else if (action === 'select') {
      setLibrarySelectMode(true); // no-op if already in select mode (keeps existing selection)
      if (!selectedPaths.has(path)) toggleRowSelection(path, false);
    }
    else if (action === 'favorite') toggleFavorite(path);
    else if (action === 'reveal') window.electronAPI.revealInFolder(path);
    else if (action === 'edit-tags') openMetadataEditor(path);
    else if (action === 'use-cover') {
      if (!track || !track.cover) { toast(tr('albumCover.badSource')); return; }
      pendingAlbumCoverSource = path;
    }
    else if (action === 'trim') { if (track) openEditorFor(track); }
    else if (action === 'add-to-playlist') openAddToPlaylistModal(path);
    else if (action === 'remove-from-playlist') {
      const pl = playlists.find(p => p.id === activePlaylistId);
      if (pl) {
        pl.trackPaths = pl.trackPaths.filter(p => p !== path);
        savePlaylists();
        renderPlaylistDetail(activePlaylistId);
        renderCounts();
      }
    }
    else if (action === 'delete') {
      if (await confirmDelete('modal.deleteTrack.title',
        tr('modal.deleteTrackFull.text', { title: track.title, artist: track.artist }))) deleteTrack(path);
    }
  });
});

// ── Metadata editor ──
let pendingEditorCoverUrl = null;

async function openMetadataEditor(path) {
  if (isRemotePath(path)) return;   // tags live on the owning device's disk
  if (isTagEditingLocked(path)) { toast(tr('editor.lockedWhilePlaying')); return; }
  pendingMetadataPath = path;
  pendingEditorCoverUrl = null;
  let meta = trackByPath(path);
  // Refresh from disk for full tag set
  const fresh = await window.electronAPI.parseMetadata(path);
  meta = { ...meta, ...fresh };
  $('md-title').value = meta.title || '';
  $('md-artist').value = meta.artist || '';
  $('md-album').value = meta.album || '';
  $('md-year').value = meta.year || '';
  $('md-genre').value = meta.genre || '';
  $('md-track-no').value = meta.trackNo || '';
  $('md-disc-no').value = meta.discNo || '';
  const cover = $('editor-cover');
  if (meta.cover) {
    cover.style.backgroundImage = `url('${meta.cover}')`;
    $('editor-cover-letter').textContent = '';
    $('editor-cover-tag').textContent = tr('editor.coverEmbed');
  } else {
    cover.style.backgroundImage = '';
    $('editor-cover-letter').textContent = (meta.title || '?')[0];
    $('editor-cover-tag').textContent = tr('editor.noCover');
  }
  $('editor-filename').textContent = path;
  $('editor-status').textContent = '';
  $('editor-status').className = 'editor-foot-status';
  const tagBox = $('md-lfm-tags');
  if (tagBox) { tagBox.innerHTML = ''; tagBox.hidden = true; }
  const mbBox = $('md-mb-results');
  if (mbBox) { mbBox.hidden = true; $('md-mb-list').innerHTML = ''; }
  $('metadata-modal').classList.add('active');
}
$('btn-close-editor').addEventListener('click', () => $('metadata-modal').classList.remove('active'));
$('btn-cancel-editor').addEventListener('click', () => $('metadata-modal').classList.remove('active'));

$('btn-set-cover-file').addEventListener('click', async () => {
  if (!window.electronAPI.chooseImage) return;
  const res = await window.electronAPI.chooseImage();
  if (!res || res.canceled || !res.dataUrl) return;
  pendingEditorCoverUrl = res.dataUrl;
  const cover = $('editor-cover');
  cover.style.backgroundImage = `url('${res.dataUrl}')`;
  $('editor-cover-letter').textContent = '';
  $('editor-cover-tag').textContent = tr('editor.coverNew');
});

// MusicBrainz: search recordings and prompt user with top 5 results to apply.
$('btn-mb-editor').addEventListener('click', async () => {
  if (!pendingMetadataPath) return;
  const btn = $('btn-mb-editor'), status = $('editor-status'), resultsBox = $('md-mb-results'), list = $('md-mb-list');
  const title = $('md-title').value.trim();
  const artist = $('md-artist').value.trim();
  let query = '';
  if (!title && !artist) {
    const base = pendingMetadataPath.split(/[/\\]/).pop() || '';
    query = base.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]/g, ' ');
  }
  btn.disabled = true;
  status.textContent = tr('editor.mbSearching');
  status.className = 'editor-foot-status';
  resultsBox.hidden = true;
  list.innerHTML = '';
  let results = [];
  try {
    results = await window.electronAPI.searchMusicBrainz({ title, artist, query });
    console.log('[MusicBrainz:results]', results);
  } catch (_) {
    results = [];
  }
  if (!results || !results.length) {
    status.textContent = tr('editor.mbNoMatch');
    const manual = await promptModal(tr('editor.mbManualPrompt'), `${$('md-artist').value} ${$('md-title').value}`.trim());
    if (manual && manual.trim()) {
      status.textContent = tr('editor.mbSearching');
      try {
        results = await window.electronAPI.searchMusicBrainz({ query: manual.trim() });
      } catch (_) { results = []; }
    }
    if (!results || !results.length) {
      status.textContent = tr('editor.mbNoMatch');
      status.className = 'editor-foot-status';
      btn.disabled = false;
      return;
    }
  }
  btn.disabled = false;
  status.textContent = '';
  results.forEach(rec => {
    const item = document.createElement('div');
    item.className = 'mb-result-item';
    const countryDate = [rec.country, rec.date || rec.year].filter(Boolean).join(' / ');
    const subParts = [rec.album, countryDate, rec.trackNo ? `Track ${rec.trackNo}` : '', rec.genre].filter(Boolean);
    const mbUrl = rec.url || (rec.id ? `https://musicbrainz.org/recording/${rec.id}` : '');
    item.innerHTML = `
      <div class="mb-result-title">
        <span>${escapeHtml(rec.title || 'Untitled')}</span>
        <div class="mb-result-meta">
          ${rec.artist ? `<span class="mb-result-artist">${escapeHtml(rec.artist)}</span>` : ''}
          ${mbUrl ? `<a class="mb-link" href="${escapeHtml(mbUrl)}" title="Open on MusicBrainz" aria-label="Open on MusicBrainz"><svg class="i" width="12" height="12"><use href="#i-link"/></svg></a>` : ''}
        </div>
      </div>
      ${subParts.length ? `<div class="mb-result-sub">${escapeHtml(subParts.join(' · '))}</div>` : ''}
    `;
    const link = item.querySelector('.mb-link');
    if (link && mbUrl) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.electronAPI.openExternal(mbUrl);
      });
    }
    item.addEventListener('click', () => {
      if (rec.title) $('md-title').value = rec.title;
      if (rec.artist) $('md-artist').value = rec.artist;
      if (rec.album) $('md-album').value = rec.album;
      if (rec.date || rec.year) $('md-year').value = rec.date || rec.year;
      if (rec.trackNo) $('md-track-no').value = rec.trackNo;
      if (rec.discNo) $('md-disc-no').value = rec.discNo;
      if (rec.genre) $('md-genre').value = rec.genre;
      status.textContent = tr('editor.mbApplied');
      status.className = 'editor-foot-status ok';
      resultsBox.querySelectorAll('.mb-result-item').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
    });
    list.appendChild(item);
  });
  resultsBox.hidden = false;
});

// Last.fm: fill name corrections into the fields and offer genre top-tags as
// one-tap chips. Never writes on its own — the user reviews and presses Save.
$('btn-lastfm-editor').addEventListener('click', async () => {
  if (!pendingMetadataPath) return;
  const btn = $('btn-lastfm-editor'), status = $('editor-status'), tagBox = $('md-lfm-tags');
  if (!lfmConfigured()) {
    status.textContent = tr('editor.lastfmNeedKey');
    status.className = 'editor-foot-status error';
    return;
  }
  const artist = $('md-artist').value.trim(), title = $('md-title').value.trim();
  if (!artist) return;
  btn.disabled = true;
  status.textContent = tr('editor.lastfmFetching');
  status.className = 'editor-foot-status';
  let corrected = false;
  const corr = await lfmCorrection(title ? 'track' : 'artist', artist, title);
  if (corr) {
    if (corr.artist) { $('md-artist').value = corr.artist; corrected = true; }
    if (corr.title) { $('md-title').value = corr.title; corrected = true; }
  }
  // Prefer track-level tags, fall back to the (corrected) artist's tags.
  const a2 = $('md-artist').value.trim(), t2 = $('md-title').value.trim();
  let tags = t2 ? await lfmTopTags('track', a2, t2) : [];
  if (!tags.length) tags = await lfmTopTags('artist', a2);
  tagBox.innerHTML = '';
  if (tags.length) {
    tags.forEach(name => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-pill';
      chip.textContent = name;
      chip.addEventListener('click', () => {
        const cur = $('md-genre').value.trim();
        const existing = cur ? cur.split(/[,;\/]+/).map(s => s.trim().toLowerCase()) : [];
        if (!existing.includes(name.toLowerCase())) {
          $('md-genre').value = cur ? `${cur}, ${name}` : name;
        }
      });
      tagBox.appendChild(chip);
    });
    tagBox.hidden = false;
  } else {
    tagBox.hidden = true;
  }
  btn.disabled = false;
  status.textContent = corrected ? tr('editor.lastfmCorrected')
    : tags.length ? tr('editor.lastfmTags') : tr('editor.lastfmNothing');
  status.className = 'editor-foot-status' + (corrected || tags.length ? ' ok' : '');
});

$('btn-save-editor').addEventListener('click', async () => {
  if (!pendingMetadataPath) return;
  if (isTagEditingLocked(pendingMetadataPath)) {
    const status = $('editor-status');
    status.textContent = tr('editor.lockedWhilePlaying');
    status.className = 'editor-foot-status error';
    toast(tr('editor.lockedWhilePlaying'));
    return;
  }
  const status = $('editor-status');
  status.textContent = tr('editor.saving');
  status.className = 'editor-foot-status';
  const tags = {
    title: $('md-title').value,
    artist: $('md-artist').value,
    album: $('md-album').value,
    year: $('md-year').value,
    genre: $('md-genre').value,
    trackNo: $('md-track-no').value,
    discNo: $('md-disc-no').value,
  };
  const res = await window.electronAPI.writeMetadata(pendingMetadataPath, tags);
  if (res.success) {
    if (pendingEditorCoverUrl) {
      await window.electronAPI.writeCover(pendingMetadataPath, pendingEditorCoverUrl);
    }
    status.textContent = tr('editor.saved');
    status.className = 'editor-foot-status ok';
    // update in-memory library
    const t = trackByPath(pendingMetadataPath);
    if (t) {
      Object.assign(t, {
        title: tags.title || t.title,
        artist: tags.artist || t.artist,
        album: tags.album || t.album,
        year: tags.year,
        genre: tags.genre,
        trackNo: tags.trackNo,
        discNo: tags.discNo,
      });
      if (pendingEditorCoverUrl) {
        t.cover = pendingEditorCoverUrl;
        t.hasCover = true;
        coverCache[pendingMetadataPath] = pendingEditorCoverUrl;
      }
      saveLibrary();
      refreshCurrentViewRows();
      if (currentTrack && currentTrack.path === pendingMetadataPath) updateNowPlayingUI(t);
    }
    setTimeout(() => $('metadata-modal').classList.remove('active'), 600);
  } else if (await purgeOnWriteFailure(pendingMetadataPath, 'metadataEditorSave', res.error)) {
    status.textContent = tr('library.purgedOnError', { count: 1 });
    status.className = 'editor-foot-status error';
    refreshCurrentViewRows();
    setTimeout(() => $('metadata-modal').classList.remove('active'), 1200);
  } else {
    status.textContent = res.error || tr('editor.errorSave');
    status.className = 'editor-foot-status error';
  }
});

// ── Command palette ──
let paletteResults = [];
let paletteHighlight = 0;

// Grouped in the order they render. `nav` names a sidebar item whose visibility
// gates the action — an opt-in feature that's switched off shouldn't be
// reachable from the palette either.
const PALETTE_ACTIONS = [
  { group: 'general', key: 'palette.action.reloadApp',     kind: 'reload-app',    icon: '#i-activity' },
  { group: 'general', key: 'palette.action.openFiles',     kind: 'open-files',    icon: '#i-folder' },
  { group: 'general', key: 'palette.action.gotoSettings',  kind: 'goto-settings', icon: '#i-settings' },
  { group: 'general', key: 'palette.action.clearLibrary',  kind: 'clear-library', icon: '#i-trash' },
  { group: 'nav', key: 'palette.action.gotoLibrary',   kind: 'goto-library',   icon: '#i-library' },
  { group: 'nav', key: 'palette.action.gotoDownloads', kind: 'goto-downloads', icon: '#i-download', nav: 'nav-downloads' },
  { group: 'nav', key: 'palette.action.gotoYtMusic',   kind: 'goto-ytmusic',   icon: '#i-youtube',  nav: 'nav-ytmusic' },
  { group: 'nav', key: 'palette.action.gotoArtists',   kind: 'goto-artists',   icon: '#i-mic' },
  { group: 'nav', key: 'palette.action.gotoAlbums',    kind: 'goto-albums',    icon: '#i-image' },
  { group: 'nav', key: 'palette.action.gotoFavorites', kind: 'goto-favorites', icon: '#i-heart' },
  { group: 'nav', key: 'palette.action.gotoPlaylists', kind: 'goto-playlists', icon: '#i-list' },
  { group: 'nav', key: 'palette.action.gotoDevices',   kind: 'goto-devices',   icon: '#i-monitor', nav: 'nav-devices' },
  { group: 'nav', key: 'palette.action.gotoReport',    kind: 'goto-report',    icon: '#i-report',  nav: 'nav-report' },
  { group: 'nav', key: 'palette.action.gotoHealth',    kind: 'goto-health',    icon: '#i-shield',  nav: 'nav-health' },
  { group: 'music', key: 'palette.action.volumeUp',       kind: 'volume-up',        icon: '#i-volume' },
  { group: 'music', key: 'palette.action.volumeDown',     kind: 'volume-down',      icon: '#i-volume-low' },
];
const PALETTE_GROUPS = [
  ['general', 'palette.group.general'],
  ['nav', 'palette.group.nav'],
  ['music', 'palette.group.music'],
];

// An action matches its label in EVERY language, not just the active one, so
// "settings" and "налаштування" both find Go to Settings.
function paletteMatches(key, q) {
  if (!q) return true;
  return Object.values(I18N).some(dict => (dict[key] || '').toLowerCase().includes(q));
}

function openPalette() {
  $('palette-overlay').classList.add('active');
  $('palette-input').value = '';
  renderPaletteResults('');
  focusModalInput($('palette-input'));
}
function closePalette() {
  $('palette-overlay').classList.remove('active');
}
function renderPaletteResults(query) {
  const q = query.trim().toLowerCase();
  const container = $('palette-results');
  container.innerHTML = '';
  paletteResults = [];
  paletteHighlight = 0;

  // Track matches
  const tracks = q ? library.filter(t =>
    t.title.toLowerCase().includes(q) ||
    t.artist.toLowerCase().includes(q) ||
    t.album.toLowerCase().includes(q)
  ).slice(0, 8) : library.slice(0, 5);
  const renderTracks = () => {
    if (!tracks.length) return;
    const lbl = document.createElement('div');
    lbl.className = 'palette-section-label';
    lbl.textContent = tr('palette.tracks');
    container.appendChild(lbl);
    tracks.forEach(t => {
      if (!t.cover) ensureCoverFor(t);
      paletteResults.push({ kind: 'play-track', path: t.path });
      const el = document.createElement('div');
      el.className = 'palette-item';
      el.dataset.idx = paletteResults.length - 1;
      const cover = t.cover ? `background-image:url('${t.cover}')` : '';
      el.innerHTML = `
        <div class="palette-item-cover" style="${cover}"></div>
        <div class="palette-item-body">
          <div class="palette-item-title">${highlightMatch(t.title, q)}</div>
          <div class="palette-item-sub">${escapeHtml(t.artist)} · ${escapeHtml(t.album)}</div>
        </div>
        <span class="palette-item-hint">${escapeHtml(tr('palette.itemHint'))}</span>
      `;
      el.addEventListener('click', () => runPaletteAction(paletteResults[+el.dataset.idx]));
      container.appendChild(el);
    });
  };

  // Artists / albums. Only searched when something is typed — the palette's
  // idle state stays a short "recent tracks" list, and this way the indexes
  // aren't rebuilt on every open.
  // ponytail: rebuilds both indexes per keystroke, same O(n) as the track
  // filter above; memoise per library revision if it ever shows up in a profile.
  const section = (labelKey, rows) => {
    if (!rows.length) return;
    const lbl = document.createElement('div');
    lbl.className = 'palette-section-label';
    lbl.textContent = tr(labelKey);
    container.appendChild(lbl);
    rows.forEach(r => {
      paletteResults.push(r.result);
      const el = document.createElement('div');
      el.className = 'palette-item';
      el.dataset.idx = paletteResults.length - 1;
      el.innerHTML = `
        <div class="palette-item-cover" style="${r.cover ? `background-image:url('${r.cover}')` : ''}"></div>
        <div class="palette-item-body">
          <div class="palette-item-title">${highlightMatch(r.name, q)}</div>
          <div class="palette-item-sub">${escapeHtml(r.sub)}</div>
        </div>
      `;
      el.addEventListener('click', () => runPaletteAction(paletteResults[+el.dataset.idx]));
      container.appendChild(el);
    });
  };
  const warmCover = a => { if (!a.cover) { const t = a.tracks.find(t => !t.cover); if (t) ensureCoverFor(t); } };
  // How closely a name answers the query: exact > starts-with > starts a word >
  // matches anywhere, plus a coverage fraction so the shorter of two names in
  // the same tier wins. 0 means no match at all.
  const matchScore = text => {
    const t = (text || '').toLowerCase();
    const i = q ? t.indexOf(q) : -1;
    if (i < 0) return 0;
    const tier = t === q ? 4 : i === 0 ? 3 : /\s/.test(t[i - 1]) ? 2 : 1;
    return tier + q.length / t.length;
  };
  const byScore = (a, b) => (b.score - a.score) || (b.count - a.count);
  const artistRows = !q ? [] : buildArtistsIndex()
    .filter(a => a.name.toLowerCase().includes(q))
    .map(a => ({
      name: a.name, cover: a.cover, count: a.trackCount, warm: a, score: matchScore(a.name),
      sub: `${withCount('tracks', a.trackCount)} · ${withCount('albums', a.albumCount)}`,
      result: { kind: 'open-artist', name: a.name },
    }))
    .sort(byScore).slice(0, 5);
  const albumRows = !q ? [] : buildAlbumsIndex()
    .filter(a => a.name.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q))
    .map(a => ({
      name: a.name, cover: a.cover, count: a.trackCount, warm: a, score: matchScore(a.name),
      sub: [a.artist, a.year, withCount('tracks', a.trackCount)].filter(Boolean).join(' · '),
      result: { kind: 'open-album', key: a.key },
    }))
    .sort(byScore).slice(0, 5);
  [...artistRows, ...albumRows].forEach(r => warmCover(r.warm));

  // Whichever answers the query more closely leads. Tracks are scored on title
  // alone: "radiohead" matches the artist field of every one of their songs, so
  // scoring those fields too would let the tracks tie with the artist forever.
  // sort() is stable, so Artists keeps its place ahead of Albums when tied.
  const best = rows => rows.reduce((m, r) => Math.max(m, r.score), 0);
  const bestTrack = tracks.reduce((m, t) => Math.max(m, matchScore(t.title)), 0);
  const entities = [['nav.artists', artistRows], ['nav.albums', albumRows]];
  if (q && Math.max(best(artistRows), best(albumRows)) > bestTrack) {
    entities.sort((a, b) => best(b[1]) - best(a[1]));
    entities.forEach(e => section(...e));
    renderTracks();
  } else {
    renderTracks();
    entities.forEach(e => section(...e));
  }

  // Actions, one section per group
  const available = PALETTE_ACTIONS.filter(a => (!a.nav || !$(a.nav).hidden) && paletteMatches(a.key, q));
  PALETTE_GROUPS.forEach(([group, labelKey]) => {
    const items = available.filter(a => a.group === group);
    if (!items.length) return;
    const lbl = document.createElement('div');
    lbl.className = 'palette-section-label';
    lbl.textContent = tr(labelKey);
    container.appendChild(lbl);
    items.forEach(a => {
      paletteResults.push({ kind: a.kind });
      const el = document.createElement('div');
      el.className = 'palette-item';
      el.dataset.idx = paletteResults.length - 1;
      el.innerHTML = `
        <div class="palette-item-cover"><svg class="i" width="13" height="13"><use href="${a.icon}"/></svg></div>
        <div class="palette-item-body">
          <div class="palette-item-title">${escapeHtml(tr(a.key))}</div>
        </div>
      `;
      el.addEventListener('click', () => runPaletteAction(paletteResults[+el.dataset.idx]));
      container.appendChild(el);
    });
  });

  if (paletteResults.length === 0) {
    container.innerHTML = `<div class="palette-empty">${escapeHtml(tr('palette.empty'))}</div>`;
  } else {
    highlightPaletteItem();
  }
}
function highlightMatch(text, q) {
  if (!q) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx))
    + `<span class="palette-match">${escapeHtml(text.slice(idx, idx + q.length))}</span>`
    + escapeHtml(text.slice(idx + q.length));
}
function highlightPaletteItem() {
  document.querySelectorAll('#palette-results .palette-item').forEach((el, i) => {
    el.classList.toggle('highlighted', i === paletteHighlight);
  });
}
function runPaletteAction(action) {
  closePalette();
  if (!action) return;
  if (action.kind === 'play-track') playTrackByPath(action.path, library);
  else if (action.kind === 'open-files') $('btn-add-files').click();
  else if (action.kind === 'goto-settings') openSettings();
  else if (action.kind === 'open-artist') { activeArtistName = action.name; setView('artist-detail'); }
  else if (action.kind === 'open-album') { activeAlbumKey = action.key; setView('album-detail'); }
  else if (action.kind === 'goto-ytmusic') ytmBrowser.open();
  else if (action.kind === 'goto-library') { clearHealthFilter(); setView('library'); }
  // Every remaining goto-* names its view directly.
  else if (action.kind.startsWith('goto-')) setView(action.kind.slice(5));
  else if (action.kind === 'clear-library') {
    confirmDelete('modal.clearLibrary.title', tr('modal.clearLibrary.text'))
      .then(ok => { if (ok) clearLibrary(); });
  }
  else if (action.kind === 'volume-up') setVolume(targetVolume + 0.05);
  else if (action.kind === 'volume-down') setVolume(targetVolume - 0.05);
  else if (action.kind === 'reload-app') location.reload();
}
$('palette-input').addEventListener('input', e => renderPaletteResults(e.target.value));
$('palette-input').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteHighlight = Math.min(paletteResults.length - 1, paletteHighlight + 1); highlightPaletteItem(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteHighlight = Math.max(0, paletteHighlight - 1); highlightPaletteItem(); }
  else if (e.key === 'Enter') { e.preventDefault(); runPaletteAction(paletteResults[paletteHighlight]); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
});
$('palette-overlay').addEventListener('click', e => {
  if (e.target.id === 'palette-overlay') closePalette();
});

// ── Hotkeys ──
// Every global shortcut is table-driven so the Settings → Hotkeys tab can
// rebind it. A binding is stored as a normalised combo string ("Ctrl+K",
// "Space", "Shift+ArrowUp"); `settings.hotkeys` holds only the user's overrides
// and is merged over HOTKEY_DEFAULTS at read time.
//
// Ctrl and Meta are deliberately folded into one "Ctrl" token: the app has
// always treated Cmd and Ctrl as interchangeable, so one default works on both
// macOS and Linux/Windows. Escape stays hard-coded below — it closes whatever
// is on top and would be a footgun to rebind.
const HOTKEY_ACTIONS = [
  { id: 'playPause',    def: 'Space',           run: () => togglePlay() },
  { id: 'nextTrack',    def: 'Ctrl+ArrowRight', run: () => nextTrack() },
  { id: 'prevTrack',    def: 'Ctrl+ArrowLeft',  run: () => prevTrack() },
  { id: 'seekForward',  def: 'ArrowRight',      run: () => hkSeek(5) },
  { id: 'seekBackward', def: 'ArrowLeft',       run: () => hkSeek(-5) },
  { id: 'volumeUp',     def: 'ArrowUp',         run: () => setVolume(targetVolume + 0.05) },
  { id: 'volumeDown',   def: 'ArrowDown',       run: () => setVolume(targetVolume - 0.05) },
  { id: 'mute',         def: 'KeyM',            run: () => toggleMute() },
  { id: 'favorite',     def: 'KeyL',            run: () => hkFavoriteCurrent() },
  { id: 'shuffle',      def: 'KeyS',            run: () => { isShuffle = !isShuffle; updateShuffleUI(); } },
  { id: 'repeat',       def: 'KeyR',            run: () => { repeatMode = (repeatMode + 1) % 3; updateRepeatUI(); } },
  { id: 'fullscreen',   def: 'KeyF',            run: () => hkToggleFullscreen() },
  { id: 'palette',      def: 'Ctrl+KeyK',       run: () => hkTogglePalette() },
  { id: 'editTags',     def: 'Ctrl+KeyE',       run: () => hkEditCurrentTags() },
  { id: 'settings',     def: 'Ctrl+Comma',      run: () => (isSettingsOpen() ? closeSettings() : openSettings()) },
];
const HOTKEY_DEFAULTS = HOTKEY_ACTIONS.reduce((m, a) => { m[a.id] = a.def; return m; }, {});

function hotkeyBindings() {
  return Object.assign({}, HOTKEY_DEFAULTS, settings.hotkeys || {});
}

function hkSeek(delta) {
  if (!audio.src || !isFinite(audio.duration)) return;
  audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + delta));
}
function hkFavoriteCurrent() {
  if (!currentTrack) return;
  toggleFavorite(currentTrack.path);
}
function hkToggleFullscreen() {
  if ($('fullscreen-overlay').classList.contains('active')) closeFullscreen();
  else openFullscreen();
}
function hkTogglePalette() {
  if ($('palette-overlay').classList.contains('active')) closePalette();
  else openPalette();
}
function hkEditCurrentTags() {
  if (!currentTrack) return;
  openMetadataEditor(currentTrack.path);
}

// Turn a keydown into a normalised combo string, or '' for a bare modifier
// press (which must not be captured as a binding on its own).
//
// Keys are identified by `e.code` (physical position), NOT `e.key`. `e.key` is
// the produced character and therefore layout-dependent: on a Cyrillic layout
// the S key reports 'с', so a binding captured in one layout would silently
// stop firing after switching to the other. `e.code` stays 'KeyS' either way.
// The trade-off is that on a non-QWERTY physical layout the displayed letter
// follows the position rather than the keycap.
function comboFromEvent(e) {
  const code = e.code;
  if (!code) return '';
  if (/^(Control|Meta|Alt|Shift|OS)/.test(code)) return '';
  return hkWithModifiers(e, code);
}

// Mouse buttons are bindable too — the side buttons in particular are what
// people want for next/previous track. Left (0) and right (2) are deliberately
// not bindable: left drives the entire UI and right opens the context menus,
// so capturing either would make the app unusable.
function comboFromMouse(e) {
  if (e.button === 0 || e.button === 2) return '';
  return hkWithModifiers(e, 'Mouse' + e.button);
}

function hkWithModifiers(e, token) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(token);
  return parts.join('+');
}

// Human-readable form for the Settings rows.
const HOTKEY_GLYPHS = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Space: 'Space', Enter: '↵', Backspace: '⌫', Escape: 'Esc',
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';',
  Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '−', Equal: '=',
  Backquote: '`', Tab: '⇥', Home: 'Home', End: 'End',
  PageUp: 'PgUp', PageDown: 'PgDn', Insert: 'Ins', Delete: 'Del',
};
function codeLabel(code) {
  // Browser button numbers: 1 = middle, 3 = X1 ("back"), 4 = X2 ("forward").
  if (code === 'Mouse1') return tr('mouse.middle');
  if (code === 'Mouse3') return tr('mouse.back');
  if (code === 'Mouse4') return tr('mouse.forward');
  if (/^Mouse\d+$/.test(code)) return tr('mouse.other', { n: code.slice(5) });
  if (HOTKEY_GLYPHS[code]) return HOTKEY_GLYPHS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return 'Num ' + code.slice(6);
  if (/^F\d{1,2}$/.test(code)) return code;
  return code;
}
function comboLabel(combo) {
  if (!combo) return '—';
  return combo.split('+').map(p => (p === 'Ctrl' || p === 'Alt' || p === 'Shift') ? p : codeLabel(p)).join(' + ');
}

// ── Global hotkeys ──
// A combo can additionally be registered with the OS so it fires while the
// window is minimised. That grab is system-wide, so two rules apply:
//   * mouse buttons can't be registered at all (Electron's globalShortcut is
//     keyboard-only);
//   * a bare key is refused — grabbing "Space" or "S" globally would swallow
//     that key in every other application, including whatever the user would
//     need to undo it.
const ACCEL_KEYS = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Space: 'Space', Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace',
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';',
  Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
  Backquote: '`', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Insert: 'Insert', Delete: 'Delete',
};
function comboToAccelerator(combo) {
  if (!combo) return '';
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  if (/^Mouse\d+$/.test(key)) return '';
  let accelKey = ACCEL_KEYS[key];
  if (!accelKey) {
    if (/^Key[A-Z]$/.test(key)) accelKey = key.slice(3);
    else if (/^Digit\d$/.test(key)) accelKey = key.slice(5);
    else if (/^F\d{1,2}$/.test(key)) accelKey = key;
    else return '';
  }
  const mods = [];
  if (parts.includes('Ctrl')) mods.push('CommandOrControl');
  if (parts.includes('Alt')) mods.push('Alt');
  if (parts.includes('Shift')) mods.push('Shift');
  return mods.concat(accelKey).join('+');
}
// Why a given combo can't go global — drives the disabled state and tooltip.
function globalBlockReason(combo) {
  if (!combo) return 'empty';
  const parts = combo.split('+');
  if (/^Mouse\d+$/.test(parts[parts.length - 1])) return 'mouse';
  const hasMod = parts.includes('Ctrl') || parts.includes('Alt') || parts.includes('Shift');
  if (!hasMod) return 'needsModifier';
  if (!comboToAccelerator(combo)) return 'unsupported';
  return '';
}
function hotkeyGlobals() {
  return settings.hotkeysGlobal || {};
}
function isGlobalOn(id) {
  return !!hotkeyGlobals()[id];
}

let globalHotkeyFailures = new Set(); // ids the OS refused (combo already taken)
let globalHotkeysSupported = true;    // false on Wayland, where no grab is possible

// Push the current global set to the main process. Called on boot and after any
// binding change.
async function syncGlobalHotkeys() {
  if (!window.electronAPI || !window.electronAPI.registerGlobalHotkeys) return;
  const bindings = hotkeyBindings();
  const globals = hotkeyGlobals();
  const list = [];
  for (const a of HOTKEY_ACTIONS) {
    if (!globals[a.id]) continue;
    const accelerator = comboToAccelerator(bindings[a.id]);
    if (accelerator) list.push({ id: a.id, accelerator });
  }
  try {
    const res = await window.electronAPI.registerGlobalHotkeys(list);
    const failed = new Set((res && res.failed) || []);
    const supported = !res || res.supported !== false;
    const changed = supported !== globalHotkeysSupported ||
      failed.size !== globalHotkeyFailures.size ||
      [...failed].some(id => !globalHotkeyFailures.has(id));
    globalHotkeyFailures = failed;
    globalHotkeysSupported = supported;
    if (changed) renderHotkeys();
  } catch (_) { /* main process unavailable — local hotkeys still work */ }
}

if (window.electronAPI && window.electronAPI.onGlobalHotkey) {
  window.electronAPI.onGlobalHotkey(({ id }) => {
    const action = HOTKEY_ACTIONS.find(a => a.id === id);
    if (action) action.run();
  });
}

let hotkeyCapture = null; // action id currently listening for a new combo

// Global keyboard shortcuts
document.addEventListener('keydown', e => {
  const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';

  // Rebinding mode swallows everything until a combo lands or the user cancels.
  if (hotkeyCapture) {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') { hotkeyCapture = null; renderHotkeys(); return; }
    if (e.code === 'Backspace') { hotkeySet(hotkeyCapture, ''); return; }
    const combo = comboFromEvent(e);
    if (combo) hotkeySet(hotkeyCapture, combo);
    return;
  }

  if (e.key === 'Escape') {
    if ($('fullscreen-overlay').classList.contains('active')) closeFullscreen();
    else if (isSettingsOpen()) closeSettings();
    // The text prompt owns a pending promise, so it has to be resolved rather
    // than just hidden. Every other modal is plain markup — close whichever is
    // open instead of naming them one by one (the old list had already drifted
    // out of date and missed the edit-playlist and track-picker modals).
    else if ($('text-prompt-modal').classList.contains('active')) closeTextPromptModal(null);
    else {
      const open = document.querySelector('.modal-overlay.active');
      if (open) open.classList.remove('active');
      else if (librarySelectMode) setLibrarySelectMode(false);
    }
    return;
  }

  const combo = comboFromEvent(e);
  if (!combo) return;
  // A bare key (no Ctrl/Alt) must not fire while the user is typing.
  const bare = !e.ctrlKey && !e.metaKey && !e.altKey;
  if (bare && isInput) return;

  const bindings = hotkeyBindings();
  const action = HOTKEY_ACTIONS.find(a => bindings[a.id] === combo);
  if (!action) return;
  e.preventDefault();
  // A successfully registered global grab already delivers this combo through
  // the main process. Running it here too would fire the action twice on any
  // platform where the key still reaches the focused window.
  if (isGlobalOn(action.id) && !globalHotkeyFailures.has(action.id) && comboToAccelerator(combo)) return;
  action.run();
});

// Mouse-button shortcuts. Bound on the capture phase so a side button still
// works over rows, buttons and other click handlers.
document.addEventListener('mousedown', e => {
  const combo = comboFromMouse(e);
  if (!combo) return; // left / right button — never bindable

  if (hotkeyCapture) {
    e.preventDefault();
    e.stopPropagation();
    hotkeySet(hotkeyCapture, combo);
    return;
  }

  const bindings = hotkeyBindings();
  const action = HOTKEY_ACTIONS.find(a => bindings[a.id] === combo);
  if (!action) return;
  e.preventDefault();
  e.stopPropagation();
  action.run();
}, true);

// The back/forward buttons also raise auxclick, which is what actually drives
// history navigation — swallow it for bound buttons so the view doesn't move.
document.addEventListener('auxclick', e => {
  const combo = comboFromMouse(e);
  if (!combo) return;
  const bindings = hotkeyBindings();
  if (hotkeyCapture || HOTKEY_ACTIONS.some(a => bindings[a.id] === combo)) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

// ── Sort ──
const SORT_I18N = {
  'date-desc': 'sort.dateDesc',
  'date-asc': 'sort.dateAsc',
  'title-asc': 'sort.titleAsc',
  'title-desc': 'sort.titleDesc',
  'artist-asc': 'sort.artistAsc',
  'artist-desc': 'sort.artistDesc',
  'duration-asc': 'sort.durationAsc',
  'duration-desc': 'sort.durationDesc',
};
function refreshSortUI() {
  const labelEl = $('sort-label');
  if (labelEl) {
    const key = SORT_I18N[activeSort] || SORT_I18N['date-desc'];
    labelEl.setAttribute('data-i18n', key);
    labelEl.textContent = tr(key);
  }
  document.querySelectorAll('#sort-select .sort-opt').forEach(o => {
    o.classList.toggle('active', o.dataset.sort === activeSort);
  });
}
const sortSelect = $('sort-select');
if (sortSelect) {
  sortSelect.querySelector('.sort-btn').addEventListener('click', e => {
    e.stopPropagation();
    sortSelect.classList.toggle('open');
  });
  sortSelect.querySelectorAll('.sort-opt').forEach(o => {
    o.addEventListener('click', () => {
      activeSort = o.dataset.sort;
      sortSelect.classList.remove('open');
      refreshSortUI();
      renderLibrary();
    });
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#sort-select')) sortSelect.classList.remove('open');
  });
  refreshSortUI();
}

// Library inline search
$('library-search').addEventListener('input', () => {
  renderLibrary();
});

// Artists sort chips + search
document.querySelectorAll('#view-artists .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#view-artists .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    artistsSort = chip.dataset.artistsSort;
    renderArtists();
  });
});
$('artists-search').addEventListener('input', () => renderArtists());
$('artist-detail-search').addEventListener('input', () => {
  if (activeArtistName) renderArtistDetail(activeArtistName);
});
document.querySelectorAll('#view-artist-detail .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#view-artist-detail .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    artistAlbumsSort = chip.dataset.artistAlbumsSort;
    if (activeArtistName) renderArtistDetail(activeArtistName);
  });
});
document.querySelectorAll('#artist-view-seg .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#artist-view-seg .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    artistView = btn.dataset.artistView;
    if (activeArtistName) renderArtistDetail(activeArtistName);
  });
});

// Albums sort chips + search
document.querySelectorAll('#view-albums .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#view-albums .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    albumsSort = settings.albumsSort = chip.dataset.albumsSort;
    saveSettings();
    renderAlbums();
  });
});
$('albums-search').addEventListener('input', () => renderAlbums());
document.querySelectorAll('#albums-view-seg .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#albums-view-seg .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    albumsViewMode = btn.dataset.albumsView;
    renderAlbums();
  });
});

// ── Settings UI ──
const TOGGLE_KEY_MAP = {
  'random-theme': 'randomTheme',
  'scan-subdirs': 'scanSubdirs',
  'artist-min-tracks': 'artistMinTracksEnabled',
  'health-check': 'healthCheck',
  'reports': 'reports',
  'editor': 'editor',
  'crossfade': 'crossfade',
  'repeat-one-reset': 'repeatOneResetOnSkip',
  'downloads': 'downloads',
  'yt-music': 'ytMusic',
  'lan-sharing': 'lanSharing',
  'show-parser-browser': 'showParserBrowser',
};

// ── Background settings UI ──
// Rows that only make sense for a real image are hidden for 'none'; the file
// picker row is additionally hidden in 'cover' mode, where the artwork is the
// source and there is no file to choose.
function renderBackgroundSettings() {
  const src = ['none', 'image', 'cover'].includes(settings.bgSource) ? settings.bgSource : 'none';
  document.querySelectorAll('#bg-source-seg .seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.bgSource === src);
  });
  document.querySelectorAll('#bg-fit-seg .seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.bgFit === (settings.bgFit || 'cover'));
  });
  const nameEl = $('bg-file-name');
  if (nameEl) nameEl.textContent = settings.bgImageName || (settings.bgImage ? '—' : tr('bg.noFile'));

  const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
  show('bg-file-row', src === 'image');
  show('bg-fit-row', src !== 'none');
  show('bg-blur-row', src !== 'none');
  show('bg-dim-row', src !== 'none');
  show('bg-alpha-row', src !== 'none');

  const set = (id, valId, value, suffix) => {
    const el = $(id); const out = $(valId);
    if (el) el.value = String(value);
    if (out) out.textContent = `${value} ${suffix}`;
  };
  set('bg-blur', 'bg-blur-val', Math.round(Number(settings.bgBlur) || 0), 'px');
  set('bg-dim', 'bg-dim-val', Math.round(Number(settings.bgDim) || 0), '%');
  set('surface-alpha', 'surface-alpha-val', Math.round(Number(settings.surfaceAlpha) || 100), '%');
}

function wireBackgroundSettings() {
  document.querySelectorAll('#bg-source-seg .seg-btn').forEach(b => {
    b.addEventListener('click', async () => {
      settings.bgSource = b.dataset.bgSource;
      // Choosing "image" with nothing picked yet goes straight to the dialog.
      if (settings.bgSource === 'image' && !settings.bgImage) {
        saveSettings();
        renderBackgroundSettings();
        await pickBackgroundImage();
        return;
      }
      saveSettings();
      applyAppearance();
      renderBackgroundSettings();
    });
  });
  document.querySelectorAll('#bg-fit-seg .seg-btn').forEach(b => {
    b.addEventListener('click', () => {
      settings.bgFit = b.dataset.bgFit;
      saveSettings();
      applyAppearance();
      renderBackgroundSettings();
    });
  });
  const slider = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      settings[key] = Number(el.value);
      applyAppearance();
      renderBackgroundSettings();
    });
    // Persist on release rather than on every frame of the drag.
    el.addEventListener('change', () => saveSettings());
  };
  slider('bg-blur', 'bgBlur');
  slider('bg-dim', 'bgDim');
  slider('surface-alpha', 'surfaceAlpha');

  const pick = $('bg-pick-btn');
  if (pick) pick.addEventListener('click', () => pickBackgroundImage());
  const clear = $('bg-clear-btn');
  if (clear) clear.addEventListener('click', async () => {
    settings.bgImage = '';
    settings.bgImageName = '';
    if (settings.bgSource === 'image') settings.bgSource = 'none';
    saveSettings();
    applyAppearance();
    renderBackgroundSettings();
    try { await window.electronAPI.clearBackground(); } catch (_) {}
  });
}

async function pickBackgroundImage() {
  if (!window.electronAPI || !window.electronAPI.pickBackground) return;
  try {
    const res = await window.electronAPI.pickBackground();
    if (!res || !res.success) {
      // Cancelling with no image yet would leave "image" selected but blank.
      if (res && res.canceled && !settings.bgImage && settings.bgSource === 'image') {
        settings.bgSource = 'none';
        saveSettings();
      }
      renderBackgroundSettings();
      applyAppearance();
      return;
    }
    settings.bgImage = res.url;
    settings.bgImageName = res.name || '';
    settings.bgSource = 'image';
    saveSettings();
    applyAppearance();
    renderBackgroundSettings();
  } catch (_) { /* dialog unavailable */ }
}
wireBackgroundSettings();

function renderAccentPalette() {
  const host = $('accent-palette');
  if (!host) return;
  const current = (settings.accent || '').toLowerCase();
  const presetValues = new Set(ACCENT_PRESETS.map(p => p.value.toLowerCase()));
  const isCustom = !!current && !presetValues.has(current);
  const parts = ACCENT_PRESETS.map(p => {
    const isActive = p.value.toLowerCase() === current;
    const cls = ['accent-swatch'];
    if (isActive) cls.push('active');
    if (p.value === '') cls.push('is-default');
    const style = p.value ? `background:${escapeHtml(p.value)};` : '';
    const title = p.value === ''
      ? tr('setting.accentDefault')
      : escapeHtml(p.value);
    return `<button type="button" class="${cls.join(' ')}" data-accent="${escapeHtml(p.value)}" style="${style}" title="${title}" aria-label="${title}"></button>`;
  });
  const customColor = isCustom ? current : '#5b9eff';
  const customCls = ['accent-swatch', 'is-custom'];
  if (isCustom) customCls.push('active');
  parts.push(
    `<span class="${customCls.join(' ')}" title="${escapeHtml(tr('setting.accentCustom'))}" aria-label="${escapeHtml(tr('setting.accentCustom'))}">` +
      `<input type="color" class="accent-custom-input" id="accent-custom-input" value="${escapeHtml(customColor)}">` +
    `</span>`
  );
  host.innerHTML = parts.join('');
  host.querySelectorAll('.accent-swatch[data-accent]').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.accent = btn.dataset.accent || '';
      saveSettings();
      applyAccent(settings.accent);
      renderAccentPalette();
    });
  });
  const customInput = $('accent-custom-input');
  if (customInput) {
    customInput.addEventListener('input', (e) => {
      const v = e.target.value;
      if (isHexColor(v)) {
        settings.accent = v;
        applyAccent(settings.accent);
      }
    });
    customInput.addEventListener('change', (e) => {
      const v = e.target.value;
      if (isHexColor(v)) {
        settings.accent = v;
        saveSettings();
        applyAccent(settings.accent);
        renderAccentPalette();
      }
    });
  }
}

// The length row only means anything while crossfade is on, so it follows the
// toggle the same way the background rows follow their source.
function renderArtistMinTracks() {
  const row = $('artist-min-tracks-row');
  const el = $('artist-min-tracks-n');
  if (row) row.hidden = !settings.artistMinTracksEnabled;
  if (el && el !== document.activeElement) el.value = String(settings.artistMinTracks);
}

function renderCrossfadeLen() {
  const row = $('crossfade-len-row');
  const el = $('crossfade-len');
  const out = $('crossfade-len-val');
  if (row) row.hidden = !settings.crossfade;
  const sec = crossfadeMs() / 1000;
  if (el) el.value = String(sec);
  if (out) out.textContent = `${sec} ${tr('unit.sec')}`;
}

function renderVolWheelStep() {
  const el = $('vol-wheel-step');
  const out = $('vol-wheel-step-val');
  const step = Number(settings.volumeWheelStep) || 0.05;
  if (el && el !== document.activeElement) el.value = String(step);
  if (out) out.textContent = `${Math.round(step * 100)}%`;
}

// ── Equalizer ──
// A Web Audio biquad chain spliced onto the main <audio>. Built lazily the first
// time the EQ is switched on: createMediaElementSource is one-shot per element
// and permanently routes playback through Web Audio, so we defer it until the
// user opts in. When off, an existing graph is flattened to 0 dB (transparent),
// not torn down.
let eqCtx = null, eqSource = null, eqFilters = [];

function clampEqGain(v) { return Math.max(-EQ_GAIN_MAX, Math.min(EQ_GAIN_MAX, Number(v) || 0)); }
function eqPresetLabel(id) { return EQ_PRESET_LABELS[id] || id; }
function eqFreqLabel(f) { return f >= 1000 ? (f / 1000) + 'k' : String(f); }

function ensureEqGraph() {
  if (eqCtx) return true;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return false;
  try {
    eqCtx = new Ctx();
    eqSource = eqCtx.createMediaElementSource(audio);
    let node = eqSource;
    eqFilters = EQ_BANDS.map((freq, i) => {
      const f = eqCtx.createBiquadFilter();
      f.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
      f.frequency.value = freq;
      f.Q.value = 1;
      f.gain.value = 0;
      node.connect(f);
      node = f;
      return f;
    });
    node.connect(eqCtx.destination);
    return true;
  } catch (e) {
    console.warn('EQ init failed:', e);
    eqCtx = null; eqSource = null; eqFilters = [];
    return false;
  }
}

// Push settings.eq onto the graph. Ramps gains to avoid zipper clicks on drag.
function applyEq() {
  const on = !!settings.eq.enabled;
  if (on && !ensureEqGraph()) return;   // no Web Audio support
  if (!eqCtx) return;                    // never enabled, no graph — leave audio untouched
  if (eqCtx.state === 'suspended') eqCtx.resume().catch(() => {});
  eqFilters.forEach((f, i) => {
    const g = on ? clampEqGain(settings.eq.gains[i]) : 0;
    try { f.gain.setTargetAtTime(g, eqCtx.currentTime, 0.02); } catch (_) { f.gain.value = g; }
  });
}

function matchEqPreset(gains) {
  for (const [id, g] of Object.entries(EQ_PRESETS)) {
    if (g.every((v, i) => v === gains[i])) return id;
  }
  return 'custom';
}

function setEqPreset(id) {
  const g = EQ_PRESETS[id];
  if (!g) return;
  settings.eq.gains = g.slice();
  settings.eq.preset = id;
  if (!settings.eq.enabled) settings.eq.enabled = true;   // picking a preset turns EQ on
  saveSettings();
  applyEq();
  renderEqualizer();
}

// Catmull-Rom spline → cubic bezier, for a smooth EQ response curve.
function eqCurvePath(pts) {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}
function drawEqCurve() {
  const path = $('eq-curve-path');
  if (!path) return;
  const n = EQ_BANDS.length;
  const pts = EQ_BANDS.map((f, i) => [
    (i / (n - 1)) * 100,
    50 - (clampEqGain(settings.eq.gains[i]) / EQ_GAIN_MAX) * 44,
  ]);
  path.setAttribute('d', eqCurvePath(pts));
}

let eqUiBuilt = false;
function buildEqUi() {
  if (eqUiBuilt) return;
  const bands = $('eq-bands'), menu = $('eq-preset-menu');
  if (!bands || !menu) return;
  menu.innerHTML = Object.keys(EQ_PRESETS).map(id =>
    `<div class="select-opt" data-eq-preset="${id}">${escapeHtml(eqPresetLabel(id))}</div>`).join('');
  menu.querySelectorAll('.select-opt').forEach(o => o.addEventListener('click', () => {
    setEqPreset(o.dataset.eqPreset);
    $('eq-preset-select').classList.remove('open');
  }));
  bands.innerHTML = EQ_BANDS.map((f, i) => `
    <div class="eq-band">
      <output class="eq-band-db" id="eq-db-${i}">0</output>
      <input type="range" class="eq-slider" id="eq-slider-${i}" data-band="${i}"
             min="${-EQ_GAIN_MAX}" max="${EQ_GAIN_MAX}" step="1" value="0" orient="vertical">
      <span class="eq-band-hz">${eqFreqLabel(f)}</span>
    </div>`).join('');
  bands.querySelectorAll('.eq-slider').forEach(el => {
    el.addEventListener('input', () => {
      const i = Number(el.dataset.band);
      settings.eq.gains[i] = clampEqGain(Number(el.value));
      settings.eq.preset = matchEqPreset(settings.eq.gains);
      applyEq();
      renderEqualizer();
    });
    el.addEventListener('change', () => saveSettings());
  });
  const tg = $('eq-toggle');
  if (tg) tg.addEventListener('click', () => {
    settings.eq.enabled = !settings.eq.enabled;
    saveSettings();
    applyEq();
    renderEqualizer();
  });
  const sel = $('eq-preset-select');
  if (sel) sel.querySelector('.select-btn').addEventListener('click', e => {
    e.stopPropagation();
    sel.classList.toggle('open');
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#eq-preset-select')) { const s = $('eq-preset-select'); if (s) s.classList.remove('open'); }
  });
  eqUiBuilt = true;
}

function renderEqualizer() {
  buildEqUi();
  const tg = $('eq-toggle');
  if (tg) tg.classList.toggle('on', !!settings.eq.enabled);
  const panel = $('eq-panel');
  if (panel) panel.classList.toggle('eq-disabled', !settings.eq.enabled);
  const cur = $('eq-preset-current');
  if (cur) cur.textContent = eqPresetLabel(settings.eq.preset);
  document.querySelectorAll('#eq-preset-menu .select-opt').forEach(o =>
    o.classList.toggle('active', o.dataset.eqPreset === settings.eq.preset));
  EQ_BANDS.forEach((f, i) => {
    const el = $('eq-slider-' + i), db = $('eq-db-' + i);
    const g = clampEqGain(settings.eq.gains[i]);
    if (el && el !== document.activeElement) el.value = String(g);
    if (db) db.textContent = (g > 0 ? '+' : '') + g;
  });
  drawEqCurve();
}

function renderSettings() {
  // Theme combobox
  const themeCurrent = $('theme-current');
  if (themeCurrent) themeCurrent.textContent = themeLabel(settings.theme);
  document.querySelectorAll('#theme-select .select-opt').forEach(o => {
    o.classList.toggle('active', o.dataset.theme === settings.theme);
  });
  renderAccentPalette();
  // Toggles
  document.querySelectorAll('.toggle').forEach(t => {
    const key = TOGGLE_KEY_MAP[t.dataset.setting];
    if (!key) return; // toggles with their own handler (e.g. hardware acceleration)
    if (settings[key]) t.classList.add('on'); else t.classList.remove('on');
  });
  refreshHwAccelToggle();
  renderArtistMinTracks();
  renderCrossfadeLen();
  renderEqualizer();
  // Folder
  $('default-folder-path').textContent = settings.defaultFolder || tr('placeholder.noFolder');
  // Default startup page
  const dvCurrent = $('defaultview-current');
  if (dvCurrent) dvCurrent.textContent = tr(DEFAULT_VIEW_LABELS[settings.defaultView] || DEFAULT_VIEW_LABELS.library);
  document.querySelectorAll('#defaultview-select .select-opt').forEach(o => {
    o.classList.toggle('active', o.dataset.defaultview === settings.defaultView);
  });
  const dvPlRow = $('defaultview-playlist-row');
  if (dvPlRow) dvPlRow.hidden = settings.defaultView !== 'playlist-detail';
  renderDefaultPlaylistSelect();
  refreshYtLoginStatus();
  // Download format combobox
  const fmtCurrent = $('dlfmt-current');
  if (fmtCurrent) fmtCurrent.textContent = DL_FORMAT_LABELS[settings.dlFormat] || DL_FORMAT_LABELS.opus;
  document.querySelectorAll('#dlfmt-select .select-opt').forEach(o => {
    o.classList.toggle('active', o.dataset.dlfmt === settings.dlFormat);
  });
  // Language — labels stay in their native language regardless of currentLang.
  const lblMap = { en: 'English', uk: 'Українська' };
  $('lang-current').textContent = lblMap[settings.language] || lblMap.en;
  document.querySelectorAll('#lang-select .select-opt').forEach(o => {
    o.classList.toggle('active', o.dataset.lang === settings.language);
  });
  // UI scale stepper
  const scaleEl = $('scale-current');
  if (scaleEl) scaleEl.textContent = Math.round(settings.uiScale * 100) + '%';
  const dec = $('scale-dec');
  const inc = $('scale-inc');
  if (dec) dec.disabled = settings.uiScale <= UI_SCALE_STEPS[0] + 1e-6;
  if (inc) inc.disabled = settings.uiScale >= UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1] - 1e-6;
  // Discord lives in its own tab now — always expanded, no collapse.
  applySettingsTab(settings.settingsTab);
  renderVolWheelStep();
  renderBackgroundSettings();
  renderHotkeys();
  renderDiscord();
  renderLastfm();
}

// ── Hotkeys settings UI ──
// Assigns `combo` to `id`. A combo can only belong to one action, so any other
// action holding it is cleared first — silently stealing it would leave two
// rows claiming the same keys while only one ever fires.
function hotkeySet(id, combo) {
  const bindings = hotkeyBindings();
  if (combo) {
    for (const a of HOTKEY_ACTIONS) {
      if (a.id !== id && bindings[a.id] === combo) bindings[a.id] = '';
    }
  }
  bindings[id] = combo;
  // Persist only what differs from the defaults, so future default changes
  // reach users who never customised that action.
  const overrides = {};
  for (const a of HOTKEY_ACTIONS) {
    if (bindings[a.id] !== HOTKEY_DEFAULTS[a.id]) overrides[a.id] = bindings[a.id];
  }
  settings.hotkeys = overrides;
  // A combo that can no longer be a global grab (cleared, or rebound to a mouse
  // button / bare key) must not stay flagged as one.
  if (settings.hotkeysGlobal && settings.hotkeysGlobal[id] && globalBlockReason(bindings[id])) {
    delete settings.hotkeysGlobal[id];
  }
  saveSettings();
  hotkeyCapture = null;
  renderHotkeys();
  syncGlobalHotkeys();
}

// Turn the system-wide grab for one action on or off.
function hotkeyToggleGlobal(id) {
  const bindings = hotkeyBindings();
  if (globalBlockReason(bindings[id])) return; // guarded in the UI too
  const globals = Object.assign({}, hotkeyGlobals());
  if (globals[id]) delete globals[id];
  else globals[id] = true;
  settings.hotkeysGlobal = globals;
  saveSettings();
  renderHotkeys();
  syncGlobalHotkeys();
}

function renderHotkeys() {
  const host = $('hotkeys-list');
  if (!host) return;
  const bindings = hotkeyBindings();
  host.innerHTML = HOTKEY_ACTIONS.map(a => {
    const capturing = hotkeyCapture === a.id;
    const combo = bindings[a.id];
    const isCustom = combo !== HOTKEY_DEFAULTS[a.id];
    const block = globalBlockReason(combo);
    const on = isGlobalOn(a.id) && !block;
    const failed = on && globalHotkeysSupported && globalHotkeyFailures.has(a.id);
    const gTitle = !globalHotkeysSupported ? tr('hotkeys.globalUnavailable')
      : failed ? tr('hotkeys.globalFailed')
      : block === 'mouse' ? tr('hotkeys.globalNoMouse')
      : block === 'needsModifier' ? tr('hotkeys.globalNeedsMod')
      : block ? tr('hotkeys.globalUnsupported')
      : tr('hotkeys.global');
    return `
      <div class="setting-row hotkey-row">
        <div class="setting-text">
          <div class="setting-label">${escapeHtml(tr('hotkey.' + a.id))}</div>
          ${failed ? `<div class="setting-desc hotkey-warn">${escapeHtml(tr('hotkeys.globalFailed'))}</div>` : ''}
          ${on && !globalHotkeysSupported ? `<div class="setting-desc hotkey-warn">${escapeHtml(tr('hotkeys.globalUnavailable'))}</div>` : ''}
        </div>
        <div class="hotkey-controls">
          <button class="hotkey-global${on ? ' is-on' : ''}${failed ? ' is-failed' : ''}"
                  data-hk-global="${a.id}" ${block ? 'disabled' : ''} title="${escapeHtml(gTitle)}">
            <svg class="i" width="13" height="13"><use href="#i-monitor"/></svg>
          </button>
          ${isCustom ? `<button class="hotkey-revert" data-hk-revert="${a.id}" title="${escapeHtml(tr('hotkeys.revert'))}">↺</button>` : ''}
          <button class="hotkey-combo${capturing ? ' is-capturing' : ''}${combo ? '' : ' is-empty'}" data-hk="${a.id}">
            ${escapeHtml(capturing ? tr('hotkeys.press') : comboLabel(combo))}
          </button>
        </div>
      </div>`;
  }).join('');
  host.querySelectorAll('[data-hk-global]').forEach(btn => {
    btn.addEventListener('click', () => hotkeyToggleGlobal(btn.dataset.hkGlobal));
  });
  host.querySelectorAll('[data-hk]').forEach(btn => {
    btn.addEventListener('click', () => {
      hotkeyCapture = hotkeyCapture === btn.dataset.hk ? null : btn.dataset.hk;
      renderHotkeys();
    });
  });
  host.querySelectorAll('[data-hk-revert]').forEach(btn => {
    btn.addEventListener('click', () => hotkeySet(btn.dataset.hkRevert, HOTKEY_DEFAULTS[btn.dataset.hkRevert]));
  });
}

const hotkeysResetBtn = $('hotkeys-reset');
if (hotkeysResetBtn) {
  hotkeysResetBtn.addEventListener('click', () => {
    settings.hotkeys = {};
    settings.hotkeysGlobal = {};
    saveSettings();
    hotkeyCapture = null;
    renderHotkeys();
    syncGlobalHotkeys();
  });
}
// Leaving the tab (or closing Settings) must not strand a live capture.
function cancelHotkeyCapture() {
  if (!hotkeyCapture) return;
  hotkeyCapture = null;
  renderHotkeys();
}

// ── Settings modal ──
// Settings is a modal dialog, not a view — it overlays whatever view is open,
// so `currentView` never becomes 'settings'. Code that needs to know whether
// the Settings UI is on screen (the live Discord preview) uses isSettingsOpen().
function isSettingsOpen() {
  const m = $('settings-modal');
  return !!m && m.classList.contains('active');
}
function openSettings() {
  const m = $('settings-modal');
  if (!m) return;
  m.classList.add('active');
  renderSettings();
}
function closeSettings() {
  const m = $('settings-modal');
  if (m) m.classList.remove('active');
  cancelHotkeyCapture();
}
const settingsCloseBtn = $('btn-close-settings');
if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', closeSettings);
const settingsModal = $('settings-modal');
if (settingsModal) {
  // Click on the scrim (not the card) closes.
  settingsModal.addEventListener('click', e => {
    if (e.target === settingsModal) closeSettings();
  });
}

// ── Settings tabs ──
// Show one settings panel at a time; the active tab persists in settings.
function applySettingsTab(tab) {
  const tabs = document.querySelectorAll('#settings-tabs .settings-tab');
  const panels = document.querySelectorAll('#settings-modal .settings-panel');
  const valid = Array.from(tabs).some(t => t.dataset.tab === tab);
  if (!valid) tab = 'appearance';
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  panels.forEach(p => { p.hidden = p.dataset.panel !== tab; });
  if (tab !== 'hotkeys') cancelHotkeyCapture();
}
document.querySelectorAll('#settings-tabs .settings-tab').forEach(t => {
  t.addEventListener('click', () => {
    settings.settingsTab = t.dataset.tab;
    saveSettings();
    applySettingsTab(settings.settingsTab);
  });
});

const themeSelect = $('theme-select');
themeSelect.querySelector('.select-btn').addEventListener('click', e => {
  e.stopPropagation();
  themeSelect.classList.toggle('open');
});
document.addEventListener('click', e => {
  if (!e.target.closest('#theme-select')) themeSelect.classList.remove('open');
});
document.querySelectorAll('#theme-select .select-opt').forEach(o => {
  o.addEventListener('click', () => {
    settings.theme = o.dataset.theme;
    saveSettings();
    themeSelect.classList.remove('open');
    applyTheme(settings.theme);
    renderSettings();
  });
});
document.querySelectorAll('.toggle').forEach(t => {
  const key = TOGGLE_KEY_MAP[t.dataset.setting];
  if (!key) return; // toggles with their own handler (e.g. hardware acceleration)
  t.addEventListener('click', () => {
    if (t.classList.contains('is-disabled')) return;
    settings[key] = !settings[key];
    saveSettings();
    t.classList.toggle('on', settings[key]);
    if (key === 'downloads') applyDownloadsVisibility();
    if (key === 'ytMusic') applyYtMusicVisibility();
    if (key === 'healthCheck') applyHealthCheckVisibility();
    if (key === 'reports') applyReportsVisibility();
    if (key === 'editor') applyEditorVisibility();
    if (key === 'crossfade') renderCrossfadeLen();
    if (key === 'randomTheme') applyTheme(settings.randomTheme ? randomThemeId() : settings.theme);
    if (key === 'lanSharing') applyLanSharingVisibility();
    if (key === 'artistMinTracksEnabled') {
      renderArtistMinTracks();
      if (currentView === 'artists') renderArtists();
    }
  });
});

(() => {
  const el = $('artist-min-tracks-n');
  if (!el) return;
  const commit = () => {
    const n = Math.max(1, Math.min(99, Math.round(Number(el.value)) || 1));
    settings.artistMinTracks = n;
    el.value = String(n);
    saveSettings();
    if (currentView === 'artists') renderArtists();
  };
  el.addEventListener('change', commit);
})();

(() => {
  const el = $('crossfade-len');
  if (!el) return;
  el.addEventListener('input', () => {
    settings.crossfadeSec = Number(el.value);
    renderCrossfadeLen();
  });
  // Persist on release rather than on every frame of the drag.
  el.addEventListener('change', () => saveSettings());
})();

(() => {
  const el = $('vol-wheel-step');
  if (!el) return;
  el.addEventListener('input', () => {
    settings.volumeWheelStep = Number(el.value);
    renderVolWheelStep();
  });
  el.addEventListener('change', () => saveSettings());
})();

// ── Hardware acceleration toggle ──
// State lives in the main process (a marker file read before app.ready), not in
// localStorage. We query it for display and ask main to persist + restart.
async function refreshHwAccelToggle() {
  const t = $('toggle-hwaccel');
  if (!t || !window.electronAPI || typeof window.electronAPI.getHardwareAcceleration !== 'function') return;
  try {
    const res = await window.electronAPI.getHardwareAcceleration();
    t.classList.toggle('on', !!(res && res.enabled));
  } catch (_) { /* leave as-is */ }
}
const hwAccelToggle = $('toggle-hwaccel');
if (hwAccelToggle) {
  hwAccelToggle.addEventListener('click', async () => {
    if (hwAccelToggle.classList.contains('is-disabled')) return;
    const enabled = !hwAccelToggle.classList.contains('on');
    hwAccelToggle.classList.toggle('on', enabled);
    try {
      await window.electronAPI.setHardwareAcceleration(enabled);
    } catch (_) { /* if it failed, re-sync from the source of truth */ }
    // If the user declined the restart, the visible state still reflects the
    // pending choice; re-sync to the actual effective state on next render.
  });
}
$('btn-choose-default-folder').addEventListener('click', async () => {
  const folder = await window.electronAPI.chooseFolder();
  if (folder) {
    settings.defaultFolder = folder;
    saveSettings();
    renderSettings();
  }
});

// Reflects the YT Premium probe (a network call) in both the settings row and
// the Downloads-page badge. State: 'none' | 'checking' | 'premium' | 'standard'
// | 'unknown'.
function setYtPremiumUI(state) {
  const settingsEl = $('yt-premium-status');
  const dlEl = $('dl-yt-account');
  const label = {
    checking: tr('setting.ytPremium.checking'),
    premium: tr('setting.ytPremium.active'),
    standard: tr('setting.ytPremium.none'),
    unknown: tr('setting.ytPremium.unknown'),
  }[state] || '';
  if (settingsEl) {
    settingsEl.hidden = state === 'none' || !label;
    settingsEl.textContent = label;
  }
  if (dlEl) {
    dlEl.hidden = state === 'none' || state === 'checking' || !label;
    dlEl.textContent = label;
    dlEl.classList.toggle('is-premium', state === 'premium');
  }
}

function refreshYtLoginStatus() {
  const el = $('yt-login-status');
  const logoutBtn = $('btn-yt-logout');
  const api = window.electronAPI;
  if (!api || typeof api.youtubeCookiesStatus !== 'function') return;
  api.youtubeCookiesStatus()
    .then(res => {
      const signedIn = !!(res && res.signedIn);
      if (el) el.textContent = tr(signedIn ? 'setting.ytLogin.signedIn' : 'setting.ytLogin.notSignedIn');
      if (logoutBtn) logoutBtn.hidden = !signedIn;
      if (!signedIn) { setYtPremiumUI('none'); return; }
      setYtPremiumUI('checking');
      if (typeof api.youtubePremiumStatus !== 'function') { setYtPremiumUI('unknown'); return; }
      api.youtubePremiumStatus()
        .then(p => setYtPremiumUI(p && p.premium ? 'premium' : (p && p.unknown ? 'unknown' : 'standard')))
        .catch(() => setYtPremiumUI('unknown'));
    })
    .catch(() => {});
}
refreshYtLoginStatus();

const ytLoginBtn = $('btn-yt-login');
if (ytLoginBtn && window.electronAPI && typeof window.electronAPI.youtubeLogin === 'function') {
  ytLoginBtn.addEventListener('click', async () => {
    const label = ytLoginBtn.querySelector('span');
    ytLoginBtn.disabled = true;
    if (label) label.textContent = tr('btn.signingIn');
    $('yt-login-status').textContent = tr('setting.ytLogin.waiting');
    try { await window.electronAPI.youtubeLogin(); } catch (_) {}
    ytLoginBtn.disabled = false;
    if (label) label.textContent = tr('btn.signIn');
    refreshYtLoginStatus();
  });
}

const ytLogoutBtn = $('btn-yt-logout');
if (ytLogoutBtn && window.electronAPI && typeof window.electronAPI.youtubeLogout === 'function') {
  ytLogoutBtn.addEventListener('click', async () => {
    ytLogoutBtn.disabled = true;
    try { await window.electronAPI.youtubeLogout(); } catch (_) {}
    ytLogoutBtn.disabled = false;
    refreshYtLoginStatus();
  });
}

document.querySelectorAll('[data-open-url]').forEach(btn => {
  btn.addEventListener('click', () => {
    const url = btn.dataset.openUrl;
    if (url) window.electronAPI.openExternal(url);
  });
});

function setUiScale(scale) {
  settings.uiScale = clampUiScale(scale);
  saveSettings();
  applyUiScale(settings.uiScale);
  renderSettings();
}
function nudgeUiScale(direction) {
  // Snap to the nearest predefined step in the chosen direction so the stepper
  // matches the labels users see in the dropdown.
  const cur = settings.uiScale;
  if (direction > 0) {
    const next = UI_SCALE_STEPS.find(s => s > cur + 1e-6);
    if (next != null) setUiScale(next);
  } else {
    const prev = [...UI_SCALE_STEPS].reverse().find(s => s < cur - 1e-6);
    if (prev != null) setUiScale(prev);
  }
}
const scaleDec = $('scale-dec');
const scaleInc = $('scale-inc');
const scaleReset = $('scale-reset');
if (scaleDec) scaleDec.addEventListener('click', () => nudgeUiScale(-1));
if (scaleInc) scaleInc.addEventListener('click', () => nudgeUiScale(1));
if (scaleReset) scaleReset.addEventListener('click', () => setUiScale(1));
const dlfmtSelect = $('dlfmt-select');
if (dlfmtSelect) {
  dlfmtSelect.querySelector('.select-btn').addEventListener('click', e => {
    e.stopPropagation();
    dlfmtSelect.classList.toggle('open');
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#dlfmt-select')) dlfmtSelect.classList.remove('open');
  });
  dlfmtSelect.querySelectorAll('.select-opt').forEach(o => {
    o.addEventListener('click', () => {
      settings.dlFormat = o.dataset.dlfmt;
      saveSettings();
      dlfmtSelect.classList.remove('open');
      renderSettings();
    });
  });
}

const defaultViewSelect = $('defaultview-select');
if (defaultViewSelect) {
  defaultViewSelect.querySelector('.select-btn').addEventListener('click', e => {
    e.stopPropagation();
    defaultViewSelect.classList.toggle('open');
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#defaultview-select')) defaultViewSelect.classList.remove('open');
  });
  defaultViewSelect.querySelectorAll('.select-opt').forEach(o => {
    o.addEventListener('click', () => {
      settings.defaultView = o.dataset.defaultview;
      saveSettings();
      defaultViewSelect.classList.remove('open');
      renderSettings();
    });
  });
}

const defaultPlaylistSelect = $('defaultplaylist-select');
if (defaultPlaylistSelect) {
  defaultPlaylistSelect.querySelector('.select-btn').addEventListener('click', e => {
    e.stopPropagation();
    defaultPlaylistSelect.classList.toggle('open');
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#defaultplaylist-select')) defaultPlaylistSelect.classList.remove('open');
  });
}
// Options are rebuilt from `playlists` on every call — the list changes
// whenever a playlist is added/renamed/deleted, unlike the static dlfmt/theme menus.
function renderDefaultPlaylistSelect() {
  const menu = $('defaultplaylist-menu');
  const current = $('defaultplaylist-current');
  if (!menu || !current) return;
  if (!playlists.length) {
    menu.innerHTML = '';
    current.textContent = tr('placeholder.noPlaylists');
    return;
  }
  const active = playlists.find(p => p.id === settings.defaultPlaylistId);
  current.textContent = active ? active.name : tr('placeholder.choosePlaylist');
  menu.innerHTML = playlists.map(p =>
    `<div class="select-opt${p.id === settings.defaultPlaylistId ? ' active' : ''}" data-plid="${escapeHtml(p.id)}">${escapeHtml(p.name)}</div>`
  ).join('');
  menu.querySelectorAll('.select-opt').forEach(o => {
    o.addEventListener('click', () => {
      settings.defaultPlaylistId = o.dataset.plid;
      saveSettings();
      defaultPlaylistSelect.classList.remove('open');
      renderDefaultPlaylistSelect();
    });
  });
}

const langSelect = $('lang-select');
langSelect.querySelector('.select-btn').addEventListener('click', e => {
  e.stopPropagation();
  langSelect.classList.toggle('open');
});
document.addEventListener('click', e => {
  if (!e.target.closest('#lang-select')) langSelect.classList.remove('open');
});
document.querySelectorAll('#lang-select .select-opt').forEach(o => {
  o.addEventListener('click', () => {
    settings.language = o.dataset.lang;
    saveSettings();
    langSelect.classList.remove('open');
    applyLanguage(settings.language);
    // Re-render dynamic surfaces so plurals, counts, and rendered strings update.
    refreshCurrentViewRows();
    if (currentView === 'playlists') renderPlaylists();
    renderCounts();
    renderRecents();
    if (currentTrack) updateNowPlayingUI(currentTrack);
    else $('track-title').textContent = tr('np.empty.title');
    updateFullscreenQueue();
    if ($('palette-overlay').classList.contains('active')) {
      renderPaletteResults($('palette-input').value);
    }
    renderSettings();
  });
});

function applyDownloadsVisibility() {
  $('nav-downloads').hidden = !settings.downloads;
  if (!settings.downloads && currentView === 'downloads') setView('library');
}
applyDownloadsVisibility();


// Report, Health and Editor share a "Tools" sidebar group (index.html
// #nav-tools-group) that's hidden whenever none of them is on, so an empty
// heading doesn't float in the sidebar for users who enable neither.
function updateToolsGroupVisibility() {
  const group = $('nav-tools-group');
  if (!group) return;
  group.hidden = $('nav-report').hidden && $('nav-health').hidden && $('nav-editor').hidden;
}

// Master switch for the Library Health-check feature: hides the Health nav item,
// the Quality column across every track table, the quality note, and any active
// health filter. Driven by a `quality-off` class on <html> so the CSS collapses
// the grid; JS just keeps the nav + current view consistent.
function applyHealthCheckVisibility(reflow = true) {
  const on = !!settings.healthCheck;
  document.documentElement.classList.toggle('quality-off', !on);
  const navHealth = $('nav-health');
  if (navHealth) navHealth.hidden = !on;
  updateToolsGroupVisibility();
  if (!on) {
    clearHealthFilter();
    if (reflow) {
      if (currentView === 'health') setView('library');
      else refreshCurrentViewRows();
    }
  }
}
applyHealthCheckVisibility(false); // boot: set class/nav only; renderLibrary() runs later

// Toggle for the Listening Report feature: hides only the Report nav item and
// redirects away from the view when off. Play-history logging keeps running
// regardless (plStartIfNeeded/plTick/savePlayLog are playback-driven), so stats
// accumulate silently and are ready the moment the user re-enables the report.
function applyReportsVisibility() {
  const navReport = $('nav-report');
  if (navReport) navReport.hidden = !settings.reports;
  updateToolsGroupVisibility();
  if (!settings.reports && currentView === 'report') setView('library');
}
applyReportsVisibility();

// Toggle for the track-trimming editor: hides the nav item and the "Trim"
// context-menu entry, and redirects away from the view when off.
function applyEditorVisibility() {
  const navEditor = $('nav-editor');
  if (navEditor) navEditor.hidden = !settings.editor;
  updateToolsGroupVisibility();
  if (!settings.editor) {
    stopEditorPreview();
    if (currentView === 'editor') setView('library');
  }
}
applyEditorVisibility();

// ── Discord Rich Presence ─────────────────────────────────────────────────────
// Renders the Settings → Discord panel and keeps the activity in sync with
// playback. The live preview mirrors what friends see in the Discord profile.
function discordUserName() {
  if (!discordUser) return '';
  return discordUser.global_name || discordUser.username || '';
}

function dcToggleHtml(key, label, desc) {
  const on = !!settings.discord[key];
  const disabled = !discordConnected;
  return `<div class="setting-row${disabled ? ' is-dimmed' : ''}">
    <div class="setting-text">
      <div class="setting-label">${escapeHtml(tr(label))}</div>
      <div class="setting-desc">${escapeHtml(tr(desc))}</div>
    </div>
    <button class="toggle${on ? ' on' : ''}${disabled ? ' is-disabled' : ''}" data-dsetting="${key}"><div class="toggle-knob"></div></button>
  </div>`;
}

function renderDiscordPreview() {
  const t = currentTrack;
  const d = settings.discord;
  const placeholder = !discordConnected;
  const paused = !!t && !isPlaying;
  const eyebrow = placeholder ? tr('discord.previewListening')
    : (paused && d.showPaused ? tr('discord.previewPaused') : tr('discord.previewListening'));
  const cover = t && t.cover ? t.cover : null;
  const coverCss = cover ? `background-image:url('${cover}')` : '';
  let body;
  if (placeholder) {
    body = `<div class="dc-prev-empty">${escapeHtml(tr('discord.previewPlaceholder'))}</div>`;
  } else if (!t) {
    body = `<div class="dc-prev-empty">${escapeHtml(tr('discord.previewEmptyTrack'))}</div>`;
  } else {
    const sub = [t.artist, t.album].filter(Boolean).join(' · ');
    const cur = isFinite(audio.currentTime) ? audio.currentTime : 0;
    const dur = isFinite(audio.duration) ? audio.duration : 0;
    const pct = dur > 0 ? Math.max(0, Math.min(100, (cur / dur) * 100)) : 0;
    const timer = (d.showTimer && isPlaying && dur > 0) ? `
      <div class="dc-prev-bar"><div class="dc-prev-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="dc-prev-times"><span>${formatTime(cur)}</span><span>${formatTime(dur)}</span></div>` : '';
    body = `<div class="dc-prev-activity">
      <div class="dc-prev-art ${d.showCover ? '' : 'dc-prev-art-mono'}" style="${d.showCover ? coverCss : ''}">
        ${d.showCover && !cover ? `<span>${escapeHtml((t.title || '?')[0] || '?')}</span>` : ''}
        <div class="dc-prev-badge"><svg class="i" width="11" height="11"><use href="#i-discord"/></svg></div>
      </div>
      <div class="dc-prev-lines">
        ${d.showTitle ? `<div class="dc-prev-title">${escapeHtml(t.title || '')}</div>` : ''}
        ${d.showArtist && sub ? `<div class="dc-prev-sub">${escapeHtml(sub)}</div>` : ''}
        ${timer}
      </div>
    </div>`;
  }
  const btns = placeholder ? '' : (settings.discord.buttons || [])
    .filter(b => b && b.label && /^https?:\/\//i.test(b.url || ''))
    .slice(0, 2)
    .map(b => `<div class="dc-prev-btn">${escapeHtml(b.label)}</div>`).join('');

  return `<div class="dc-prev-card">
    <div class="dc-prev-user">
      <div class="dc-prev-avatar"></div>
      <div>
        <div class="dc-prev-name">${escapeHtml(discordUserName() || 'Discord')}</div>
        <div class="dc-prev-online">${escapeHtml(tr('discord.previewOnline'))}</div>
      </div>
    </div>
    <div class="dc-prev-divider"></div>
    <div class="dc-prev-eyebrow">${escapeHtml(eyebrow)}</div>
    ${body}
    ${btns ? `<div class="dc-prev-btns">${btns}</div>` : ''}
  </div>`;
}

function renderDiscord() {
  const host = $('discord-body');
  if (!host) return;
  const d = settings.discord;
  const connectLabel = discordConnected ? tr('discord.disconnect') : tr('discord.connect');
  const statusText = discordConnected ? tr('discord.statusConnected') : tr('discord.statusDisconnected');
  const sub = discordConnected
    ? `${escapeHtml(discordUserName())} · ${escapeHtml(tr('discord.sessionActive'))}`
    : escapeHtml(tr('discord.connectHint'));

  const buttonsRows = (d.buttons || []).slice(0, 2).map((b, i) => `
    <div class="setting-row dc-btn-row${discordConnected ? '' : ' is-dimmed'}">
      <div class="dc-btn-field">
        <div class="dc-btn-cap">${escapeHtml(tr('discord.btnLabel'))}</div>
        <input class="dc-input" type="text" data-dbtn="${i}" data-dfield="label" value="${escapeHtml(b.label || '')}" placeholder="${escapeHtml(tr('discord.btnLabelPh'))}" ${discordConnected ? '' : 'disabled'} />
      </div>
      <div class="dc-btn-field dc-btn-field-wide">
        <div class="dc-btn-cap">${escapeHtml(tr('discord.btnUrl'))}</div>
        <input class="dc-input dc-input-mono" type="text" data-dbtn="${i}" data-dfield="url" value="${escapeHtml(b.url || '')}" placeholder="${escapeHtml(tr('discord.btnUrlPh'))}" ${discordConnected ? '' : 'disabled'} />
      </div>
    </div>`).join('');

  host.innerHTML = `
    <div class="setting-card setting-card-tight">
      <div class="dc-conn${discordConnected ? ' is-connected' : ''}">
        <div class="dc-conn-icon"><svg class="i" width="22" height="22"><use href="#i-discord"/></svg></div>
        <div class="dc-conn-main">
          <div class="dc-conn-title">Discord <span class="dc-conn-status">${discordConnected ? '●' : '○'} ${escapeHtml(statusText)}</span></div>
          <div class="dc-conn-sub">${sub}</div>
        </div>
        <button class="btn-ghost dc-conn-btn${discordConnected ? '' : ' dc-conn-btn-primary'}" id="discord-conn-btn">${escapeHtml(connectLabel)}</button>
      </div>
      ${DISCORD_CLIENT_ID ? '' : `<div class="dc-warn">${escapeHtml(tr('discord.noClientId'))}</div>`}
    </div>

    <div class="dc-grid">
      <div class="dc-controls">
        <div class="dc-sublabel">${escapeHtml(tr('discord.show'))}</div>
        <div class="setting-card">
          ${dcToggleHtml('showTitle', 'discord.showTitle', 'discord.showTitleDesc')}
          ${dcToggleHtml('showArtist', 'discord.showArtist', 'discord.showArtistDesc')}
          ${dcToggleHtml('showCover', 'discord.showCover', 'discord.showCoverDesc')}
          ${dcToggleHtml('showTimer', 'discord.showTimer', 'discord.showTimerDesc')}
          ${dcToggleHtml('showPaused', 'discord.showPaused', 'discord.showPausedDesc')}
        </div>

        <div class="dc-sublabel">${escapeHtml(tr('discord.buttons'))}</div>
        <div class="setting-card">${buttonsRows}</div>
        <div class="dc-hint">${escapeHtml(tr('discord.buttonsHint'))}</div>

        <div class="dc-sublabel">${escapeHtml(tr('discord.privacy'))}</div>
        <div class="setting-card">
          ${dcToggleHtml('privacyInvisible', 'discord.privacyInvisible', 'discord.privacyInvisibleDesc')}
          ${dcToggleHtml('privacyPrivate', 'discord.privacyPrivate', 'discord.privacyPrivateDesc')}
        </div>
      </div>

      <div class="dc-preview">
        <div class="dc-sublabel">${escapeHtml(tr('discord.preview'))}</div>
        ${renderDiscordPreview()}
        <div class="dc-prev-note"><svg class="i" width="13" height="13"><use href="#i-info"/></svg><span>${escapeHtml(tr('discord.previewNote'))}</span></div>
      </div>
    </div>`;

  // Wire connect/disconnect
  const connBtn = $('discord-conn-btn');
  if (connBtn) connBtn.addEventListener('click', () => discordConnected ? disconnectDiscord() : connectDiscord());

  // Wire toggles
  host.querySelectorAll('.toggle[data-dsetting]').forEach(t => {
    t.addEventListener('click', () => {
      if (t.classList.contains('is-disabled')) return;
      const key = t.dataset.dsetting;
      settings.discord[key] = !settings.discord[key];
      saveSettings();
      t.classList.toggle('on', settings.discord[key]);
      renderDiscordPreviewOnly();
      pushDiscordActivity(true);
    });
  });

  // Wire button inputs
  host.querySelectorAll('.dc-input[data-dbtn]').forEach(inp => {
    inp.addEventListener('input', () => {
      const i = Number(inp.dataset.dbtn);
      const field = inp.dataset.dfield;
      if (!settings.discord.buttons[i]) settings.discord.buttons[i] = { label: '', url: '' };
      settings.discord.buttons[i][field] = inp.value;
      saveSettings();
      renderDiscordPreviewOnly();
      pushDiscordActivity(false);
    });
  });
}

// Re-paint only the preview card (cheap path on toggle/seek/track change).
function renderDiscordPreviewOnly() {
  const host = $('discord-body');
  if (!host) return;
  const card = host.querySelector('.dc-preview');
  if (!card) return;
  card.innerHTML = `<div class="dc-sublabel">${escapeHtml(tr('discord.preview'))}</div>${renderDiscordPreview()}<div class="dc-prev-note"><svg class="i" width="13" height="13"><use href="#i-info"/></svg><span>${escapeHtml(tr('discord.previewNote'))}</span></div>`;
}

function buildDiscordActivity() {
  const d = settings.discord;
  const t = currentTrack;
  if (!t) return null;
  if (!isPlaying && !d.showPaused) return null;
  // Discord requires details/state to be ≥ 2 chars when present.
  const fit = (s, max) => { s = (s || '').slice(0, max); return s.length >= 2 ? s : null; };
  // type 2 = Listening. Discord only renders the scrubbable progress bar (vs.
  // a plain elapsed/remaining countdown) for Listening/Watching activities —
  // Playing (the IPC default) never gets one, no matter what timestamps say.
  const activity = { instance: false, type: 2 };
  if (d.showTitle) { const v = fit(t.title || 'Unknown', 128); if (v) activity.details = v; }
  if (d.showArtist) { const v = fit([t.artist, t.album].filter(Boolean).join(' · '), 128); if (v) activity.state = v; }
  if (d.showTimer && isPlaying && isFinite(audio.duration) && audio.duration > 0) {
    const startSec = Math.floor((Date.now() - Math.floor(audio.currentTime * 1000)) / 1000);
    activity.timestamps = { start: startSec, end: startSec + Math.round(audio.duration) };
  }
  // Discord's RPC accepts a raw https URL for large_image (only large_image —
  // small_image still needs an uploaded asset key). We resolve a public cover
  // URL per track via the iTunes Search API (see ensureDiscordCover). Until it
  // resolves, or if there's no match, we send no image rather than a broken one.
  if (d.showCover) {
    // Use the resolved iTunes cover; fall back to the Audex logo when there's
    // no match (or briefly, while the lookup is still in flight).
    const cover = discordCoverCache[t.path];
    activity.assets = {
      large_image: cover || AUDEX_LOGO_URL,
      large_text: (t.album || t.title || 'Audex').slice(0, 128),
    };
  }
  const btns = (d.buttons || [])
    .filter(b => b && b.label && /^https?:\/\//i.test(b.url || ''))
    .slice(0, 2)
    .map(b => ({ label: b.label.slice(0, 31), url: b.url }));
  if (btns.length) activity.buttons = btns;
  return activity;
}

// Public album-art URLs resolved from the iTunes Search API, keyed by track
// path. Value is a URL string, or null once looked up with no match. Pending
// lookups are tracked separately so we never fire duplicate requests.
const discordCoverCache = {};
const discordCoverInflight = {};
async function ensureDiscordCover(track) {
  if (!track || !settings.discord.showCover) return;
  if (!window.electronAPI || !window.electronAPI.lookupCover) return;
  const key = track.path;
  if (key in discordCoverCache || discordCoverInflight[key]) return;
  discordCoverInflight[key] = true;
  let url = null;
  try {
    const res = await window.electronAPI.lookupCover({ artist: track.artist, title: track.title, album: track.album });
    url = res && res.url ? res.url : null;
  } catch (_) { url = null; }
  discordCoverCache[key] = url;
  delete discordCoverInflight[key];
  // If this track is still the current one, re-push with the artwork attached.
  if (url && currentTrack && currentTrack.path === key) {
    pushDiscordActivity(true);
  }
}

let discordPreviewSec = -1;
let discordPushTimer = null;
let discordLastPush = 0;
const DISCORD_PUSH_MIN_MS = 2000; // Discord rate-limits SET_ACTIVITY (~5 / 20s)
function pushDiscordActivity(immediate) {
  if (!discordConnected || !window.electronAPI || !window.electronAPI.discordSetActivity) return;
  const cur = currentTrack;
  if (cur && settings.discord.showCover && !(cur.path in discordCoverCache)) ensureDiscordCover(cur);
  const send = () => {
    discordLastPush = Date.now();
    discordPushTimer = null;
    try { window.electronAPI.discordSetActivity(buildDiscordActivity()); } catch (_) {}
  };
  const since = Date.now() - discordLastPush;
  if (immediate || since >= DISCORD_PUSH_MIN_MS) {
    if (discordPushTimer) { clearTimeout(discordPushTimer); discordPushTimer = null; }
    send();
  } else if (!discordPushTimer) {
    discordPushTimer = setTimeout(send, DISCORD_PUSH_MIN_MS - since);
  }
}

// Single connect attempt. Updates state + pushes activity on success; returns a
// boolean so callers (manual button, boot, retry loop) can decide what to do.
async function tryDiscordConnect() {
  if (!window.electronAPI || !window.electronAPI.discordConnect || !DISCORD_CLIENT_ID) return false;
  let res = null;
  try { res = await window.electronAPI.discordConnect(DISCORD_CLIENT_ID); } catch (_) { res = null; }
  if (res && res.ok) {
    discordConnected = true;
    discordUser = res.user || null;
    pushDiscordActivity(true);
    return true;
  }
  discordConnected = false;
  return false;
}

// Background retry: while the integration is enabled but not connected (Discord
// client closed, or not yet launched), poll until it's reachable, then connect
// automatically. Stopped on explicit disconnect.
let discordReconnectTimer = null;
const DISCORD_RECONNECT_MS = 10000;
function stopDiscordReconnect() {
  if (discordReconnectTimer) { clearTimeout(discordReconnectTimer); discordReconnectTimer = null; }
}
function scheduleDiscordReconnect() {
  if (discordReconnectTimer || discordConnected) return;
  if (!settings.discord.enabled || !DISCORD_CLIENT_ID) return;
  discordReconnectTimer = setTimeout(async () => {
    discordReconnectTimer = null;
    if (!settings.discord.enabled || discordConnected) return;
    const ok = await tryDiscordConnect();
    if (ok) { if (isSettingsOpen()) renderDiscord(); }
    else scheduleDiscordReconnect();
  }, DISCORD_RECONNECT_MS);
}

async function connectDiscord() {
  if (!window.electronAPI || !window.electronAPI.discordConnect) return;
  if (!DISCORD_CLIENT_ID) { renderDiscord(); return; }
  // Record the intent first so it survives a restart even if Discord isn't up.
  settings.discord.enabled = true;
  saveSettings();
  stopDiscordReconnect();
  const btn = $('discord-conn-btn');
  if (btn) { btn.disabled = true; btn.textContent = tr('discord.connecting'); }
  const ok = await tryDiscordConnect();
  renderDiscord();
  if (!ok) {
    // Discord client not reachable — keep the intent and connect in the
    // background as soon as Discord launches.
    const w = document.querySelector('#discord-body .dc-conn-sub');
    if (w) { w.textContent = tr('discord.waitingForDiscord'); w.classList.add('dc-error'); }
    scheduleDiscordReconnect();
  }
}

async function disconnectDiscord() {
  stopDiscordReconnect();
  if (window.electronAPI && window.electronAPI.discordDisconnect) {
    try { await window.electronAPI.discordDisconnect(); } catch (_) {}
  }
  discordConnected = false;
  discordUser = null;
  settings.discord.enabled = false;
  saveSettings();
  renderDiscord();
}

// Main process pushes status changes (e.g. Discord client quit drops the socket).
// If we still want to be connected, start polling to reconnect automatically.
if (window.electronAPI && window.electronAPI.onDiscordStatus) {
  window.electronAPI.onDiscordStatus(({ connected, user }) => {
    discordConnected = !!connected;
    discordUser = user || null;
    if (isSettingsOpen()) renderDiscord();
    if (!connected && settings.discord.enabled) scheduleDiscordReconnect();
  });
}

// On boot, restore the connection if the user had it enabled. If Discord isn't
// running yet, the retry loop keeps trying until it launches.
if (settings.discord.enabled && DISCORD_CLIENT_ID) {
  tryDiscordConnect().then(ok => {
    if (ok) { if (isSettingsOpen()) renderDiscord(); }
    else scheduleDiscordReconnect();
  });
}

// ── Last.fm: scrobbling, offline queue, metadata lookups ──────────────────────
// Scrobbles that can't be sent (offline / not authed / API down) sit in a
// crash-safe store file and drain on the next successful flush.
let lfmQueue = readStore('lastfm-queue', 'audex-lastfm-queue') || [];
function saveLfmQueue() { writeStore('lastfm-queue', lfmQueue, 'audex-lastfm-queue'); }

// "Configured" = credentials present (enables the Connect button + read-only
// lookups). "Authed" also needs a session key, which only a successful Connect
// grants — that's what actually gates scrobbling/love.
function lfmConfigured() { const c = settings.lastfm; return !!(c && c.apiKey && c.secret); }
function lfmAuthed() { return lfmConfigured() && !!settings.lastfm.session; }

// One generic caller. `sign` adds the md5 signature; `auth` also injects the
// session key (sk); write methods (scrobble/love/nowplaying) are signed POSTs.
async function lfmCall(method, params = {}, { sign = false, post = false, auth = false } = {}) {
  const c = settings.lastfm;
  const p = { api_key: c.apiKey, ...params };
  if (auth) p.sk = c.session;
  if (!window.electronAPI || !window.electronAPI.lastfm) throw new Error('Last.fm bridge unavailable');
  const res = await window.electronAPI.lastfm({ method, params: p, secret: c.secret, sign: sign || auth || post, post });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Last.fm request failed');
  return res.data;
}

// Auth: fetch a request token, open the browser for the user to approve, then
// poll auth.getSession until they do. The session key never expires.
async function lfmGetToken() {
  const d = await lfmCall('auth.getToken', {}, { sign: true });
  if (!d || !d.token) throw new Error('No token from Last.fm');
  window.electronAPI.openExternal(`https://www.last.fm/api/auth/?api_key=${encodeURIComponent(settings.lastfm.apiKey)}&token=${encodeURIComponent(d.token)}`);
  return d.token;
}
let lfmAuthPolling = false;
async function lfmPollSession(token, tries = 40) {
  if (lfmAuthPolling) return false;
  lfmAuthPolling = true;
  try {
    for (let i = 0; i < tries; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const d = await lfmCall('auth.getSession', { token }, { sign: true });
        if (d && d.session && d.session.key) {
          settings.lastfm.session = d.session.key;
          settings.lastfm.user = d.session.name || '';
          saveSettings();
          lfmFlush();
          return true;
        }
      } catch (_) { /* not approved yet — keep waiting */ }
    }
    return false;
  } finally { lfmAuthPolling = false; }
}

// Last.fm's own rule: track ≥30s long, listened past halfway OR for 4 min.
// `entry` is a play-log entry (see plStartIfNeeded): { t, a, n, b, s, d }.
function lfmMaybeScrobble(entry) {
  if (!entry || entry.scrobbled || !lfmAuthed() || !settings.lastfm.scrobble) return;
  if (!entry.a || !entry.n) return;
  const dur = Number(entry.d) || 0, played = Number(entry.s) || 0;
  if (dur && dur < 30) return;
  if (played < (dur ? Math.min(240, dur / 2) : 240)) return;
  entry.scrobbled = true;   // dedup across pause/resume/switch and restarts
  savePlayLog();
  lfmQueue.push({ artist: entry.a, track: entry.n, album: entry.b || '', duration: Math.round(dur) || undefined, timestamp: Math.floor(entry.t / 1000) });
  saveLfmQueue();
  lfmFlush();
}

let lfmFlushing = false;
async function lfmFlush() {
  if (lfmFlushing || !lfmAuthed() || lfmQueue.length === 0 || !navigator.onLine) return;
  lfmFlushing = true;
  try {
    while (lfmQueue.length) {
      const batch = lfmQueue.slice(0, 50);   // track.scrobble accepts up to 50 per call
      const params = {};
      batch.forEach((s, i) => {
        params[`artist[${i}]`] = s.artist;
        params[`track[${i}]`] = s.track;
        params[`timestamp[${i}]`] = s.timestamp;
        if (s.album) params[`album[${i}]`] = s.album;
        if (s.duration) params[`duration[${i}]`] = s.duration;
      });
      await lfmCall('track.scrobble', params, { post: true, auth: true });
      lfmQueue = lfmQueue.slice(batch.length);
      saveLfmQueue();
    }
  } catch (_) {
    // Network/API failure — leave the queue intact for the next flush.
  } finally { lfmFlushing = false; }
}

async function lfmNowPlaying(track) {
  if (!lfmAuthed() || !settings.lastfm.nowPlaying || !track || !track.artist || !track.title) return;
  const params = { artist: track.artist, track: track.title };
  if (track.album) params.album = track.album;
  if (track.duration) params.duration = Math.round(track.duration);
  try { await lfmCall('track.updateNowPlaying', params, { post: true, auth: true }); } catch (_) {}
}

async function lfmLove(track, loved) {
  if (!lfmAuthed() || !settings.lastfm.loveSync || !track || !track.artist || !track.title) return;
  try { await lfmCall(loved ? 'track.love' : 'track.unlove', { artist: track.artist, track: track.title }, { post: true, auth: true }); } catch (_) {}
}

// ── Metadata lookups (need only the api key, no session) ──
async function lfmCorrection(kind, artist, title) {
  if (!lfmConfigured()) return null;
  try {
    if (kind === 'artist') {
      const d = await lfmCall('artist.getCorrection', { artist });
      const c = d && d.corrections && d.corrections.correction;
      const name = c && c.artist && c.artist.name;
      return name && name !== artist ? { artist: name } : null;
    }
    const d = await lfmCall('track.getCorrection', { artist, track: title });
    const c = d && d.corrections && d.corrections.correction;
    if (!c || !c.track) return null;
    const a = c.track.artist && c.track.artist.name, t = c.track.name;
    return (a && a !== artist) || (t && t !== title) ? { artist: a || artist, title: t || title } : null;
  } catch (_) { return null; }
}

async function lfmTopTags(kind, artist, name) {
  if (!lfmConfigured()) return [];
  try {
    const d = kind === 'artist' ? await lfmCall('artist.getTopTags', { artist })
      : kind === 'album' ? await lfmCall('album.getTopTags', { artist, album: name })
      : await lfmCall('track.getTopTags', { artist, track: name });
    const tags = (d && d.toptags && d.toptags.tag) || [];
    return tags.map(t => t.name).filter(Boolean).slice(0, 6);
  } catch (_) { return []; }
}

async function lfmSimilarArtists(artist, limit = 8) {
  if (!lfmConfigured()) return [];
  try {
    const d = await lfmCall('artist.getSimilar', { artist, limit });
    const arr = (d && d.similarartists && d.similarartists.artist) || [];
    return arr.map(a => a.name).filter(Boolean);
  } catch (_) { return []; }
}

// ── Last.fm settings card ──
function renderLastfm() {
  const host = $('lastfm-body');
  if (!host) return;
  const c = settings.lastfm;
  const authed = lfmAuthed();
  const statusText = authed ? tr('lastfm.connected') : tr('lastfm.notConnected');
  const sub = authed
    ? escapeHtml(c.user || tr('lastfm.connected'))
    : (lfmAuthPolling ? escapeHtml(tr('lastfm.connecting')) : escapeHtml(tr('lastfm.connectHint')));
  const connectLabel = authed ? tr('lastfm.disconnect') : tr('lastfm.connect');
  const lfToggle = (key, label, desc) => `
    <div class="setting-row">
      <div class="setting-text">
        <div class="setting-label">${escapeHtml(tr(label))}</div>
        <div class="setting-desc">${escapeHtml(tr(desc))}</div>
      </div>
      <button class="toggle${c[key] ? ' on' : ''}" data-lfm="${key}"><div class="toggle-knob"></div></button>
    </div>`;

  host.innerHTML = `
    <div class="dc-hint" style="margin-top:0">${escapeHtml(tr('lastfm.subtitle'))}</div>

    <div class="setting-card setting-card-tight">
      <div class="dc-conn dc-conn-lastfm${authed ? ' is-connected' : ''}">
        <div class="dc-conn-icon"><svg class="i" width="22" height="22"><use href="#i-lastfm"/></svg></div>
        <div class="dc-conn-main">
          <div class="dc-conn-title">Last.fm <span class="dc-conn-status">${authed ? '●' : '○'} ${escapeHtml(statusText)}</span></div>
          <div class="dc-conn-sub">${sub}</div>
        </div>
        <button class="btn-ghost dc-conn-btn${authed ? '' : ' dc-conn-btn-primary'}" id="lastfm-conn-btn"${(lfmConfigured() || authed) ? '' : ' disabled'}>${escapeHtml(connectLabel)}</button>
      </div>
    </div>

    <div class="setting-card setting-card-tight">
      <div class="setting-row dc-btn-row">
        <div class="dc-btn-field dc-btn-field-wide">
          <div class="dc-btn-cap">${escapeHtml(tr('lastfm.apiKey'))}</div>
          <input class="dc-input dc-input-mono" type="text" spellcheck="false" id="lastfm-key" value="${escapeHtml(c.apiKey)}" placeholder="0123abcd…">
        </div>
        <div class="dc-btn-field dc-btn-field-wide">
          <div class="dc-btn-cap">${escapeHtml(tr('lastfm.secret'))}</div>
          <input class="dc-input dc-input-mono" type="password" spellcheck="false" id="lastfm-secret" value="${escapeHtml(c.secret)}" placeholder="••••••••">
        </div>
      </div>
    </div>
    <div class="dc-hint">${escapeHtml(tr('lastfm.keyHint'))} <a href="#" id="lastfm-getkey">${escapeHtml(tr('lastfm.getKey'))}</a></div>

    <div class="setting-card setting-card-tight">
      ${lfToggle('scrobble', 'lastfm.scrobble', 'lastfm.scrobbleDesc')}
      ${lfToggle('nowPlaying', 'lastfm.nowPlaying', 'lastfm.nowPlayingDesc')}
      ${lfToggle('loveSync', 'lastfm.loveSync', 'lastfm.loveSyncDesc')}
    </div>
    ${lfmQueue.length ? `<div class="dc-hint">${escapeHtml(tr('lastfm.queued', { n: lfmQueue.length }))}</div>` : ''}
  `;

  const keyInput = $('lastfm-key'), secretInput = $('lastfm-secret');
  const connBtn = $('lastfm-conn-btn');
  // Persist + enable Connect live as they type — no re-render, or blurring a
  // field to click Connect would rebuild the button and swallow the click.
  const persistKeys = () => {
    settings.lastfm.apiKey = keyInput.value.trim();
    settings.lastfm.secret = secretInput.value.trim();
    saveSettings();
    if (connBtn && !authed) connBtn.disabled = !lfmConfigured();
  };
  keyInput.addEventListener('input', persistKeys);
  secretInput.addEventListener('input', persistKeys);
  $('lastfm-getkey').addEventListener('click', e => { e.preventDefault(); window.electronAPI.openExternal('https://www.last.fm/api/account/create'); });

  if (connBtn) connBtn.addEventListener('click', () => authed ? disconnectLastfm() : connectLastfm());

  host.querySelectorAll('.toggle[data-lfm]').forEach(t => t.addEventListener('click', () => {
    const key = t.dataset.lfm;
    settings.lastfm[key] = !settings.lastfm[key];
    saveSettings();
    renderLastfm();
    if (key === 'scrobble' && settings.lastfm[key]) lfmFlush();
  }));
}

async function connectLastfm() {
  const c = settings.lastfm;
  if (!c.apiKey || !c.secret) { toast(tr('lastfm.needKey')); return; }
  c.enabled = true;
  saveSettings();
  const btn = $('lastfm-conn-btn');
  if (btn) { btn.disabled = true; btn.textContent = tr('lastfm.connecting'); }
  try {
    const token = await lfmGetToken();
    if (isSettingsOpen()) renderLastfm();      // shows the "waiting for approval" sub-state
    const ok = await lfmPollSession(token);
    if (!ok) toast(tr('lastfm.authFailed'));
  } catch (err) {
    toast(String(err && err.message || err));
  }
  if (isSettingsOpen()) renderLastfm();
}

function disconnectLastfm() {
  settings.lastfm.session = '';
  settings.lastfm.user = '';
  settings.lastfm.enabled = false;
  saveSettings();
  renderLastfm();
}

// Drain the queue on boot and whenever the network returns.
window.addEventListener('online', lfmFlush);
if (lfmAuthed()) lfmFlush();

// Covers for recents (sidebar) and the now-playing track are loaded eagerly,
// since they're always visible. Library/favorites/playlist covers load lazily
// as rows scroll into view (see ensureCoverFor + renderTrackRow).
async function restoreCovers() {
  if (library.length === 0) return;
  const priority = new Set();
  recents.slice(0, 4).forEach(p => priority.add(p));
  if (currentTrack) {
    priority.add(currentTrack.path);
  }
  for (const path of priority) {
    const t = trackByPath(path);
    if (t) await ensureCoverFor(t);
  }
  renderRecents();
  if (currentTrack) updateNowPlayingUI(currentTrack);
}

// Pull tracks from the app's own downloads folder ("Audex Downloads") and, if
// the user has set one, from their default folder. This keeps the library in
// sync with both sources without requiring manual import. importPaths skips
// paths already in the library, so re-running this is idempotent.
async function rescanFolders() {
  lastRescan = Date.now();   // also at the end: a slow scan shouldn't let a re-focus start a second one
  const folders = [];
  try {
    const downloadsDir = await window.electronAPI.getDownloadsDir();
    if (downloadsDir) folders.push(downloadsDir);
  } catch (_) { /* ignore */ }
  if (settings.defaultFolder && !folders.includes(settings.defaultFolder)) {
    folders.push(settings.defaultFolder);
  }
  for (const folder of folders) {
    try {
      const files = await window.electronAPI.scanFolder(folder);
      if (files && files.length > 0) await importPaths(files);
    } catch (_) { /* ignore */ }
  }
  lastRescan = Date.now();
}

// Files that appeared while the app was open — a download in another app, a
// copy from a file manager — stay invisible until the next launch otherwise.
// Cheaper than a file watcher: rescan when the window is focused again, at
// most once every few minutes so tabbing back and forth doesn't re-walk the
// whole folder tree.
const RESCAN_MIN_INTERVAL_MS = 5 * 60 * 1000;
let lastRescan = 0;
window.addEventListener('focus', () => {
  if (Date.now() - lastRescan < RESCAN_MIN_INTERVAL_MS) return;
  rescanFolders().catch(() => {});
});

// ── Update check ──
// Asks the main process whether a newer GitHub release exists and, if so,
// shows the in-app banner. The banner is suppressed for the rest of the day
// once the user closes it (keyed by version + date), so it reappears the next
// day — and immediately for any newer version.
function updateTodayStr() {
  return new Date().toISOString().slice(0, 10);
}
function getUpdateDismiss() {
  try { return JSON.parse(localStorage.getItem(LS.updateDismiss)) || {}; }
  catch (_) { return {}; }
}
const UPDATE_RELEASES_URL = 'https://github.com/zhotheone/audex-player/releases/latest';
function showUpdateBanner(info) {
  const banner = document.getElementById('update-banner');
  if (!banner) return;
  const versionEl = document.getElementById('update-banner-version');
  if (versionEl) versionEl.textContent = 'v' + info.latestVersion;
  const dlBtn = document.getElementById('update-download-btn');
  if (dlBtn) dlBtn.onclick = async () => {
    if (!window.electronAPI || typeof window.electronAPI.downloadUpdate !== 'function') {
      window.electronAPI.openExternal(UPDATE_RELEASES_URL);
      return;
    }
    dlBtn.disabled = true;
    dlBtn.textContent = tr('update.downloading', { pct: 0 });
    const offProgress = window.electronAPI.onUpdateDownloadProgress
      ? window.electronAPI.onUpdateDownloadProgress((pct) => {
          dlBtn.textContent = tr('update.downloading', { pct: Math.round(pct * 100) });
        })
      : null;
    // electron-updater fires this once the download is verified and ready —
    // the app has to quit to apply it, so hand control to the user instead of
    // restarting out from under them.
    const offDownloaded = window.electronAPI.onUpdateDownloaded
      ? window.electronAPI.onUpdateDownloaded(() => {
          dlBtn.textContent = tr('update.restart');
          dlBtn.disabled = false;
          dlBtn.onclick = () => window.electronAPI.installUpdate();
          if (offDownloaded) offDownloaded();
        })
      : null;
    let res;
    try { res = await window.electronAPI.downloadUpdate(); }
    catch (_) { res = { success: false }; }
    if (offProgress) offProgress();
    if (!res || !res.success) {
      if (offDownloaded) offDownloaded();
      dlBtn.textContent = tr('update.failed');
      // The real reason (e.g. an unsigned macOS build can't self-update) has
      // nowhere else to surface — this app has no menu bar or DevTools shortcut.
      dlBtn.title = (res && res.error) || '';
      if (res && res.error) console.error('[update] download failed:', res.error);
      window.electronAPI.openExternal(UPDATE_RELEASES_URL);
      setTimeout(() => { dlBtn.disabled = false; dlBtn.textContent = tr('update.download'); }, 3000);
    }
  };
  const closeBtn = document.getElementById('update-close-btn');
  if (closeBtn) closeBtn.onclick = () => {
    banner.hidden = true;
    try {
      localStorage.setItem(LS.updateDismiss, JSON.stringify({
        version: info.latestVersion,
        date: updateTodayStr(),
      }));
    } catch (_) { /* ignore */ }
  };
  banner.hidden = false;
}
async function checkForUpdates() {
  if (!window.electronAPI || typeof window.electronAPI.checkForUpdate !== 'function') return;
  let info;
  try { info = await window.electronAPI.checkForUpdate(); }
  catch (_) { return; }
  if (!info || !info.success || !info.hasUpdate) return;
  const dismissed = getUpdateDismiss();
  if (dismissed.version === info.latestVersion && dismissed.date === updateTodayStr()) return;
  showUpdateBanner(info);
}

const checkUpdateBtn = $('btn-check-update');
if (checkUpdateBtn && window.electronAPI && typeof window.electronAPI.checkForUpdate === 'function') {
  checkUpdateBtn.addEventListener('click', async () => {
    const statusEl = $('check-update-status');
    const label = checkUpdateBtn.querySelector('span');
    checkUpdateBtn.disabled = true;
    if (label) label.textContent = tr('btn.checking');
    if (statusEl) statusEl.textContent = '';
    let info;
    try { info = await window.electronAPI.checkForUpdate(); }
    catch (_) { info = null; }
    checkUpdateBtn.disabled = false;
    if (label) label.textContent = tr('btn.checkUpdate');
    if (!info || !info.success) {
      if (statusEl) statusEl.textContent = tr('update.checkFailed');
      return;
    }
    // Manual check bypasses the "dismissed for today" suppression that the
    // silent boot-time check respects — the user explicitly asked.
    if (info.hasUpdate) showUpdateBanner(info);
    else if (statusEl) statusEl.textContent = tr('update.upToDate', { v: info.currentVersion });
  });
}

const openLogsBtn = $('btn-open-logs');
if (openLogsBtn && window.electronAPI && typeof window.electronAPI.openLogsFolder === 'function') {
  openLogsBtn.addEventListener('click', () => window.electronAPI.openLogsFolder());
}

// Boot
// The boot overlay (#boot-overlay in index.html) covers the window from first
// paint; the phases below update its status line, and hideBootOverlay() fades
// it out once the async boot work finishes.
const bootStartedAt = Date.now();
const BOOT_OVERLAY_MIN_MS = 150; // brief non-blocking display
function splashStatus(key, params) {
  const el = document.getElementById('boot-status-text');
  if (!el) return;
  const text = tr(key, params);
  el.textContent = text;
  document.getElementById('boot-status').classList.toggle('has-text', !!text);
}
function hideBootOverlay() {
  const overlay = document.getElementById('boot-overlay');
  if (!overlay) return;
  const left = BOOT_OVERLAY_MIN_MS - (Date.now() - bootStartedAt);
  setTimeout(() => {
    overlay.classList.add('boot-hide');
    // Drop it from the DOM after the fade so it can't intercept anything.
    setTimeout(() => overlay.remove(), 600);
  }, Math.max(0, left));
}
(async () => {
  let commit = '';
  try {
    const info = await window.electronAPI.getBuildInfo();
    commit = (info && info.commit) || '';
  } catch (_) { /* leave blank rather than show a stale number */ }
  const tag = document.getElementById('version-tag');
  if (tag) tag.textContent = commit ? `Audex ${commit}` : 'Audex';
  const footer = document.getElementById('boot-footer');
  if (footer) footer.textContent = `${tag ? tag.textContent : 'Audex'} · Audex Audio Engine`;
  const brand = document.getElementById('brand-version');
  if (brand) brand.textContent = commit;
  const about = document.getElementById('about-version');
  if (about) {
    const plat = String(navigator.platform || '');
    const osLabel = plat.startsWith('Win') ? 'Windows' : plat.startsWith('Mac') ? 'macOS' : plat.startsWith('Linux') ? 'Linux' : (plat || 'Desktop');
    about.textContent = commit ? `${commit} · Electron · ${osLabel}` : `Electron · ${osLabel}`;
  }
})();
setTimeout(hideBootOverlay, 30000);

// Bulk-load the persistent disk cover cache (one IPC round-trip) before the
// first row render, so covers appear instantly without per-track metadata
// parsing while scrolling.
async function warmCoversFromDisk() {
  if (library.length === 0) return;
  try {
    const map = await window.electronAPI.loadCoverCache(library.map(t => t.path));
    for (const p in map) {
      coverCache[p] = map[p];
      const t = trackByPath(p);
      if (t && !t.cover) t.cover = map[p];
    }
  } catch (_) { /* cache is best-effort */ }
}

// After boot, parse whatever the disk cache didn't have (covers + quality)
// in small throttled batches. Each parse also writes the extracted cover to
// the disk cache in the main process, so the next boot is fully warm.
function warmMissingCoversInBackground() {
  const missing = library.filter(t =>
    (!t.cover && t.hasCover !== false) || t.quality === undefined || t.hasCover === undefined);
  let i = 0;
  const step = () => {
    if (i >= missing.length) { scheduleCoverRefresh(); return; }
    const batch = missing.slice(i, i + 4);
    i += 4;
    Promise.allSettled(batch.map(t => ensureCoverFor(t, true))).then(() => setTimeout(step, 200));
  };
  step();
}

// ── LAN / Tailscale sharing ──
//
// Main owns the socket; this side owns the library and the player. So we push a
// snapshot down whenever either changes, and remote commands come back up.
// Talking to a peer is a plain fetch straight from here — no reason to relay a
// JSON request through the main process.

let lanStatus = { enabled: false, key: '', name: '', addresses: [], peers: [], running: false, error: '' };
let lanPeerLibraries = {};     // deviceId -> { name, tracks } — kept in sync automatically, no "Browse" needed
let lanPollTimer = null;

function lanPeer(id) { return lanStatus.peers.find(p => p.deviceId === id) || null; }

async function lanApi(peer, route, body) {
  const res = await fetch(peer.base + route, {
    method: body ? 'POST' : 'GET',
    headers: { 'Authorization': 'Bearer ' + lanStatus.key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(res.status === 401 ? tr('lan.errKey') : `HTTP ${res.status}`);
  return res.json();
}

// A peer's track carries its own signed stream/cover URL, so it slots into the
// normal library shape and plays through the same path as a local file.
function lanRemoteAsTrack(t, peer) {
  return {
    path: t.url, title: t.title || '', artist: t.artist || '', album: t.album || '',
    albumArtist: t.albumArtist || '', year: t.year || '', genre: t.genre || '',
    trackNo: t.trackNo || '', discNo: t.discNo || '', duration: t.duration || 0,
    quality: t.quality || null, hasCover: !!t.coverUrl, cover: t.coverUrl || null,
    remote: true, deviceId: peer.deviceId, deviceName: peer.name,
  };
}

async function lanSyncPeerLibrary(peer) {
  try {
    const lib = await lanApi(peer, '/api/library');
    lanPeerLibraries[peer.deviceId] = { name: peer.name, tracks: (lib.tracks || []).map(t => lanRemoteAsTrack(t, peer)) };
  } catch (e) {
    delete lanPeerLibraries[peer.deviceId];
  }
  if (currentView === 'library') renderLibrary();
  if (currentView === 'devices') renderDevices();
}

function lanAllRemoteTracks() {
  return Object.values(lanPeerLibraries).flatMap(l => l.tracks);
}

// "Download from Host": pulls peer tracks down as real local files (through
// the same defaultFolder prompt every other download in the app uses) and
// indexes them via importPaths, exactly like a finished YouTube/Spotify
// download. Only ever called with tracks that are still in lanPeerLibraries
// right now, so there's no separate "peer still reachable" check needed - an
// unreachable peer's tracks already vanished from the list (see
// lanSyncPeerLibrary). Shared by the library bulk-select bar and the
// album/artist "⋮" menu, both of which just gather track objects differently.
async function downloadTracksFromHost(tracks) {
  tracks = tracks.filter(t => isRemotePath(t.path));
  if (!tracks.length) return;
  const args = await ensureDownloadArgs({});
  if (!args) return; // user closed the folder picker without choosing one
  let done = 0, failed = 0;
  for (let i = 0; i < tracks.length; i++) {
    setProgressBanner(i, tracks.length, 'lanDownload.progress');
    const t = tracks[i];
    const res = await window.electronAPI.lanDownloadTrack({
      url: t.path, artist: t.artist, album: t.album, title: t.title, targetDir: args.targetDir,
    });
    if (res && res.success) {
      done++;
      await importPaths([res.filePath]);
    } else {
      failed++;
      window.electronAPI.logError?.('lanDownload', `${t.path}: ${(res && res.error) || 'no response'}`);
    }
  }
  setProgressBanner(null);
  setLibrarySelectMode(false);
  toast(tr('lanDownload.summary', { done, failed, total: tracks.length }));
}

async function lanRefresh() {
  lanStatus = await window.electronAPI.lanStatus();
  $('count-devices').textContent = lanStatus.peers.length;
  const ids = new Set(lanStatus.peers.map(p => p.deviceId));
  for (const id of Object.keys(lanPeerLibraries)) if (!ids.has(id)) delete lanPeerLibraries[id];
  // Inbound-only entries (see lan.js's `inbound` map) have no base URL to
  // reach them through — they only ever pull from us, so there's no library
  // to fetch back.
  for (const p of lanStatus.peers) if (!lanPeerLibraries[p.deviceId] && p.base) lanSyncPeerLibrary(p);
  if (currentView === 'devices') renderDevices();
  if (currentView === 'library') renderLibrary();
  if ($('connect-menu').classList.contains('open')) renderConnectMenu();
}

// ── publishing our own library + state + config ──

// Only prefs that make sense the same way on every device — never a local
// file path, a per-screen scale, or the sharing switch itself (pulling that
// remotely could silently turn a peer's networking off).
const LAN_SYNCABLE_SETTINGS = [
  'theme', 'accent', 'language', 'dlFormat', 'scanSubdirs', 'healthCheck',
  'reports', 'editor', 'crossfade', 'crossfadeSec', 'volumeWheelStep',
  'downloads', 'showParserBrowser',
];
function lanConfigSnapshot() {
  const out = {};
  for (const k of LAN_SYNCABLE_SETTINGS) out[k] = settings[k];
  return out;
}

// Tracks are sent only when the library changed; state goes out on every
// playback event and once a second while playing, so a peer's "now playing"
// and a takeover's seek position stay within a second of the truth.
function lanPublish() {
  if (!lanStatus.enabled) return;
  const curPath = currentTrack ? currentTrack.path : '';
  const idx = currentQueue.findIndex(t => t.path === curPath);
  const snap = {
    state: {
      path: curPath,
      title: currentTrack ? currentTrack.title : '',
      artist: currentTrack ? currentTrack.artist : '',
      album: currentTrack ? currentTrack.album : '',
      coverUrl: currentTrack && isRemotePath(currentTrack.path) ? currentTrack.cover : null,
      playing: isPlaying && !audio.paused,
      position: Number(audio.currentTime) || 0,
      duration: Number(audio.duration) || (currentTrack ? currentTrack.duration : 0) || 0,
      volume: targetVolume,
      shuffle: isShuffle,
      repeat: repeatMode,
      queue: idx >= 0 ? currentQueue.slice(idx + 1, idx + 51).map(t => t.path) : [],
    },
  };
  if (lanTracksDirty) {
    lanTracksDirty = false;
    snap.tracks = library.map(t => ({
      path: t.path, title: t.title, artist: t.artist, album: t.album, albumArtist: t.albumArtist,
      year: t.year, genre: t.genre, trackNo: t.trackNo, discNo: t.discNo,
      duration: t.duration, quality: t.quality, hasCover: t.hasCover,
    }));
  }
  if (lanConfigDirty) {
    lanConfigDirty = false;
    snap.config = lanConfigSnapshot();
  }
  window.electronAPI.lanPublish(snap);
}

function lanStartPublishing() {
  if (lanPollTimer) return;
  lanPollTimer = setInterval(() => {
    // While playing this also carries the position tick; while idle it still
    // has to run so a library/cover change (dirty flag) reaches peers even
    // though nothing is "happening" to trigger an audio event.
    if ((isPlaying && !audio.paused) || lanTracksDirty || lanConfigDirty) lanPublish();
  }, 1000);
  for (const ev of ['play', 'pause', 'seeked', 'loadedmetadata', 'volumechange']) {
    audio.addEventListener(ev, () => lanPublish());
  }
  // A one-shot library fetch means a request that failed once (peer still
  // booting its server, a dropped packet) never gets retried, and a peer's
  // covers that finish backfilling after the initial sync never show up.
  // Re-pulling every known peer's library periodically covers both.
  setInterval(() => {
    if (!lanStatus.enabled) return;
    for (const p of lanStatus.peers) lanSyncPeerLibrary(p);
  }, 30000);
}

// ── remote control of this device ──

function lanAdoptState(state, autoplay) {
  if (!state || !state.track) return;
  const asTrack = (t) => ({
    path: t.url, title: t.title || '', artist: t.artist || '', album: t.album || '',
    duration: t.duration || 0, cover: t.coverUrl || null, hasCover: !!t.coverUrl, remote: true,
  });
  const track = asTrack(state.track);
  currentTrack = track;
  currentQueue = [track, ...(state.queue || []).map(asTrack)];
  isShuffle = !!state.shuffle;
  repeatMode = [0, 1, 2].includes(state.repeat) ? state.repeat : 0;
  updateShuffleUI();
  updateRepeatUI();
  stopCrossfadeTail();
  audio.src = track.path;
  audio.volume = targetVolume;
  const pos = Number(state.position) || 0;
  if (pos > 0) {
    audio.addEventListener('loadedmetadata', () => {
      try { audio.currentTime = pos; } catch (_) {}
    }, { once: true });
  }
  isPlaying = autoplay !== false && state.playing !== false;
  if (isPlaying) audio.play().catch(e => console.warn('lan play error:', e));
  updateNowPlayingUI(track);
  updatePlayButtonUI();
  refreshPlayingHighlight();
}

function applyLanCommand(cmd) {
  if (!cmd) return;
  switch (cmd.type) {
    case 'play': if (audio.paused) togglePlay(); break;
    case 'pause': if (!audio.paused) togglePlay(); break;
    case 'next': nextTrack(); break;
    case 'prev': prevTrack(); break;
    case 'seek': try { audio.currentTime = Number(cmd.position) || 0; } catch (_) {} break;
    case 'volume': setVolume(Number(cmd.volume)); break;
    case 'playState': lanAdoptState(cmd.state, true); break;
  }
  lanPublish();
}

// ── taking a session over ──
//
// Spotify Connect's transfer, minus the cloud: ask the peer for its session, let
// it pause itself, and pick the track up here at the same position.
async function lanTakeOver(peer) {
  try {
    const res = await lanApi(peer, '/api/command', { type: 'transfer' });
    if (!res.state || !res.state.track) { toast(tr('lan.nothingPlaying')); return; }
    lanAdoptState(res.state, true);
  } catch (e) {
    toast(tr('lan.errReach') + ' ' + (e.message || e));
  }
}

// Push is the takeover in reverse: hand a peer our session and let it start
// playing. The track URL has to be one the *peer* can reach, and which of our
// addresses that is depends on which network they're on — match octets against
// their host (both Tailscale's 100.x, or the same LAN subnet) rather than
// guessing. Getting our own signed state means asking our own server, the only
// place that builds those URLs.
function lanMyAddressFor(peer) {
  const prefix = String(peer.host || '').split('.').slice(0, 2).join('.');
  return lanStatus.addresses.find(a => a.split('.').slice(0, 2).join('.') === prefix)
    || lanStatus.addresses[0];
}
async function lanPushTo(peer) {
  if (!currentTrack) return;
  const myHost = lanMyAddressFor(peer);
  if (!myHost) { toast(tr('lan.errReach') + ' (no reachable local address)'); return; }
  try {
    const mine = await lanApi({ base: `http://${myHost}:${lanStatus.port}` }, '/api/state');
    if (!mine.track) { toast(tr('lan.nothingPlaying')); return; }
    await lanApi(peer, '/api/command', { type: 'playState', state: mine });
    // Handing the session off should stop it here too, same as a take-over
    // pauses the device being taken from.
    if (!audio.paused) togglePlay();
  } catch (e) {
    toast(tr('lan.errReach') + ' ' + (e.message || e));
  }
}

// ── syncing settings from a peer ──
//
// The mirror of lanConfigSnapshot(): pull a peer's syncable subset and adopt
// it here. A confirm because, unlike library/playback, this overwrites the
// user's own preferences.
async function lanSyncSettingsFrom(peer) {
  if (!peer) return;
  try {
    const cfg = await lanApi(peer, '/api/config');
    if (!cfg || Object.keys(cfg).length === 0) { toast(tr('lan.syncSettingsNone')); return; }
    if (!(await confirmToast(tr('lan.syncSettingsConfirm', { device: peer.name })))) return;
    for (const k of LAN_SYNCABLE_SETTINGS) if (cfg[k] !== undefined) settings[k] = cfg[k];
    saveSettings();
    applyTheme(settings.theme);
    applyAccent(settings.accent);
    applyLanguage(settings.language);
    renderSettings();
  } catch (e) {
    toast(tr('lan.errReach') + ' ' + (e.message || e));
  }
}

// ── Devices view ──
//
// Setup and pairing only — browsing a peer's library happens automatically
// (see lanSyncPeerLibrary) and session transfer lives in the playbar's
// Connect menu below, Spotify-style, so this view doesn't duplicate either.

function renderDevices() {
  const el = $('devices-content');
  const s = lanStatus;
  const addr = s.addresses.map(a => `${a}:${s.port}`).join(', ') || '—';
  const statusLine = !s.enabled ? tr('lan.off')
    : s.error ? `${tr('lan.error')}: ${escapeHtml(s.error)}`
    : s.running ? `${tr('lan.on')} · ${escapeHtml(addr)}`
    : tr('lan.starting');

  const peers = s.peers.map(p => {
    const lib = lanPeerLibraries[p.deviceId];
    const trackCount = lib ? ` · ${withCount('tracks', lib.tracks.length)}` : '';
    // Inbound-only entries are one-way (they connected to us; we have no
    // address to reach them back at) — no port, no sync/remove actions.
    const meta = p.inbound ? `${escapeHtml(p.host)} · ${tr('lan.inbound')}`
      : `${escapeHtml(p.host)}:${p.port}${p.manual ? ' · ' + tr('lan.manual') : ''}${trackCount}`;
    const icon = p.inbound ? 'i-link' : 'i-monitor';
    return `
    <div class="device-row" data-peer="${escapeHtml(p.deviceId)}" style="cursor:default">
      <svg class="i" width="14" height="14"><use href="#${icon}"/></svg>
      <div class="device-body">
        <div class="device-name">${escapeHtml(p.name)}</div>
        <div class="device-meta">${meta}</div>
      </div>
      ${!p.inbound ? `<button class="btn-ghost" data-act="sync-settings" title="${escapeHtml(tr('lan.syncSettingsHint'))}">${tr('lan.syncSettings')}</button>` : ''}
      ${p.manual ? `<button class="btn-ghost" data-act="remove">${tr('lan.remove')}</button>` : ''}
    </div>`;
  }).join('') || `<div class="device-empty">${tr('lan.noPeers')}</div>`;

  el.innerHTML = `
    <div class="device-section">
      <div class="device-title">${tr('lan.thisDevice')}</div>
      <div class="device-form">
        <input id="lan-name" type="text" value="${escapeHtml(s.name || '')}" placeholder="${tr('lan.namePh')}">
        <input id="lan-key" type="text" spellcheck="false" autocomplete="off" value="${escapeHtml(s.key || '')}" placeholder="${tr('lan.keyPh')}">
        <button class="btn-ghost" id="lan-gen">${tr('lan.generate')}</button>
        <button class="btn-primary" id="lan-toggle">${s.enabled ? tr('lan.disable') : tr('lan.enable')}</button>
      </div>
      <div class="device-meta">${statusLine}</div>
      <div class="device-hint">${tr('lan.hint')}</div>
    </div>
    <div class="device-section">
      <div class="device-title">${tr('lan.peers')}</div>
      ${peers}
      <div class="device-form">
        <input id="lan-addr" type="text" placeholder="${tr('lan.addPh')}">
        <button class="btn-ghost" id="lan-add">${tr('lan.add')}</button>
      </div>
      <div class="device-hint">${tr('lan.hintPeers')}</div>
    </div>`;

  const save = () => window.electronAPI.lanSetConfig({
    name: $('lan-name').value.trim(),
    key: $('lan-key').value.trim(),
  }).then(st => { lanStatus = st; lanTracksDirty = true; lanConfigDirty = true; lanPublish(); renderDevices(); });

  $('lan-name').addEventListener('change', save);
  $('lan-key').addEventListener('change', save);
  $('lan-gen').addEventListener('click', () => {
    $('lan-key').value = Array.from(crypto.getRandomValues(new Uint8Array(12)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    save();
  });
  $('lan-toggle').addEventListener('click', async () => {
    const key = $('lan-key').value.trim();
    if (!key && !s.enabled) { toast(tr('lan.needKey')); return; }
    lanStatus = await window.electronAPI.lanSetConfig({
      enabled: !s.enabled, key, name: $('lan-name').value.trim(),
    });
    lanTracksDirty = true;
    lanConfigDirty = true;
    lanPublish();
    renderDevices();
  });
  $('lan-add').addEventListener('click', async () => {
    const addr = $('lan-addr').value.trim();
    if (!addr) return;
    await window.electronAPI.lanAddPeer(addr);
    $('lan-addr').value = '';
    lanRefresh();
  });

  el.querySelectorAll('.device-row').forEach(row => {
    row.addEventListener('click', async (e) => {
      const act = e.target.closest('button') && e.target.closest('button').dataset.act;
      const id = row.dataset.peer;
      if (act === 'remove') { await window.electronAPI.lanRemovePeer(id); return lanRefresh(); }
      if (act === 'sync-settings') return lanSyncSettingsFrom(lanPeer(id));
    });
  });
}

// ── Connect menu (playbar) ──
//
// Spotify Connect's device picker: a small popover off the playbar listing
// known peers, each with the two session-transfer actions. Reuses the same
// fixed-position popover mechanics as the track context menu.

function closeConnectMenu() {
  $('connect-menu').classList.remove('open');
}

function renderConnectMenu() {
  const menu = $('connect-menu');
  // Inbound-only entries have no address to send a take-over/push request to
  // — they only ever pull from us — so they don't belong in a picker of
  // session-transfer targets.
  const rows = lanStatus.peers.filter(p => !p.inbound).map(p => `
    <div class="cm-device" data-peer="${escapeHtml(p.deviceId)}">
      <div class="device-row" style="cursor:default">
        <svg class="i" width="14" height="14"><use href="#i-monitor"/></svg>
        <div class="device-body">
          <div class="device-name">${escapeHtml(p.name)}</div>
          <div class="device-meta">${escapeHtml(p.host) + (p.manual ? ' · ' + tr('lan.manual') : '')}</div>
        </div>
      </div>
      <div class="cm-device-actions">
        <button class="btn-ghost" data-act="take" title="${escapeHtml(tr('lan.takeOverHint'))}">${tr('lan.takeOver')}</button>
        <button class="btn-ghost" data-act="push" ${currentTrack ? '' : 'disabled'} title="${escapeHtml(tr('lan.pushHint'))}">${tr('lan.push')}</button>
      </div>
    </div>`).join('') || `<div class="device-empty">${tr('lan.noPeers')}</div>`;
  menu.innerHTML = `<div class="device-title cm-connect-title">${tr('lan.connect')}</div>${rows}`;
  menu.querySelectorAll('.cm-device').forEach(row => {
    row.addEventListener('click', e => {
      const act = e.target.closest('button') && e.target.closest('button').dataset.act;
      if (!act) return;
      const peer = lanPeer(row.dataset.peer);
      closeConnectMenu();
      if (act === 'take') lanTakeOver(peer);
      else if (act === 'push') lanPushTo(peer);
    });
  });
}

function openConnectMenu(anchorBtn) {
  renderConnectMenu();
  const menu = $('connect-menu');
  menu.classList.add('open');
  const b = anchorBtn.getBoundingClientRect();
  const w = 280, h = menu.getBoundingClientRect().height || 200;
  let x = b.right - w;
  if (x < 8) x = 8;
  let y = b.top - h - 8;
  if (y < 8) y = b.bottom + 8;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

$('btn-connect').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('connect-menu');
  if (menu.classList.contains('open')) { closeConnectMenu(); return; }
  openConnectMenu(e.currentTarget);
});
document.addEventListener('click', e => {
  if (!e.target.closest('#connect-menu') && !e.target.closest('#btn-connect')) closeConnectMenu();
});

// Master switch, separate from the Devices view's own enable-toggle: this one
// gates whether the feature is wired up at all. Off (the default) means no IPC
// listeners, no publishing, and any server left running from a previous
// version — before this flag existed — gets shut down.
let lanWired = false;
function lanEnableFeature() {
  if (!window.electronAPI || !window.electronAPI.lanStatus) return;
  if (!lanWired) {
    lanWired = true;
    window.electronAPI.onLanPeers(() => lanRefresh());
    window.electronAPI.onLanCommand(applyLanCommand);
    lanStartPublishing();
  }
  lanRefresh().then(() => { lanTracksDirty = true; lanConfigDirty = true; lanPublish(); });
}
function lanDisableFeature() {
  if (lanPollTimer) { clearInterval(lanPollTimer); lanPollTimer = null; }
  if (window.electronAPI && window.electronAPI.lanStatus) window.electronAPI.lanSetConfig({ enabled: false });
  lanStatus = Object.assign({}, lanStatus, { enabled: false, running: false, peers: [] });
  lanPeerLibraries = {};
  closeConnectMenu();
  const count = $('count-devices');
  if (count) count.textContent = '0';
  if (currentView === 'library') renderLibrary();
}
function applyLanSharingVisibility() {
  const nav = $('nav-devices');
  if (nav) nav.hidden = !settings.lanSharing;
  const connectBtn = $('btn-connect');
  if (connectBtn) connectBtn.hidden = !settings.lanSharing;
  if (settings.lanSharing) lanEnableFeature();
  else {
    if (currentView === 'devices') setView('library');
    lanDisableFeature();
  }
}
applyLanSharingVisibility();

applyLanguage(settings.language);
splashStatus('splash.loading');
renderSettings();
applyEq();   // build + activate the EQ graph if it was left enabled last session
syncGlobalHotkeys();
updateShuffleUI();
updateRepeatUI();
// Boot-time equivalent of a nav click for whichever page Settings' "Default
// page" points to — falls back to Library if it's a playlist that's since
// been deleted.
function openDefaultView() {
  const view = settings.defaultView || 'library';
  if (view === 'playlist-detail') {
    const pl = playlists.find(p => p.id === settings.defaultPlaylistId);
    if (pl) { activePlaylistId = pl.id; return setView('playlist-detail'); }
    return setView('library');
  }
  if (view === 'artists' || view === 'albums' || view === 'favorites') return setView(view);
  return setView('library');
}

(async () => {
  splashStatus('splash.covers');
  await warmCoversFromDisk();
  openDefaultView();
  renderRecents();
  loadLastTrack();
  restoreDownloadsState();
  hideBootOverlay();
  try { await restoreCovers(); } catch (_) { /* ignore */ }
  try { await rescanFolders(); } catch (_) { /* ignore */ }
  checkForUpdates();
  warmMissingCoversInBackground();
})();

function spawnDownloadParticles(btn) {
  if (!btn) return;
  btn.classList.remove('btn-dl-anim');
  void btn.offsetWidth;
  btn.classList.add('btn-dl-anim');
  setTimeout(() => btn.classList.remove('btn-dl-anim'), 800);
  const rect = btn.getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const colors = ['var(--accent)', 'var(--svc-ytm)', '#34d399', '#60a5fa', '#f59e0b'];
  for (let i = 0; i < 8; i++) {
    const p = document.createElement('div');
    p.className = 'dl-particle';
    const angle = (i / 8) * 2 * Math.PI + (Math.random() * 0.4 - 0.2);
    const dist = 22 + Math.random() * 18;
    p.style.setProperty('--tx', `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--ty', `${Math.sin(angle) * dist}px`);
    p.style.left = `${cx}px`;
    p.style.top = `${cy}px`;
    p.style.backgroundColor = colors[i % colors.length];
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 600);
  }
}

// ── In-app YouTube Music browser: search artist → releases → tracks → queue ───
// No browser/login/yt-dlp: reads the unauthenticated innertube API (main.js
// ytm:* handlers). Adding tracks reuses the exact download-queue path as the
// URL-based YT Music parser (buildQueueItemFromYtm → downloadQueue).
const ytmBrowser = (function () {
  let state = 'search';       // 'search' | 'releases' | 'album'
  let curArtist = null;
  let searchTimer = null;
  let artistAlbums = [], artistSingles = [];
  let albumPage = 1, singlesPage = 1;
  const PAGE_SIZE = 10;

  const el = id => $(id);
  const body = () => el('ytm-body');
  const setStatus = (msg, cls) => { const s = el('ytm-status'); if (s) { s.textContent = msg || ''; s.className = 'ytm-status' + (cls ? ' ' + cls : ''); } };
  const setHeader = (title, sub, showBack) => {
    el('ytm-title').textContent = title;
    el('ytm-sub').textContent = sub || '';
    el('ytm-back').hidden = !showBack;
  };
  const releaseKind = k => {
    const s = (k || '').toLowerCase();
    if (s.includes('single')) return 'single';
    if (s.includes('ep')) return 'ep';
    return 'album';
  };

  function open(prefillArtist) {
    setView('downloads');
    activateDlTab('ytmusic');
    const input = el('ytm-search');
    if (prefillArtist) {
      input.value = prefillArtist;
      goSearch();
      runSearch(prefillArtist, true);
    } else {
      goSearch();
      body().innerHTML = '';
      setStatus('');
      setTimeout(() => input.focus(), 50);
    }
  }

  function goSearch() {
    state = 'search';
    setHeader('YouTube Music', tr('ytm.sub'), false);
  }

  async function runSearch(q, autoOpenTop) {
    q = (q || '').trim();
    if (!q) { body().innerHTML = ''; setStatus(''); return; }
    state = 'search';
    setHeader('YouTube Music', tr('ytm.results', { q }), false);
    setStatus(tr('ytm.searching'));
    let res;
    try { res = await window.electronAPI.ytmSearchArtists(q); }
    catch (e) { setStatus(String(e), 'error'); return; }
    if (!res || !res.success) { setStatus((res && res.error) || tr('ytm.searchFailed'), 'error'); return; }
    if (!res.artists.length) { body().innerHTML = ''; setStatus(tr('ytm.noArtists')); return; }
    setStatus('');
    if (autoOpenTop) { openArtist(res.artists[0]); return; }
    body().innerHTML = res.artists.map((a, i) => `
      <div class="ytm-artist-row" data-i="${i}">
        <div class="ytm-artist-av" style="${a.thumb ? `background-image:url('${a.thumb}')` : ''}"></div>
        <div class="ytm-artist-name">${escapeHtml(a.name)}</div>
      </div>`).join('');
    body().querySelectorAll('.ytm-artist-row').forEach(row =>
      row.addEventListener('click', () => openArtist(res.artists[+row.dataset.i])));
  }

  function renderReleases() {
    const totalAlbumPages = Math.max(1, Math.ceil(artistAlbums.length / PAGE_SIZE));
    const totalSinglePages = Math.max(1, Math.ceil(artistSingles.length / PAGE_SIZE));

    const pagedAlbums = artistAlbums.slice((albumPage - 1) * PAGE_SIZE, albumPage * PAGE_SIZE);
    const pagedSingles = artistSingles.slice((singlesPage - 1) * PAGE_SIZE, singlesPage * PAGE_SIZE);

    const section = (title, list, fullList, page, totalPages, kind) => {
      if (!fullList.length) return '';
      const pager = totalPages > 1 ? `
        <div class="ytm-pagination">
          <button class="btn-ghost btn-sm ytm-prev" data-kind="${kind}" ${page <= 1 ? 'disabled' : ''}>‹</button>
          <span class="ytm-page-info">${page} / ${totalPages}</span>
          <button class="btn-ghost btn-sm ytm-next" data-kind="${kind}" ${page >= totalPages ? 'disabled' : ''}>›</button>
        </div>` : '';
      return `
        <div class="ytm-group-head">
          <div class="ytm-group-title">${title} <span class="ytm-group-count">(${fullList.length})</span></div>
          ${pager}
        </div>
        <div class="ytm-releases">
          ${list.map(r => `
            <div class="ytm-release" data-id="${escapeHtml(r.albumBrowseId)}">
              <div class="ytm-release-cover" style="${r.thumb ? `background-image:url('${r.thumb}')` : ''}">
                <button class="btn-solid icon-only ytm-add-all" title="${escapeHtml(tr('ytm.addAll'))}"><svg class="i" width="12" height="12"><use href="#i-plus"/></svg></button>
              </div>
              <div class="ytm-release-title" title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</div>
              <div class="ytm-release-meta">${escapeHtml([r.kind, r.year].filter(Boolean).join(' · '))}</div>
            </div>`).join('')}
        </div>`;
    };

    body().innerHTML = section(tr('ytm.albums'), pagedAlbums, artistAlbums, albumPage, totalAlbumPages, 'album') +
      section(tr('ytm.singles'), pagedSingles, artistSingles, singlesPage, totalSinglePages, 'single');

    body().querySelectorAll('.ytm-prev').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.kind === 'album' && albumPage > 1) { albumPage--; renderReleases(); }
        else if (btn.dataset.kind === 'single' && singlesPage > 1) { singlesPage--; renderReleases(); }
      });
    });
    body().querySelectorAll('.ytm-next').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.kind === 'album' && albumPage < totalAlbumPages) { albumPage++; renderReleases(); }
        else if (btn.dataset.kind === 'single' && singlesPage < totalSinglePages) { singlesPage++; renderReleases(); }
      });
    });

    body().querySelectorAll('.ytm-release').forEach(card => {
      const id = card.dataset.id;
      const r = (artistAlbums.concat(artistSingles)).find(x => x.albumBrowseId === id);
      if (!r) return;
      const addBtn = card.querySelector('.ytm-add-all');
      addBtn.addEventListener('click', e => {
        e.stopPropagation();
        spawnDownloadParticles(addBtn);
        quickAdd(r);
      });
      card.addEventListener('click', () => openAlbum(r));
    });
  }

  async function openArtist(artist) {
    curArtist = artist;
    state = 'releases';
    setHeader(artist.name, tr('ytm.releases'), true);
    setStatus(tr('ytm.loadingReleases'));
    body().innerHTML = '';
    let res;
    try { res = await window.electronAPI.ytmArtistReleases(artist.browseId); }
    catch (e) { setStatus(String(e), 'error'); return; }
    if (!res || !res.success) { setStatus((res && res.error) || tr('ytm.releasesFailed'), 'error'); return; }
    if (!res.releases.length) { setStatus(tr('ytm.noReleases')); return; }
    setStatus('');
    artistAlbums = res.releases.filter(r => releaseKind(r.kind) === 'album');
    artistSingles = res.releases.filter(r => releaseKind(r.kind) !== 'album');
    albumPage = 1; singlesPage = 1;
    renderReleases();
  }

  // Album metadata (cover/artist/year) + the canonical share URL, from the fast
  // innertube endpoint — drives the browse UI.
  async function loadAlbum(r) {
    try { return await window.electronAPI.ytmAlbumTracks(r.albumBrowseId); }
    catch (e) { return { success: false, error: String(e) }; }
  }

  // Resolve a release to the SAME track list the Downloads "Parsing" tab would
  // produce from its share link, so downloads go through one identical yt-dlp
  // path instead of a second, divergent metadata extraction. Cached per URL.
  const parseCache = new Map();
  async function parsedTracksFor(al) {
    if (!al || !al.shareUrl) return null;
    if (parseCache.has(al.shareUrl)) return parseCache.get(al.shareUrl);
    let tracks = null;
    try {
      const res = await window.electronAPI.ytMusicParse({ url: al.shareUrl });
      if (res && res.success && Array.isArray(res.tracks)) tracks = res.tracks;
    } catch (_) { /* fall back to innertube ids below */ }
    parseCache.set(al.shareUrl, tracks);
    return tracks;
  }

  // Innertube track → the parse-tab track shape, as a fallback when a release
  // has no OLAK5uy share URL (or parsing failed). Still downloads by exact id.
  const asParseTrack = t => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration, explicit: t.explicit, url: `https://music.youtube.com/watch?v=${t.id}` });

  // Enqueue exactly like the Parsing tab's "Queue all": parsed track → the
  // shared buildQueueItemFromYtm → downloadQueue. One path, no album threading.
  function enqueueParsed(tracks, startNo = 1) {
    let added = 0;
    tracks.forEach((t, i) => {
      if (isYtmTrackInQueue(t)) return;
      downloadQueue.push(buildQueueItemFromYtm(t, startNo + i));
      added++;
    });
    if (added) { renderQueue(); updateQueueTabBadge(); startQueueWorker(); }
    return added;
  }

  async function addWholeRelease(al) {
    const parsed = await parsedTracksFor(al);
    const tracks = parsed && parsed.length ? parsed : al.tracks.map(asParseTrack);
    return enqueueParsed(tracks);
  }

  async function quickAdd(r) {
    setStatus(tr('ytm.loadingName', { name: r.title }));
    const al = await loadAlbum(r);
    if (!al || !al.success) { setStatus((al && al.error) || tr('ytm.albumFailed'), 'error'); return; }
    const name = al.album || r.title;
    setStatus(tr('ytm.addingName', { name }));
    const n = await addWholeRelease(al);
    setStatus(n ? tr('ytm.addedFrom', { count: withCount('tracks', n), name }) : tr('ytm.already'));
  }

  async function openAlbum(r) {
    state = 'album';
    setHeader(r.title, tr('ytm.loading'), true);
    setStatus(tr('ytm.loadingTracks'));
    body().innerHTML = '';
    const al = await loadAlbum(r);
    if (!al || !al.success) { setStatus((al && al.error) || tr('ytm.albumFailed'), 'error'); return; }
    setStatus('');
    setHeader(al.album || r.title, [al.artist, al.year].filter(Boolean).join(' · '), true);
    renderAlbum(al);
  }

  function renderAlbum(al) {
    const head = `
      <div class="ytm-album-head">
        <div class="ytm-album-cover" style="${al.cover ? `background-image:url('${al.cover}')` : ''}"></div>
        <div class="ytm-album-info">
          <div class="ytm-album-name">${escapeHtml(al.album || '')}</div>
          <div class="ytm-album-sub">${escapeHtml([al.artist, al.year, withCount('tracks', al.tracks.length)].filter(Boolean).join(' · '))}</div>
          <div style="margin-top:10px"><button class="btn-solid" id="ytm-add-album"><svg class="i" width="12" height="12"><use href="#i-plus"/></svg><span>${escapeHtml(tr('ytm.addAll'))}</span></button></div>
        </div>
      </div>`;
    const rows = al.tracks.map((t, i) => `
      <div class="ytm-track${isYtmTrackInQueue({ id: t.id }) ? ' queued' : ''}" data-i="${i}">
        <div class="ytm-track-no">${i + 1}</div>
        <div class="ytm-track-title">${escapeHtml(t.title)}${t.explicit ? '<span class="ytm-e">E</span>' : ''}</div>
        <div class="ytm-track-dur">${escapeHtml(t.duration || '')}</div>
        <button class="btn-ic ytm-add" title="${escapeHtml(tr('ytm.addOne'))}"><svg class="i" width="14" height="14"><use href="#i-plus"/></svg></button>
      </div>`).join('');
    body().innerHTML = head + rows;
    el('ytm-add-album').addEventListener('click', async () => {
      const btn = el('ytm-add-album');
      spawnDownloadParticles(btn);
      setStatus(tr('ytm.adding'));
      const n = await addWholeRelease(al);
      setStatus(n ? tr('ytm.added', { count: withCount('tracks', n) }) : tr('ytm.already'));
      renderAlbum(al);
    });
    body().querySelectorAll('.ytm-track').forEach(row => {
      row.querySelector('.ytm-add').addEventListener('click', async () => {
        const btn = row.querySelector('.ytm-add');
        spawnDownloadParticles(btn);
        const i = +row.dataset.i;
        const t = al.tracks[i];
        setStatus(tr('ytm.adding'));
        // Prefer the parse-tab track for this exact id so its download handling
        // is identical to the direct-link path; fall back to the id itself.
        const parsed = await parsedTracksFor(al);
        const track = (parsed && parsed.find(p => p.id === t.id)) || asParseTrack(t);
        if (enqueueParsed([track], i + 1)) { row.classList.add('queued'); setStatus(tr('ytm.addedOne')); }
        else setStatus(tr('ytm.already'));
      });
    });
  }

  (function wire() {
    el('ytm-back').addEventListener('click', () => {
      if (state === 'album' && curArtist) openArtist(curArtist);
      else { goSearch(); runSearch(el('ytm-search').value); }
    });
    const input = el('ytm-search');
    input.addEventListener('input', () => { clearTimeout(searchTimer); const v = input.value; searchTimer = setTimeout(() => runSearch(v), 350); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(input.value); } });
    const btn = el('btn-artist-ytm');
    if (btn) btn.addEventListener('click', () => open(activeArtistName || el('artist-detail-title').textContent || ''));
  })();

  return { open };
})();
