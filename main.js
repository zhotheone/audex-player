const { app, BrowserWindow, ipcMain, dialog, shell, screen, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const { pathToFileURL, fileURLToPath } = require('url');
const musicMetadata = require('music-metadata');
const lan = require('./lan');

app.setName('Audex');

// ── Global app log ──
// General-purpose error log next to update-error.log, for troubleshooting
// crashes that have nowhere else to surface (no menu bar, no DevTools
// shortcut). Catches both main-process crashes and renderer-reported errors
// (see 'renderer:logError' below and the window.onerror hook in renderer.js).
function appendLog(fileName, where, err) {
  const line = `[${new Date().toISOString()}] ${where}: ${String(err && err.stack || err)}\n`;
  try { fs.appendFileSync(path.join(app.getPath('userData'), fileName), line); } catch (_) {}
}
function logAppError(where, err) { appendLog('app.log', where, err); }
process.on('uncaughtException', (err) => logAppError('main:uncaughtException', err));
process.on('unhandledRejection', (err) => logAppError('main:unhandledRejection', err));

// Single-instance lock. Two Electron processes pointed at the same userData
// directory can both open the localStorage LevelDB and corrupt it (lost library
// + settings). If another instance already holds the lock, quit immediately and
// just focus the existing window instead of opening a second one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── GPU / hardware-acceleration fallback ──
// Some Windows 10 GPU drivers make Electron hang on launch ("not responding").
// We disable hardware acceleration when either:
//   • the AUDEX_DISABLE_GPU env var or the --disable-gpu CLI flag is present, or
//   • a `disable-gpu` marker file exists in userData. The marker is written
//     automatically the first time the window goes unresponsive (see
//     createWindow), so the *next* launch comes up without GPU and works.
// Must run at module load, before app is ready, for disableHardwareAcceleration
// to take effect.
const gpuMarkerPath = path.join(app.getPath('userData'), 'disable-gpu');
function isGpuDisabled() {
  if (process.env.AUDEX_DISABLE_GPU) return true;
  if (process.argv.includes('--disable-gpu')) return true;
  try { return fs.existsSync(gpuMarkerPath); } catch (_) { return false; }
}
if (isGpuDisabled()) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let trayState = {
  hasTrack: false,
  isPlaying: false,
  isFavorite: false,
  title: '',
  artist: '',
};

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function sendTrayCommand(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('tray:command', { action }); } catch (_) {}
}

// ── Global (system-wide) hotkeys ──
// The renderer owns the binding table and hands us a ready list of
// { id, accelerator } pairs; we register them with the OS so they fire while
// the window is minimised or unfocused, and forward each hit back by id.
// Registration is all-or-nothing per accelerator: another app may already own
// a combo, in which case register() returns false and we report the id back so
// the Settings UI can flag it instead of silently doing nothing.
let registeredGlobalHotkeys = [];
function clearGlobalHotkeys() {
  for (const acc of registeredGlobalHotkeys) {
    try { globalShortcut.unregister(acc); } catch (_) {}
  }
  registeredGlobalHotkeys = [];
}

// Wayland deliberately forbids applications from grabbing global keys — the
// compositor owns them — so globalShortcut.register() fails for *every*
// accelerator there, including obviously free ones. Probe once with a combo
// nothing realistically owns so the UI can say "not available in this session"
// instead of wrongly blaming another app for taking the shortcut.
// (On Wayland the working path is MPRIS: the media keys and any compositor
// shortcut wired to org.mpris.MediaPlayer2 already drive playback.)
const GLOBAL_PROBE_ACCELERATOR = 'Control+Alt+Shift+F24';
let globalShortcutsSupported = null;
function probeGlobalShortcutSupport() {
  if (globalShortcutsSupported !== null) return globalShortcutsSupported;
  let ok = false;
  try {
    ok = globalShortcut.register(GLOBAL_PROBE_ACCELERATOR, () => {});
    if (ok) globalShortcut.unregister(GLOBAL_PROBE_ACCELERATOR);
  } catch (_) {
    ok = false;
  }
  globalShortcutsSupported = ok;
  return ok;
}

ipcMain.handle('hotkeys:registerGlobal', (event, list) => {
  clearGlobalHotkeys();
  const supported = probeGlobalShortcutSupport();
  if (!supported) {
    return { success: true, supported: false, failed: [], registered: 0 };
  }
  const failed = [];
  for (const item of Array.isArray(list) ? list : []) {
    const accelerator = String((item && item.accelerator) || '');
    const id = String((item && item.id) || '');
    if (!accelerator || !id) continue;
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        try { mainWindow.webContents.send('hotkeys:trigger', { id }); } catch (_) {}
      });
    } catch (_) {
      ok = false; // malformed accelerator — treat like a taken combo
    }
    if (ok) registeredGlobalHotkeys.push(accelerator);
    else failed.push(id);
  }
  return { success: true, supported: true, failed, registered: registeredGlobalHotkeys.length };
});

// Leaving a grab behind would keep the combo dead for the rest of the session.
app.on('will-quit', clearGlobalHotkeys);

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.opus', '.flac', '.m4a', '.aac']);

function scanDir(dirPath) {
  let results = [];
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dirPath, item.name);
      if (item.isDirectory()) {
        results = results.concat(scanDir(fullPath));
      } else if (AUDIO_EXTENSIONS.has(path.extname(item.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  } catch (e) { /* skip unreadable dirs */ }
  return results;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#0a0a0b',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    }
  });

  // Remove the application menu entirely so Alt / Shift+Alt can't reveal the
  // (File/Edit/View/Window) menu bar. autoHideMenuBar only hides it until Alt.
  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.autoHideMenuBar = true;

  // Side effect of no application menu: Electron normally wires Ctrl/Cmd+C/V/X/A/Z
  // to Chromium's edit commands through that menu's accelerators, so with none,
  // copy/paste/select-all silently stop working in every text field (e.g. copying
  // a generated LAN sharing key to paste on another device). Re-wire just the
  // commands via webContents, not a visible menu, so Alt still reveals nothing.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt) return;
    if (!(process.platform === 'darwin' ? input.meta : input.control)) return;
    const wc = mainWindow.webContents;
    switch (input.key.toLowerCase()) {
      case 'c': wc.copy(); break;
      case 'x': wc.cut(); break;
      case 'v': wc.paste(); break;
      case 'a': wc.selectAll(); break;
      case 'z': input.shift ? wc.redo() : wc.undo(); break;
    }
  });

  // Show only once the renderer has painted its first frame — avoids the blank
  // white window that otherwise flashes (and looks like a freeze) on slow boots.
  // The renderer paints the boot overlay (#boot-overlay in index.html) first,
  // so what appears is the loader screen.
  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
  // ready-to-show is flaky on some Wayland/GPU combos — it occasionally never
  // fires, leaving the app tray-only. Guarantee a visible window regardless:
  // if it still isn't visible shortly after creation, show it anyway (worst
  // case the user briefly sees the background color instead of the first
  // painted frame).
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 2000);

  // If the renderer hangs (common with broken GPU drivers on Windows 10), drop a
  // marker so the next launch disables hardware acceleration, and offer an
  // immediate restart. No-op once we're already running without GPU.
  mainWindow.on('unresponsive', () => {
    if (isGpuDisabled()) return;
    try { fs.writeFileSync(gpuMarkerPath, '1'); } catch (_) { /* ignore */ }
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Restart', 'Wait'],
      defaultId: 0,
      cancelId: 1,
      title: 'Audex is not responding',
      message: 'The app looks frozen because of hardware acceleration.',
      detail: 'Restart with hardware acceleration disabled? This often helps on Windows.',
    });
    if (choice === 0) {
      isQuitting = true;
      app.relaunch();
      app.exit(0);
    }
  });

  mainWindow.loadFile('index.html');

  // Close to tray instead of quitting — only an explicit Quit (menu / app.quit)
  // sets isQuitting and lets the window actually close.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (process.platform === 'darwin') {
        try { app.dock && app.dock.hide(); } catch (_) {}
      }
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; refreshTray(); });
  mainWindow.on('show', () => refreshTray());
  mainWindow.on('hide', () => refreshTray());
}

// Cross-platform tray icon. Windows prefers .ico (multi-size); macOS and
// Linux load the full-color 1024×1024 source and let nativeImage resize it
// to the menu-bar / AppIndicator size — the small pre-rendered indexed-color
// PNGs in build/icons render blank under some Linux indicators.
function resolveTrayIconPath() {
  const base = path.join(__dirname, 'build');
  if (process.platform === 'win32') {
    const ico = path.join(base, 'icon.ico');
    if (fs.existsSync(ico)) return ico;
  }
  return path.join(base, 'icon.png');
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === 'darwin') {
    try { app.dock && app.dock.show(); } catch (_) {}
  }
}

function buildTrayMenu() {
  const { hasTrack, isPlaying, isFavorite, title, artist } = trayState;

  const nowPlayingLabel = hasTrack
    ? truncate(`${title}${artist ? ' — ' + artist : ''}`, 60)
    : 'Nothing is playing';

  return Menu.buildFromTemplate([
    { label: nowPlayingLabel, enabled: false },
    { type: 'separator' },
    {
      label: !hasTrack ? 'Play' : (isPlaying ? 'Pause' : 'Play'),
      enabled: hasTrack || true, // even with no track, triggers "play first track"
      click: () => sendTrayCommand('playPause'),
    },
    {
      label: 'Previous track',
      enabled: hasTrack,
      click: () => sendTrayCommand('prev'),
    },
    {
      label: 'Next track',
      enabled: hasTrack,
      click: () => sendTrayCommand('next'),
    },
    {
      label: isFavorite ? 'Remove from favourites' : 'Add to favourites',
      enabled: hasTrack,
      click: () => sendTrayCommand('toggleFavorite'),
    },
    { type: 'separator' },
    { label: 'Open Audex', click: () => showMainWindow() },
    {
      label: 'Hide window',
      enabled: !!(mainWindow && mainWindow.isVisible()),
      click: () => { if (mainWindow && mainWindow.isVisible()) mainWindow.hide(); },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { isQuitting = true; app.quit(); },
    },
  ]);
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  const tip = trayState.hasTrack
    ? truncate(`Audex — ${trayState.isPlaying ? '▶' : '❚❚'} ${trayState.title}${trayState.artist ? ' — ' + trayState.artist : ''}`, 120)
    : 'Audex';
  tray.setToolTip(tip);
}

function createTray() {
  if (tray) return;
  const iconPath = resolveTrayIconPath();
  let image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) {
    if (process.platform === 'darwin') {
      image = image.resize({ width: 16, height: 16 });
    } else if (process.platform === 'linux') {
      // GNOME AppIndicator and KDE StatusNotifier both render best around
      // 22–24px; full-color RGBA scales cleanly from the 1024px source.
      image = image.resize({ width: 22, height: 22 });
    }
    // Windows uses .ico (already multi-size) — no resize needed.
  }
  tray = new Tray(image);
  refreshTray();

  // Single click toggles the window on Windows/Linux. macOS opens the menu by
  // default; users can double-click to open the window.
  const onActivate = () => {
    if (!mainWindow || !mainWindow.isVisible()) {
      showMainWindow();
    } else {
      mainWindow.hide();
    }
  };
  tray.on('click', onActivate);
  tray.on('double-click', () => showMainWindow());
}

ipcMain.handle('tray:updateState', (event, state) => {
  trayState = {
    hasTrack: !!(state && state.hasTrack),
    isPlaying: !!(state && state.isPlaying),
    isFavorite: !!(state && state.isFavorite),
    title: (state && state.title) || '',
    artist: (state && state.artist) || '',
  };
  refreshTray();
  return { success: true };
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  startLan();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
});

app.on('before-quit', () => { isQuitting = true; lan.stop(); });

// ── LAN / Tailscale sharing ──
// The server lives here (it needs the filesystem and a real socket) but the
// library and the player live in the renderer, so the renderer publishes a
// snapshot on every change and remote commands are forwarded back to it.
function toRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send(channel, payload); } catch (_) {}
  }
}

function startLan() {
  lan.load({
    userDataDir: app.getPath('userData'),
    coverDir: coverCacheDir(),
    logError: logAppError,
    sendCommand: (cmd) => toRenderer('lan:command', cmd),
    onPeersChanged: (peers) => toRenderer('lan:peers', peers),
  });
}

