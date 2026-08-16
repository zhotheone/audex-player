// Freezes the current git short hash into build-info.json so packaged builds can
// show it — .git is not shipped, so main.js can't ask git at runtime there.
// Runs from the `dist` script, before electron-builder collects build.files.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const infoPath = path.join(root, 'build-info.json');
const pkgPath = path.join(root, 'package.json');

let commit = '';
let commitCount = 0;

// Read existing build-info.json if present as fallback
try {
  const existing = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  if (existing.commit) commit = existing.commit;
  if (existing.commitCount) commitCount = existing.commitCount;
} catch (_) {}

// Query live git if available
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root })
    .toString().trim();
  commitCount = parseInt(
    execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root }).toString().trim(), 10
  ) || commitCount;
} catch (_) {}

fs.writeFileSync(infoPath, JSON.stringify({ commit, commitCount }) + '\n');
console.log(`build-info.json: commit=${commit || '(unknown)'} count=${commitCount}`);

// package.json's "version" stays real semver for electron-builder's Windows exe
// metadata, but nobody hand-bumps it — this fork's user-facing version is the
// git hash above. electron-updater needs a version that strictly increases to
// detect updates at all, so pin it to the commit count on every build: always
// increases, valid semver, no human has to remember it.
if (commitCount > 0 || commit) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (commitCount > 0) pkg.version = `0.0.${commitCount}`;
  if (commit && pkg.build) {
    if (pkg.build.nsis) pkg.build.nsis.artifactName = '${productName}-Setup-' + commit + '.${ext}';
    if (pkg.build.win) pkg.build.win.artifactName = '${productName}-' + commit + '-${os}.${ext}';
  }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`package.json: version=${pkg.version}`);
}
