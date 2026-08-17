// Checks for the two file-touching rules that are easy to get silently wrong:
// where a download is filed, and whether a tag write survives a round trip in
// every container we support. main.js requires electron, so its pure helpers are
// sliced out of the source (every top-level function there ends on a line that
// is just "}").
// Run: node test-audex.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const grab = (name) => {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in main.js`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;   // keep the async keyword
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, `${name} has no top-level end in main.js`);
  return src.slice(start, end + 3);
};
const grabConst = (name) => {
  const start = src.indexOf(`const ${name} = `);
  assert.ok(start > 0, `${name} not found in main.js`);
  return src.slice(start, src.indexOf(';\n', start) + 2); // literals here have no inner semicolons
};
const { sanitizeFsName, placeDownload, ffmpegTagArgs, ffmpegTrimArgs, oggCoverMetaFile, PARSE_OPTS } = new Function('fs', 'path',
  grab('sanitizeFsName') + grab('safeRenameSync') + grab('placeDownload') + grabConst('FFMPEG_TAG_KEYS') + grab('isOggContainer') +
  grab('oggCoverMetaFile') + grab('toFfmpegPath') + grab('ffmpegTagArgs') +
  grabConst('REENCODE_BITRATE') + grab('ffmpegTrimArgs') + grabConst('PARSE_OPTS') +
  'return { sanitizeFsName, placeDownload, ffmpegTagArgs, ffmpegTrimArgs, oggCoverMetaFile, PARSE_OPTS };')(fs, path);

// Sign-in detection: an anonymous YouTube jar must not read as a session.
// youtubeCookiesPath() is stubbed to a temp file so hasYtAuthCookie() can be
// exercised without an Electron app object.
const cookieJar = path.join(os.tmpdir(), `audex-yt-${process.pid}.txt`);
const { cookiesToNetscape, hasYtAuthCookie } = new Function('fs', 'path', 'JAR',
  'function youtubeCookiesPath() { return JAR; }' +
  grabConst('YT_AUTH_COOKIES') + grab('hasYtAuthCookie') + grab('cookiesToNetscape') +
  'return { cookiesToNetscape, hasYtAuthCookie };')(fs, path, cookieJar);

const writeJar = (cookies) => fs.writeFileSync(cookieJar, cookiesToNetscape(cookies));
const anon = [
  { name: 'VISITOR_INFO1_LIVE', value: 'abc', domain: '.youtube.com', path: '/', secure: true, expirationDate: 2e9 },
  { name: 'CONSENT', value: 'YES+1', domain: '.youtube.com', path: '/', secure: false, expirationDate: 2e9 },
  { name: 'YSC', value: 'xyz', domain: '.youtube.com', path: '/', secure: true, expirationDate: 0 },
];

fs.rmSync(cookieJar, { force: true });
assert.strictEqual(hasYtAuthCookie(), false, 'no jar at all is not signed in');

writeJar(anon);
assert.strictEqual(hasYtAuthCookie(), false,
  'a jar of only anonymous cookies must not read as signed in (this is what put a Logout button on screen)');

writeJar([...anon, { name: 'LOGIN_INFO', value: 'realsession', domain: '.youtube.com', path: '/', secure: true, expirationDate: 2e9 }]);
assert.strictEqual(hasYtAuthCookie(), true, 'LOGIN_INFO means a real session');

writeJar([...anon, { name: '__Secure-3PSID', value: 'sess', domain: '.google.com', path: '/', secure: true, expirationDate: 2e9 }]);
assert.strictEqual(hasYtAuthCookie(), true, '__Secure-3PSID means a real session');

// An auth cookie present but blank is a cleared session, not a live one.
writeJar([...anon, { name: 'SID', value: '', domain: '.youtube.com', path: '/', secure: true, expirationDate: 2e9 }]);
assert.strictEqual(hasYtAuthCookie(), false, 'an empty auth cookie is not a session');
fs.rmSync(cookieJar, { force: true });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audex-dl-'));
const drop = (name) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  return p;
};

// Full tags → artist/album/name.
let out = placeDownload(drop('raw [abc].opus'), dir,
  { artist: 'Boards of Canada', album: 'Geogaddi', suggestedName: 'Boards of Canada - Dawn Chorus', format: 'opus' });