ipcMain.handle('lan:status', () => lan.status());
ipcMain.handle('lan:setConfig', (event, next) => lan.setConfig(next || {}));
ipcMain.handle('lan:publish', (event, snap) => { lan.publish(snap); return true; });
ipcMain.handle('lan:addPeer', (event, addr) => lan.addManualPeer(addr));
ipcMain.handle('lan:removePeer', (event, id) => lan.removePeer(id));
ipcMain.handle('lan:wsRequest', (event, deviceId, route, body) => lan.wsRequest(deviceId, route, body));

// Tray keeps the app alive when all windows are closed — don't quit on
// window-all-closed (mac already kept the app alive; we now do the same
// on Linux/Windows so the tray icon persists).

// Portrait ("mobile player") mode: shrinks the window to a tall narrow size and
// remembers the previous bounds + minimum size so we can restore them on exit.
// We resize synchronously here rather than interpolating frame-by-frame because
// the renderer drives a FLIP-based cover animation that needs the *final*
// layout to be in effect at measurement time. A staggered window resize would
// give the renderer a moving target and the cover would snap at the end.
let portraitSavedBounds = null;
let portraitSavedMinSize = null;
ipcMain.handle('window:setPortrait', async (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false };
  const on = !!(payload && payload.on);
  const portraitW = 420;
  const portraitH = 780;

  // If the OS window is in fullscreen, don't resize — that would forcibly exit
  // fullscreen. The CSS in `.is-portrait` already adapts the layout to any width,
  // so a centered mobile column will render inside the fullscreen viewport.
  if (win.isFullScreen()) {
    return { success: true, fullscreen: true };
  }

  if (on) {
    if (!portraitSavedBounds) {
      portraitSavedBounds = win.getBounds();
      portraitSavedMinSize = win.getMinimumSize();
    }
    win.setMinimumSize(320, 560);
    const display = screen.getDisplayMatching(win.getBounds());
    win.setBounds({
      width: portraitW,
      height: portraitH,
      x: Math.round(display.workArea.x + (display.workArea.width - portraitW) / 2),
      y: Math.round(display.workArea.y + (display.workArea.height - portraitH) / 2),
    }, false);
  } else {
    if (portraitSavedMinSize) win.setMinimumSize(portraitSavedMinSize[0], portraitSavedMinSize[1]);
    if (portraitSavedBounds) win.setBounds(portraitSavedBounds, false);
    portraitSavedBounds = null;
    portraitSavedMinSize = null;
  }
  // An un-animated setBounds growing the window can leave the compositor
  // showing a stale frame in the newly-exposed area until something forces a
  // repaint — visible as a sliver of the old (pre-fullscreen) layout at the
  // window edge after toggling portrait mode back off. Force one explicitly.
  win.webContents.invalidate();
  return { success: true };
});

// ── Trending charts ──
// YouTube Music publishes per-country "Top 100 Songs" playlists on a single
// charts channel, and their ids are stable. yt-dlp reads them flat (one request,
// no per-video lookups), which is why a full 100-track chart lands in a few
// seconds. Only the chart id travels from the renderer — it is matched against
// this table rather than being interpolated into a URL, so a bad value can't
// point yt-dlp at an arbitrary page.
const TRENDING_CHARTS = {
  // Per-country "Top 100 Songs" — YouTube Music's official charts channel.
  global:  'PL4fGSI1pDJn6puJdseH2Rt9sMvt9E2M4i',
  ukraine: 'PL4fGSI1pDJn4E_HoW5HB-w5vFPkYfo3dB',
  usa:     'PL4fGSI1pDJn6O1LS0XSdF3RyO0Rq_LDeI',
  uk:      'PL4fGSI1pDJn6_f5P3MnzXg9l3GDfnSlXa',
  germany: 'PL4fGSI1pDJn6KpOXlp0MH8qA9tngXaUJ-',
  france:  'PL4fGSI1pDJn7bK3y1Hx-qpHBqfr6cesNs',
  turkey:  'PL4fGSI1pDJn5tdVDtIAZArERm_vv4uFCR',
  poland:  'PL4fGSI1pDJn68fmsRw9f6g-NzU5UA45v1',
  // Per-genre — YouTube Music's official curated "<Genre> Hits" playlists
  // (RDCLAK5uy_ prefix). Like the country charts these flat-list into individual
  // songs in one request. Keys are prefixed `g_` so they never collide with a
  // country code.
  g_pop:        'RDCLAK5uy_l6kmbwVnzKyu31exvtuxnFkjswnNgI6Uw',
  g_hiphop:     'RDCLAK5uy_lX24L_CGP46xH6pM4FgXpX4yNr3jX9xpU',
  g_rock:       'RDCLAK5uy_k54Zr5UY8lb-LJx1XLj0q4rH355y9dJV8',
  g_electronic: 'RDCLAK5uy_khFJzdpmtk0_MaUuWNgqYbNamuGV623kk',
  g_phonk:      'RDCLAK5uy_lbdY2I_FKUrzQOGiOQxV0Ux_b3HH2dfc8',
  g_rnb:        'RDCLAK5uy_kYUaBqUZxA0VpgN2xsHNUnVoLu8-JGXk8',
  g_chill:      'RDCLAK5uy_kycx4KP0Kj3BcUEZN4RDhGEjUce2UPqEc',
  g_metal:      'RDCLAK5uy_k0Gg0qAR50hC6S3gxvO4KPQ6avEgAu6ho',
  g_latin:      'RDCLAK5uy_lw21MuKaqFsDBIPZSbRmZcoDrHmV_c6uY',
  g_kpop:       'RDCLAK5uy_k27uu-EtQ_b5U2r26DNDZOmNqGdccUIGQ',
  g_jazz:       'RDCLAK5uy_kL57PLcOmExjhzqGfGhvA82ZWe4fPH2c4',
  g_classical:  'RDCLAK5uy_kVXmNQjiBEKjCGifBWc3eTMg8Fwjc6K8M',
  g_country:    'RDCLAK5uy_kpxnNxJpPZjLKbL9WgvrPuErWkUxMP6x4',
};

// "Artist - Title (Official Video)" is the chart's naming convention; split it
// so rows show a real artist column instead of one long string.
const TRENDING_NOISE = new RegExp(
  '\\s*[([]\\s*(?:' + [
    'mv', 'm/v',
    'official\\s*(?:music\\s*)?video', 'official\\s*audio', 'official\\s*visuali[sz]er',
    'music\\s*video', 'video\\s*premiere[^)\\]]*', 'visuali[sz]er',
    'lyrics?(?:\\s*video)?', 'mood\\s*video', 'clip\\s*officiel',
  ].join('|') + ')\\s*[)\\]]\\s*', 'gi');
function splitTrendingTitle(raw) {
  let s = String(raw || '').replace(TRENDING_NOISE, ' ').trim();
  const dash = s.indexOf(' - ');
  if (dash > 0) {
    return { artist: s.slice(0, dash).trim(), title: s.slice(dash + 3).trim() || s };
  }
  return { artist: '', title: s };
}

ipcMain.handle('trending:fetch', async (event, payload) => {
  const region = String((payload && payload.region) || 'global');
  const listId = TRENDING_CHARTS[region];
  if (!listId) return { success: false, error: 'Unknown region' };
  const bin = ytDlpPath();
  const url = `https://music.youtube.com/playlist?list=${listId}`;
  const args = ['--flat-playlist', '--dump-json', '--playlist-end', '100',
                '--no-warnings', '--ignore-config', url];
  return new Promise((resolve) => {
    let out = '', err = '';
    let proc;
    try {
      proc = spawn(bin, args);
    } catch (e) {
      return resolve({ success: false, error: String((e && e.message) || e) });
    }
    // A hung chart fetch must not leave the tab spinning forever.
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 90000);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', (e) => {
      clearTimeout(killer);
      resolve({ success: false, error: e && e.code === 'ENOENT'
        ? 'yt-dlp not found. Install it: pip install -U yt-dlp'
        : String((e && e.message) || e) });
    });
    proc.on('close', () => {
      clearTimeout(killer);
      const tracks = [];
      for (const line of out.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        let j;
        try { j = JSON.parse(s); } catch (_) { continue; }
        if (!j.id) continue;
        const { artist, title } = splitTrendingTitle(j.title);
        const thumb = Array.isArray(j.thumbnails) && j.thumbnails.length
          ? j.thumbnails[j.thumbnails.length - 1].url : '';
        tracks.push({
          id: j.id,
          url: j.url || `https://www.youtube.com/watch?v=${j.id}`,
          rawTitle: j.title || '',
          title, artist,
          duration: Number(j.duration) || 0,
          thumbnail: thumb,
        });
      }
      if (!tracks.length) {
        return resolve({ success: false, error: err.trim().split('\n').slice(-2).join(' ') || 'Empty chart' });
      }
      resolve({ success: true, region, tracks, fetchedAt: Date.now() });
    });
  });
});

// ── Custom background image ──
// The picked file is *copied* into <userData>/backgrounds/ rather than
// referenced in place: the setting only stores a path, so a wallpaper the user
// later moves or deletes would otherwise silently blank the background. Old
// copies are pruned so the folder can't grow without bound.
ipcMain.handle('appearance:pickBackground', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'] }],
  });
  if (canceled || !filePaths.length) return { success: false, canceled: true };
  const src = filePaths[0];
  try {
    const dir = path.join(app.getPath('userData'), 'backgrounds');
    fs.mkdirSync(dir, { recursive: true });
    const ext = (path.extname(src) || '.jpg').toLowerCase();
    const hash = crypto.createHash('sha1').update(src + String(Date.now())).digest('hex').slice(0, 16);
    const dest = path.join(dir, hash + ext);
    await fs.promises.copyFile(src, dest);
    // Keep only the newest copy — there is a single active background.
    for (const name of await fs.promises.readdir(dir)) {
      if (name !== path.basename(dest)) {
        try { await fs.promises.unlink(path.join(dir, name)); } catch (_) {}
      }
    }
    return { success: true, url: pathToFileURL(dest).href, name: path.basename(src) };
  } catch (err) {
    return { success: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('appearance:clearBackground', async () => {
  try {
    const dir = path.join(app.getPath('userData'), 'backgrounds');
    if (fs.existsSync(dir)) {
      for (const name of await fs.promises.readdir(dir)) {
        try { await fs.promises.unlink(path.join(dir, name)); } catch (_) {}
      }
    }
  } catch (_) { /* best effort */ }
  return { success: true };
});

ipcMain.handle('dialog:openFiles', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections', 'openDirectory'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'opus', 'flac', 'm4a', 'aac'] }]
  });
  if (canceled) return [];

  let allFiles = [];
  for (const p of filePaths) {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      allFiles = allFiles.concat(scanDir(p));
    } else {
      allFiles.push(p);
    }
  }
  return allFiles;
});

ipcMain.handle('dialog:chooseFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  if (canceled || filePaths.length === 0) return null;
  return filePaths[0];
});

ipcMain.handle('music:scanFolder', async (event, folderPath) => {
  if (!folderPath || !fs.existsSync(folderPath)) return [];
  return scanDir(folderPath);
});

// Tier 1 quality — everything derivable from the file header at parse time
// (no audio decoding). music-metadata's `format` block already exposes the
// codec, true average bitrate (Xing/Info for VBR), sample rate, the LAME
// preset via `codecProfile`, and the encoder tool. The Tier 2 spectral
// transcode detector (in the renderer) fills in `cutoffKHz` and may upgrade
// `tier` to 'suspicious' later. See design_handoff_track_quality/README.md.
function buildQuality(format) {
  if (!format) return null;
  const codec = String(format.codec || '').toUpperCase();
  const container = String(format.container || '').toUpperCase();
  const both = codec + ' ' + container;
  const lossless = !!format.lossless;

  let fmt;
  if (/FLAC/.test(both)) fmt = 'FLAC';
  else if (/ALAC/.test(both)) fmt = 'ALAC';
  else if (/AAC|MP4|M4A|MPEG-4/.test(both)) fmt = 'AAC';
  else if (/VORBIS|OPUS|OGG/.test(both)) fmt = 'OGG';
  else if (/WAV|PCM|WAVE/.test(both)) fmt = 'WAV';
  else if (/MPEG|MP3|LAYER 3/.test(both)) fmt = 'MP3';
  else fmt = codec || container || '—';

  const bitrate = format.bitrate ? Math.round(format.bitrate / 1000) : 0;
  const sampleRate = format.sampleRate || 0;
  const encoder = format.tool || '';
  const hasLame = /LAME/i.test(encoder);

  // codecProfile is the LAME preset for MP3: "V0".."V9" (VBR) or "CBR"/"CVBR".
  const profile = String(format.codecProfile || '').trim();
  const vbrMatch = profile.match(/^V\s*([0-9])/i);
  let mode;
  if (lossless) mode = 'Lossless';
  else if (vbrMatch || /VBR/i.test(profile)) mode = 'VBR';
  else mode = 'CBR';

  let preset = '';
  if (vbrMatch) preset = '-V ' + vbrMatch[1];
  else if (mode === 'CBR' && bitrate) preset = '-b ' + bitrate;

  // Tier 1 classification (spectral analysis may later flag 'suspicious').
  let tier;
  const vLevel = vbrMatch ? parseInt(vbrMatch[1], 10) : null;
  if (lossless) tier = 'lossless';
  else if (bitrate >= 320 || vLevel === 0 || vLevel === 1) tier = 'high';
  else if (bitrate >= 192 || (vLevel !== null && vLevel <= 4)) tier = 'good';
  else tier = 'low';

  return { format: fmt, bitrate, mode, sampleRate,
    channels: format.numberOfChannels || 0,
    bitsPerSample: format.bitsPerSample || 0,
    encoder, preset, hasLame, lossless, tier, cutoffKHz: null };
}

