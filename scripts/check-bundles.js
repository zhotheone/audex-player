// Refuses to package for a platform whose bundled binaries are not present.
//
// yt-dlp and fpcalc are fetched by `postinstall` for whatever machine
// runs npm — so cross-building (say, --win from Linux) happily produces an
// installer carrying Linux binaries. Nothing downstream complains: the app
// installs, launches, and only fails once the user tries to download or
// identify a track. This turns that into a build-time error.
//
// Usage: node scripts/check-bundles.js <win32|darwin|linux>

const fs = require('fs');
const path = require('path');

const target = process.argv[2] || process.platform;
const root = path.join(__dirname, '..');

const YTDLP = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp_linux' }[target];
const FPCALC = target === 'win32' ? 'fpcalc.exe' : 'fpcalc';

const missing = [];
for (const [dir, name] of [['yt-dlp-bundle', YTDLP], ['fpcalc-bundle', FPCALC]]) {
  if (!name || !fs.existsSync(path.join(root, dir, name))) missing.push(`${dir}/${name}`);
}

if (missing.length) {
  console.error(`\n[check-bundles] cannot build for ${target}: missing ${missing.join(', ')}`);
  console.error(`[check-bundles] these are fetched by postinstall for the machine you run it on,`);
  console.error(`[check-bundles] so a ${target} build has to run on ${target} — or push a v* tag`);
  console.error(`[check-bundles] and let .github/workflows/release.yml build it on a ${target} runner.\n`);
  process.exit(1);
}

console.log(`[check-bundles] ${target} bundles present`);
