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
   renderer/app.js \
   renderer/theme-boot.js \
   "$OUT/renderer/"

# Web-only touches that must NOT leak into the Electron build:
#  - a favicon (the packaged app has its own .icns)
#  - .nojekyll so Pages serves the files verbatim
cp build/icon.svg "$OUT/favicon.svg"
node -e '
const fs = require("fs");
const p = "web/index.html";
let html = fs.readFileSync(p, "utf8");
const css = "<link rel=\"stylesheet\" href=\"styles.css\">";
if (!html.includes(css)) { console.error("build-web: styles.css link not found"); process.exit(1); }
html = html.replace(css,
  "<link rel=\"icon\" href=\"favicon.svg\" type=\"image/svg+xml\">\n  " + css);
fs.writeFileSync(p, html);
'
touch "$OUT/.nojekyll"

# Fail loudly if the entry references anything we did not copy.
missing=0
for f in $(grep -o 'renderer/[a-z-]*\.js' "$OUT/index.html" | sort -u); do
  [ -f "$OUT/$f" ] || { echo "MISSING: $f" >&2; missing=1; }
done
[ "$missing" = 0 ] || { echo "build-web: incomplete output" >&2; exit 1; }

echo "build-web: $OUT/ ready ($(du -sh "$OUT" | cut -f1))"