// ── Persistent cover cache ──
// Extracted cover art is written to <userData>/cover-cache/<sha1(trackPath)>.<ext>
// the first time a track is parsed. On boot the renderer bulk-loads the whole
// cache in one 'covers:load' IPC (file:// URLs, no metadata parsing), so covers
// are available instantly instead of being re-extracted from the audio files
// every session.
function coverCacheDir() {
  return path.join(app.getPath('userData'), 'cover-cache');
}
function coverCacheHash(trackPath) {
  return crypto.createHash('sha1').update(String(trackPath)).digest('hex');
}
function coverExt(format) {
  const f = String(format || '').toLowerCase();
  if (f.includes('png')) return 'png';
  if (f.includes('webp')) return 'webp';
  return 'jpg';
}
async function saveCoverToCache(trackPath, picture) {
  try {
    const dir = coverCacheDir();
    const file = path.join(dir, coverCacheHash(trackPath) + '.' + coverExt(picture.format));
    if (fs.existsSync(file)) return;
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(file, Buffer.from(picture.data));
  } catch (_) { /* cache is best-effort */ }
}

// Bulk cover lookup for the given track paths. Also prunes cache entries whose
// track is no longer in the library (the renderer always passes the full list).
ipcMain.handle('covers:load', async (_event, paths) => {
  const result = {};
  try {
    const dir = coverCacheDir();
    let entries = [];
    try { entries = await fs.promises.readdir(dir); } catch (_) { return result; }
    const byHash = new Map();
    for (const name of entries) {
      const dot = name.lastIndexOf('.');
      byHash.set(dot > 0 ? name.slice(0, dot) : name, name);
    }
    const wanted = new Set();
    for (const p of Array.isArray(paths) ? paths : []) {
      const h = coverCacheHash(p);
      wanted.add(h);
      const name = byHash.get(h);
      if (name) result[p] = pathToFileURL(path.join(dir, name)).href;
    }
    for (const [h, name] of byHash) {
      if (!wanted.has(h)) fs.promises.unlink(path.join(dir, name)).catch(() => {});
    }
  } catch (_) { /* cache is best-effort */ }
  return result;
});

// Windows normalizes DOS-style paths before they ever reach the filesystem —
// trailing dots/spaces are silently dropped and anything past ~260 chars is
// rejected — unless the path carries the \\?\ prefix, which selects the raw
// NT path and skips that step entirely. A file this app didn't create itself
// (imported from elsewhere, or just deeply nested) can have either baked into
// its real on-disk name, so the plain path 404s on every fs call even though
// the file is right there. Only takes the \\?\ detour when the plain path
// actually fails to resolve, so the common case is untouched.
function resolveRealPath(filePath) {
  if (!filePath || process.platform !== 'win32' || fs.existsSync(filePath)) return filePath;
  const abs = path.resolve(filePath);
  const long = abs.startsWith('\\\\') ? '\\\\?\\UNC\\' + abs.slice(2) : '\\\\?\\' + abs;
  return fs.existsSync(long) ? long : filePath;
}

// Ogg/Opus keeps no duration in its header — it lives in the granule position of
// the very last page, so without this music-metadata stops after the tags and
// leaves duration, and the bitrate derived from it, undefined. Everything the UI
// shows for a track (length, bitrate, quality tier) then reads as zero.
const PARSE_OPTS = { duration: true };

ipcMain.handle('music:parseMetadata', async (event, filePath) => {
  try {
    // A malformed embedded picture (common in Ogg/Opus, where the cover is a
    // base64 Vorbis comment) throws out of the whole parse. Losing the artwork
    // is fine; losing artist/album/duration with it is not — so retry without
    // covers before giving up on the file.
    const realPath = resolveRealPath(filePath);
    let metadata;
    try {
      metadata = await musicMetadata.parseFile(realPath, PARSE_OPTS);
    } catch (err) {
      metadata = await musicMetadata.parseFile(realPath, { ...PARSE_OPTS, skipCovers: true });
    }
    let coverBase64 = null;
    let coverFormat = null;

    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const picture = metadata.common.picture[0];
      coverBase64 = Buffer.from(picture.data).toString('base64');
      coverFormat = picture.format;
      saveCoverToCache(filePath, picture);
    }

    return {
      title: metadata.common.title || path.basename(filePath, path.extname(filePath)),
      artist: metadata.common.artist || 'Unknown Artist',
      album: metadata.common.album || 'Unknown Album',
      albumArtist: metadata.common.albumartist || '',
      year: metadata.common.year || '',
      genre: (metadata.common.genre || []).join(', '),
      trackNo: metadata.common.track && metadata.common.track.no ? String(metadata.common.track.no) : '',
      discNo: metadata.common.disk && metadata.common.disk.no ? String(metadata.common.disk.no) : '',
      comment: (metadata.common.comment && metadata.common.comment[0]) || '',
      duration: metadata.format.duration || 0,
      quality: buildQuality(metadata.format),
      hasCover: !!(metadata.common.picture && metadata.common.picture.length > 0),
      cover: coverBase64 ? `data:${coverFormat};base64,${coverBase64}` : null,
      path: filePath
    };
  } catch (error) {
    console.error('Error parsing metadata for', filePath, error);
    return {
      title: path.basename(filePath, path.extname(filePath)),
      artist: 'Unknown Artist',
      album: 'Unknown Album',
      albumArtist: '',
      year: '',
      genre: '',
      trackNo: '',
      discNo: '',
      comment: '',
      duration: 0,
      quality: null,
      hasCover: false,
      cover: null,
      path: filePath
    };
  }
});

// Read raw audio bytes so the renderer can decode the track and extract real
// amplitude peaks for the waveform progress bar (Web Audio decode runs in the
// renderer). Returns a Buffer; IPC serializes it to a Uint8Array on the other side.
ipcMain.handle('audio:readFile', async (event, filePath) => {
  return await fs.promises.readFile(resolveRealPath(filePath));
});

function runFfmpeg(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `ffmpeg exited with ${code}`));
    });
  });
}

// Tags are rewritten by remuxing through ffmpeg rather than with a format-specific
// tag library: "-map 0 -c copy" carries every stream over byte-for-byte (embedded
// cover art included) and ffmpeg maps these generic keys onto whatever the
// container actually stores — ID3 frames for mp3, Vorbis comments for opus/flac,
// iTunes atoms for m4a. Like the trimmer, it writes a temp file and only then
// moves it into place, so an interrupted run can't truncate the original.
const FFMPEG_TAG_KEYS = {
  title: 'title',
  artist: 'artist',
  album: 'album',
  albumArtist: 'album_artist',
  year: 'date',
  genre: 'genre',
  trackNo: 'track',
  discNo: 'disc',
  comment: 'comment',
};

function isOggContainer(ext) {
  return ext === '.opus' || ext === '.ogg';
}

// Ogg/Opus stores cover art as a base64 METADATA_BLOCK_PICTURE vorbis comment, not a real
// stream — but ffmpeg's demuxer fakes an mjpeg "video" stream out of it for playback tooling,
// and its own ogg muxer then refuses to write that stream back out ("Unsupported codec id in
// stream 1"). So "-map 0 -c copy" mux-crashes on any .opus/.ogg source that has a cover. The
// fix is to map only the audio stream and re-inject the picture as a plain vorbis comment via
// an ffmetadata file (the FLAC/Ogg picture block, all big-endian: type, mime, description,
// width, height, depth, colors, data).
function oggCoverMetaFile(tmpPath, picture) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };
  const mime = Buffer.from(picture.format, 'utf8');
  const data = Buffer.from(picture.data);
  const block = Buffer.concat([
    u32(3), u32(mime.length), mime, u32(0), u32(0), u32(0), u32(0), u32(0), u32(data.length), data,
  ]).toString('base64').replace(/=/g, '\\='); // ffmetadata syntax reserves '='
  const metaPath = tmpPath + '.meta.txt';
  fs.writeFileSync(metaPath, `;FFMETADATA1\nMETADATA_BLOCK_PICTURE=${block}\n`);
  return metaPath;
}

function ffmpegTagArgs(filePath, tmpPath, tags, picture) {
  const ext = path.extname(filePath).toLowerCase();
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', filePath];
  if (isOggContainer(ext) && picture) {
    // Both -map_metadata calls apply (later ones add to earlier ones, not replace): the
    // source's own tags still come from 0, the picture is layered in from the synthetic file.
    args.push('-i', oggCoverMetaFile(tmpPath, picture), '-map', '0:a', '-map_metadata', '0', '-map_metadata', '1', '-c', 'copy');
  } else if (isOggContainer(ext)) {
    // No picture to re-embed — but the source may still carry a cover we
    // simply failed to parse (a known yt-dlp/mutagen embed corruption, see
    // music:writeMetadata's catch below). Mapping stream 0 wholesale would hit
    // that same cover's synthetic mjpeg stream and crash the mux either way,
    // so stay audio-only regardless; a bad cover just gets dropped, not fatal.
    args.push('-map', '0:a', '-c', 'copy', '-map_metadata', '0');
  } else {
    args.push('-map', '0', '-c', 'copy', '-map_metadata', '0');
  }
  // Ogg/Opus vorbis comments live on the audio stream itself, not the output's global
  // metadata slot. A plain "-metadata key=value" only sets the global slot, which
  // -map_metadata 0 above doesn't feed into — the stream-level copy wins and the file
  // keeps its old tags no matter what gets written here. Target the stream explicitly.
  const metaFlag = isOggContainer(ext) ? '-metadata:s:a:0' : '-metadata';
  for (const [key, ffKey] of Object.entries(FFMPEG_TAG_KEYS)) {
    if (tags && tags[key] !== undefined) args.push(metaFlag, `${ffKey}=${String(tags[key])}`);
  }
  if (ext === '.mp3') args.push('-id3v2_version', '3');
  args.push(tmpPath);
  return args;
}

async function writeMetadataToFile(filePath, tags) {
  if (!filePath) return { success: false, error: 'File not found' };
  filePath = resolveRealPath(filePath);
  if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };
  const ffmpeg = resolveBundledFfmpeg();
  if (!ffmpeg) return { success: false, error: 'ffmpeg not found' };

  const ext = path.extname(filePath).toLowerCase();
  let picture = null;
  if (isOggContainer(ext)) {
    try {
      const md = await musicMetadata.parseFile(filePath);
      picture = (md.common.picture && md.common.picture[0]) || null;
    } catch (_) { /* cover unparseable — drop it, ffmpegTagArgs stays audio-only either way */ }
  }

  const tmpPath = path.join(path.dirname(filePath), `.audex-tags-${Date.now()}${ext}`);
  const args = ffmpegTagArgs(filePath, tmpPath, tags, picture);

  try {
    await runFfmpeg(ffmpeg, args);
    await fs.promises.rename(tmpPath, filePath);
    return { success: true };
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    return { success: false, error: String((err && err.message) || err) };
  } finally {
    if (picture) { try { fs.unlinkSync(tmpPath + '.meta.txt'); } catch (_) {} }
  }
}

ipcMain.handle('music:writeMetadata', async (event, { filePath, tags }) => writeMetadataToFile(filePath, tags));

