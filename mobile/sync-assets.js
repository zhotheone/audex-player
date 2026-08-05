// Pulls the desktop renderer into the Capacitor webDir. index.html/style.css/
// renderer.js stay single-sourced at the repo root — this just copies them in
// and wires up the two mobile-only tags (bridge.js, mobile.css) that make the
// same renderer boot outside Electron.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(__dirname, 'src');
const out = path.join(__dirname, 'www');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const f of ['style.css', 'renderer.js']) {
  fs.copyFileSync(path.join(root, f), path.join(out, f));
}
for (const f of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, f), path.join(out, f));
}

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
// viewport-fit=cover is what makes env(safe-area-inset-*) resolve to real
// values instead of 0 — without it every notch/gesture-bar padding rule in
// mobile.css is a no-op. Desktop has no viewport meta at all (Electron's
// renderer isn't a scaling mobile viewport), so this is mobile-only too.
html = html.replace(
  '<meta charset="UTF-8">',
  '<meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">'
);
html = html.replace(
  '<link rel="stylesheet" href="style.css">',
  '<link rel="stylesheet" href="style.css">\n  <link rel="stylesheet" href="mobile.css">'
);
html = html.replace(
  '<script src="renderer.js"></script>',
  '<script src="bridge.js"></script>\n  <script src="renderer.js"></script>'
);
fs.writeFileSync(path.join(out, 'index.html'), html);

console.log(`synced into ${path.relative(root, out)}/`);
