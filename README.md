<div align="center">

<img src="build/icon.png" width="120" alt="Audex icon" />

# Audex

### Your music. Your machine. No account, no subscription, no cloud.

A fast, beautiful desktop player for the music you actually own — and a one-click way to get more of it.

[![Version](https://img.shields.io/badge/version-24b3121-e8a33d?style=for-the-badge)](https://github.com/zhotheone/audex-player/releases/latest)
[![Platforms](https://img.shields.io/badge/Linux%20·%20macOS%20·%20Windows-2b2b2b?style=for-the-badge)](https://github.com/zhotheone/audex-player/releases/latest)
[![License](https://img.shields.io/badge/MIT-blue?style=for-the-badge)](LICENSE)

### [⬇️  Download the latest release](https://github.com/zhotheone/audex-player/releases/latest)

*Free and open source. No telemetry, no ads, no sign-up.*

</div>

---

## This fork vs. [upstream](https://github.com/MishaSok/audex-player)

- **Devices (LAN & Tailscale)** — see every device's library live, stream from it, and one-click **take over** its playback session. Libraries and settings sync across your devices automatically.
- **More download formats** — Opus, FLAC and M4A, not just MP3.
- **In-app YouTube Music browser** — search an artist, walk their albums and singles, and queue a whole release without touching a link.
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
- **It looks good.** Eleven palettes, any accent color you like, your own wallpaper behind the interface.
- **It fills the gaps.** Missing a track? Search YouTube Music by artist or paste a Spotify link, and it lands in your library tagged, covered and ready — without leaving the app.
- **It respects you.** Your listening stats are computed on your device and never leave it.

*Not fully offline: lyrics come from [LRCLIB](https://lrclib.net/), and search/parsing/downloads talk to YouTube — only when you use those features. The LAN/Tailscale device server (below) is optional and off by default.*

---

## See it in action

### Your year in music, computed locally

Listening time, top artists and tracks, a streak counter, and a clock showing when you actually listen. Day, month, year or all-time — none of it ever leaves your machine.

![Listening report](docs/screenshots/report.png)

### Eleven palettes, one click

Dark is Rosé Pine and Light is Rosé Pine Dawn, with Default following your OS between the two. Then Rosé Pine Moon, Catppuccin (Mocha/Latte), Gruvbox (dark/light), Dracula (and its light Alucard variant) and Tokyo Night (night/day). Turn on **Random theme** and the app picks one for you at every launch. Pick any accent color to go with them.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/settings-themes.png" alt="Theme picker" /></td>
    <td width="50%"><img src="docs/screenshots/library-light.png" alt="Light theme" /></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/screenshots/artists-nocturne.png" alt="Artists view" /></td>
  </tr>
</table>

### A player worth going fullscreen for

A floating playbar island at the bottom, and a fullscreen view with the queue
alongside, karaoke-style synced lyrics that keep the transport in reach, and a
portrait "mobile player" mode for when the window is narrow.

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

- Recursive import of `.mp3`, `.wav`, `.ogg`, `.opus`, `.flac`, `.m4a`, `.aac`.
- Tags and cover art read with `music-metadata`. **Tag editing** is written back through ffmpeg, so it isn't MP3-only.
- **Playlists, Favorites, Recents**, and **Artists/Albums** views grouped automatically — including tracks streamed from other devices.
- **Command palette** (<kbd>Ctrl/⌘</kbd>+<kbd>K</kbd>) — tracks, artists, albums and every action in one box, ranked so an exact artist or album name comes out on top. Actions match in both interface languages.
- Shuffle, repeat, sorting, filtering, and **resume on launch**.
- **Crossfade** and a **track trimmer** with a waveform fragment picker *(both optional)*.
- **Library health-check** *(optional)* — finds suspected transcodes, low bitrates, missing covers, incomplete tags and duplicates.

</details>

<details open>
<summary><b>⬇️ Get new music</b></summary>

- **YouTube Music browser** — its own sidebar tab: search an artist, open an album or single, and queue one track or the whole release. No link, no login, no browser window.
- **Link parsing** — paste a YouTube Music album/single/artist URL or a Spotify playlist/album URL and get the full track list.
- **YouTube sign-in** — hand yt-dlp your cookies to unlock age-restricted or private videos.
- **Download queue** with live progress; queue state survives restarts.
- Cover art and metadata are embedded automatically; downloads land in Opus, FLAC or M4A wherever you like.

</details>

<details open>
<summary><b>🎨 Interface</b></summary>

- **Two languages** — English, Ukrainian.
- **Eleven palettes** — Rosé Pine, Catppuccin, Gruvbox, Dracula, Tokyo Night, each with a light and dark variant, optionally randomized per launch — and a **customizable accent color**.
- **Custom background** — your own image or the current album art, with blur and dim controls.
- **UI scale** and a **responsive layout**, with a **portrait "mobile player"** mode for the fullscreen view.
- **A sidebar you choose** — Downloads, YouTube Music, Devices, Report, Health-check and the Editor are each a switch in **Settings → Sidebar**, so the nav only shows what you use.

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
| `GET /api/config` | the shared settings blob peers sync between themselves |
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
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd> | Open the command palette |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>E</kbd> | Edit tags of the current track |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>,</kbd> | Open settings |
| <kbd>Space</kbd> | Play / pause |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>←</kbd> / <kbd>→</kbd> | Previous / next track |
| <kbd>←</kbd> / <kbd>→</kbd> | Seek 5 seconds |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Volume |
| <kbd>F</kbd> · <kbd>M</kbd> · <kbd>L</kbd> · <kbd>S</kbd> · <kbd>R</kbd> | Fullscreen · mute · like · shuffle · repeat |
| <kbd>Esc</kbd> | Close the fullscreen view or any dialog |
| <kbd>↑</kbd> / <kbd>↓</kbd> · <kbd>Enter</kbd> | Navigate and run palette results |

Every playback shortcut is rebindable in **Settings → Hotkeys**, and can be made system-wide.

---

## 📦 Download

Grab the latest build from the [**Releases page**](https://github.com/zhotheone/audex-player/releases/latest):

| Platform | File |
| --- | --- |
| **Linux** | `Audex-0.0.<n>.AppImage` (portable) or `audex-player_0.0.<n>_amd64.deb` |
| **macOS** (Apple Silicon) | `Audex-0.0.<n>-arm64.dmg` (or the `-mac.zip`) |
| **Windows** | `Audex-Setup-<commit>.exe` |

Releases are tagged `v-<commit>` — the short git hash is this fork's version, and
it's what Settings → About shows. `0.0.<n>` is the commit count, an
always-increasing number the auto-updater compares; nobody hand-bumps it.

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
npm run dist    # Linux AppImage + .deb into release/
npm test        # the LAN/API and library self-checks
```

macOS and Windows builds are produced by GitHub Actions on tag push.

---

## 🧰 Built with

**[Electron 42](https://www.electronjs.org/)** · vanilla HTML/CSS/JS — no framework, no bundler · **[music-metadata](https://github.com/borewit/music-metadata)** · **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** · **[ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)** · **[electron-updater](https://www.electron.build/auto-update)**

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