// ── Cover replacement (album-wide "regenerate thumbnails") ──
// track.cover in the renderer is always a `data:<mime>;base64,<data>` URL —
// decode straight back into the {format, data} shape ffmpegTagArgs already
// expects, so ogg/opus reuses that exact path (it never cared where the
// picture came from). Other containers have no such path yet: ffmpegTagArgs's
// "-map 0 -c copy" just carries the source's own cover stream through
// untouched, so replacing it needs a second ffmpeg input (the new image)
// mapped in as the attached-pic stream instead.
// track.cover in the renderer is either a `data:<mime>;base64,<data>` URL (a
// freshly-parsed embedded picture) or a `file://...` URL into the on-disk
// thumbnail cache (the fast-boot path in warmCoversFromDisk — see covers:load
// above, which is what most already-scanned tracks carry). Both are valid
// "this track's cover art" — accept either.
function parseCoverSource(source) {
  const s = String(source || '');
  const m = /^data:([^;]+);base64,(.+)$/.exec(s);
  if (m) return { format: m[1], data: Buffer.from(m[2], 'base64') };
  if (s.startsWith('file:')) {
    try {
      const filePath = fileURLToPath(s);
      const ext = path.extname(filePath).toLowerCase();
      const format = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      return { format, data: fs.readFileSync(filePath) };
    } catch (_) { return null; }
  }
  return null;
}

async function writeCoverToFile(origPath, coverDataUrl) {
  if (!origPath) return { success: false, error: 'File not found' };
  const filePath = resolveRealPath(origPath);
  if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };
  const picture = parseCoverSource(coverDataUrl);
  if (!picture) return { success: false, error: 'Bad cover data' };
  const ffmpeg = resolveBundledFfmpeg();
  if (!ffmpeg) return { success: false, error: 'ffmpeg not found' };

  const ext = path.extname(filePath).toLowerCase();
  const tmpPath = path.join(path.dirname(filePath), `.audex-cover-${Date.now()}${ext}`);
  let tmpImgPath = null;
  let args;
  if (isOggContainer(ext)) {
    args = ffmpegTagArgs(filePath, tmpPath, {}, picture);
  } else {
    tmpImgPath = `${tmpPath}.${coverExt(picture.format)}`;
    fs.writeFileSync(tmpImgPath, picture.data);
    args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', filePath, '-i', tmpImgPath,
      '-map', '0:a', '-map', '1:v', '-c', 'copy', '-map_metadata', '0', '-disposition:v', 'attached_pic'];
    if (ext === '.mp3') args.push('-id3v2_version', '3');
    args.push(tmpPath);
  }

  try {
    await runFfmpeg(ffmpeg, args);
    await fs.promises.rename(tmpPath, filePath);
    // Disk cover cache is keyed by a hash of the path and never overwrites an
    // existing entry (it assumes a track's art is immutable) — drop the stale
    // one first so the new cover actually lands on next boot. Keyed by the
    // original (unresolved) path — that's what covers:load looks it up with.
    const dir = coverCacheDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const hash = coverCacheHash(origPath);
    for (const name of await fs.promises.readdir(dir)) {
      if (name.startsWith(hash)) await fs.promises.unlink(path.join(dir, name)).catch(() => {});
    }
    await saveCoverToCache(origPath, picture);
    return { success: true };
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    return { success: false, error: String((err && err.message) || err) };
  } finally {
    if (tmpImgPath) { try { fs.unlinkSync(tmpImgPath); } catch (_) {} }
    if (isOggContainer(ext)) { try { fs.unlinkSync(tmpPath + '.meta.txt'); } catch (_) {} }
  }
}

ipcMain.handle('music:writeCover', async (event, { filePath, cover }) => writeCoverToFile(filePath, cover));

// yt-dlp embeds YouTube thumbnails into Ogg/Opus via Python/mutagen, which can
// write a METADATA_BLOCK_PICTURE that music-metadata (and this app's own
// ffmpeg tag writer) can't parse back — the same corruption documented in
// writeMetadataToFile above. Catch it right after download: a full parse
// that throws means the cover is broken, so re-run it through the tag writer
// with no tag changes, which reuses that same fallback to drop the bad
// picture instead of shipping a file that renders a mangled cover later.
async function stripCoverIfCorrupt(filePath) {
  if (!isOggContainer(path.extname(filePath).toLowerCase())) return;
  try {
    await musicMetadata.parseFile(filePath);
  } catch (_) {
    try { await writeMetadataToFile(filePath, {}); } catch (_) {}
  }
}

ipcMain.handle('shell:revealInFolder', async (event, filePath) => {
  const real = filePath && resolveRealPath(filePath);
  if (real && fs.existsSync(real)) {
    shell.showItemInFolder(real);
    return true;
  }
  return false;
});

ipcMain.handle('renderer:logError', (event, { where, message } = {}) => {
  logAppError(where || 'renderer', message);
  return true;
});

ipcMain.handle('shell:openLogsFolder', async () => {
  const err = await shell.openPath(app.getPath('userData'));
  return { success: !err, error: err || undefined };
});

ipcMain.handle('shell:openExternal', async (event, url) => {
  if (typeof url !== 'string') return { success: false, error: 'No url' };
  if (!/^https?:\/\//i.test(url)) return { success: false, error: 'Only http(s) URLs are allowed' };
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// ── Hardware acceleration toggle ──
// Reflects/controls the `disable-gpu` marker file used by the GPU fallback at
// the top of this file. Returns whether hardware acceleration is currently
// effective. Toggling writes or removes the marker; the change needs a restart
// to take hold (disableHardwareAcceleration only works before app is ready), so
// we offer one via a native dialog.
// ── Build identity ──
// The UI labels builds by git short hash, not by the package.json version. In a
// dev checkout that comes straight from git; a packaged build has no .git, so it
// falls back to build-info.json written by scripts/build-info.js at `dist` time.
let cachedCommit;
function getCommit() {
  if (cachedCommit !== undefined) return cachedCommit;
  const root = app.getAppPath();
  try {
    cachedCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'],
      { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (_) {
    try {
      cachedCommit = String(JSON.parse(
        fs.readFileSync(path.join(root, 'build-info.json'), 'utf8')).commit || '');
    } catch (_) { cachedCommit = ''; }
  }
  return cachedCommit;
}

ipcMain.handle('app:getBuildInfo', () => ({ commit: getCommit() }));

ipcMain.handle('app:getHardwareAcceleration', () => {
  return { enabled: !isGpuDisabled() };
});

ipcMain.handle('app:setHardwareAcceleration', async (event, enabled) => {
  try {
    if (enabled) {
      try { fs.rmSync(gpuMarkerPath, { force: true }); } catch (_) { /* ignore */ }
    } else {
      fs.writeFileSync(gpuMarkerPath, '1');
    }
  } catch (err) {
    return { success: false, error: String(err) };
  }
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'question',
    buttons: ['Restart', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Restart required',
    message: 'The change takes effect after the app restarts.',
    detail: 'Restart Audex now?',
  });
  if (choice === 0) {
    isQuitting = true;
    app.relaunch();
    app.exit(0);
  }
  return { success: true, restarted: choice === 0 };
});

// ── Auto-update (electron-updater) ──
// GitHub-hosted releases. electron-builder's `publish` config (package.json)
// embeds an app-update.yml pointing at zhotheone/audex-player; electron-updater
// reads it to find latest.yml / latest-mac.yml on the GitHub release, and does
// the download-verify-apply dance itself (NSIS silent update on Windows,
// Squirrel.Mac on macOS, in-place AppImage swap on Linux) — the part a
// hand-rolled updater tends to get wrong.
// autoDownload is off so the renderer's update banner controls *when* the
// download starts; the user still has to click.
const { autoUpdater } = require('electron-updater');
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

function sendUpdateEvent(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
autoUpdater.on('download-progress', (p) => sendUpdateEvent('update:downloadProgress', p.percent / 100));
autoUpdater.on('update-downloaded', () => sendUpdateEvent('update:downloaded'));

// The app has no menu bar (Menu.setApplicationMenu(null) above) and no DevTools
// shortcut, so a failed update has nowhere to show its real error — this is the
// only trace of it. Most common cause on macOS: the build is unsigned
// (mac.identity: null), and Squirrel.Mac refuses to update an unsigned app.
function logUpdateError(where, err) { appendLog('update-error.log', where, err); }

ipcMain.handle('update:check', async () => {
  const currentVersion = app.getVersion();
  // Unpackaged (dev) runs have no app-update.yml — electron-updater throws
  // looking for one, so just report "no update" instead.
  if (!app.isPackaged) return { success: true, hasUpdate: false, currentVersion };
  try {
    const result = await new Promise((resolve, reject) => {
      const onAvailable = (info) => { cleanup(); resolve({ hasUpdate: true, info }); };
      const onNotAvailable = (info) => { cleanup(); resolve({ hasUpdate: false, info }); };
      const onError = (err) => { cleanup(); reject(err); };
      function cleanup() {
        autoUpdater.off('update-available', onAvailable);
        autoUpdater.off('update-not-available', onNotAvailable);
        autoUpdater.off('error', onError);
      }
      autoUpdater.once('update-available', onAvailable);
      autoUpdater.once('update-not-available', onNotAvailable);
      autoUpdater.once('error', onError);
      autoUpdater.checkForUpdates().catch(onError);
    });
    return {
      success: true,
      currentVersion,
      latestVersion: result.info ? result.info.version : currentVersion,
      hasUpdate: result.hasUpdate,
    };
  } catch (err) {
    logUpdateError('check', err);
    return { success: false, error: String(err), currentVersion };
  }
});

ipcMain.handle('update:download', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    logUpdateError('download', err);
    return { success: false, error: String(err && err.message || err) };
  }
});

// Quits and applies the already-downloaded update — only meaningful after
// update:downloaded has fired.
ipcMain.handle('update:install', () => {
  isQuitting = true;
  autoUpdater.quitAndInstall();
  return { success: true };
});

// ── Track trimming (editor) ──
// Cuts [start, end] out of an audio file with the bundled ffmpeg. Without fades
// we stream-copy (-c copy): instant and lossless, cutting on frame boundaries.
// Fades require re-encoding, so those go through libmp3lame at 320k CBR.
// Output is always written to a temp file first and only then moved into place,
// so an interrupted run can never truncate the user's original.
// Re-encode bitrate per container: libopus refuses anything above 256k (and is
// transparent well below it), lossless formats take none at all. Everything
// else gets the old 320k.
const REENCODE_BITRATE = { '.opus': '192k', '.flac': '', '.wav': '' };

function ffmpegTrimArgs(src, tmpPath, { start, dur, fadeIn, fadeOut, gain, picture }) {
  const ext = path.extname(src).toLowerCase();
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-i', src, '-t', String(dur)];
  // Ogg/Opus cover art is metadata, not a stream ffmpeg can carry through a trim (see
  // oggCoverMetaFile above) — feed it back in as a second input instead.
  const withPicture = isOggContainer(ext) && picture;
  if (withPicture) args.push('-i', oggCoverMetaFile(tmpPath, picture));
  // Any filter (fade or gain) rules out the stream copy and forces a re-encode.
  if (fadeIn > 0 || fadeOut > 0 || gain !== 0) {
    const filters = [];
    // Gain first, so the fades shape the already-scaled signal and always end
    // at true silence.
    if (gain !== 0) filters.push(`volume=${gain}dB`);
    if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn}`);
    if (fadeOut > 0) filters.push(`afade=t=out:st=${Math.max(0, dur - fadeOut)}:d=${fadeOut}`);
    // No explicit codec: ffmpeg picks the container's default encoder, so an
    // opus cut stays opus and a flac cut stays lossless flac. Naming libmp3lame
    // here would put MP3 frames inside whatever extension the source had.
    args.push('-af', filters.join(','));
    const bitrate = ext in REENCODE_BITRATE ? REENCODE_BITRATE[ext] : '320k';
    if (bitrate) args.push('-b:a', bitrate);
  } else {
    args.push('-c', 'copy');
  }
  // Carry cover art and tags over to the cut file. -id3v2_version belongs to the
  // mp3 muxer only; handing it to the opus or flac muxer aborts the whole run.
  if (withPicture) args.push('-map', '0:a', '-map_metadata', '0', '-map_metadata', '1');
  else args.push('-map_metadata', '0');
  if (ext === '.mp3') args.push('-id3v2_version', '3');
  args.push(tmpPath);
  return args;
}

ipcMain.handle('audio:trim', async (event, payload) => {
  const src = resolveRealPath(payload && payload.filePath ? String(payload.filePath) : '');
  const start = Math.max(0, Number(payload && payload.start) || 0);
  const end = Number(payload && payload.end) || 0;
  const fadeIn = Math.max(0, Number(payload && payload.fadeIn) || 0);
  const fadeOut = Math.max(0, Number(payload && payload.fadeOut) || 0);
  // Gain in dB: negative makes the cut quieter, positive louder. Clamped to a
  // sane range so a bad renderer value can't ask ffmpeg for absurd gain.
  const gain = Math.max(-40, Math.min(40, Number(payload && payload.gain) || 0));
  const overwrite = !!(payload && payload.overwrite);

  if (!src || !fs.existsSync(src)) return { success: false, error: 'File not found' };
  if (!(end > start)) return { success: false, error: 'End must be greater than start' };

  const ffmpeg = resolveBundledFfmpeg();
  if (!ffmpeg) return { success: false, error: 'ffmpeg not found' };

  const dir = path.dirname(src);
  const ext = path.extname(src);
  const base = path.basename(src, ext);
  const dur = end - start;

  let outPath;
  if (overwrite) {
    outPath = src;
  } else {
    outPath = path.join(dir, `${base} (trimmed)${ext}`);
    let n = 2;
    while (fs.existsSync(outPath)) outPath = path.join(dir, `${base} (trimmed ${n++})${ext}`);
  }
  const tmpPath = path.join(dir, `.audex-trim-${Date.now()}${ext}`);

  let picture = null;
  if (isOggContainer(ext.toLowerCase())) {
    try {
      const md = await musicMetadata.parseFile(src);
      picture = (md.common.picture && md.common.picture[0]) || null;
    } catch (_) { /* no cover to preserve */ }
  }
  const args = ffmpegTrimArgs(src, tmpPath, { start, dur, fadeIn, fadeOut, gain, picture });

  try {
    await runFfmpeg(ffmpeg, args);
    await fs.promises.rename(tmpPath, outPath);
    return { success: true, filePath: outPath, overwritten: overwrite };
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) await fs.promises.unlink(tmpPath); } catch (_) {}
    return { success: false, error: String(err && err.message || err).slice(0, 300) };
  } finally {
    if (picture) { try { fs.unlinkSync(tmpPath + '.meta.txt'); } catch (_) {} }
  }
});

ipcMain.handle('shell:deleteFile', async (event, filePath) => {
  if (!filePath) return { success: false, error: 'No path' };
  filePath = resolveRealPath(filePath);
  if (!fs.existsSync(filePath)) return { success: true, missing: true };
  try {
    await shell.trashItem(filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// ── Downloads: YouTube via yt-dlp ─────────────────────────────────────────────

// The standalone yt-dlp binary shipped inside the app (see scripts/fetch-ytdlp.js
// and build.asarUnpack in package.json). Returns null when not packed.
function resolveBundledYtDlp() {
  const bundleRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'yt-dlp-bundle')
    : path.join(__dirname, 'yt-dlp-bundle');
  const name = process.platform === 'linux' ? 'yt-dlp_linux'
    : process.platform === 'darwin' ? 'yt-dlp_macos'
    : process.platform === 'win32' ? 'yt-dlp.exe'
    : null;
  if (!name) return null;
  const candidate = path.join(bundleRoot, name);
  try {
    if (fs.existsSync(candidate)) {
      // AppImage/asar-unpacked files can lose the exec bit on some setups.
      if (process.platform !== 'win32') {
        try { fs.chmodSync(candidate, 0o755); } catch (_) {}
      }
      return candidate;
    }
  } catch (_) {}
  return null;
}

function ytDlpPath() {
  // Prefer the bundled binary so the downloader works without a system install.
  const bundled = resolveBundledYtDlp();
  if (bundled) return bundled;
  // Fall back to a system-installed yt-dlp (dev runs, or if the bundle is missing).
  const candidates = [
    'yt-dlp',
    path.join(process.env.HOME || '', '.local', 'bin', 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
  ];
  for (const c of candidates.slice(1)) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return candidates[0];
}

// ffmpeg is required by yt-dlp for audio extraction (mp3) and thumbnail embedding.
// We ship the static binary via the ffmpeg-static npm package (asarUnpack'd in
// package.json). require() resolves the path inside the asar; rewrite it to the
// unpacked copy so the binary is actually runnable. Returns null if unavailable
// (then yt-dlp falls back to a system ffmpeg on PATH, if any).
let _ffmpegPath;
function resolveBundledFfmpeg() {
  if (_ffmpegPath !== undefined) return _ffmpegPath;
  _ffmpegPath = null;
  try {
    let p = require('ffmpeg-static');
    if (p) {
      if (app.isPackaged) p = p.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(p)) {
        if (process.platform !== 'win32') {
          try { fs.chmodSync(p, 0o755); } catch (_) {}
        }
        _ffmpegPath = p;
      }
    }
  } catch (_) {}
  return _ffmpegPath;
}

// YouTube increasingly answers yt-dlp with "Sign in to confirm you're not a
// bot" for anonymous requests. youtube:login (below) opens a real signed-in
// browser session and dumps its cookies here in Netscape format, the file
// format yt-dlp's --cookies flag expects; every yt-dlp call picks it up
// automatically once it exists.
function youtubeCookiesPath() {
  return path.join(app.getPath('userData'), 'yt-cookies.txt');
}
function ytDlpCookieArgs() {
  const p = youtubeCookiesPath();
  return fs.existsSync(p) ? ['--cookies', p] : [];
}

function runYtDlp(args, { timeoutMs } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    const proc = spawn(ytDlpPath(), [...ytDlpCookieArgs(), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => { killed = true; try { proc.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    }
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || String(err), spawnError: String(err) });
    });
    proc.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, killed });
    });
  });
}

function fmtDuration(sec) {
  if (!sec || sec < 0) return '';
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

ipcMain.handle('downloads:ytSearch', async (event, query, count) => {
  const q = String(query || '').trim();
  if (!q) return { success: true, results: [] };
  const n = Math.max(1, Math.min(20, parseInt(count, 10) || 8));
  const args = [
    `ytsearch${n}:${q}`,
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    '--no-playlist',
    '--socket-timeout', '15',
  ];
  const { code, stdout, stderr, spawnError } = await runYtDlp(args, { timeoutMs: 30000 });
  if (spawnError) {
    return { success: false, error: 'yt-dlp not found. Install it: pip install -U yt-dlp' };
  }
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  const results = [];
  for (const line of lines) {
    try {
      const j = JSON.parse(line);
      if (!j.id) continue;
      const thumbs = Array.isArray(j.thumbnails) ? j.thumbnails : [];
      const thumb = thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${j.id}/mqdefault.jpg`;
      results.push({
        id: j.id,
        title: j.title || '',
        channel: j.channel || j.uploader || j.uploader_id || '',
        duration: j.duration || 0,
        durationStr: fmtDuration(j.duration || 0),
        thumbnail: thumb,
        url: j.url || j.webpage_url || `https://www.youtube.com/watch?v=${j.id}`,
      });
    } catch (_) { /* skip malformed lines */ }
  }
  if (results.length === 0 && code !== 0) {
    return { success: false, error: (stderr.trim().split('\n').pop() || 'yt-dlp error').slice(0, 300) };
  }
  return { success: true, results };
});

