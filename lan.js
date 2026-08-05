// ── Audex LAN / Tailscale sharing ──
//
// A plain HTTP + JSON API so other Audex instances (and, later, mobile clients)
// can browse this device's library, stream from it, and take its session over
// the way Spotify Connect does. Node's own `http` and `dgram` cover all of it —
// no framework, no websocket library.
//
// Everything is off until the user enables it and sets a network key. The key
// is shared across a person's own devices (like a Wi-Fi password): same key =
// same device group. Every request must present it as a bearer token, so the
// server is safe to bind on 0.0.0.0 — which is what makes it reach both the LAN
// and the Tailscale interface without knowing anything about either.
//
// Media URLs can't carry an Authorization header (<audio src> and <img src>
// don't take one), so those endpoints authenticate with a per-track HMAC of the
// key instead. The key itself never travels in a URL.

const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const musicMetadata = require('music-metadata');

// Discovery has to be a well-known port for broadcasts to land, but the HTTP
// port only has to be *reachable* — peers learn it from the announce, and manual
// entries can spell it out. So the server walks up until it finds a free one
// rather than silently not sharing because something else holds 8422.
const PORT = 8422;
const PORT_TRIES = 5;
const ANNOUNCE_MS = 5000;
const PEER_TTL = 20000;

let httpPort = PORT;

const MIME = {
  '.mp3': 'audio/mpeg', '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.wma': 'audio/x-ms-wma',
};

let cfg = { enabled: false, key: '', name: os.hostname() };
let cfgPath = '';
let coverDir = '';
let deviceId = '';
let logError = () => {};
let sendCommand = () => {};
let onPeersChanged = () => {};

let server = null;
let udp = null;
let announceTimer = null;
let lastError = '';

// Published by the renderer, which owns the library and the player. Paths stay
// on this side of the wire: peers only ever see the sha1 id.
let snapshot = { tracks: [], state: null, config: null };
let byId = new Map();

const peers = new Map(); // deviceId -> { deviceId, name, host, port, lastSeen, manual }

// ── config ──

function load(opts) {
  cfgPath = path.join(opts.userDataDir, 'lan.json');
  coverDir = opts.coverDir;
  logError = opts.logError || logError;
  sendCommand = opts.sendCommand || sendCommand;
  onPeersChanged = opts.onPeersChanged || onPeersChanged;
  try { Object.assign(cfg, JSON.parse(fs.readFileSync(cfgPath, 'utf8'))); } catch (_) {}
  if (!cfg.deviceId) cfg.deviceId = crypto.randomBytes(8).toString('hex');
  deviceId = cfg.deviceId;
  if (!cfg.name) cfg.name = os.hostname();
  for (const p of cfg.manualPeers || []) addManualPeer(p, true);
  if (cfg.enabled && cfg.key) start();
}

function save() {
  cfg.manualPeers = [...peers.values()].filter(p => p.manual).map(p => `${p.host}:${p.port}`);
  try { fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); } catch (e) { logError('lan:save', e); }
}

function setConfig(next) {
  const wasOn = !!(cfg.enabled && cfg.key);
  Object.assign(cfg, next);
  save();
  const wantOn = !!(cfg.enabled && cfg.key);
  // The key is baked into auth and into the discovery HMAC, so a key change has
  // to cycle the server even when it was already running.
  if (wasOn) stop();
  if (wantOn) start();
  return status();
}

// ── auth ──

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

function authOk(req) {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Bearer ')) return false;
  return crypto.timingSafeEqual(sha256(h.slice(7)), sha256(cfg.key));
}