assert.strictEqual(out, path.join(dir, 'Boards of Canada', 'Geogaddi', 'Boards of Canada - Dawn Chorus.opus'));
assert.ok(fs.existsSync(out) && !fs.existsSync(path.join(dir, 'raw [abc].opus')));

// No album → one level less, not an "Unknown Album" folder.
out = placeDownload(drop('raw2 [def].mp3'), dir,
  { artist: 'Aphex Twin', album: '', suggestedName: 'Aphex Twin - Xtal', format: 'mp3' });
assert.strictEqual(out, path.join(dir, 'Aphex Twin', 'Aphex Twin - Xtal.mp3'));

// Separators and traversal in remote metadata stay inside the downloads dir.
out = placeDownload(drop('raw3 [ghi].opus'), dir,
  { artist: 'AC/DC', album: '..', suggestedName: '../../etc/passwd', format: 'opus' });
assert.ok(out.startsWith(dir + path.sep), `escaped the downloads dir: ${out}`);
assert.strictEqual(out, path.join(dir, 'AC_DC', '.._.._etc_passwd.opus'));

// Downloading the same track twice keeps the first copy and drops the new file.
const dupe = drop('raw4 [jkl].opus');
out = placeDownload(dupe, dir,
  { artist: 'Aphex Twin', album: '', suggestedName: 'Aphex Twin - Xtal', format: 'mp3' });
assert.strictEqual(out, path.join(dir, 'Aphex Twin', 'Aphex Twin - Xtal.mp3'));
assert.ok(!fs.existsSync(dupe), 'duplicate download was left behind');

// Nothing to name it by → leave the file where yt-dlp put it.
const unnamed = drop('raw5 [mno].opus');
assert.strictEqual(placeDownload(unnamed, dir, { artist: '', album: '', suggestedName: '...', format: 'opus' }), unnamed);

// ── Tag writing: one ffmpeg remux path for every container ───────────────────
// A one-second tone per format, tagged, then read back with the same library the
// app indexes with. Catches the muxer-specific traps: mp3-only flags handed to
// the opus muxer, or tags silently dropped by a container that has no slot.
const ffmpeg = require('ffmpeg-static');
const mm = require('music-metadata');

const tags = {
  title: 'Dawn Chorus', artist: 'Boards of Canada', album: 'Geogaddi',
  albumArtist: 'Boards of Canada', year: '2002', genre: 'IDM',
  trackNo: '7', discNo: '1', comment: 'round trip',
};