// ── YouTube Music parser ──────────────────────────────────────────────────────
// Enumerates an album / single / artist page on music.youtube.com into a flat
// track list via yt-dlp's --flat-playlist. Unlike the Spotify parser this needs
// no browser/login/captcha: yt-dlp's youtube:tab extractor reads these URLs
// directly. Downloading each track reuses the existing downloads:ytDownload
// handler (by video id), so the MP3 gets its thumbnail + tags embedded just like
// the YouTube search downloader. Flat mode keeps it fast on large artist pages at
// the cost of sparse per-track artist data — the embedded tags fill that in.
ipcMain.handle('downloads:ytMusicParse', async (event, payload) => {
  const url = String((payload && payload.url) || '').trim();
  if (!url) return { success: false, error: 'No URL' };
  const isYtUrl = /^https?:\/\/([\w-]+\.)*youtube\.com\//i.test(url) || /^https?:\/\/youtu\.be\//i.test(url);
  if (!isYtUrl) return { success: false, error: 'Not a YouTube / YouTube Music URL' };
  const args = [
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    '--ignore-errors',
    '--socket-timeout', '20',
    url,
  ];
  const { stdout, stderr, spawnError, killed } = await runYtDlp(args, { timeoutMs: 120000 });
  if (spawnError) return { success: false, error: 'yt-dlp not found. Install it: pip install -U yt-dlp' };
  if (killed) return { success: false, error: 'Timed out while reading the page.' };

  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  const tracks = [];
  let playlistTitle = '';
  // The playlist uploader can be trusted as the track artist only for an artist's
  // own channel/topic page — NOT for user-curated playlists, where the uploader is
  // whoever built the playlist (e.g. "Adrian"), not the performer. Auto-generated
  // album/single releases (OLAK5uy_… list ids) are handled per-entry below.
  const urlListId = (String(url).match(/[?&]list=([^&#]+)/) || [])[1] || '';
  const isArtistPage = /\/channel\/|\/@|\/browse\/(UC|MPAD)/i.test(url);
  for (const line of lines) {
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (!j || !j.id) continue;
    // Some artist pages list nested playlists among the entries — keep only tracks.
    if (j._type === 'playlist') continue;
    // Bare channel URLs also surface Shorts (no duration, not music) — skip them.
    const entryUrl = j.url || j.webpage_url || '';
    if (/\/shorts\//i.test(entryUrl)) continue;
    if (!playlistTitle) playlistTitle = j.playlist_title || j.playlist || '';

    let title = j.title || '';
    let artist = '';
    if (Array.isArray(j.artists) && j.artists.length) artist = j.artists.filter(Boolean).join(', ');
    else artist = j.channel || j.uploader || j.artist || '';
    // In --flat-playlist mode album/single/artist pages give no per-track artist,
    // but there the playlist-level uploader/channel *is* the release artist. Use it
    // only for releases (OLAK5uy_… list ids) and artist pages — never for
    // user-curated playlists, where it would wrongly show the playlist's owner.
    if (!artist) {
      const listId = urlListId || j.playlist_id || '';
      const isRelease = /^OLAK5uy_/i.test(listId);
      if (isRelease || isArtistPage) artist = j.playlist_uploader || j.playlist_channel || '';
    }
    artist = artist.replace(/\s*-\s*topic\s*$/i, '').trim(); // strip auto-channel " - Topic"
    // Last resort: recover an artist from a "Artist - Title" title (used for bare
    // channel feeds). Only when nothing above worked, to avoid mis-splitting titles
    // like "Song - Radio Edit" when we already know the real artist.
    if (!artist && title.includes(' - ')) {
      const parts = title.split(' - ');
      artist = parts.shift().trim();
      title = parts.join(' - ').trim();
    }
    // Drop a redundant leading "Artist - " from the title when we already know it.
    if (artist) {
      const pfx = (artist + ' - ').toLowerCase();
      if (title.toLowerCase().startsWith(pfx)) title = title.slice(pfx.length).trim();
    }
    const dur = typeof j.duration === 'number' ? j.duration : 0;
    const thumbs = Array.isArray(j.thumbnails) ? j.thumbnails : [];
    // Highest-res thumbnail; fall back to the always-available ytimg cover for the id.
    const cover = (thumbs.length && thumbs[thumbs.length - 1].url)
      ? thumbs[thumbs.length - 1].url
      : `https://i.ytimg.com/vi/${j.id}/mqdefault.jpg`;
    tracks.push({
      id: j.id,
      title,
      artist,
      duration: fmtDuration(dur),
      cover,
      url: entryUrl || `https://music.youtube.com/watch?v=${j.id}`,
    });
  }
  if (tracks.length === 0) {
    const msg = (stderr.trim().split('\n').pop() || 'No tracks found').slice(0, 300);
    return { success: false, error: msg };
  }
  return { success: true, tracks, title: playlistTitle };
});

function sanitizeFsName(name) {
  // Windows silently strips trailing dots and spaces when it actually creates
  // the file/folder, so a tag like "Vol. 1." would leave this app holding a
  // path that doesn't match what's really on disk — every later read (tag
  // parsing, cover load, playback) then misses the file. Strip trailing dots/
  // spaces here, twice: once before the length cut, once after (truncation
  // can expose a new trailing dot/space of its own).
  const clean = (s) => s.trim().replace(/[.\s]+$/, '');
  const s = clean(clean(String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')).slice(0, 180));
  // "." and ".." survive the character filter and would climb out of the target
  // directory — album/artist tags come from remote metadata, so this matters.
  return /^\.+$/.test(s) ? '' : s;
}

function streamYtDlp(args, { onProgress, onPhase, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutBuf = '';
    const proc = spawn(ytDlpPath(), [...ytDlpCookieArgs(), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    }
    proc.stdout.on('data', d => {
      const text = d.toString();
      stdout += text;
      stdoutBuf += text;
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.startsWith('[dlprog]')) {
          const parts = line.slice(8).trim().split('|');
          const rawPct = (parts[0] || '').trim().replace('%', '');
          const pct = parseFloat(rawPct);
          if (!isNaN(pct) && onProgress) {
            onProgress({
              phase: 'download',
              percent: Math.max(0, Math.min(100, pct)),
              speed: (parts[1] || '').trim(),
              eta: (parts[2] || '').trim(),
            });
          }
        } else if (line.startsWith('[ExtractAudio]') || line.startsWith('[EmbedThumbnail]') || line.startsWith('[Metadata]') || line.startsWith('[FixupM3u8]')) {
          if (onPhase) onPhase('postprocess');
        }
      }
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || String(err), spawnError: String(err) });
    });
    proc.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function resolveDownloadsDir(requested) {
  const fallback = path.join(app.getPath('music'), 'Audex Downloads');
  const candidate = (requested && String(requested).trim()) || '';
  if (candidate) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK);
      return candidate;
    } catch (_) { /* fall through to fallback */ }
  }
  try { fs.mkdirSync(fallback, { recursive: true }); } catch (_) {}
  return fallback;
}

// yt-dlp reports failures as free English prose aimed at a terminal user — the
// geo-restriction one even ends with "use a VPN or a proxy server (with
// --proxy)", advice that means nothing inside a GUI. Reduce the common cases to
// a stable tag so the renderer can show a real message and decide whether a
// different source is worth trying.
function classifyYtDlpError(text) {
  const s = String(text || '');
  if (/not made this video available in your country|geo restriction|geo-restricted/i.test(s)) return 'geo';
  if (/Video unavailable|This video is not available|has been removed|private video|Video has been removed/i.test(s)) return 'unavailable';
  if (/Sign in to confirm|not a bot|cookies/i.test(s)) return 'signin';
  if (/members-only|join this channel/i.test(s)) return 'members';
  if (/Unable to download|Failed to resolve|Connection reset|timed out|Network is unreachable/i.test(s)) return 'network';
  return '';
}

// Formats yt-dlp can extract to where the container extension equals the format
// name — the fallback file scan and the final rename both rely on that.
const AUDIO_FORMATS = new Set(['opus', 'mp3', 'flac', 'm4a', 'wav']);
const THUMBNAIL_FORMATS = new Set(['opus', 'mp3', 'flac', 'm4a']);
// When the source stream already uses the target codec, yt-dlp only remuxes it
// (-c copy) and the audio comes out bit-identical to what YouTube served. Asking
// for such a stream first makes that the normal case instead of a coincidence:
// picking by bitrate alone can land on the AAC stream and force a transcode.
// Nothing to prefer for mp3/flac/wav — YouTube never serves those.
const SOURCE_CODEC_FILTER = { opus: '[acodec=opus]', m4a: '[acodec^=mp4a]' };
// Marks the one stdout line carrying the finished file's path and album, so it
// can't be confused with anything else yt-dlp prints.
const META_TAG = '[audexmeta]';

// yt-dlp lands the file under a temp name in the root of the downloads dir;
// this moves it to {dir}/{artist}/{album}/{artist} - {title}.{ext}. Artist and
// title come from the renderer (parsed off the source page, far more reliable
// than YouTube's own metadata); the album only exists in yt-dlp's metadata.
// Missing segments are skipped rather than filled with "Unknown" — a flat file
// is easier to fix later than a wrongly-named folder.
function placeDownload(filePath, downloadsDir, { artist, album, suggestedName, format }) {
  const base = sanitizeFsName(suggestedName || path.basename(filePath, path.extname(filePath)));
  if (!base) return filePath;
  const dir = path.join(downloadsDir, ...[artist, album].map(sanitizeFsName).filter(Boolean));
  const targetPath = path.join(dir, base + '.' + format);
  if (targetPath === filePath) return filePath;
  fs.mkdirSync(dir, { recursive: true });
  // Already downloaded before — keep the existing copy, drop the new one.
  if (fs.existsSync(targetPath)) {
    try { fs.unlinkSync(filePath); } catch (_) {}
    return targetPath;
  }
  fs.renameSync(filePath, targetPath);
  return targetPath;
}

// Both download entry points differ only in what they hand yt-dlp: a concrete
// video URL, or a "ytsearch1:…" query.
async function runYtDownload(event, payload, target) {
  const { videoId, url, suggestedName, artist, requestId, targetDir } = payload || {};
  const format = AUDIO_FORMATS.has(payload && payload.format) ? payload.format : 'opus';
  const downloadsDir = resolveDownloadsDir(targetDir);
  const outPattern = path.join(downloadsDir, '%(title)s [%(id)s].%(ext)s');

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-quiet',
    '--newline',
    '--progress-template', '[dlprog] %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--extract-audio',
    '--audio-format', format,
    '--audio-quality', '0',
    '--add-metadata',
    '--output', outPattern,
    '--print', `after_move:${META_TAG}%(artist|)s\t%(album|)s\t%(filepath)s`,
    target,
  ];
  if (THUMBNAIL_FORMATS.has(format)) args.push('--embed-thumbnail');
  if (SOURCE_CODEC_FILTER[format]) args.push('-f', `bestaudio${SOURCE_CODEC_FILTER[format]}/bestaudio/best`);
  const ffmpeg = resolveBundledFfmpeg();
  if (ffmpeg) args.push('--ffmpeg-location', ffmpeg);

  const sendProgress = (data) => {
    try {
      if (event && event.sender && !event.sender.isDestroyed()) {
        event.sender.send('downloads:ytProgress', { videoId, url, requestId, ...data });
      }
    } catch (_) {}
  };

  const { code, stdout, stderr, spawnError } = await streamYtDlp(args, {
    timeoutMs: 5 * 60 * 1000,
    onProgress: (p) => sendProgress(p),
    onPhase: (phase) => sendProgress({ phase }),
  });

  if (spawnError) {
    return { success: false, error: 'yt-dlp not found. Install it: pip install -U yt-dlp' };
  }
  if (code !== 0) {
    const errLine = (stderr.trim().split('\n').pop() || stdout.trim().split('\n').pop() || 'yt-dlp failed').slice(0, 300);
    return { success: false, error: errLine, reason: classifyYtDlpError(stderr || stdout) };
  }

  // artist \t album \t path — the path goes last so a stray tab in it can't
  // shift the fields, and the renderer's artist wins over yt-dlp's when both exist.
  const meta = (stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith(META_TAG)).pop() || '').slice(META_TAG.length).split('\t');
  const album = meta.length >= 3 ? meta[1] : '';
  let filePath = meta.length >= 3 ? meta.slice(2).join('\t') : '';
  const folderArtist = artist || (meta.length >= 3 ? meta[0] : '');
  if (!filePath || !fs.existsSync(filePath)) {
    try {
      const files = fs.readdirSync(downloadsDir)
        .filter(f => f.toLowerCase().endsWith('.' + format) && (videoId ? f.includes(`[${videoId}]`) : true))
        .map(f => ({ f, m: fs.statSync(path.join(downloadsDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (files.length) filePath = path.join(downloadsDir, files[0].f);
    } catch (_) {}
  }
  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: 'Downloaded file not found' };
  }

  try {
    filePath = placeDownload(filePath, downloadsDir, { artist: folderArtist, album, suggestedName, format });
  } catch (_) { /* keep the file where yt-dlp left it */ }

  await stripCoverIfCorrupt(filePath);

  return { success: true, filePath, downloadsDir };
}

ipcMain.handle('downloads:ytDownload', async (event, payload) => {
  const { videoId, url } = payload || {};
  if (!videoId && !url) return { success: false, error: 'No video id' };
  return runYtDownload(event, payload, url || `https://www.youtube.com/watch?v=${videoId}`);
});

ipcMain.handle('downloads:ytDownloadByQuery', async (event, payload) => {
  const query = String((payload && payload.query) || '').trim();
  if (!query) return { success: false, error: 'Empty query' };
  return runYtDownload(event, payload, `ytsearch1:${query}`);
});

ipcMain.handle('downloads:getDir', async (event, payload) => {
  return resolveDownloadsDir(payload && payload.targetDir);
});

// ── Shared Puppeteer helpers ─────────────────────────────────────────────────
// Bundled-Chromium resolution and duration parsing, shared with the Spotify parser.

function resolveBundledChromium() {
  const bundleRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'chromium-bundle')
    : path.join(__dirname, 'chromium-bundle');

  let dirPrefix;
  let relExe;
  if (process.platform === 'linux') {
    dirPrefix = 'linux';
    relExe = path.join('chrome-linux64', 'chrome');
  } else if (process.platform === 'win32') {
    dirPrefix = 'win64';
    relExe = path.join('chrome-win64', 'chrome.exe');
  } else if (process.platform === 'darwin') {
    dirPrefix = process.arch === 'arm64' ? 'mac_arm' : 'mac';
    const inner = process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64';
    relExe = path.join(inner, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  } else {
    return null;
  }

  try {
    const chromeRoot = path.join(bundleRoot, 'chrome');
    const subdirs = fs.readdirSync(chromeRoot).filter(d => d.startsWith(dirPrefix + '-'));
    if (subdirs.length) {
      subdirs.sort();
      const versionDir = subdirs[subdirs.length - 1];
      const candidate = path.join(chromeRoot, versionDir, relExe);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch (_) { /* fall through */ }

  try { return require('puppeteer').executablePath(); } catch (_) { return null; }
}

function durationToSeconds(dur) {
  if (!dur) return 0;
  const parts = String(dur).trim().split(/[:.]/);
  try {
    if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    if (parts.length === 3) return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
  } catch (_) {}
  return 0;
}

// ── Spotify playlist parser (Puppeteer) ───────────────────────────────────────
// Puppeteer + bundled Chromium, scroll-and-collect over a virtualized list, with
// Spotify-specific extraction: open.spotify.com
// uses hashed class names, so rows are located via data-testid attributes and
// href patterns instead of class fragments. Spotify has no yt-dlp extractor, so
// downloading goes through ytsearch1:"artist title".

let spotifyBrowser = null;

const SPOTIFY_TRACK_SEL = '[data-testid="tracklist-row"]';

async function dismissSpotifyOverlays(page) {
  // Cookie consent (OneTrust) and the occasional promo dialog.
  for (const sel of ['#onetrust-accept-btn-handler', 'button[data-testid="close-button"]']) {
    try {
      const h = await page.$(sel);
      if (h) { await h.click({ delay: 30 }).catch(() => {}); await new Promise(r => setTimeout(r, 300)); }
    } catch (_) {}
  }
  try { await page.keyboard.press('Escape'); } catch (_) {}
}

async function extractSpotifyTracksFromDom(page) {
  return await page.evaluate((TRACK_SEL) => {
    // Artist links that live outside any track row belong to the page header
    // (album artist / artist page name). Used as fallback for rows that omit
    // the artist (album pages, artist "Popular" sections).
    function getPageArtist() {
      const rows = Array.from(document.querySelectorAll(TRACK_SEL));
      const links = Array.from(document.querySelectorAll("a[href*='/artist/']"));
      const names = [];
      for (const a of links) {
        if (rows.some(r => r.contains(a))) continue;
        const t = (a.textContent || '').trim();
        if (t && !names.includes(t)) names.push(t);
      }
      // Artist pages: the header h1 is the artist itself and has no /artist/ link.
      if (!names.length && /\/artist\//.test(location.pathname)) {
        const h1 = document.querySelector('h1');
        const t = h1 ? (h1.textContent || '').trim() : '';
        if (t) names.push(t);
      }
      return names.join(' & ');
    }
    function getPageCover() {
      const imgs = document.querySelectorAll("img[src*='i.scdn.co/image']");
      for (const img of imgs) {
        const row = img.closest(TRACK_SEL);
        if (!row) return img.getAttribute('src') || '';
      }
      return '';
    }
    // Spotify encodes the thumbnail size in the image id prefix — swap the
    // 64px / 300px variants for the 640px one.
    function upscaleCover(src) {
      return String(src || '').replace('ab67616d00004851', 'ab67616d0000b273').replace('ab67616d00001e02', 'ab67616d0000b273');
    }
    const pageArtist = getPageArtist();
    const pageCover = getPageCover();
    const out = [];
    document.querySelectorAll(TRACK_SEL).forEach(row => {
      let title = '';
      const titleLink = row.querySelector("a[data-testid='internal-track-link']");
      if (titleLink) title = (titleLink.textContent || '').trim();
      if (!title) {
        // Album pages: the title is plain text, the first div[dir=auto] that
        // isn't inside an artist/album link.
        const divs = row.querySelectorAll("div[dir='auto']");
        for (const d of divs) {
          if (d.closest('a')) continue;
          const t = (d.textContent || '').trim();
          if (t) { title = t; break; }
        }
      }
      if (!title) return;

      const artistNames = [];
      row.querySelectorAll("a[href*='/artist/']").forEach(a => {
        const t = (a.textContent || '').trim();
        if (t && !artistNames.includes(t)) artistNames.push(t);
      });
      const artist = artistNames.join(' & ') || pageArtist;

      let dur = '';
      row.querySelectorAll('div').forEach(d => {
        if (dur) return;
        const t = (d.textContent || '').trim();
        if (/^\d+:\d{2}$/.test(t) && d.childElementCount === 0) dur = t;
      });

      const img = row.querySelector("img[src*='i.scdn.co/image']");
      const cover = upscaleCover(img ? img.getAttribute('src') : pageCover);

      out.push({
        title,
        artist: artist || '—',
        duration: dur || '—',
        cover_url: cover || '',
      });
    });
    return out;
  }, SPOTIFY_TRACK_SEL);
}

ipcMain.handle('spotify:parsePlaylist', async (event, payload) => {
  const url = (payload && payload.url) ? String(payload.url).trim() : '';
  const showBrowser = !payload || payload.showBrowser !== false;
  if (!url || !/^https?:\/\/open\.spotify\.com\//i.test(url)) {
    return { success: false, error: 'Invalid Spotify URL' };
  }

  const send = (data) => {
    try {
      if (event && event.sender && !event.sender.isDestroyed()) {
        event.sender.send('spotify:parseProgress', data);
      }
    } catch (_) {}
  };

  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch (err) {
    return { success: false, error: 'puppeteer not installed' };
  }

  const executablePath = resolveBundledChromium();
  if (!executablePath || !fs.existsSync(executablePath)) {
    return { success: false, error: 'Bundled Chromium not found. Run "npm install puppeteer" before packaging.' };
  }

  const userDataDir = path.join(app.getPath('userData'), 'spotify-profile');
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (_) {}

  send({ phase: 'launching', message: showBrowser ? 'Launching browser…' : 'Starting the parser…' });

  try {
    spotifyBrowser = await puppeteer.launch({
      executablePath,
      headless: !showBrowser,
      userDataDir,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-notifications',
        ...(showBrowser ? ['--window-size=1440,900'] : []),
      ],
      defaultViewport: showBrowser ? null : { width: 1440, height: 900 },
    });
  } catch (err) {
    return { success: false, error: 'Failed to launch Chromium: ' + String(err).slice(0, 200) };
  }

  const collected = new Map();

  try {
    const pages = await spotifyBrowser.pages();
    const page = pages[0] || await spotifyBrowser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    send({ phase: 'loading', message: 'Opening the page…' });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    } catch (navErr) {
      // The "wait for tracks" loop below is
      // the real gate, DOMContentLoaded on heavy SPAs is unreliable.
      send({ phase: 'loading', message: 'The page is loading slower than usual, continuing…' });
    }
    await new Promise(r => setTimeout(r, 2500));

    await dismissSpotifyOverlays(page);

    send({
      phase: 'loading',
      message: showBrowser
        ? 'Waiting for tracks (sign in to Spotify in the browser window if needed)…'
        : 'Waiting for tracks…',
    });
    const deadline = Date.now() + 90_000;
    let appeared = false;
    while (Date.now() < deadline) {
      await dismissSpotifyOverlays(page);
      const count = await page.$$eval(SPOTIFY_TRACK_SEL, els => els.length).catch(() => 0);
      if (count > 0) { appeared = true; break; }
      await new Promise(r => setTimeout(r, 1500));
    }
    if (!appeared) throw new Error('Tracks did not appear (private playlist or wrong URL?)');

    send({ phase: 'scrolling', message: 'Collecting tracks…', total: 0 });

    let noNew = 0;
    const SCROLL_RETRIES = 6;
    while (noNew < SCROLL_RETRIES) {
      const tracks = await extractSpotifyTracksFromDom(page);
      let added = 0;
      for (const t of tracks) {
        const key = `${t.title}|${t.artist}`;
        if (!collected.has(key)) {
          collected.set(key, { ...t, index: collected.size + 1, duration_sec: durationToSeconds(t.duration) });
          added++;
        }
      }
      if (added === 0) noNew++; else noNew = 0;
      send({
        phase: 'scrolling',
        message: 'Collecting tracks…',
        total: collected.size,
        added,
        tracks: Array.from(collected.values()),
      });
      try {
        // Spotify virtualizes the list inside its own scroll container —
        // scrollIntoView on the last visible row advances it reliably.
        await page.evaluate((sel) => {
          const els = document.querySelectorAll(sel);
          if (els.length) { els[els.length - 1].scrollIntoView({ block: 'center' }); return; }
          const sc = document.querySelector('[data-overlayscrollbars-viewport], .main-view-container__scroll-node');
          if (sc) sc.scrollBy(0, 800); else window.scrollBy(0, 600);
        }, SPOTIFY_TRACK_SEL);
      } catch (_) {
        await page.evaluate(() => window.scrollBy(0, 600));
      }
      await new Promise(r => setTimeout(r, 1500));
    }

    const tracks = Array.from(collected.values());
    send({ phase: 'done', message: `Done — ${tracks.length} tracks`, total: tracks.length, tracks });
    return { success: true, tracks };
  } catch (err) {
    const msg = String(err && err.message || err).slice(0, 300);
    send({ phase: 'error', message: msg });
    return { success: false, error: msg, tracks: Array.from(collected.values()) };
  } finally {
    try { if (spotifyBrowser) await spotifyBrowser.close(); } catch (_) {}
    spotifyBrowser = null;
  }
});

// ── YouTube sign-in (for yt-dlp cookies) ──────────────────────────────────────
// Same trick as the Spotify parser: a real, visible, bundled-Chromium window
// with a profile that persists across runs, so the user only has to sign in
// once. Unlike Spotify there's no page to scrape afterward — the whole point
// is the cookie jar — so instead of waiting for one specific action to finish,
// snapshot cookies periodically while the window is open and keep whatever
// the last snapshot was once the user closes it (closing is the "done" signal;
// cookies can't be read from Chromium anymore once it has disconnected).
let youtubeLoginBrowser = null;

function cookiesToNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
    const expires = c.expires > 0 ? Math.round(c.expires) : Math.round(Date.now() / 1000) + 365 * 24 * 3600;
    lines.push([domain, 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', expires, c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

ipcMain.handle('youtube:login', async () => {
  if (youtubeLoginBrowser) return { success: false, error: 'A sign-in window is already open.' };

  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch (_) { return { success: false, error: 'puppeteer not installed' }; }
  const executablePath = resolveBundledChromium();
  if (!executablePath || !fs.existsSync(executablePath)) {
    return { success: false, error: 'Bundled Chromium not found. Run "npm install puppeteer" before packaging.' };
  }

  const userDataDir = path.join(app.getPath('userData'), 'youtube-profile');
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (_) {}

  let interval = null;
  try {
    youtubeLoginBrowser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-notifications', '--window-size=1200,840'],
      defaultViewport: null,
    });
    const pages = await youtubeLoginBrowser.pages();
    const page = pages[0] || await youtubeLoginBrowser.newPage();
    await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

    const client = await page.target().createCDPSession();
    const saveCookies = async () => {
      try {
        const { cookies } = await client.send('Network.getAllCookies');
        fs.writeFileSync(youtubeCookiesPath(), cookiesToNetscape(cookies));
      } catch (_) { /* browser may already be closing */ }
    };
    await saveCookies();
    interval = setInterval(saveCookies, 3000);

    await new Promise((resolve) => youtubeLoginBrowser.once('disconnected', resolve));
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err && err.message || err).slice(0, 300) };
  } finally {
    if (interval) clearInterval(interval);
    try { if (youtubeLoginBrowser) await youtubeLoginBrowser.close(); } catch (_) {}
    youtubeLoginBrowser = null;
  }
});

ipcMain.handle('youtube:cookiesStatus', async () => {
  try {
    const stat = fs.statSync(youtubeCookiesPath());
    return { signedIn: true, updatedAt: stat.mtimeMs };
  } catch (_) {
    return { signedIn: false };
  }
});

// ── Discord Rich Presence ────────────────────────────────────────────────────
// Self-contained client for Discord's local IPC protocol — no external npm
// dependency (keeps the vanilla-everything / careful-packaging philosophy).
// A frame is <4-byte LE opcode><4-byte LE length><utf8 JSON payload>. Discord
// exposes up to ten sockets named discord-ipc-0 … discord-ipc-9.
const DISCORD_OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
let discordSock = null;
let discordReady = false;
let discordUser = null;
let discordClientId = null;
let discordReadBuf = Buffer.alloc(0);
let discordReadyResolve = null;
let discordActivityNonce = 0;

function discordIpcCandidates() {
  if (process.platform === 'win32') {
    const out = [];
    for (let i = 0; i < 10; i++) out.push('\\\\?\\pipe\\discord-ipc-' + i);
    return out;
  }
  // Linux/macOS: the socket lives in a runtime/temp dir. Flatpak and Snap
  // builds of Discord nest it under app-specific subdirectories.
  const roots = [process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP, '/tmp']
    .filter(Boolean);
  const dirs = [];
  for (const r of roots) {
    dirs.push(r);
    dirs.push(path.join(r, 'app', 'com.discordapp.Discord'));
    dirs.push(path.join(r, 'snap.discord'));
  }
  const out = [];
  for (let i = 0; i < 10; i++) for (const d of dirs) out.push(path.join(d, 'discord-ipc-' + i));
  return out;
}

function discordEncode(op, dataObj) {
  const json = Buffer.from(JSON.stringify(dataObj), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

function discordConnectSocket(paths) {
  return new Promise((resolve, reject) => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= paths.length) { reject(new Error('Discord is not running (IPC socket not found)')); return; }
      const p = paths[idx++];
      const sock = net.createConnection(p);
      sock.once('connect', () => { sock.removeAllListeners('error'); resolve(sock); });
      sock.once('error', () => { try { sock.destroy(); } catch (_) {} tryNext(); });
    };
    tryNext();
  });
}

function discordOnData(chunk) {
  discordReadBuf = Buffer.concat([discordReadBuf, chunk]);
  while (discordReadBuf.length >= 8) {
    const op = discordReadBuf.readInt32LE(0);
    const len = discordReadBuf.readInt32LE(4);
    if (discordReadBuf.length < 8 + len) break;
    const payload = discordReadBuf.slice(8, 8 + len).toString('utf8');
    discordReadBuf = discordReadBuf.slice(8 + len);
    let msg = null;
    try { msg = JSON.parse(payload); } catch (_) { continue; }
    if (op === DISCORD_OP.PING) { try { discordSock.write(discordEncode(DISCORD_OP.PONG, msg)); } catch (_) {} continue; }
    if (op === DISCORD_OP.CLOSE) { discordTeardown(); notifyDiscordStatus(); continue; }
    if (msg && msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
      const u = msg.data && msg.data.user;
      discordUser = u ? { id: u.id, username: u.username, global_name: u.global_name || null } : null;
      discordReady = true;
      if (discordReadyResolve) { const r = discordReadyResolve; discordReadyResolve = null; r(discordUser); }
      notifyDiscordStatus();
    }
  }
}

function discordTeardown() {
  discordReady = false;
  discordUser = null;
  discordReadBuf = Buffer.alloc(0);
  if (discordSock) { try { discordSock.destroy(); } catch (_) {} discordSock = null; }
}

function notifyDiscordStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('discord:status', { connected: discordReady, user: discordUser }); } catch (_) {}
}