// Per-resource signature for URLs that can't carry a header.
function sign(id) {
  return crypto.createHmac('sha256', cfg.key).update(String(id)).digest('hex').slice(0, 32);
}
function signOk(id, given) {
  const want = sign(id);
  if (typeof given !== 'string' || given.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

// ── snapshot ──

// The renderer sends `tracks` only when the library actually changed — playback
// state ticks once a second and has no business re-sending thousands of rows.
function publish(next) {
  if (next && next.state !== undefined) snapshot.state = next.state;
  if (next && next.config !== undefined) snapshot.config = next.config;
  if (!Array.isArray(next && next.tracks)) return;
  snapshot.tracks = next.tracks;
  byId = new Map();
  for (const t of snapshot.tracks) {
    if (t && t.path) byId.set(crypto.createHash('sha1').update(t.path).digest('hex'), t);
  }
}

const idOf = (p) => crypto.createHash('sha1').update(p).digest('hex');

// Peers connect over whichever interface they can reach — LAN address on the
// LAN, 100.x on Tailscale. Building the media URLs from the Host header they
// already used means we never have to work out which of our own addresses is
// the one that answers for them.
function publicTrack(id, t, host) {
  return {
    id,
    title: t.title || '', artist: t.artist || '', album: t.album || '',
    albumArtist: t.albumArtist || '', year: t.year || '', genre: t.genre || '',
    trackNo: t.trackNo || '', discNo: t.discNo || '',
    duration: t.duration || 0, quality: t.quality || null, hasCover: !!t.hasCover,
    url: `http://${host}/api/track/${id}?s=${sign(id)}`,
    coverUrl: t.hasCover ? `http://${host}/api/cover/${id}?s=${sign(id)}` : null,
  };
}

// ── http ──

function sendJson(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  });
  res.end(buf);
}

// Range support is not optional here: without 206 responses Chromium's <audio>
// can load a stream but can't seek within it.
function sendFile(req, res, filePath, mime) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return sendJson(res, 404, { error: 'gone' }); }

  const head = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (m && (m[1] || m[2])) {
    let start = m[1] ? parseInt(m[1], 10) : NaN;
    let end = m[2] ? parseInt(m[2], 10) : NaN;
    if (Number.isNaN(start)) { start = Math.max(0, stat.size - end); end = stat.size - 1; } // suffix range
    if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (!(start >= 0 && start <= end)) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }
    head['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    head['Content-Length'] = end - start + 1;
    res.writeHead(206, head);
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }
  head['Content-Length'] = stat.size;
  res.writeHead(200, head);
  fs.createReadStream(filePath).pipe(res);
}

