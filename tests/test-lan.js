// Check for lan.js: the bits that are easy to get subtly wrong — bearer auth,
// per-track URL signatures, HTTP Range replies (seeking in <audio> depends on
// them), and the transfer handshake behind session takeover.
//
//   node test-lan.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lan = require('../lan');

// subnetBroadcasts() must derive the correct directed-broadcast address from
// address+netmask (this is what makes discovery reach the real LAN adapter on
// Windows boxes with a Tailscale/VPN virtual NIC, instead of only the one the
// OS picks for the ambiguous 255.255.255.255 target).
const realNI = os.networkInterfaces;
os.networkInterfaces = () => ({
  eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.42', netmask: '255.255.255.0' }],
  tailscale0: [{ family: 'IPv4', internal: false, address: '100.64.0.5', netmask: '255.192.0.0' }],
  lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
});
assert.deepStrictEqual(lan.subnetBroadcasts().sort(), ['100.127.255.255', '192.168.1.255'].sort(),
  'directed broadcast must be computed per-interface and skip internal/loopback');
os.networkInterfaces = realNI;

const KEY = 'test-network-key';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audex-lan-'));
const audioPath = path.join(dir, 'song.mp3');
const BYTES = Buffer.from('0123456789abcdef');
fs.writeFileSync(audioPath, BYTES);

const commands = [];

let BASE;
async function get(route, opts = {}) {
  const res = await fetch(BASE + route, {
    method: opts.body ? 'POST' : 'GET',
    headers: {
      ...(opts.auth === false ? {} : { Authorization: 'Bearer ' + (opts.key || KEY) }),
      ...(opts.range ? { Range: opts.range } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res;
}

(async () => {
  lan.load({
    userDataDir: dir,
    coverDir: path.join(dir, 'covers'),
    logError: () => {},
    sendCommand: (c) => commands.push(c),
    onPeersChanged: () => {},
  });
  lan.setConfig({ enabled: true, key: KEY, name: 'test-device' });
  lan.publish({
    tracks: [{ path: audioPath, title: 'Song', artist: 'Artist', album: 'Album', duration: 42, hasCover: false }],
    state: { path: audioPath, playing: true, position: 12.5, duration: 42, volume: 0.8, shuffle: false, repeat: 0, queue: [] },
  });
  await new Promise(r => setTimeout(r, 200)); // let listen() land
  BASE = `http://127.0.0.1:${lan.status().port}`;

  // Auth
  assert.strictEqual((await get('/api/library', { auth: false })).status, 401, 'no token must be rejected');
  assert.strictEqual((await get('/api/library', { key: 'wrong' })).status, 401, 'wrong key must be rejected');

  // Library
  const lib = await (await get('/api/library')).json();
  assert.strictEqual(lib.tracks.length, 1);
  const t = lib.tracks[0];
  assert.strictEqual(t.title, 'Song');
  assert.ok(!('path' in t), 'filesystem paths must not leave the device');
  assert.ok(/\/api\/track\/[a-f0-9]{40}\?s=[a-f0-9]{32}$/.test(t.url), 'track url must be signed: ' + t.url);

  const route = t.url.slice(BASE.length);

  // Signature guards the media endpoints (they can't carry a header).
  assert.strictEqual((await get(route.replace(/s=.*/, 's=' + 'f'.repeat(32)), { auth: false })).status, 401,
    'a bad signature must be rejected');

  // Whole file
  const whole = await get(route, { auth: false });
  assert.strictEqual(whole.status, 200);
  assert.strictEqual(whole.headers.get('accept-ranges'), 'bytes', 'client needs to know seeking is possible');
  assert.deepStrictEqual(Buffer.from(await whole.arrayBuffer()), BYTES);

  // Range: the reply must be 206 with an exact Content-Range, or seeking breaks.
  const part = await get(route, { auth: false, range: 'bytes=2-5' });
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.headers.get('content-range'), `bytes 2-5/${BYTES.length}`);
  assert.strictEqual(Buffer.from(await part.arrayBuffer()).toString(), '2345');

  // Open-ended range
  const tail = await get(route, { auth: false, range: 'bytes=12-' });
  assert.strictEqual(tail.status, 206);
  assert.strictEqual(Buffer.from(await tail.arrayBuffer()).toString(), 'cdef');

  // Suffix range ("the last 3 bytes")
  const suffix = await get(route, { auth: false, range: 'bytes=-3' });
  assert.strictEqual(suffix.status, 206);
  assert.strictEqual(Buffer.from(await suffix.arrayBuffer()).toString(), 'def');

  // Unsatisfiable range
  assert.strictEqual((await get(route, { auth: false, range: 'bytes=999-1200' })).status, 416);

  // State carries a URL any peer can stream, plus where we are in the track.
  const state = await (await get('/api/state')).json();
  assert.strictEqual(state.position, 12.5);
  assert.strictEqual(state.track.url, t.url);

  // Config: same auth gate as everything else, round-trips what was published,
  // and (like the library) survives a state-only publish tick.
  assert.strictEqual((await get('/api/config', { auth: false })).status, 401);
  assert.deepStrictEqual(await (await get('/api/config')).json(), {}, 'nothing published yet');
  lan.publish({ config: { theme: 'dark', language: 'en' } });
  assert.deepStrictEqual(await (await get('/api/config')).json(), { theme: 'dark', language: 'en' });
  lan.publish({ state: { path: audioPath, playing: false, position: 1 } });
  assert.deepStrictEqual(await (await get('/api/config')).json(), { theme: 'dark', language: 'en' },
    'a state-only publish must keep the published config');

  // Takeover: hand the session over, then stop playing it here.
  const res = await (await get('/api/command', { body: { type: 'transfer' } })).json();
  assert.strictEqual(res.state.track.url, t.url, 'transfer must return the session');
  assert.deepStrictEqual(commands.at(-1), { type: 'pause' }, 'transfer must pause the source device');

  // Other commands pass through untouched.
  await get('/api/command', { body: { type: 'seek', position: 30 } });
  assert.deepStrictEqual(commands.at(-1), { type: 'seek', position: 30 });

  // State ticks must not wipe the published library.
  lan.publish({ state: { path: audioPath, playing: false, position: 1 } });
  assert.strictEqual((await (await get('/api/library')).json()).tracks.length, 1,
    'a state-only publish must keep the track list');

  lan.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('lan: all checks passed');
})().catch((e) => {
  lan.stop();
  console.error(e);
  process.exit(1);
});