async function discordConnect(clientId) {
  if (!clientId) throw new Error('Discord Client ID is not set');
  if (discordSock && discordReady && discordClientId === clientId) return discordUser;
  discordTeardown();
  discordClientId = clientId;
  const sock = await discordConnectSocket(discordIpcCandidates());
  discordSock = sock;
  sock.on('data', discordOnData);
  sock.on('close', () => { discordTeardown(); notifyDiscordStatus(); });
  sock.on('error', () => { /* 'close' fires right after and handles cleanup */ });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!discordReady) { discordReadyResolve = null; discordTeardown(); reject(new Error('Discord did not respond (handshake timeout)')); }
    }, 8000);
    discordReadyResolve = (u) => { clearTimeout(timer); resolve(u); };
    try { sock.write(discordEncode(DISCORD_OP.HANDSHAKE, { v: 1, client_id: clientId })); }
    catch (err) { clearTimeout(timer); discordReadyResolve = null; discordTeardown(); reject(err); }
  });
}

function discordSetActivity(activity) {
  if (!discordSock || !discordReady) return false;
  const frame = {
    cmd: 'SET_ACTIVITY',
    args: { pid: process.pid, activity: activity || null },
    nonce: String(++discordActivityNonce),
  };
  try { discordSock.write(discordEncode(DISCORD_OP.FRAME, frame)); return true; } catch (_) { return false; }
}

