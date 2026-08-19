# Audex Player: Query-to-Downloaded-File Specification

This document provides the complete end-to-end specification of how Audex Player resolves, streams, enriches, tags, and stores audio files from various query inputs down to the local filesystem.

---

## 1. Architectural Overview

The Audex Player audio acquisition engine coordinates between the **Renderer UI**, Electron **Main Process (Node.js)**, **yt-dlp**, **ffmpeg**, **YouTube Music InnerTube API**, **Spotify Web Scraper**, and the **MusicBrainz / Cover Art Archive API**.

```
+---------------------------------------------------------------------------------------------------------+
|                                              RENDERER PROCESS                                           |
|                                                                                                         |
|  User Input / Query Sources:                                                                            |
|  • Free-form Text Search ("Artist - Song")           • YouTube / YT Music URL (Video, Album, Artist)   |
|  • Spotify URL (Playlist, Album, Artist)             • LAN / P2P Peer Track                            |
|                                     │                                                                   |
|                                     ▼                                                                   |
|                       Download Queue Manager (renderer.js)                                              |
+-------------------------------------┬────────────────────────────────────────────────-------------------+
                                      │ IPC Invocation
+-------------------------------------▼-------------------------------------------------------------------+
|                                            MAIN PROCESS (main.js)                                       |
|                                                                                                         |
|  ┌───────────────────────────────┐     ┌─────────────────────────────┐     ┌─────────────────────────┐  |
|  |       Query Resolvers         |     |       Spotify Scraper       |     |     InnerTube Parser    |  |
|  |  • Direct URL Normalizer      |     |  • Electron \`persist\` Win   |     |  • \`WEB_REMIX\` Client   |  |
|  |  • \`ytsearch1:\` Constructor   |     |  • Virtual DOM Extractor    |     |  • Explicit Badges      |  |
|  └──────────────┬────────────────┘     └──────────────┬──────────────┘     └────────────┬────────────┘  |
|                 │                                     │                                 │               |
|                 └──────────────────────────────┬──────┴─────────────────────────────────┘               |
|                                                ▼                                                        |
|                                  Execution Engine (\`runYtDownload\`)                                     |
|                                                │                                                        |
|                 ┌──────────────────────────────┴──────────────────────────────┐                         |
|                 ▼                                                             ▼                         |
|  ┌─────────────────────────────┐                               ┌─────────────────────────────┐          |
|  |       yt-dlp Subprocess     |                               |   MusicBrainz / CAA API     |          |
|  |  • Codec: Opus / AAC Stream | ── [dlprog] Progress Events ──>|  • 1.1s Rate-Limited Queue  |          |
|  |  • Audio Extraction         |                               |  • Album / Artist Fallback  |          |
|  |  • Thumbnail Conversion PNG |                               |  • Genre + 500px CAA Cover  |          |
|  └──────────────┬──────────────┘                               └──────────────┬──────────────┘          |
|                 │                                                             │                         |
|                 └──────────────────────────────┬──────────────────────────────┘                         |
|                                                ▼                                                        |
|                                  Tagging & Packaging Engine                                             |
|                                  • ffmpeg Stream Remuxing (\`writeMetadataToFile\`)                       |
|                                  • Container Picture Embedding (\`embedPicture\`)                         |
|                                  • NativeImage Integrity Verification (\`stripCoverIfCorrupt\`)          |
|                                                │                                                        |
|                                                ▼                                                        |
|                                  Filesystem Placement (\`placeDownload\`)                                 |
|                                  • Path Sanitization (\`sanitizeFsName\`)                                 |
|                                  • \`{Artist}/{Album}/{Artist} - {Title}.{ext}\`                          |
|                                  • Folder \`cover.<ext>\` Drop + Cache (\`saveCoverToCache\`)               |
+---------------------------------------------------------------------------------------------------------+
```

---

## 2. Input Ingestion & Query Resolution

Audex supports multiple entry points for audio discovery and download.

### 2.1 Supported Query Types

