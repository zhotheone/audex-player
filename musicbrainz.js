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
  const A = esc(artist), AL = esc(album);
  // Only album-keyed lookups are cacheable — a no-album call keys on the artist
  // alone, which is still a stable genre result worth caching.
  const cacheKey = `${A.toLowerCase()}|${AL.toLowerCase()}`;
  if (albumCache.has(cacheKey)) return albumCache.get(cacheKey);
  const result = await resolveAlbumInfo(A, AL);
  albumCache.set(cacheKey, result);
  return result;
}

async function resolveAlbumInfo(A, AL) {
  // artistName/albumName carry MusicBrainz's canonical original-script title
  // (e.g. Cyrillic), which YouTube usually romanizes — the caller prefers these
  // for the album folder so the on-disk name matches the release, not YouTube.
  const out = { cover: null, genre: null, artistName: null, albumName: null };
  let release = null;
  let artistMbid = null;

  if (A && AL) {
    try {
      const q = `artist:"${A}" AND release:"${AL}"`;
      const d = await mbFetch(`${MB}/release/?query=${encodeURIComponent(q)}&fmt=json&limit=1`);
      release = (d.releases && d.releases[0]) || null;
    } catch (_) {}
  }

  if (release) {
    const credit = release['artist-credit'] && release['artist-credit'][0];
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

module.exports = { lookupAlbumInfo };