ipcMain.handle('discord:connect', async (event, payload) => {
  try { const user = await discordConnect(payload && payload.clientId); return { ok: true, user }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});
ipcMain.handle('discord:disconnect', () => { discordTeardown(); notifyDiscordStatus(); return { ok: true }; });
ipcMain.handle('discord:setActivity', (event, payload) => ({ ok: discordSetActivity(payload && payload.activity) }));
ipcMain.handle('discord:getStatus', () => ({ connected: discordReady, user: discordUser }));

app.on('before-quit', () => discordTeardown());

// ── Album-cover lookup (iTunes Search API) ───────────────────────────────────
// Discord rich presence can show a large image only from an art-asset key or a
// public https URL — not local/embedded artwork. We resolve a public cover URL
// from Apple's free, key-less iTunes Search API and hand it to the renderer,
// which passes it straight into the activity's large_image. Results are cached
// in-process so each track is looked up at most once per session.
const itunesCoverCache = new Map(); // term (lowercased) -> url | null

async function httpsGetJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Audex' }, signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    // Error bodies (e.g. AcoustID's {status:"error",error:{code,message}})
    // still carry the real reason a request failed — attach it so callers
    // can tell "bad key" apart from "rate limited" apart from "bad request".
    try { err.body = JSON.parse(text); } catch (_) {}
    throw err;
  }
  return JSON.parse(text);
}