| Query Type | Pattern / Example | Resolution Mechanism |
|:---|:---|:---|
| **Direct YouTube URL** | \`https://www.youtube.com/watch?v=...\`<br>\`https://youtu.be/...\` | Direct video ID download via \`downloads:ytDownload\` |
| **YouTube Music Track** | \`https://music.youtube.com/watch?v=...\` | Direct video ID download via \`downloads:ytDownload\` |
| **YouTube Music Release** | \`https://music.youtube.com/playlist?list=OLAK5uy_...\` | Page enumeration via \`downloads:ytMusicParse\` |
| **YouTube Playlist** | \`https://music.youtube.com/playlist?list=PL...\` | Page enumeration via \`downloads:ytMusicParse\` |
| **YouTube Artist Page** | \`https://music.youtube.com/channel/...\`<br>\`https://music.youtube.com/@...\`<br>\`https://music.youtube.com/browse/UC...\`<br>\`https://music.youtube.com/browse/MPAD...\` | Page enumeration via \`downloads:ytMusicParse\` |
| **Spotify Playlist / Album** | \`https://open.spotify.com/playlist/...\`<br>\`https://open.spotify.com/album/...\`<br>\`https://open.spotify.com/artist/...\` | Headless/UI DOM scraping via \`spotify:parsePlaylist\`, then individual search queries via \`downloads:ytDownloadByQuery\` |
| **Free-form Text Search** | \`"Daft Punk Get Lucky"\` | Query string routed to \`ytsearch1:Daft Punk Get Lucky\` via \`downloads:ytDownloadByQuery\` |
| **LAN Peer Track** | \`http://<ip>:<port>/track/<id>\` | Binary fetch over HTTP via \`lan:downloadTrack\` |

---

### 2.2 URL Normalization & Sanitization

All incoming YouTube links are normalized via \`toMusicYoutubeUrl(url)\` before dispatch:
- Converts \`youtu.be/<id>\` to \`https://music.youtube.com/watch?v=<id>\`.
- Replaces domains \`youtube.com\`, \`www.youtube.com\`, \`m.youtube.com\`, and \`www.music.youtube.com\` with \`music.youtube.com\`.
- Preserves playlist parameters (\`?list=...\`) and video identifiers (\`?v=...\`).

---

### 2.3 YouTube Music Flat Enumeration (\`downloads:ytMusicParse\`)

When parsing an album, single, playlist, or artist channel, \`yt-dlp\` runs in lightweight flat enumeration mode:

```bash
yt-dlp \
  --flat-playlist \
  --dump-json \
  --no-warnings \
  --ignore-errors \
  --socket-timeout 20 \
  https://music.youtube.com/...