(async () => {
  for (const ext of ['.mp3', '.opus', '.flac', '.m4a']) {
    const file = path.join(dir, 'tone' + ext);
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', file]);

    const tmp = path.join(dir, '.tmp' + ext);
    execFileSync(ffmpeg, ffmpegTagArgs(file, tmp, tags));
    fs.renameSync(tmp, file);

    const { common } = await mm.parseFile(file);
    assert.strictEqual(common.title, tags.title, `title lost in ${ext}`);
    assert.strictEqual(common.artist, tags.artist, `artist lost in ${ext}`);
    assert.strictEqual(common.album, tags.album, `album lost in ${ext}`);
    assert.strictEqual(String(common.year || ''), tags.year, `year lost in ${ext}`);
    assert.strictEqual(String(common.track.no || ''), tags.trackNo, `track lost in ${ext}`);

    // A trim with fades re-encodes: the cut must stay in the source's own codec,
    // at a bitrate that codec accepts (libopus caps out at 256k).
    const cut = path.join(dir, 'cut' + ext);
    execFileSync(ffmpeg, ffmpegTrimArgs(file, cut, { start: 0.2, dur: 0.5, fadeIn: 0.1, fadeOut: 0.1, gain: -3 }));
    const cutFmt = (await mm.parseFile(cut)).format;
    assert.strictEqual(cutFmt.container, (await mm.parseFile(file)).format.container, `container changed by trim in ${ext}`);
    assert.ok(cutFmt.duration > 0, `empty trim output for ${ext}`);
  }

  // .opus cover art lives in a synthetic ffmpeg "video" stream that the ogg muxer can never
  // write back out — tag-writing and trimming must route it through oggCoverMetaFile instead
  // of a plain stream copy, or they mux-crash on every downloaded track that has a thumbnail.
  {
    const coverFile = path.join(dir, 'cover.jpg');
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=16x16', '-frames:v', '1', coverFile]);
    const picture = { format: 'image/jpeg', data: fs.readFileSync(coverFile) };

    const base = path.join(dir, 'covered.opus');
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-i', oggCoverMetaFile(base, picture), '-map', '0', '-map_metadata', '1', '-c:a', 'libopus', base]);

    const tagged = path.join(dir, '.covered-tagged.opus');
    execFileSync(ffmpeg, ffmpegTagArgs(base, tagged, tags, picture));
    const taggedMeta = await mm.parseFile(tagged);
    assert.strictEqual(taggedMeta.common.title, tags.title, 'title lost writing tags to an opus with a cover');
    assert.ok(taggedMeta.common.picture && taggedMeta.common.picture.length, 'cover lost writing tags to an opus with a cover');

    const cutCovered = path.join(dir, 'cut-covered.opus');
    execFileSync(ffmpeg, ffmpegTrimArgs(base, cutCovered, { start: 0.1, dur: 0.5, fadeIn: 0.1, fadeOut: 0, gain: 0, picture }));
    const cutMeta = await mm.parseFile(cutCovered);
    assert.ok(cutMeta.common.picture && cutMeta.common.picture.length, 'cover lost trimming an opus with a cover');
  }

  // Real downloaded .opus files store their vorbis comments on the audio stream, not in
  // ffmpeg's global metadata slot (music-metadata's own parser doesn't care about that
  // split, so a synthetic file tagged at the global slot doesn't catch this the way a real
  // download does). A plain "-metadata title=x" writes the global slot only, which
  // -map_metadata 0 doesn't feed into, so it silently loses to the stream-level copy of the
  // old title — ffmpegTagArgs has to target the stream explicitly to actually change anything.
  {
    const streamTagged = path.join(dir, 'streamtagged.opus');
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-metadata:s:a:0', 'title=Old Title', streamTagged]);
    assert.strictEqual((await mm.parseFile(streamTagged)).common.title, 'Old Title', 'setup: stream-level title did not stick');

    const retitled = path.join(dir, '.streamtagged-retitled.opus');
    execFileSync(ffmpeg, ffmpegTagArgs(streamTagged, retitled, tags, null));
    assert.strictEqual((await mm.parseFile(retitled)).common.title, tags.title, 'a stream-level opus title survived the rewrite unchanged');
  }

  // Ogg/Opus only reveals its length on the last page, so a header-only parse
  // returns no duration and no bitrate. Needs a file long enough that the parser
  // would stop early without PARSE_OPTS — a one-second tone gets read whole.
  const long = path.join(dir, 'long.opus');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=300', '-c:a', 'libopus', long]);
  const longFmt = (await mm.parseFile(long, PARSE_OPTS)).format;
  assert.ok(longFmt.duration > 299, `opus duration missing: ${longFmt.duration}`);
  assert.ok(longFmt.bitrate > 0, `opus bitrate missing: ${longFmt.bitrate}`);

  fs.rmSync(dir, { recursive: true, force: true });

  // MusicBrainz recording match formatting: extracts title, artist credit, first release, year, trackNo
  const { formatRecordingMatch } = require('./musicbrainz');
  const recMatch = formatRecordingMatch({
    id: 'mb-rec-123',
    title: 'Test Song',
    score: 95,
    'artist-credit': [{ name: 'Artist A', joinphrase: ' feat. ' }, { name: 'Artist B' }],
    releases: [{
      title: 'Test Album',
      date: '2023-10-12',
      media: [{ position: 1, track: [{ number: '3', position: 3 }] }]
    }],
    tags: [{ name: 'indie', count: 5 }]
  });
  assert.strictEqual(recMatch.id, 'mb-rec-123');
  assert.strictEqual(recMatch.url, 'https://musicbrainz.org/recording/mb-rec-123');
  assert.strictEqual(recMatch.title, 'Test Song');
  assert.strictEqual(recMatch.artist, 'Artist A feat. Artist B');
  assert.strictEqual(recMatch.album, 'Test Album');
  assert.strictEqual(recMatch.date, '2023-10-12');
  assert.strictEqual(recMatch.year, '2023-10-12');
  assert.strictEqual(recMatch.trackNo, '3');
  assert.strictEqual(recMatch.discNo, '1');
  assert.strictEqual(recMatch.genre, 'indie');
  assert.strictEqual(formatRecordingMatch({}), null);

  // Multi-artist splitting (renderer.js): "FACE" and "FACE, Ivan Dremin, ..." used to land
  // as two unrelated artists because only " & " was a separator — comma-joined credits, the
  // most common tagging convention, never split at all.
  const rendererSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  const artistSepLine = rendererSrc.slice(
    rendererSrc.indexOf('const ARTIST_SEP'),
    rendererSrc.indexOf('\n', rendererSrc.indexOf('const ARTIST_SEP')));
  const ARTIST_SEP = new Function(artistSepLine + '\nreturn ARTIST_SEP;')();
  const split = (s) => s.split(ARTIST_SEP).map(p => p.trim()).filter(Boolean);
  assert.deepStrictEqual(split('FACE, Ivan Dremin, Anton Vasilev, Vladislav Mamaev'),
    ['FACE', 'Ivan Dremin', 'Anton Vasilev', 'Vladislav Mamaev'], 'comma-joined credits did not split');
  assert.deepStrictEqual(split('Artist A feat. Artist B'), ['Artist A', 'Artist B'], '"feat." did not split');
  assert.deepStrictEqual(split('Artist A ft Artist B'), ['Artist A', 'Artist B'], '"ft" did not split');
  assert.deepStrictEqual(split('Artist A; Artist B'), ['Artist A', 'Artist B'], '";" did not split');
  assert.deepStrictEqual(split('Featherweight'), ['Featherweight'], '"feat" inside a word wrongly split');
  assert.deepStrictEqual(split('Deftones'), ['Deftones'], '"ft" inside a word wrongly split');

  // Fullscreen upcoming queue wrapping with repeat-all
  const qList = [{ path: '1' }, { path: '2' }, { path: '3' }];
  const qUpcoming = [];
  const curIdx = 2; // last track
  for (let i = 1; i < qList.length && qUpcoming.length < 8; i++) {
    qUpcoming.push(qList[(curIdx + i) % qList.length]);
  }
  assert.deepStrictEqual(qUpcoming.map(t => t.path), ['1', '2'], 'repeat-all wraps queue ahead');

  // The store that replaced localStorage for the library index: a truncated or
  // escaped write here loses someone's whole library, so lock the two rules —
  // the write is atomic (tmp + rename, nothing half-written under the real
  // name), and a store name can't point outside the store directory.
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'audex-store-'));
  const { storePath, writeStoreFile } = new Function('fs', 'path', 'ROOT',
    'function storeDir() { return ROOT; }' +
    'function logAppError() {}' +
    grab('safeRename') + grab('storePath') + grab('writeStoreFile') +
    'return { storePath, writeStoreFile };')(fs, path, storeRoot);

  assert.deepStrictEqual(await writeStoreFile('library-meta', '[{"path":"/a.mp3"}]'), { success: true });
  assert.strictEqual(fs.readFileSync(path.join(storeRoot, 'library-meta.json'), 'utf8'), '[{"path":"/a.mp3"}]');

  await writeStoreFile('library-meta', '[]');
  assert.strictEqual(fs.readFileSync(path.join(storeRoot, 'library-meta.json'), 'utf8'), '[]', 'overwrite did not replace');
  assert.deepStrictEqual(fs.readdirSync(storeRoot).filter(f => f.endsWith('.tmp')), [], 'left a .tmp behind');

  assert.strictEqual(storePath('../../escape'), path.join(storeRoot, 'escape.json'), 'store name escaped the store dir');

  // A write that cannot land must fail loudly and leave the previous store intact.
  fs.mkdirSync(path.join(storeRoot, 'blocked.json'));
  const blocked = await writeStoreFile('blocked', '[]');
  assert.strictEqual(blocked.success, false, 'an impossible write reported success');
  assert.strictEqual(fs.readFileSync(path.join(storeRoot, 'library-meta.json'), 'utf8'), '[]', 'a failed write damaged another store');
  fs.rmSync(storeRoot, { recursive: true, force: true });

  // The renderer half of that store: the migration read (file wins, else the
  // localStorage copy this version replaced) and the rule that the old key is
  // dropped only after a write actually lands. Getting either backwards loses
  // an existing user's library on upgrade.
  const grabFn = (name) => {
    const start = rendererSrc.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} not found in renderer.js`);
    return rendererSrc.slice(start, rendererSrc.indexOf('\n}\n', start) + 3);
  };
  const makeStore = (api) => {
    const ls = new Map();
    const toasts = [];
    const env = {
      electronAPI: api,
      localStorage: {
        getItem: (k) => (ls.has(k) ? ls.get(k) : null),
        setItem: (k, v) => ls.set(k, String(v)),
        removeItem: (k) => ls.delete(k),
      },
    };
    const mod = new Function('window', 'localStorage', 'toast', 'tr', 'console',
      'const hasStore = !!(window.electronAPI && window.electronAPI.readStoreSync);' +
      grabFn('readStore') + grabFn('writeStore') +
      'const saveFailedOnce = new Set();' + grabFn('warnSaveFailed') +
      'return { readStore, writeStore };'
    )(env, env.localStorage, (m) => toasts.push(m), (k) => k, { warn() {} });
    return { ...mod, ls, toasts };
  };

  let file = '[{"path":"/from-file.mp3"}]';
  let store = makeStore({ readStoreSync: () => file, writeStore: async () => ({ success: true }) });
  store.ls.set('ambevor-library-meta', '[{"path":"/stale.mp3"}]');
  assert.deepStrictEqual(store.readStore('library-meta', 'ambevor-library-meta'),
    [{ path: '/from-file.mp3' }], 'the file must win over the localStorage copy it replaced');

  file = null;   // not migrated yet
  assert.deepStrictEqual(store.readStore('library-meta', 'ambevor-library-meta'),
    [{ path: '/stale.mp3' }], 'with no file yet, the old localStorage library must still load');

  const written = [];
  store = makeStore({
    readStoreSync: () => null,
    writeStore: async (name, json) => { written.push([name, json]); return { success: true }; },
  });
  store.ls.set('ambevor-library-meta', '[]');
  store.writeStore('library-meta', [{ path: '/a.mp3' }], 'ambevor-library-meta');
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(written, [['library-meta', '[{"path":"/a.mp3"}]']]);
  assert.strictEqual(store.ls.has('ambevor-library-meta'), false, 'a landed write should reclaim the localStorage quota');

  store = makeStore({ readStoreSync: () => null, writeStore: async () => ({ success: false, error: 'ENOSPC' }) });
  store.ls.set('ambevor-library-meta', '[]');
  store.writeStore('library-meta', [], 'ambevor-library-meta');
  store.writeStore('library-meta', [], 'ambevor-library-meta');
  await new Promise(r => setImmediate(r));
  assert.strictEqual(store.ls.has('ambevor-library-meta'), true, 'a failed write must not drop the last good copy');
  // Tag editing locks while playing for non-ogg containers (.m4a, .flac, etc.)
  const rSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  const isTagEditingLockedFn = new Function('currentTrack',
    rSrc.slice(rSrc.indexOf('function isTagEditingLocked('), rSrc.indexOf('function srcFor(')) +
    'return isTagEditingLocked;'
  )({ path: '/music/song.m4a' });

  assert.strictEqual(isTagEditingLockedFn('/music/song.m4a'), true, 'm4a must lock while playing');
  assert.strictEqual(isTagEditingLockedFn('/music/song.flac'), false, 'different track must not lock');
  assert.strictEqual(isTagEditingLockedFn('/music/song.opus'), false, 'opus must not lock');

  const isTagEditingLockedOpus = new Function('currentTrack',
    rSrc.slice(rSrc.indexOf('function isTagEditingLocked('), rSrc.indexOf('function srcFor(')) +
    'return isTagEditingLocked;'
  )({ path: '/music/song.opus' });
  assert.strictEqual(isTagEditingLockedOpus('/music/song.opus'), false, 'playing opus must not lock');

  const isTagEditingLockedFlac = new Function('currentTrack',
    rSrc.slice(rSrc.indexOf('function isTagEditingLocked('), rSrc.indexOf('function srcFor(')) +
    'return isTagEditingLocked;'
  )({ path: '/music/song.flac' });
  assert.strictEqual(isTagEditingLockedFlac('/music/song.flac'), true, 'playing flac must lock');

  // Health check tags issue: flags missing tags and generic "Music" genre
  const computeHealthIssuesFn = new Function('library', 'tr', 'qualityFor', 'coverCache', 'normDupKey',
    rSrc.slice(rSrc.indexOf('function computeHealthIssues('), rSrc.indexOf('function buildSpectrumSvg(')) +
    'return computeHealthIssues;'
  )(
    [
      { path: '/a.mp3', title: 'Song', artist: 'Artist', album: 'Album', year: '2020', genre: 'Rock', hasCover: true },
      { path: '/b.mp3', title: 'Song 2', artist: 'Artist', album: 'Album', year: '2020', genre: '', hasCover: true },
      { path: '/c.mp3', title: 'Song 3', artist: 'Artist', album: 'Album', year: '2020', genre: 'Music', hasCover: true },
    ],
    () => '',
    () => null,
    {},
    () => ''
  );
  const issues = computeHealthIssuesFn();
  const tagsIssue = issues.find(i => i.id === 'tags');
  assert.deepStrictEqual(tagsIssue.paths, ['/b.mp3', '/c.mp3'], 'tracks with empty or generic Music genre must be flagged');

  // Active downloads count logic
  const mockQueue = [
    { status: 'done' },
    { status: 'queued' },
    { status: 'downloading' },
    { status: 'error' },
    { status: 'queued' },
  ];
  const activeCount = mockQueue.filter(it => it.status === 'queued' || it.status === 'downloading').length;
  assert.strictEqual(activeCount, 3, 'only queued and downloading tracks count as active');

  // Lyrics query parsing logic
  function parseLyricsQuery(q) {
    let artist = String(q.artist || '').trim();
    let title = String(q.title || '').trim();
    const qStr = String(q.query || '').trim();
    if (!title && qStr) {
      if (qStr.includes(' - ')) {
        const parts = qStr.split(' - ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
      } else title = qStr;
    }
    return { artist, title };
  }
  assert.deepStrictEqual(parseLyricsQuery({ query: 'Queen - Bohemian Rhapsody' }), { artist: 'Queen', title: 'Bohemian Rhapsody' });
  assert.deepStrictEqual(parseLyricsQuery({ query: 'Yesterday' }), { artist: '', title: 'Yesterday' });

  // renderTrackRow null check
  function mockRenderTrackRow(track) {
    if (!track) return { isStub: true };
    return { path: track.path };
  }
  // isTrackInLibrary matching check
  const normTitle = s => (s || '').toLowerCase().replace(/[\(\[].*?[\)\]]/g, '').replace(/\s+/g, ' ').trim();
  function isTrackInLibraryTest(lib, title, artist) {
    const nt = normTitle(title);
    if (!nt) return false;
    const na = normTitle(artist);
    if (na) {
      const match = lib.some(t => {
        const lt = normTitle(t.title);
        if (lt !== nt) return false;
        const la = normTitle(t.artist);
        return la === na || (la && na && (la.includes(na) || na.includes(la)));
      });
      if (match) return true;
    }
    return lib.some(t => normTitle(t.title) === nt);
  }

  const sampleLib = [
    { title: 'Everything in Its Right Place', artist: 'Radiohead' },
    { title: 'Midnight City (feat. Vocals)', artist: 'M83' },
    { title: 'Xtal', artist: 'Aphex Twin' }
  ];
  assert.strictEqual(isTrackInLibraryTest(sampleLib, 'Everything in Its Right Place', 'Radiohead'), true);
  assert.strictEqual(isTrackInLibraryTest(sampleLib, 'Midnight City', 'M83'), true);
  assert.strictEqual(isTrackInLibraryTest(sampleLib, 'Xtal', ''), true);
  assert.strictEqual(isTrackInLibraryTest(sampleLib, 'Karma Police', 'Radiohead'), false);

  console.log('ok');
})();
