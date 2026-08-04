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
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in main.js`);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, `${name} has no top-level end in main.js`);
  return src.slice(start, end + 3);
};
const grabConst = (name) => {
  const start = src.indexOf(`const ${name} = {`);
  assert.ok(start > 0, `${name} not found in main.js`);
  return src.slice(start, src.indexOf(';\n', start) + 2); // object literals here have no inner semicolons
};
const { sanitizeFsName, placeDownload, ffmpegTagArgs, ffmpegTrimArgs, oggCoverMetaFile, PARSE_OPTS } = new Function('fs', 'path',
  grab('sanitizeFsName') + grab('placeDownload') + grabConst('FFMPEG_TAG_KEYS') + grab('isOggContainer') +
  grab('oggCoverMetaFile') + grab('ffmpegTagArgs') +
  grabConst('REENCODE_BITRATE') + grab('ffmpegTrimArgs') + grabConst('PARSE_OPTS') +
  'return { sanitizeFsName, placeDownload, ffmpegTagArgs, ffmpegTrimArgs, oggCoverMetaFile, PARSE_OPTS };')(fs, path);

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

  // AcoustID picks the highest-scoring recording that actually has a title —
  // getting the ordering or the untitled-skip wrong silently mistags files.
  const bestMatch = new Function(grab('acoustidBestMatch') + 'return acoustidBestMatch;')();
  const m = bestMatch({ results: [
    { id: 'low', score: 0.3, recordings: [{ title: 'Wrong', artists: [{ name: 'X' }] }] },
    { id: 'high', score: 0.9, recordings: [
      { title: null },   // untitled entries are skipped, not treated as a match
      { title: 'Right', artists: [{ name: 'A' }, { name: 'B' }],
        releasegroups: [{ title: null }, { title: 'The Album' }] }] },
  ] });
  assert.strictEqual(m.title, 'Right', 'best match ignored the higher score');
  assert.strictEqual(m.artist, 'A & B', 'multi-artist join');
  assert.strictEqual(m.album, 'The Album', 'album skipped the untitled release group');
  assert.strictEqual(bestMatch({ results: [] }), null, 'no results -> null');
  assert.strictEqual(bestMatch({}), null, 'malformed response -> null');
  assert.strictEqual(bestMatch({ results: [{ id: 'x', score: 1 }] }), null, 'no recordings -> null');

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

  console.log('ok');
})();