```

#### Metadata Extraction & Disambiguation Rules:
1. **Playlist / Release Artist Attribution**:
   - For official releases (\`list=OLAK5uy_...\`) and artist pages (\`/channel/\`, \`/@\`, \`/browse/UC\`, \`/browse/MPAD\`), the playlist uploader/channel is trusted as the release artist:
     $$\\text{artist} = \\text{playlist\\_uploader} \\lor \\text{playlist\\_channel}$$
   - For user-curated playlists, uploader names (e.g. curator username) are **never** used as track artist; per-track metadata is used.
2. **Channel Suffix Cleanup**:
   - Automatic YouTube topic channel suffixes are stripped:
     $$\\text{artist} = \\text{artist.replace}(/\\backslash\\text{s}*-\\backslash\\text{s}*\\text{topic}\\backslash\\text{s}*\\$/i, \\text{''})$$
3. **Title / Artist Separation**:
   - If artist is missing and the title contains \`" - "\`, the string is split into \`artist\` and \`title\`.
   - If artist is known and the title begins with \`"${artist} - "\`, the redundant prefix is stripped.
4. **Shorts & Nested Playlist Filtering**:
   - Entries with \`_type === "playlist"\` or URLs containing \`/shorts/\` are discarded.
5. **Cover Art Selection**:
   - Selects the highest resolution thumbnail from the \`thumbnails\` array; falls back to \`https://i.ytimg.com/vi/${id}/mqdefault.jpg\`.

#### Explicit Content Badge Resolution (\`ytmExplicitByPlaylist\`):
\`yt-dlp\` does not provide explicit flags. Audex makes an unauthenticated call to YouTube Music\'s InnerTube API:
- **Endpoint**: \`https://music.youtube.com/youtubei/v1/browse?prettyPrint=false\`
- **Client Configuration**: \`WEB_REMIX\` (\`clientVersion: 1.20241218.01.00\`, \`hl: "en"\`, \`gl: "US"\`)
- **Payload**: \`{ context: { client: YTM_CLIENT }, browseId: "VL" + listId }\`
- Recursively walks the response tree (\`musicResponsiveListItemRenderer\`) to map \`videoId\` $\\to$ \`MUSIC_EXPLICIT_BADGE\`.

---

### 2.4 Spotify Parsing Subsystem (\`spotify:parsePlaylist\`)

Because Spotify does not allow direct media extraction via \`yt-dlp\`, Audex parses track listings from the Spotify web client and fulfills downloads via YouTube queries.

#### Execution Details:
1. **Session & Window Management**:
   - Uses an Electron \`BrowserWindow\` with a persistent partition (\`persist:spotify\`) to retain authentication and prevent recurring sign-ins.
   - Configurable visibility via \`settings.showParserBrowser\` (hidden by default; can be displayed to solve CAPTCHAs or log in).
2. **Overlay Suppression**:
   - Automatically clicks OneTrust cookie banners (\`#onetrust-accept-btn-handler\`) and dismisses promo modals (\`button[data-testid="close-button"]\`).
3. **Virtual DOM Scraping**:
   - Target selector: \`[data-testid="tracklist-row"]\`.
   - Title: \`a[data-testid="internal-track-link"]\` or the first non-link \`div[dir="auto"]\`.
   - Artist: Joins all \`a[href*="/artist/"]\` anchors with \`" & "\`; falls back to header artist link or \`h1\`.
   - Thumbnail Upscaling: Converts 64px (\`ab67616d00001e02\`) and 300px (\`ab67616d00004851\`) image CDN URLs to 640px (\`ab67616d0000b273\`).
4. **Download Fulfillment**:
   - Each Spotify track is queued as an individual item where \`source = "spotify"\` and \`query = "${artist} ${title}"\`, routing to \`downloads:ytDownloadByQuery\`.

---

## 3. Download & Audio Extraction Subsystem

The core download pipeline is implemented in \`runYtDownload()\` inside \`main.js\`.

```
Target URL / Query
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│  Environment Configuration:                                 │
│  • ELECTRON_RUN_AS_NODE=1                                   │
│  • PYTHONUTF8=1, PYTHONIOENCODING=utf-8                     │
│  • JS Runtime: node:<process.execPath>                      │
│  • Extractor Arg: youtube:formats=missing_pot               │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  Cookie Handling & Fallback:                                │
│  1. Attempt with `--cookies <path>` if cookies exist        │
│  2. If code != 0, retry immediately without `--cookies`     │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  Stream Selection & Transcode Flags:                        │
│  • opus: -f bestaudio[acodec=opus]/bestaudio/best (Copy)    │
│  • m4a:  -f bestaudio/best --audio-quality 256K (AAC)       │
│  • flac: -f bestaudio/best --audio-quality 0 (Lossless)     │
│  • Thumbnails: --write-thumbnail --convert-thumbnails png   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  IPC Progress Stream:                                       │
│  • Parse `[dlprog]` lines -> `downloads:ytProgress`         │
│  • Output: %(title)s [%(id)s].%(ext)s                       │
│  • Print: `after_move:[audexmeta]<artist>\t<album>\t<path>` │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 Audio Formats & Codec Filtering