// Covers live in main's cover-cache as <sha1-of-path>.<ext>; anything not cached
// yet gets read straight out of the file's tags.
async function sendCover(res, trackPath) {
  const hash = crypto.createHash('sha1').update(trackPath).digest('hex');
  try {
    for (const name of fs.readdirSync(coverDir)) {
      if (name.startsWith(hash)) {
        const ext = path.extname(name).slice(1) || 'jpeg';
        return sendFile({ headers: {} }, res, path.join(coverDir, name), `image/${ext}`);
      }
    }
  } catch (_) { /* no cache dir yet — fall through to the tags */ }
  try {
    const md = await musicMetadata.parseFile(trackPath);
    const pic = md.common.picture && md.common.picture[0];
    if (!pic) return sendJson(res, 404, { error: 'no cover' });
    const buf = Buffer.from(pic.data);
    res.writeHead(200, {
      'Content-Type': pic.format || 'image/jpeg',
      'Content-Length': buf.length,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
  } catch (_) { sendJson(res, 404, { error: 'no cover' }); }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// The state a peer needs to continue this session elsewhere. The track is
// described by a URL any peer can fetch, so a takeover works whether we were
// playing a local file or already streaming from a third device.
function publicState(host) {
  const s = snapshot.state || {};
  const out = {
    deviceId, name: cfg.name,
    playing: !!s.playing, position: s.position || 0, duration: s.duration || 0,
    volume: s.volume, shuffle: !!s.shuffle, repeat: s.repeat || 0,
    track: null,
  };
  // A track we're only relaying keeps its origin URL — a takeover should stream
  // from wherever it actually lives, not chain through this device.
  const describe = (p) => {
    if (/^https?:/.test(p)) return null;
    const id = idOf(p);
    const t = byId.get(id);
    return t ? publicTrack(id, t, host) : null;
  };
  if (s.path) {
    out.track = describe(s.path) || {
      id: s.path, title: s.title || '', artist: s.artist || '', album: s.album || '',
      duration: s.duration || 0, url: s.path, coverUrl: s.coverUrl || null,
    };
  }
  // What comes after the current track, so a takeover keeps playing the album
  // rather than stopping dead at the end of one song.
  out.queue = (Array.isArray(s.queue) ? s.queue : []).map(describe).filter(Boolean);
  return out;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  const route = url.pathname;
  const host = req.headers.host || `127.0.0.1:${httpPort}`;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  // Media endpoints authenticate by signature, everything else by bearer token.
  const media = /^\/api\/(track|cover)\/([a-f0-9]{40})$/.exec(route);
  if (media) {
    const id = media[2];
    if (!signOk(id, url.searchParams.get('s'))) return sendJson(res, 401, { error: 'bad signature' });
    const t = byId.get(id);
    if (!t) return sendJson(res, 404, { error: 'unknown track' });
    if (media[1] === 'cover') return sendCover(res, t.path);
    return sendFile(req, res, t.path, MIME[path.extname(t.path).toLowerCase()] || 'application/octet-stream');
  }

  if (!authOk(req)) return sendJson(res, 401, { error: 'unauthorized' });

  if (route === '/api/info') {
    return sendJson(res, 200, { deviceId, name: cfg.name, app: 'audex', api: 1, tracks: snapshot.tracks.length });
  }
  if (route === '/api/library') {
    return sendJson(res, 200, { tracks: [...byId].map(([id, t]) => publicTrack(id, t, host)) });
  }
  if (route === '/api/state') {
    return sendJson(res, 200, publicState(host));
  }
  if (route === '/api/config') {
    return sendJson(res, 200, snapshot.config || {});
  }
  if (route === '/api/command' && req.method === 'POST') {
    const cmd = await readBody(req);
    // A takeover is "give me the session, then stop playing it" — one round trip.
    const state = cmd.type === 'transfer' ? publicState(host) : null;
    if (cmd.type === 'transfer') sendCommand({ type: 'pause' });
    else sendCommand(cmd);
    return sendJson(res, 200, { ok: true, state });
  }
  sendJson(res, 404, { error: 'no route' });
}

// ── discovery ──
//
// UDP broadcast finds peers on a LAN. Tailscale carries no broadcast traffic, so
// devices reached over it are added by address instead — hence manual peers.

function announceMsg() {
  const body = { t: 'audex', deviceId, name: cfg.name, port: httpPort };
  body.mac = crypto.createHmac('sha256', cfg.key).update(deviceId).digest('hex').slice(0, 16);
  return Buffer.from(JSON.stringify(body));
}

function notePeer(p) {
  const prev = peers.get(p.deviceId);
  peers.set(p.deviceId, { ...prev, ...p, lastSeen: Date.now() });
  if (!prev || prev.host !== p.host || prev.name !== p.name) onPeersChanged(listPeers());
}

// The global broadcast address (255.255.255.255) only reaches the interface
// Windows' routing table happens to pick for it — on a machine with several
// IPv4 adapters (Tailscale's virtual NIC, a VPN, Hyper-V/VMware switches) that
// is frequently *not* the real LAN adapter, so the announce silently never
// leaves the box. Sending the same packet to every interface's own
// subnet-directed broadcast (e.g. 192.168.1.255) sidesteps the ambiguity: each
// one matches a specific route and is forced out its own adapter.
function subnetBroadcasts() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal || !ni.netmask) continue;
      const addr = ni.address.split('.').map(Number);
      const mask = ni.netmask.split('.').map(Number);
      if (addr.length !== 4 || mask.length !== 4) continue;
      out.push(addr.map((o, i) => o | (~mask[i] & 255)).join('.'));
    }
  }
  return out;
}

function startDiscovery() {
  udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('error', (e) => { lastError = String(e.message || e); logError('lan:udp', e); });
  udp.on('message', (buf, rinfo) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch (_) { return; }
    if (!m || m.t !== 'audex' || !m.deviceId || m.deviceId === deviceId) return;
    // Only devices holding the same network key are worth listing.
    const want = crypto.createHmac('sha256', cfg.key).update(m.deviceId).digest('hex').slice(0, 16);
    if (m.mac !== want) return;
    notePeer({ deviceId: m.deviceId, name: m.name || rinfo.address, host: rinfo.address, port: m.port || PORT, manual: false });
  });
  udp.bind(PORT, () => {
    try { udp.setBroadcast(true); } catch (_) {}
    const beat = () => {
      const msg = announceMsg();
      const targets = new Set(['255.255.255.255', ...subnetBroadcasts()]);
      for (const addr of targets) {
        try { udp.send(msg, PORT, addr); } catch (_) {}
      }
      let dropped = false;
      // Mobile peers never send a UDP announce (that's this loop's own
      // heartbeat) — their presence is the open WebSocket itself, cleaned up
      // by handleUpgrade()'s close handler instead of this TTL.
      for (const [id, p] of peers) {
        if (!p.manual && !p.mobile && Date.now() - p.lastSeen > PEER_TTL) { peers.delete(id); dropped = true; }
      }
      if (dropped) onPeersChanged(listPeers());
    };
    beat();
    announceTimer = setInterval(beat, ANNOUNCE_MS);
  });
}

