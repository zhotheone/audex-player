// MusicBrainz + Cover Art Archive lookup: album cover art and genre tags for a
// downloaded track. Both APIs are keyless — MusicBrainz only requires a
// meaningful User-Agent and ≤1 request/sec; Cover Art Archive is unmetered and
// redirects to archive.org (global fetch follows it).
//
// Genre precedence: the album's genres (from the release-group) win; if it has
// none, the artist's genres are used instead. YouTube carries no genre at all,
// so this is the only source.

const UA = 'audex-player/1.3.0 (https://github.com/zhotheone/audex-player)';
const MB = 'https://musicbrainz.org/ws/2';

// ponytail: one global 1.1s-spaced request chain. Downloads are sequential, so a
// serial throttle is enough — swap for a token-bucket only if lookups ever run
// concurrently.
let mbChain = Promise.resolve();
function mbFetch(url) {
  const run = async () => {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    await new Promise(r => setTimeout(r, 1100));
    if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
    return res.json();
  };
  const p = mbChain.then(run, run); // run regardless of a prior lookup's outcome
  mbChain = p.catch(() => {});
  return p;
}

// Lucene reserves these in query strings; a downloaded artist/album name is free
// text, so neutralize them rather than build a precise escape.
const esc = (s) => String(s || '').replace(/["\\]/g, ' ').trim();

const topGenres = (entity) =>
  ((entity && entity.genres) || [])
    .slice()
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, 3)
    .map((g) => g.name);

async function fetchCover(releaseMbid) {
  try {
    const res = await fetch(`https://coverartarchive.org/release/${releaseMbid}/front-500`, {
      headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000), redirect: 'follow',
    });
    if (!res.ok) return null; // 404 = release has no front image
    const buf = Buffer.from(await res.arrayBuffer());
    return { format: (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim(), data: buf };
  } catch (_) { return null; }
}

// Same artist+album resolves to the same cover+genre, and a full-album grab hits
// this once per track — cache by artist|album so only the first track pays the
// ~2-4s of throttled lookups. ponytail: unbounded process-lifetime Map; a
// download session touches a handful of albums, so no eviction needed.
const albumCache = new Map();

// Returns { cover: {format, data}|null, genre: string|null }. Every network step
// is best-effort: a miss on any one leaves that field null rather than throwing.
async function lookupAlbumInfo({ artist, album, title } = {}) {
  const A = esc(artist), AL = esc(album), T = esc(title);
  // With an album, one lookup serves every track on it → key on artist|album.
  // Without one, each track resolves its own album via a recording search, so
  // the title has to be in the key or two different tracks would collide.
  const cacheKey = AL ? `${A.toLowerCase()}|${AL.toLowerCase()}` : `${A.toLowerCase()}||${T.toLowerCase()}`;
  if (albumCache.has(cacheKey)) return albumCache.get(cacheKey);
  const result = await resolveAlbumInfo(A, AL, T);
  albumCache.set(cacheKey, result);
  return result;
}

async function resolveAlbumInfo(A, AL, T) {
  // artistName/albumName carry MusicBrainz's canonical original-script title
  // (e.g. Cyrillic), which YouTube usually romanizes — the caller prefers these
  // for the album folder so the on-disk name matches the release, not YouTube.
  const out = { cover: null, genre: null, artistName: null, albumName: null };
  let release = null;
  let artistMbid = null;
  let recCredit = null; // recording's artist-credit — the release from a recording search often omits its own

  if (A && AL) {
    try {
      const q = `artist:"${A}" AND release:"${AL}"`;
      const d = await mbFetch(`${MB}/release/?query=${encodeURIComponent(q)}&fmt=json&limit=1`);
      release = (d.releases && d.releases[0]) || null;
    } catch (_) {}
  }

  // No album tag (YouTube often has none) or no match — recover the album from
  // the recording itself, so the download still lands in {artist}/{album} with
  // MusicBrainz's original-script title instead of dumping in the artist root.
  if (!release && A && T) {
    try {
      const q = `artist:"${A}" AND recording:"${T}"`;
      const d = await mbFetch(`${MB}/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=1`);
      const rec = d.recordings && d.recordings[0];
      release = (rec && rec.releases && rec.releases[0]) || null;
      recCredit = (rec && rec['artist-credit'] && rec['artist-credit'][0]) || null;
    } catch (_) {}
  }

  if (release) {
    const credit = (release['artist-credit'] && release['artist-credit'][0]) || recCredit;
    artistMbid = credit && credit.artist && credit.artist.id;
    out.albumName = release.title || null;
    out.artistName = (credit && (credit.name || (credit.artist && credit.artist.name))) || null;
    out.cover = await fetchCover(release.id);
    const rgId = release['release-group'] && release['release-group'].id;
    if (rgId) {
      try {
        const rg = await mbFetch(`${MB}/release-group/${rgId}?inc=genres&fmt=json`);
        const g = topGenres(rg);
        if (g.length) out.genre = g.join(', ');
      } catch (_) {}
    }
  }

  // Artist genres — the fallback when the album had none, and the only genre
  // source when no release matched at all.
  if (!out.genre && A) {
    if (!artistMbid) {
      try {
        const d = await mbFetch(`${MB}/artist/?query=artist:"${A}"&fmt=json&limit=1`);
        artistMbid = d.artists && d.artists[0] && d.artists[0].id;
      } catch (_) {}
    }
    if (artistMbid) {
      try {
        const ar = await mbFetch(`${MB}/artist/${artistMbid}?inc=genres&fmt=json`);
        const g = topGenres(ar);
        if (g.length) out.genre = g.join(', ');
      } catch (_) {}
    }
  }

  return out;
}

function formatRecordingMatch(rec) {
  if (!rec || !rec.title) return null;
  const artistCredit = (rec['artist-credit'] || [])
    .map(c => (c.name || (c.artist && c.artist.name) || '') + (c.joinphrase || ''))
    .join('').trim();
  let album = '', year = '', trackNo = '', discNo = '';
  const rel = (rec.releases || [])[0];
  if (rel) {
    album = rel.title || (rel['release-group'] && rel['release-group'].title) || '';
    if (rel.date) {
      const ym = String(rel.date).match(/^\d{4}/);
      if (ym) year = ym[0];
    }
    const medium = (rel.media || [])[0];
    if (medium) {
      if (medium.position) discNo = String(medium.position);
      const trk = (medium.track || [])[0];
      if (trk && (trk.position || trk.number)) trackNo = String(trk.position || trk.number);
    }
  }
  const tags = (rec.tags || []).concat(rec.genres || [])
    .slice().sort((a, b) => (b.count || 0) - (a.count || 0))
    .map(t => t.name).filter(Boolean);
  const genre = tags.slice(0, 3).join(', ');
  return { title: rec.title, artist: artistCredit, album, year, trackNo, discNo, genre, score: rec.score || 0 };
}

async function searchRecordings({ artist = '', title = '', query = '' } = {}) {
  const A = esc(artist), T = esc(title), Q = esc(query);
  let q = '';
  if (A && T) q = `artist:"${A}" AND recording:"${T}"`;
  else if (T) q = `recording:"${T}"`;
  else if (Q) q = Q;
  else if (A) q = `artist:"${A}"`;
  if (!q) return [];
  try {
    const d = await mbFetch(`${MB}/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=5`);
    const recs = (d && Array.isArray(d.recordings)) ? d.recordings : [];
    return recs.map(formatRecordingMatch).filter(Boolean);
  } catch (_) {
    return [];
  }
}

module.exports = { lookupAlbumInfo, searchRecordings, formatRecordingMatch };