| Format | Source Selector (\`-f\`) | Audio Quality (\`--audio-quality\`) | Bitrate / Behavior |
|:---|:---|:---|:---|
| \`opus\` *(Default)* | \`bestaudio[acodec=opus]/bestaudio/best\` | \`0\` | **Bit-identical remux** from YouTube\'s native ~160kbps Opus stream (\`-c copy\`). No transcoding generational loss. |
| \`m4a\` | \`bestaudio/best\` | \`256K\` | Down-transcoded from highest bitrate Opus/AAC stream. Quality capped at \`256K\` to prevent ffmpeg native AAC VBR bloat (~450kbps). |
| \`flac\` | \`bestaudio/best\` | \`0\` | Lossless container transcode from best available source stream. |

---

### 3.2 Premium & Missing POT Bypass

YouTube Music serves high-bitrate audio streams (256kbps Opus/AAC, itags 774/141) exclusively to YouTube Premium subscribers. \`yt-dlp\` marks these streams with \`MISSING POT\` (Proof of Origin token) and hides them by default.

Audex bypasses this restriction by supplying:
```
--js-runtimes node:<process.execPath>
--extractor-args youtube:formats=missing_pot
```
When valid session cookies are present, yt-dlp successfully acquires the high-bitrate stream without requiring a separate JavaScript runtime solver.

---

### 3.3 Cookie Resilience & Fallback Engine (\`runYtDlpWithCookieFallback\`)

To prevent cookie corruption or solver mismatch from breaking downloads:
1. Audex invokes \`streamYtDlpOnce\` with \`--cookies <cookiePath>\` and \`--js-runtimes\`.
2. If \`code !== 0\` (e.g. expired session, signature solver error, geo-block):
   - Immediately retries the download in unauthenticated mode (\`useCookies: false\`).
   - The cookie file is **not** deleted on transient solver errors, preserving user login for subsequent attempts.

---

### 3.4 Process Execution & Encoding Safety

To guarantee cross-platform encoding compatibility (particularly on Windows with non-UTF-8 locales):
```javascript
function ytDlpSpawnEnv() {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8'
  };
}
```
This guarantees that the \`--print after_move:[audexmeta]%(artist|)s\t%(album|)s\t%(filepath)s\` pipeline delimiter emits valid UTF-8, preventing truncated metadata in Cyrillic, CJK, and accented Latin character sets.

---

### 3.5 Real-Time Progress Parsing

yt-dlp output is piped using the format template:
```
--progress-template "[dlprog] %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s"
```

The line parser matches \`[dlprog]\` and emits real-time events over IPC (\`downloads:ytProgress\`):
```javascript
{
  videoId: "dQw4w9WgXcQ",
  url: "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
  requestId: "req-1718000000000",
  phase: "download",       // 'download' | 'postprocess'
  percent: 84.5,           // Float [0.0 - 100.0]
  speed: "4.2MiB/s",
  eta: "00:03"
}
```

---

## 4. Metadata Enrichment Pipeline (MusicBrainz)

Once the raw audio file is extracted, Audex enriches tags and artwork via MusicBrainz and the Cover Art Archive (\`musicbrainz.js\`).

### 4.1 Lookup Sequence & Precedence Hierarchy

```
Metadata Sources:
1. User / Source Page (Renderer UI)  ──>  [Authoritative Title, Artist, Album]
2. MusicBrainz API Lookup            ──>  [Canonical Album, Original-Script Artist, Release Group Genre]
3. yt-dlp Extracted Metadata         ──>  [Fallback Artist, Fallback Album]
```

```
Input: { artist, album, title }
                │
         Is Album present?
         ├─────────────── YES: Query `artist:"..." AND release:"..."`
         │                     └─ If found: Extract Release MBID, Release Group, Album Title
         │
         └─────────────── NO:  Query `artist:"..." AND recording:"..."`
                               └─ If found: Extract Release from Recording Credit