function addManualPeer(addr, quiet) {
  const s = String(addr || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!s) return null;
  const i = s.lastIndexOf(':');
  const host = i > 0 && !s.slice(i + 1).includes(']') ? s.slice(0, i) : s;
  const port = i > 0 ? parseInt(s.slice(i + 1), 10) || PORT : PORT;
  const key = `manual:${host}:${port}`;
  peers.set(key, { deviceId: key, name: host, host, port, manual: true, lastSeen: Date.now() });
  if (!quiet) { save(); onPeersChanged(listPeers()); }
  return listPeers();
}

function removePeer(id) {
  peers.delete(id);
  save();
  onPeersChanged(listPeers());
  return listPeers();
}

function listPeers() {
  return [...peers.values()].map(p => (p.mobile ? { ...p } : { ...p, base: `http://${p.host}:${p.port}` }));
}

// ── mobile clients (WebSocket) ──
//
// A mobile client (mobile/src/bridge.js) has no server of its own to receive
// a push or answer a take-over on — Capacitor's WebView can't listen for
// inbound connections without new native code. But it can hold a normal
// client WebSocket open to *this* server, and the browser/WebView already
// implements the WS protocol on that end for free. So the only new code
// needed is a minimal WS *server* here: an Upgrade handshake plus enough of
// RFC 6455 framing to read/write small JSON text messages — no ping/pong
// keepalive, no fragmented messages (every message here is one short JSON
// blob). Same bearer key as the HTTP API; since a browser WebSocket can't
// set an Authorization header, the key travels as the first message instead
// of a header.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const wsClients = new Map();  // deviceId -> { socket, lastSeen }
const wsPending = new Map();  // reqId -> { resolve, reject, timer }
let wsReqSeq = 0;

function wsEncode(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  // Every message we send is a small control blob (a command or a state
  // snapshot) — 16-bit extended length is plenty; never expect to hit it.
  const head = len < 126 ? Buffer.from([0x81, len])
    : Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([head, payload]);
}

// One text frame off the front of `buf`, or null if it isn't fully buffered
// yet. Client-to-server frames are always masked per spec; anything else is
// rejected. No continuation-frame support — see the comment above.
function wsDecode(buf) {
  if (buf.length < 2) return null;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (!masked || buf.length < offset + 4) return null;
  const maskKey = buf.slice(offset, offset + 4);
  offset += 4;
  if (buf.length < offset + len) return null;
  const raw = buf.slice(offset, offset + len);
  const payload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) payload[i] = raw[i] ^ maskKey[i & 3];
  return { opcode: buf[0] & 0x0f, payload, size: offset + len };
}

function wsSend(socket, obj) {
  try { socket.write(wsEncode(JSON.stringify(obj))); } catch (_) {}
}

function wsCloseUnauthorized(socket) {
  try { socket.write(Buffer.from([0x88, 2, 0x0f, 0xa1])); } catch (_) {} // close, code 4001
  try { socket.destroy(); } catch (_) {}
}