// ── AcoustID / MusicBrainz identification ──
// The audio itself is fingerprinted with Chromaprint's fpcalc (a well-known
// system binary, shelled out to like ffmpeg and yt-dlp already are — the
// bundled ffmpeg-static is built without the chromaprint muxer, so it can't
// stand in). The fingerprint goes to AcoustID, which answers with the
// MusicBrainz recordings it maps to. This is the only lookup here that needs
// the network, and it only runs when the user presses Identify. Requires the
// user's own free key from acoustid.org/api-key — no built-in fallback key.
const ACOUSTID_URL = 'https://api.acoustid.org/v2/lookup';

// The fpcalc shipped inside the app (see scripts/fetch-fpcalc.js and
// build.asarUnpack), falling back to a system install for dev runs or if the
// bundle is missing. Mirrors resolveBundledYtDlp/ytDlpPath.
function fpcalcPath() {
  const bundleRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'fpcalc-bundle')
    : path.join(__dirname, 'fpcalc-bundle');
  const name = process.platform === 'win32' ? 'fpcalc.exe' : 'fpcalc';
  const bundled = path.join(bundleRoot, name);
  try {
    if (fs.existsSync(bundled)) {
      // AppImage/asar-unpacked files can lose the exec bit on some setups.
      if (process.platform !== 'win32') {
        try { fs.chmodSync(bundled, 0o755); } catch (_) {}
      }
      return bundled;
    }
  } catch (_) {}
  for (const c of ['/usr/bin/fpcalc', '/usr/local/bin/fpcalc', '/opt/homebrew/bin/fpcalc',
                   path.join(process.env.HOME || '', '.local', 'bin', 'fpcalc')]) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return name; // last resort: whatever is on PATH
}

function fingerprintFile(filePath) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(fpcalcPath(), ['-json', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ error: 'notFound' });
      return;
    }
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.resume();
    proc.on('error', () => resolve({ error: 'notFound' }));
    proc.on('close', (code) => {
      if (code !== 0) { resolve({ error: 'failed' }); return; }
      try {
        const fp = JSON.parse(out);
        resolve(fp && fp.fingerprint && fp.duration ? { fp } : { error: 'failed' });
      } catch (_) { resolve({ error: 'failed' }); }
    });
    setTimeout(() => { try { proc.kill(); } catch (_) {} }, 60000);
  });
}

// Highest-scoring recording that actually carries a title.
function acoustidBestMatch(data) {
  const results = (data && Array.isArray(data.results) ? data.results : [])
    .slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  for (const r of results) {
    for (const rec of r.recordings || []) {
      if (!rec.title) continue;
      const match = {
        title: rec.title,
        artist: (rec.artists || []).map(a => a.name).join(' & ') || '',
        album: ((rec.releasegroups || []).find(rg => rg.title) || {}).title || '',
      };
      // Track/disc number and year live on the release (a recording can appear
      // on many releases, at different positions and dates), not on the
      // recording itself — take the first release+medium that actually lists
      // this recording, and use that same release's date for consistency.
      for (const rel of rec.releases || []) {
        const medium = (rel.mediums || []).find(m => (m.tracks || []).some(t => t.id === rec.id));
        const track = medium && medium.tracks.find(t => t.id === rec.id);
        if (!track) continue;
        if (track.position) match.trackNo = String(track.position);
        if (medium.position) match.discNo = String(medium.position);
        if (rel.date && rel.date.year) match.year = String(rel.date.year);
        break;
      }
      return match;
    }
  }
  return null;
}

ipcMain.handle('acoustid:identify', async (event, { filePath, apiKey } = {}) => {
  filePath = filePath && resolveRealPath(filePath);
  if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'notFound' };
  const key = String(apiKey || '').trim();
  if (!key) return { success: false, error: 'noKey' };
  const { fp, error } = await fingerprintFile(filePath);
  if (error) return { success: false, error: error === 'notFound' ? 'noFpcalc' : 'fingerprint' };
  // A space (not "+") in `meta` — the querystring encoder turns it into the
  // separator the API wants; a literal "+" is escaped to %2B and the whole
  // meta value is silently dropped, so no recordings ever come back.
  const qs = new URLSearchParams({
    client: key,
    duration: String(Math.round(fp.duration)),
    fingerprint: fp.fingerprint,
    meta: 'recordings releasegroups releases tracks',
    format: 'json',
  });
  // AcoustID's numeric error codes aren't reliably documented across API
  // versions — trust the human-readable message instead of guessing a code
  // (an earlier version of this guessed code 1/4, which risked mislabeling an
  // unrelated 400 — e.g. rate limiting — as "bad key"). Every failure here is
  // logged to app.log with the raw response so a wrong guess is visible.
  const isKeyError = (msg) => /api ?key/i.test(String(msg || ''));
  let data;
  try {
    data = await httpsGetJson(`${ACOUSTID_URL}?${qs}`);
  } catch (err) {
    const code = err && err.body && err.body.error && err.body.error.code;
    const msg = String((err && err.body && err.body.error && err.body.error.message) || (err && err.message) || err);
    logAppError('acoustid:identify', `key=${key}, HTTP error, code=${code}, message=${msg}`);
    return { success: false, error: isKeyError(msg) ? 'apiKey' : 'lookup', detail: msg };
  }
  if (data && data.status === 'error') {
    const code = data.error && data.error.code;
    const msg = String((data.error && data.error.message) || '');
    logAppError('acoustid:identify', `key=${key}, status=error, code=${code}, message=${msg}`);
    return { success: false, error: isKeyError(msg) ? 'apiKey' : 'lookup', detail: msg };
  }
  const match = acoustidBestMatch(data);
  const results = (data && Array.isArray(data.results) ? data.results : []).slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  const top = results[0];
  logAppError('acoustid:identify', `file=${filePath}, score=${top ? top.score : 'n/a'}, recordings=${top ? (top.recordings || []).length : 0}, match=${JSON.stringify(match)}`);
  if (match) return { success: true, match };
  // No MusicBrainz recording linked yet — the raw AcoustID is still worth showing.
  return { success: true, match: null, acoustid: top ? top.id : null };
});

// artworkUrl100 looks like ".../100x100bb.jpg" — upscale to 512 for Discord.
async function itunesArtwork(term, entity) {
  const api = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=${entity}&limit=1`;
  const json = await httpsGetJson(api);
  const r = json && Array.isArray(json.results) && json.results[0];
  return r && r.artworkUrl100 ? r.artworkUrl100.replace(/\/\d+x\d+bb\./, '/512x512bb.') : null;
}

ipcMain.handle('music:lookupCover', async (event, query) => {
  try {
    const artist = String(query && query.artist || '').trim();
    const title = String(query && query.title || '').trim();
    const album = String(query && query.album || '').trim();
    // Prefer artist+title (most specific); fall back to artist+album.
    const term = ([artist, title].filter(Boolean).join(' ').trim())
      || ([artist, album].filter(Boolean).join(' ').trim());
    if (!term) return { url: null };
    const cacheKey = term.toLowerCase();
    if (itunesCoverCache.has(cacheKey)) return { url: itunesCoverCache.get(cacheKey) };
    let url = null;
    try {
      // An album search matches the actual release art; a song search often
      // returns whatever compilation/rerelease iTunes ranks first for a common
      // track title, which is frequently the wrong cover. Try album first.
      const albumTerm = [artist, album].filter(Boolean).join(' ').trim();
      if (albumTerm) url = await itunesArtwork(albumTerm, 'album');
      if (!url) url = await itunesArtwork(term, 'song');
    } catch (_) { url = null; }
    itunesCoverCache.set(cacheKey, url);
    return { url };
  } catch (err) {
    return { url: null, error: String(err && err.message || err) };
  }
});

// ── Lyrics lookup (LRCLIB) ────────────────────────────────────────────────
// LRCLIB is a free, key-less lyrics API. /api/get wants an exact match
// (artist+title+album+duration, duration tolerance ~2s) and 404s if it can't
// find one; we then fall back to /api/search, which fuzzy-matches on
// artist+title and returns a ranked list — we take the first hit that has
// synced lyrics, or else the first with plain lyrics.
const lrclibCache = new Map(); // "artist|title|album|duration" -> result

ipcMain.handle('music:lookupLyrics', async (event, query) => {
  try {
    const artist = String(query && query.artist || '').trim();
    const title = String(query && query.title || '').trim();
    const album = String(query && query.album || '').trim();
    const duration = Math.round(Number(query && query.duration) || 0);
    if (!title) return { success: false, synced: null, plain: null };
    const cacheKey = [artist, title, album, duration].join('|').toLowerCase();
    if (lrclibCache.has(cacheKey)) return lrclibCache.get(cacheKey);

    let result = null;
    const getParams = new URLSearchParams({ track_name: title, artist_name: artist });
    if (album) getParams.set('album_name', album);
    if (duration > 0) getParams.set('duration', String(duration));
    try {
      const json = await httpsGetJson(`https://lrclib.net/api/get?${getParams}`);
      if (json && (json.syncedLyrics || json.plainLyrics)) {
        result = { success: true, synced: json.syncedLyrics || null, plain: json.plainLyrics || null };
      }
    } catch (_) { /* no exact match — fall through to search */ }

    if (!result) {
      const searchParams = new URLSearchParams({ track_name: title, artist_name: artist });
      try {
        const json = await httpsGetJson(`https://lrclib.net/api/search?${searchParams}`);
        const hit = Array.isArray(json) ? (json.find(r => r.syncedLyrics) || json.find(r => r.plainLyrics)) : null;
        if (hit) result = { success: true, synced: hit.syncedLyrics || null, plain: hit.plainLyrics || null };
      } catch (_) { /* no match at all */ }
    }

    if (!result) result = { success: true, synced: null, plain: null };
    lrclibCache.set(cacheKey, result);
    return result;
  } catch (err) {
    return { success: false, error: String(err && err.message || err), synced: null, plain: null };
  }
});