```

### 4.2 Rate Limiting & Caching Protocol
- **Rate Limit**: Serial promise chain (\`mbChain\`) enforcing an **1100ms** delay between calls, conforming to the MusicBrainz $\\le 1\\text{ req/sec}$ policy.
- **Process Memory Cache**: \`albumCache\` Map keyed by:
  - \`${artist.toLowerCase()}|${album.toLowerCase()}\` (for release queries).
  - \`${artist.toLowerCase()}||${title.toLowerCase()}\` (for track-level queries).

### 4.3 Genre Resolution Hierarchy
YouTube provides no genre tags. Audex discovers genres exclusively via MusicBrainz:
1. Primary: Top genres from the MusicBrainz **Release Group** (\`/release-group/${rgId}?inc=genres\`).
2. Fallback: Top genres from the **Artist** entity (\`/artist/${artistMbid}?inc=genres\`).
3. Formatted as a comma-separated list of up to 3 genres ordered by community vote count.

---

## 5. Tag Writing & Container-Specific Cover Art Packaging

All metadata writing and picture embedding is handled through **ffmpeg stream remuxing** (\`-map 0 -c copy\`), preventing audio re-encoding.

### 5.1 Tag Field Mapping Matrix

| Logical Tag | ffmpeg Argument Key | MP3 (ID3v2.3) | Ogg / Opus (Vorbis) | M4A (iTunes Atom) | FLAC (Vorbis) |
|:---|:---|:---|:---|:---|:---|
| \`title\` | \`title\` | \`TIT2\` | \`TITLE\` | \`©nam\` | \`TITLE\` |
| \`artist\` | \`artist\` | \`TPE1\` | \`ARTIST\` | \`©ART\` | \`ARTIST\` |
| \`album\` | \`album\` | \`TALB\` | \`ALBUM\` | \`©alb\` | \`ALBUM\` |
| \`albumArtist\` | \`album_artist\` | \`TPE2\` | \`ALBUMARTIST\` | \`aART\` | \`ALBUMARTIST\` |
| \`year\` | \`date\` | \`TDRC\` / \`TYER\` | \`DATE\` | \`©day\` | \`DATE\` |
| \`genre\` | \`genre\` | \`TCON\` | \`GENRE\` | \`©gen\` | \`GENRE\` |
| \`trackNo\` | \`track\` | \`TRCK\` | \`TRACKNUMBER\` | \`trkn\` | \`TRACKNUMBER\` |
| \`discNo\` | \`disc\` | \`TPOS\` | \`DISCNUMBER\` | \`disk\` | \`DISCNUMBER\` |
| \`comment\` | \`comment\` | \`COMM\` | \`COMMENT\` | \`©cmt\` | \`COMMENT\` |

> [!IMPORTANT]
> **Ogg / Opus Metadata Target**: Vorbis comments on Ogg containers must be directed to \`-metadata:s:a:0\` instead of the global \`-metadata\` container flags to prevent tag loss during stream copy.

---

### 5.2 Cover Art Embedding Architecture

Audex resolves cover art using a two-tier mechanism:
1. **Primary**: Cover Art Archive front cover (500px JPEG) from \`https://coverartarchive.org/release/${releaseMbid}/front-500\`.
2. **Fallback**: YouTube video thumbnail converted to PNG (\`--write-thumbnail --convert-thumbnails png\`).

#### Container-Specific Embed Mechanisms:

```
                         Cover Picture Buffer
                                  │
                   Is target container Ogg/Opus?
                   ├──────────────────────────────────┐
                  YES                                 NO (MP3, M4A, FLAC)
                   │                                  │
                   ▼                                  ▼
      Generate ffmetadata block:             Pass image via secondary input:
      • Type: 3 (Cover Front)                • `-i <tmpImgPath>`
      • Big-Endian FLAC picture block        • `-map 0:a -map 1:v`
      • Vorbis METADATA_BLOCK_PICTURE        • `-c copy -disposition:v attached_pic`
      • `-map 0:a -map_metadata 1`           • If MP3: `-id3v2_version 3`