function handleUpgrade(req, socket) {
  if (new URL(req.url, 'http://x').pathname !== '/api/ws') { socket.destroy(); return; }
  const wsKey = req.headers['sec-websocket-key'];
  if (!wsKey) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(wsKey + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  let buf = Buffer.alloc(0);
  let deviceId = null;
  let authed = false;

  const cleanup = () => {
    if (!deviceId) return;
    wsClients.delete(deviceId);
    peers.delete(deviceId);
    onPeersChanged(listPeers());
    deviceId = null;
  };

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let frame;
    while ((frame = wsDecode(buf))) {
      buf = buf.slice(frame.size);
      if (frame.opcode === 0x8) { socket.destroy(); return; }               // close
      if (frame.opcode === 0x9) { try { socket.write(Buffer.from([0x8a, 0])); } catch (_) {} continue; } // ping -> pong
      if (frame.opcode !== 0x1) continue;                                    // text frames only

      let msg;
      try { msg = JSON.parse(frame.payload.toString('utf8')); } catch (_) { continue; }

      if (!authed) {
        if (msg.type !== 'auth' || typeof msg.key !== 'string' || !cfg.key
            || !crypto.timingSafeEqual(sha256(msg.key), sha256(cfg.key))) {
          return wsCloseUnauthorized(socket);
        }
        authed = true;
        deviceId = String(msg.deviceId || `mobile:${crypto.randomBytes(4).toString('hex')}`);
        wsClients.set(deviceId, { socket, lastSeen: Date.now() });
        notePeer({ deviceId, name: msg.name || 'Mobile', mobile: true });
        wsSend(socket, { type: 'auth-ok' });
        continue;
      }

      const client = wsClients.get(deviceId);
      if (client) client.lastSeen = Date.now();
      if (msg.type === 'state' && msg.reqId && wsPending.has(msg.reqId)) {
        const pend = wsPending.get(msg.reqId);
        wsPending.delete(msg.reqId);
        clearTimeout(pend.timer);
        pend.resolve(msg.state || null);
      }
    }
  });
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

// The renderer-facing half of a take/push against a mobile peer — same shape
// as lanApi()'s HTTP round trip (`{ok, state}`), just carried over the socket
// instead of fetch(). Only /api/command is meaningful for a mobile peer: it
// has no library/config to browse the way a desktop peer does.
function wsRequest(deviceId, route, body) {
  const client = wsClients.get(deviceId);
  if (!client) return Promise.reject(new Error('device not connected'));
  if (route !== '/api/command') return Promise.reject(new Error('not supported for this device'));
  if (!body || body.type !== 'transfer') {
    wsSend(client.socket, { type: 'command', cmd: body });
    return Promise.resolve({ ok: true, state: null });
  }
  // A take-over: ask the phone for its state and wait for the reply, same
  // one-round-trip contract as the HTTP peer's /api/command?type=transfer.
  return new Promise((resolve, reject) => {
    const reqId = String(++wsReqSeq);
    const timer = setTimeout(() => { wsPending.delete(reqId); reject(new Error('timeout')); }, 5000);
    wsPending.set(reqId, { resolve: (state) => resolve({ ok: true, state }), reject, timer });
    wsSend(client.socket, { type: 'req-state', reqId });
  });
}

// ── lifecycle ──

function start() {
  stop();
  lastError = '';
  server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      logError('lan:handle', e);
      try { sendJson(res, 500, { error: 'server error' }); } catch (_) {}
    });
  });
  server.on('upgrade', handleUpgrade);
  let attempt = 0;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && ++attempt < PORT_TRIES) {
      httpPort = PORT + attempt;
      return server.listen(httpPort, '0.0.0.0');
    }
    lastError = e.code === 'EADDRINUSE'
      ? `ports ${PORT}–${PORT + PORT_TRIES - 1} are all in use`
      : String(e.message || e);
    logError('lan:server', e);
  });
  httpPort = PORT;
  server.listen(httpPort, '0.0.0.0');
  startDiscovery();
}

function stop() {
  if (announceTimer) { clearInterval(announceTimer); announceTimer = null; }
  if (udp) { try { udp.close(); } catch (_) {} udp = null; }
  if (server) { try { server.close(); } catch (_) {} server = null; }
  for (const [id, c] of wsClients) { try { c.socket.destroy(); } catch (_) {} }
  wsClients.clear();
  for (const [id, p] of peers) if (!p.manual) peers.delete(id);
}

function addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function status() {
  return {
    enabled: !!cfg.enabled, hasKey: !!cfg.key, key: cfg.key || '', name: cfg.name,
    deviceId, port: httpPort, running: !!server, error: lastError,
    addresses: addresses(), peers: listPeers(),
  };
}

module.exports = { load, setConfig, publish, status, addManualPeer, removePeer, listPeers, stop, PORT, subnetBroadcasts, wsRequest };
