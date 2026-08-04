// Freezes the current git short hash into build-info.json so packaged builds can
// show it — .git is not shipped, so main.js can't ask git at runtime there.
// Runs from the `dist` script, before electron-builder collects build.files.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
let commit = '';
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root })
    .toString().trim();
} catch (_) {
  // Building from a tarball with no git history — leave it blank rather than fail.
}

fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify({ commit }) + '\n');
console.log(`build-info.json: commit=${commit || '(unknown)'}`);