```

#### The Ogg/Opus FFmpeg Mux-Crash Solution:
When ffmpeg demuxes an Ogg file with embedded Vorbis artwork, it generates a synthetic MJPEG video stream for player compatibility. If \`-map 0 -c copy\` is executed on that file, ffmpeg\'s Ogg muxer crashes with \`Unsupported codec id in stream 1\`.

Audex solves this by:
1. Building a standard binary FLAC \`METADATA_BLOCK_PICTURE\` structure in memory:
   $$\\text{Block} = [\\text{type: } 3] + [\\text{mime\\_len}] + [\\text{mime}] + [\\text{desc\\_len: } 0] + [\\text{dims: } 0,0,0,0] + [\\text{data\\_len}] + [\\text{data}]$$
2. Base64-encoding the block into an \`ffmetadata\` text file:
   ```ini
   ;FFMETADATA1
   METADATA_BLOCK_PICTURE=<base64_payload>
   ```
3. Mapping **only the audio stream** (\`-map 0:a\`) while merging the metadata file (\`-map_metadata 1\`), completely bypassing the synthetic video stream crash.

---

### 5.3 Corrupt Artwork Detection & Stripping (\`stripCoverIfCorrupt\`)

If thumbnail data is truncated during download or parsing:
1. Immediately following download completion, Audex parses the written file using \`music-metadata\`.
2. Verifies the buffer with Chromium\'s decoder via Electron \`nativeImage.createFromBuffer(pic.data)\`.
3. If \`nativeImage.isEmpty()\` is \`true\` or dimensions are \`0x0\`, the file is re-muxed with \`{ dropCover: true }\`, stripping the broken stream and preventing visual render errors or player crashes.

---

## 6. Filesystem Placement & Sanitization

Final file organization and directory hierarchy are managed by \`placeDownload()\` and \`sanitizeFsName()\`.

### 6.1 Directory & Filename Structure

The downloaded file is moved from the temporary extraction path into the organized library hierarchy:

$$\\text{Target Path} = \\text{downloadsDir} / \\text{SanitizedArtist} / \\text{SanitizedAlbum} / \\text{SanitizedBase}.\\text{ext}$$

#### Placement Hierarchy Rules:
- If both \`Artist\` and \`Album\` are present:
  \`Audex Downloads/Pink Floyd/The Dark Side of the Moon/Pink Floyd - Time.opus\`
- If \`Album\` is absent:
  \`Audex Downloads/Pink Floyd/Pink Floyd - Time.opus\`
- If \`Artist\` and \`Album\` are absent:
  \`Audex Downloads/Time.opus\`
- Missing segments are cleanly omitted without creating \`"Unknown"\` or \`"None"\` folder levels.

---

### 6.2 Filesystem Sanitization Algorithm (\`sanitizeFsName\`)

To maintain full compatibility across Windows (NTFS/FAT32), macOS (APFS), and Linux (ext4/btrfs):

```javascript
function sanitizeFsName(name) {
  const clean = (s) => s.trim().replace(/[.\s]+$/, '');
  const s = clean(clean(String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')).slice(0, 180));
  return /^\.+$/.test(s) ? '' : s;
}
```

1. **Reserved Character Replacement**: Replaces \`< > : " / \\ | ? *\` and ASCII control characters \`\x00-\x1f\` with \`_\`.
2. **Trailing Dot & Space Stripping**:
   Windows silently strips trailing dots and spaces during directory creation. Sanitization strips \`/[.\s]+$/\` before and after string truncation to ensure the JavaScript runtime path matches the physical disk path.
3. **Length Clamping**: Names are truncated to **180 characters** to avoid exceeding filesystem path limits ($255$ bytes).
4. **Path Traversal Protection**: Rejects strings consisting exclusively of dots (\`.\` or \`..\`), preventing directory traversal out of the destination root.

---

### 6.3 Album Folder Artwork & Cache Synchronization

1. **Album Cover Drop**:
   The embedded cover art is saved directly into the album folder as:
   ```
   {downloadsDir}/{SanitizedArtist}/{SanitizedAlbum}/cover.jpg (or .png / .webp)
   ```
   This allows OS file explorers, DLNA media servers, and offline music players to immediately display album art.
2. **Global Cover Cache**:
   The image is cached in \`~/.config/Audex/covers/\` keyed by SHA-256 hash of the canonical file path (\`coverCacheHash\`), accelerating track rendering across subsequent app launches.

---

## 7. Error Classification & Recovery

\`classifyYtDlpError()\` categorizes failures from stderr and stdout into actionable states:

| Error Code | Regex Pattern | Root Cause | User UI Message | Recovery Strategy |
|:---|:---|:---|:---|:---|
| \`geo\` | \`not made this video available in your country\` \| \`geo-restricted\` | Geographic licensing restriction | "Video is not available in your region." | Suggest alternative track / proxy. |
| \`unavailable\` | \`Video unavailable\` \| \`has been removed\` \| \`private video\` | Deleted or privatized YouTube upload | "Track is unavailable or removed." | Attempt search with alternative release query. |
| \`signin\` | \`Sign in to confirm\` \| \`not a bot\` \| \`cookies\` | Bot detection / Age gate / Auth required | "YouTube requires authentication." | Trigger \`youtube:login\` modal to refresh cookies. |
| \`members\` | \`members-only\` \| \`join this channel\` | Paid YouTube channel membership | "Track is members-only content." | Skip or request alternate source. |
| \`network\` | \`Unable to download\` \| \`Connection reset\` \| \`timed out\` | Network drop or DNS failure | "Network connection error." | Automated retry with backoff. |
| \`transient\` | \`errno \d+\` \| \`Postprocessing:\` \| \`No such file\` | Incomplete YouTube stream manifest | "Transient download error." | Automatic clean retry. |

---

## 8. Summary Trace: End-to-End Sequence

```
User Query ("Daft Punk Get Lucky")
  │
  ├─> [Renderer] Appends track to downloadQueue with status: 'queued'
  ├─> [IPC] Invokes `downloads:ytDownloadByQuery({ query, format: "opus" })`
  │
  ├─> [Main] `runYtDownload()` resolves destination directory: `~/Music/Audex Downloads`
  ├─> [Main] Runs `streamYtDlp()` with args:
  │     `ytsearch1:Daft Punk Get Lucky`
  │     `--extract-audio --audio-format opus -f bestaudio[acodec=opus]/bestaudio/best`
  │     `--write-thumbnail --convert-thumbnails png`
  │
  ├─> [yt-dlp] Emits download progress `[dlprog] 45.2%|3.1MiB/s|00:04`
  │     └─> [IPC] `downloads:ytProgress` updates UI progress bar
  │
  ├─> [yt-dlp] Finishes extraction: `Daft Punk - Get Lucky [v=4D7u5KF7VM8].opus`
  │     └─> Emits `[audexmeta]Daft Punk\tRandom Access Memories\t<path>`
  │
  ├─> [Main] `lookupAlbumInfo({ artist: "Daft Punk", album: "Random Access Memories" })`
  │     ├─> MusicBrainz Release lookup -> MBID: `9f30e...`
  │     ├─> Cover Art Archive fetch -> 500px Front Cover Buffer
  │     └─> Release Group genres -> "Disco, Funk, Electronic"
  │
  ├─> [Main] `writeMetadataToFile()` executes ffmpeg stream copy:
  │     Remuxes tags: `title="Get Lucky"`, `artist="Daft Punk"`, `album="Random Access Memories"`, `genre="Disco, Funk, Electronic"`
  │
  ├─> [Main] `embedPicture()` creates ffmetadata `METADATA_BLOCK_PICTURE` for Ogg/Opus
  │     Embeds Cover Art Archive image into `.opus` stream without MJPEG mux crash
  │
  ├─> [Main] `stripCoverIfCorrupt()` validates image bytes with `nativeImage`
  │
  ├─> [Main] `placeDownload()` sanitizes names and moves file to:
  │     `~/Music/Audex Downloads/Daft Punk/Random Access Memories/Daft Punk - Get Lucky.opus`
  │
  ├─> [Main] Writes folder album artwork:
  │     `~/Music/Audex Downloads/Daft Punk/Random Access Memories/cover.jpg`
  │
  └─> [IPC] Resolves `{ success: true, filePath }` -> Track state updated to "completed" in UI
```
