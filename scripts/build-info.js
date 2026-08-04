// Freezes the current git short hash into build-info.json so packaged builds can
// show it — .git is not shipped, so main.js can't ask git at runtime there.
// Runs from the `dist` script, before electron-builder collects build.files.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
let commit = '';
let commitCount = 0;
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root })
    .toString().trim();
  commitCount = parseInt(
    execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root }).toString().trim(), 10
  ) || 0;
} catch (_) {
  // Building from a tarball with no git history — leave it blank rather than fail.
}

fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify({ commit }) + '\n');
console.log(`build-info.json: commit=${commit || '(unknown)'}`);

// package.json's "version" stays real semver for electron-builder's Windows exe
// metadata, but nobody hand-bumps it — this fork's user-facing version is the
// git hash above. electron-updater needs a version that strictly increases to
// detect updates at all, so pin it to the commit count on every build: always
// increases, valid semver, no human has to remember it.
if (commitCount > 0) {
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = `0.0.${commitCount}`;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`package.json: version=${pkg.version} (commit count)`);
}
