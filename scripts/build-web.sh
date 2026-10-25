#!/usr/bin/env bash
# Build the web edition of cardwall into web/.
#
# The renderer is dual-mode: under Electron the preload owns
# window.cardwall (filesystem vault); in a plain browser
# renderer/web-bridge.js installs a localStorage-backed twin. So the web
# edition is literally the same index.html + styles.css + renderer/ —
# no build step, no bundler, no dependencies.
#
#   scripts/build-web.sh   # regenerate web/
#
# Deploy: git subtree push --prefix web origin gh-pages
# (GitHub Pages then serves https://<user>.github.io/<repo>/.)
set -euo pipefail

cd "$(dirname "$0")/.."

OUT=web
rm -rf "$OUT"
mkdir -p "$OUT/renderer"

# The shared entry + styles + renderer (web-bridge.js included; it no-ops
# under Electron where the preload already ran).
cp index.html styles.css "$OUT/"
cp renderer/physics.js \
   renderer/sample.js \
   renderer/web-bridge.js \
   renderer/interaction.js \
   renderer/debug.js \
   renderer/pdf-writer.js \
   renderer/export-geom.js \
   renderer/export-pdf.js \
   renderer/app.js \
   renderer/theme-boot.js \
   renderer/pwa-register.js \
   "$OUT/renderer/"

# PWA assets (installable on Android/iOS; ignored by the Electron build):
# the manifest, the service worker, and the generated icon set.
cp pwa/manifest.json pwa/service-worker.js "$OUT/"
mkdir -p "$OUT/icons"
cp pwa/icons/*.png "$OUT/icons/"

# Web-only touches that must NOT leak into the Electron build:
#  - a favicon (the packaged app has its own .icns)
#  - the PWA links: manifest + apple-touch-icon (the repo root ships no
#    manifest or icons, so the desktop build would just fetch 404s)
#  - .nojekyll so Pages serves the files verbatim
cp build/icon.svg "$OUT/favicon.svg"
node -e '
const fs = require("fs");
const p = "web/index.html";
let html = fs.readFileSync(p, "utf8");
const css = "<link rel=\"stylesheet\" href=\"styles.css\">";
if (!html.includes(css)) { console.error("build-web: styles.css link not found"); process.exit(1); }
html = html.replace(css,
  "<link rel=\"icon\" href=\"favicon.svg\" type=\"image/svg+xml\">\n" +
  "  <link rel=\"manifest\" href=\"manifest.json\">\n" +
  "  <link rel=\"apple-touch-icon\" href=\"icons/apple-touch-icon-180.png\">\n" +
  "  " + css);
fs.writeFileSync(p, html);
'
touch "$OUT/.nojekyll"

# Fail loudly if the entry references anything we did not copy.
missing=0
for f in $(grep -o 'renderer/[a-z-]*\.js' "$OUT/index.html" | sort -u); do
  [ -f "$OUT/$f" ] || { echo "MISSING: $f" >&2; missing=1; }
done
[ -f "$OUT/manifest.json" ] || { echo "MISSING: manifest.json" >&2; missing=1; }
[ -f "$OUT/service-worker.js" ] || { echo "MISSING: service-worker.js" >&2; missing=1; }
# Every icon the manifest points at must exist, and the manifest itself must
# be referenced from the entry (otherwise nothing is installable).
for icon in $(grep -o '"icons/[^"]*\.png"' "$OUT/manifest.json" | tr -d '"'); do
  [ -f "$OUT/$icon" ] || { echo "MISSING: $icon" >&2; missing=1; }
done
grep -q 'rel="manifest"' "$OUT/index.html" || { echo "MISSING: manifest link in index.html" >&2; missing=1; }
[ "$missing" = 0 ] || { echo "build-web: incomplete output" >&2; exit 1; }

echo "build-web: $OUT/ ready ($(du -sh "$OUT" | cut -f1))"
