<div align="center">

<img src="build/icon.png" width="120" alt="Audex icon" />

# Audex

### Your music. Your machine. No account, no subscription, no cloud.

A fast, beautiful desktop player for the music you actually own — and a one-click way to get more of it.

[![Version](https://img.shields.io/badge/version-05e1ad8-e8a33d?style=for-the-badge)](https://github.com/zhotheone/audex-player/releases/latest)
[![Platforms](https://img.shields.io/badge/Linux%20·%20macOS%20·%20Windows-2b2b2b?style=for-the-badge)](https://github.com/zhotheone/audex-player/releases/latest)
[![License](https://img.shields.io/badge/MIT-blue?style=for-the-badge)](LICENSE)

### [⬇️  Download the latest release](https://github.com/zhotheone/audex-player/releases/latest)

*Free and open source. No telemetry, no ads, no sign-up.*

</div>

---

## This fork vs. [upstream](https://github.com/MishaSok/audex-player)

- **Devices (LAN & Tailscale)** — see every device's library live, stream from it, and one-click **take over** its playback session. Libraries and settings sync across your devices automatically.
- **AcoustID track ID** — auto-fill missing tags and track/disc numbers; bulk "fix the tags" for a song, artist, album, or the whole library.
- **More download formats** — Opus, FLAC, M4A and WAV, not just MP3.
- **YouTube sign-in** — pass yt-dlp your cookies for age-restricted or private videos.
- **Real auto-updates** — downloads and installs the new version instead of just linking to the releases page.
- **Fullscreen lyrics, an Albums view**, and cross-links between tracks, artists and albums.
- **Native Windows build**, a global app log, and an "open logs folder" button.
- Dropped everything Yandex/Russia-related.

---

![Audex library](docs/screenshots/library-dark.png)

## Why you'll like it

- **It's yours.** Point it at a folder and it just works — offline, forever. Nothing is uploaded anywhere.
- **It's quick.** Thousands of tracks scroll without a stutter — the list is virtualized and every cover is cached to disk after the first scan.
- **It looks good.** Nine themes, any accent color you like, your own wallpaper behind the interface.
- **It fills the gaps.** Missing a track? Search YouTube, paste a Spotify playlist, or grab what's charting today — without leaving the app.
- **It respects you.** Your listening stats are computed on your device and never leave it.

*Not fully offline: identifying a track queries [AcoustID](https://acoustid.org/), lyrics come from [LRCLIB](https://lrclib.net/), and search/parsing/downloads talk to YouTube — only when you use those features. The LAN/Tailscale device server (below) is optional and off by default.*

---

## See it in action

### Charts by country *and* genre

Browse what's trending worldwide or dive into a genre — Pop, Hip-hop, Phonk, Metal, K-pop and more. One click downloads the track, tags and cover art included.

![Trending charts](docs/screenshots/trending.png)

### Your year in music, computed locally

Listening time, top artists and tracks, a streak counter, and a clock showing when you actually listen. Day, month, year or all-time — none of it ever leaves your machine.

![Listening report](docs/screenshots/report.png)

### Nine themes, one click

Dark, Light, System, plus six hand-tuned palettes: Nocturne, Terracotta, Forest, Vapor, Crimson Noir and Arctic. Pick any accent color to go with them.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/settings-themes.png" alt="Theme picker" /></td>
    <td width="50%"><img src="docs/screenshots/library-light.png" alt="Light theme" /></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/screenshots/artists-nocturne.png" alt="Artists view in the Nocturne theme" /></td>
  </tr>
</table>

### A player worth going fullscreen for

Real waveform seeking, an upcoming-queue panel, and a portrait "mobile player" mode for when the window is narrow.

<table>
  <tr>
    <td width="68%"><img src="docs/screenshots/now-playing.png" alt="Fullscreen now playing" /></td>
    <td width="32%"><img src="docs/screenshots/mobile.png" alt="Portrait mobile player" /></td>
  </tr>
</table>

### Search it, queue it, done

<img src="docs/screenshots/downloads.png" alt="Downloads tab" />

---

## Features

<details open>
<summary><b>🎵 Library &amp; playback</b></summary>

- Recursive import of `.mp3`, `.wav`, `.ogg`, `.flac`, `.m4a`, `.aac`.
- Tags and cover art via `music-metadata`; **AcoustID** fills in what's missing. **MP3 tag editing** written back with `node-id3`.
- **Playlists, Favorites, Recents**, and **Artists/Albums** views grouped automatically — including tracks streamed from other devices.
- **Command palette** (<kbd>Ctrl/⌘</kbd>+<kbd>K</kbd>) — jump to any track or view instantly.
- Shuffle, repeat, sorting, filtering, and **resume on launch**.
- **Real-waveform seek bar**, **crossfade**, and a **track trimmer** *(all optional)*.
- **Library health-check** *(optional)* — finds suspected transcodes, low bitrates, missing covers, incomplete tags and duplicates.

</details>

<details open>
<summary><b>⬇️ Get new music</b></summary>

- **YouTube** — search and download by query, with cover art and metadata embedded automatically. Sign in to unlock age-restricted or private videos.
- **YouTube Music** — paste an album, single or artist link and parse the full track list.
- **Spotify** — parse playlists and albums, then download them through the shared queue.
- **Trending** — YouTube Music charts for 8 countries and 13 genres, downloadable in one click.
- **Download queue** with live progress; queue state survives restarts.
- Downloads in MP3, Opus, FLAC, M4A or WAV, saved wherever you like.

</details>

<details open>
<summary><b>🎨 Interface</b></summary>

- **Two languages** — English, Ukrainian.
- **Nine themes** and a **customizable accent color**.
- **Custom background** — your own image or the current album art, with blur and dim controls.
- **UI scale** and a **responsive layout**, with a **portrait "mobile player"** mode for the fullscreen view.

</details>

<details open>
<summary><b>🖥️ System integration</b></summary>

- **System tray**, **MPRIS / Media Session**, and **global hotkeys** — control and see what's playing from outside the app.
- **Discord Rich Presence** — track, artist and album cover on your profile, with an optional timer and custom buttons.
- **Auto-updates** — downloads and installs new releases; a dismissible banner tells you when.
- **Global app log**, one click away in Settings → About.

</details>

---

## 🔗 Devices (LAN & Tailscale)

Turn on sharing in **Devices**, set the same *network key* on each of your machines, and they'll
see each other's libraries — merged straight into yours, tracks and all, no separate "Browse"
screen. Play anything from another device, or hit **Take over** to pull its session onto yours —
same track, same position, same queue, and the other device pauses itself.

On a LAN devices find each other automatically (UDP broadcast on 8422). Tailscale carries no
broadcast traffic, so there you add the address by hand — `100.x.y.z` or a MagicDNS name. The
server binds `0.0.0.0`, so one switch covers both.

One Android client speaks this API today:
[PixelPlayer](https://github.com/zhotheone/PixelPlayer) — a fork of the excellent
[PixelPlayerHQ/PixelPlayer](https://github.com/PixelPlayerHQ/PixelPlayer) with an added Audex
source: pair with a device's network key and its library syncs straight into PixelPlayer's own
Library/Albums/Artists/Search, cover art and all, alongside its Navidrome/Jellyfin/Telegram
sources.

<details>
<summary><b>HTTP API</b></summary>

Sharing is a plain HTTP + JSON API, so an Android or iOS client only has to speak HTTP. The
server listens on **8422** (walking up to 8426 if that's taken; the announce carries the real
port). Requests authenticate with the network key as a bearer token:

```
Authorization: Bearer <network key>
```

| Route | What it does |
| --- | --- |
| `GET /api/info` | device id, name, track count |
| `GET /api/library` | every track, each with a signed `url` and `coverUrl` |
| `GET /api/state` | what's playing, position, volume, shuffle/repeat, and the next 50 queued tracks |
| `GET /api/track/<id>?s=…` | the audio, with `Range` support so clients can seek |
| `GET /api/cover/<id>?s=…` | cover art |
| `POST /api/command` | `play` · `pause` · `next` · `prev` · `seek` · `volume` · `playState` · `transfer` |

`<audio src>` and `<img src>` can't send headers, so the media routes authenticate with a
per-track HMAC (`?s=`) that `/api/library` hands you instead. The key itself never appears in a
URL, and file paths never leave the device — peers only ever see the id.

`POST /api/command {"type":"transfer"}` is the takeover: it returns the device's full session and
pauses it. Point your player at `state.track.url`, seek to `state.position`, and you've moved the
music. `playState` is the same thing pushed the other way — hand a device a session and it starts
playing it.

</details>

---

## ⌨️ Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd> | Open the search command palette |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>E</kbd> | Edit tags of the current track |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>,</kbd> | Open settings |
| <kbd>Space</kbd> | Play / pause |
| <kbd>Esc</kbd> | Close the fullscreen view or any dialog |
| <kbd>↑</kbd> / <kbd>↓</kbd> · <kbd>Enter</kbd> | Navigate and run palette results |

Every playback shortcut is rebindable in **Settings → Hotkeys**, and can be made system-wide.

---

## 📦 Download

Grab the latest build from the [**Releases page**](https://github.com/zhotheone/audex-player/releases/latest):

| Platform | File |
| --- | --- |
| **Linux** | `Audex-1.3.0.AppImage` (portable) or `audex-player_1.3.0_amd64.deb` |
| **macOS** (Apple Silicon) | `Audex-1.3.0-arm64.dmg` |
| **Windows** | `Audex.Setup.1.3.0.exe` |

**Nothing else to install.** `yt-dlp` and `ffmpeg` ship inside the app, and parsing runs in Electron's own Chromium — downloading and parsing work out of the box.

> **Builds are unsigned**, so the OS will ask once:
> - **macOS** — right-click the app → **Open**, or run `xattr -d com.apple.quarantine /Applications/Audex.app`.
> - **Windows** — SmartScreen may warn; click **More info → Run anyway**.

---

## 🛠️ Build from source

```bash
git clone https://github.com/zhotheone/audex-player.git
cd audex-player
npm install
npm start
```

`npm start` runs `electron . --no-sandbox` (the flag avoids sandbox permission issues on some Linux setups).

On a bare Debian/Ubuntu box, Electron needs a few system libraries first:

```bash
sudo apt install libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 libgbm1
```

```bash
npm run dist   # Linux AppImage + .deb into release/
```

macOS and Windows builds are produced by GitHub Actions on tag push.

---

## 🧰 Built with

**[Electron 42](https://www.electronjs.org/)** · vanilla HTML/CSS/JS — no framework, no bundler · **[music-metadata](https://github.com/borewit/music-metadata)** · **[node-id3](https://github.com/Zazama/node-id3)** · **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** · **[ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)**

---

## 📬 Contact

Originally made by **Mikhail Sokov**. This fork is maintained by **Heorhii Litovskyi**.

- 🐙 **This fork:** [zhotheone/audex-player](https://github.com/zhotheone/audex-player)
- ✉️ **Email:** zhotheone@gmail.com
- 🐙 **Upstream project:** [MishaSok/audex-player](https://github.com/MishaSok/audex-player)
- 💬 **Upstream Telegram:** [@JuicexNet](https://t.me/JuicexNet)

---

<div align="center">

**[⬇️  Download Audex](https://github.com/zhotheone/audex-player/releases/latest)** · Released under the [MIT License](LICENSE).

</div>
