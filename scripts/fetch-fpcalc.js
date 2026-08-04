// Downloads Chromaprint's fpcalc into fpcalc-bundle/ so electron-builder can ship
// it (see build.files / build.asarUnpack in package.json). Runs as part of the
// `postinstall` script, so each CI runner fetches its own platform binary.
//
// fpcalc is what turns audio into the fingerprint AcoustID looks up. The bundled
// ffmpeg-static is built without the chromaprint muxer, so it cannot stand in.
//
// Unlike yt-dlp these releases are archives rather than bare binaries. Both the
// .tar.gz and the .zip are unpacked with `tar -xf`: GNU tar handles the former,
// and Windows 10+ ships bsdtar, which reads both — so one code path covers all
// three platforms instead of pulling in a zip library.

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const { execFileSync } = require('child_process');

const FPCALC_VERSION = '1.6.1';

// macOS takes the universal build so one asset covers Intel and Apple Silicon.
const SLUG = {
  'linux-x64': 'linux-x86_64',
  'linux-arm64': 'linux-arm64',
  'darwin-x64': 'macos-universal',
  'darwin-arm64': 'macos-universal',
  'win32-x64': 'windows-x86_64',
}[`${process.platform}-${process.arch}`];

if (!SLUG) {
  console.warn(`[fetch-fpcalc] unsupported platform ${process.platform}-${process.arch} — skipping`);
  process.exit(0);
}

const isWin = process.platform === 'win32';
const ext = isWin ? 'zip' : 'tar.gz';
const archive = `chromaprint-fpcalc-${FPCALC_VERSION}-${SLUG}.${ext}`;
const url = `https://github.com/acoustid/chromaprint/releases/download/v${FPCALC_VERSION}/${archive}`;

const bundleDir = path.join(__dirname, '..', 'fpcalc-bundle');
const binName = isWin ? 'fpcalc.exe' : 'fpcalc';
const dest = path.join(bundleDir, binName);

if (fs.existsSync(dest) && fs.statSync(dest).size > 100_000) {
  console.log(`[fetch-fpcalc] ${binName} already present — skipping`);
  process.exit(0);
}

fs.mkdirSync(bundleDir, { recursive: true });

function download(from, redirectsLeft, to, cb) {
  https.get(from, { headers: { 'User-Agent': 'audex-player-build' } }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      if (redirectsLeft <= 0) return cb(new Error('too many redirects'));
      res.resume();
      return download(res.headers.location, redirectsLeft - 1, to, cb);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return cb(new Error(`HTTP ${res.statusCode} for ${from}`));
    }
    const tmp = to + '.part';
    const file = fs.createWriteStream(tmp);
    res.pipe(file);
    file.on('finish', () => file.close(() => { fs.renameSync(tmp, to); cb(null); }));
    file.on('error', cb);
  }).on('error', cb);
}

console.log(`[fetch-fpcalc] downloading fpcalc ${FPCALC_VERSION} (${SLUG})…`);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'audex-fpcalc-'));
const archivePath = path.join(work, archive);

download(url, 5, archivePath, (err) => {
  if (err) {
    console.error(`[fetch-fpcalc] FAILED: ${err.message}`);
    process.exit(1);
  }
  try {
    // --strip-components drops the versioned top-level directory, leaving the
    // binary (and, on Windows, its DLL-free single exe) directly in the bundle.
    execFileSync('tar', ['-xf', archivePath, '-C', bundleDir, '--strip-components=1'],
      { stdio: 'inherit' });
    if (!fs.existsSync(dest)) throw new Error(`${binName} missing after extraction`);
    if (!isWin) fs.chmodSync(dest, 0o755);
    console.log(`[fetch-fpcalc] saved ${dest}`);
  } catch (e) {
    console.error(`[fetch-fpcalc] FAILED: ${e.message}`);
    process.exit(1);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
