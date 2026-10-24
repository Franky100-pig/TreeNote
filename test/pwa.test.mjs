// PWA asset contract. These run against the SOURCES (pwa/, index.html) so they
// pass without a build:web run; the build script re-verifies the output.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

test('manifest: installable shape', () => {
  const m = JSON.parse(read('pwa/manifest.json'));
  assert.ok(m.name && m.short_name, 'name + short_name');
  assert.equal(m.display, 'standalone');
  assert.ok(m.background_color && m.theme_color, 'colors for the splash');
  // Relative URLs so the same manifest works on GitHub Pages project paths,
  // any custom domain, and a plain local server.
  for (const key of ['start_url', 'scope']) {
    assert.ok(!/^https?:/.test(m[key]), `${key} must be relative`);
    assert.ok(m[key].startsWith('.'), `${key} must be explicitly relative`);
  }
});

test('manifest: icons cover launcher + adaptive + iOS sizes', () => {
  const m = JSON.parse(read('pwa/manifest.json'));
  const byPurpose = {};
  for (const icon of m.icons) {
    (byPurpose[icon.purpose] ||= []).push(icon);
    assert.ok(exists(path.join('pwa', icon.src)), `icon file exists: ${icon.src}`);
  }
  const sizes = (list) => (list || []).map((i) => i.sizes).sort();
  assert.deepEqual(sizes(byPurpose.any), ['192x192', '512x512']);
  assert.deepEqual(sizes(byPurpose.maskable), ['192x192', '512x512']);
  // iOS uses apple-touch-icon from the HTML head, not the manifest.
  assert.ok(exists('pwa/icons/apple-touch-icon-180.png'), 'apple touch icon exists');
});

test('service worker: hardening per the stale-SW playbook', () => {
  const sw = read('pwa/service-worker.js');
  assert.match(sw, /var CACHE = 'cardwall-v\d+'/, 'versioned cache key');
  assert.match(sw, /cache: 'reload'/, 'install fetches bypass the HTTP cache');
  assert.doesNotMatch(sw, /\.addAll\(/, 'never the addAll API (atomic + HTTP-cache seeding)');
  assert.match(sw, /skipWaiting/, 'new worker takes over immediately');
  assert.match(sw, /clients\.claim/, 'claim open clients on activate');
  assert.match(sw, /caches\.delete/, 'activate drops stale cache keys');
  assert.match(sw, /req\.mode === 'navigate'/, 'navigations get their own branch');
  assert.match(sw, /url\.origin !== self\.location\.origin/, 'cross-origin is never cached');
  // stale-while-revalidate: cached answer wins, fetch refreshes in background.
  assert.match(sw, /return cached \|\| fresh;/, 'static assets are cache-first');
});

test('service worker: ASSETS matches the files the app actually loads', () => {
  const sw = read('pwa/service-worker.js');
  const html = read('index.html');
  const referenced = [...html.matchAll(/(?:src|href)="(renderer\/[a-z-]+\.js|styles\.css)"/g)]
    .map((m) => m[1]);
  for (const ref of referenced) {
    assert.ok(sw.includes(`./${ref}`), `SW precaches ${ref}`);
  }
  for (const icon of JSON.parse(read('pwa/manifest.json')).icons) {
    assert.ok(sw.includes(`./${icon.src}`), `SW precaches ${icon.src}`);
  }
});

test('register script: web-only, CSP-safe', () => {
  const reg = read('renderer/pwa-register.js');
  assert.match(reg, /platform !== 'web'/, 'no-op under Electron');
  assert.match(reg, /'serviceWorker' in navigator/, 'feature guard');
  assert.match(reg, /serviceWorker\.register/, 'registers the worker');
  assert.doesNotMatch(reg, /<script/i, 'external file — CSP bans inline');
});

test('index.html: register script in source, PWA links injected at build time', () => {
  const html = read('index.html');
  // The register script is harmless under Electron (platform guard), so it
  // ships in the shared source.
  assert.match(html, /<script src="renderer\/pwa-register\.js"><\/script>/);
  // The manifest / apple-touch-icon links are WEB-ONLY (the repo root has no
  // manifest) — they must not sit in the shared source, or the desktop build
  // fetches 404s. build-web.sh injects them, exactly like the favicon.
  assert.doesNotMatch(html, /<link rel="manifest"/, 'no manifest link in shared source');
  assert.doesNotMatch(html, /<link rel="apple-touch-icon"/, 'no touch-icon link in shared source');
  // iOS standalone behaviour was already in place; keep it honest.
  assert.match(html, /apple-mobile-web-app-capable/);

  const build = read('scripts/build-web.sh');
  assert.match(build, /rel=\\"manifest\\" href=\\"manifest\.json\\"/, 'build injects the manifest link');
  assert.match(build, /apple-touch-icon-180\.png/, 'build injects the touch icon');
});

test('web/ output: PWA links present in the built entry', () => {
  // web/ is a committed artifact; if it is stale this catches it.
  const html = read('web/index.html');
  assert.match(html, /<link rel="manifest" href="manifest\.json">/);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon-180\.png">/);
  assert.match(html, /<script src="renderer\/pwa-register\.js"><\/script>/);
});
