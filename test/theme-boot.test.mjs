// Unit tests for the first-paint theme resolution (renderer/theme-boot.js).
//
// theme-boot.js is a parser-blocking IIFE in <head>: it runs BEFORE the
// renderer and decides what the canvas looks like on frame one. It is not a
// module (no exports — the CSP forbids inline scripts, hence a file of its
// own), so the test harness evaluates the source in a controlled scope with
// stubbed window / document / localStorage.
//
// The contract under test:
//   - stored value is whitelisted to exactly dark | light | auto
//   - 'auto' resolves through prefers-color-scheme (matchMedia)
//   - the WEB edition never reads storage and always starts dark
//   - anything unexpected (junk value, missing key, storage throwing,
//     no matchMedia at all) degrades to the dark default — never a crash
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(here, '..', 'renderer', 'theme-boot.js'), 'utf8');

// Runs theme-boot.js against a stubbed environment and reports what the
// first frame looks like. `dataset.theme` is undefined for the dark canvas
// (the app deletes the attribute rather than setting 'dark').
function boot(opts = {}) {
  const dataset = {};
  const reads = [];
  const localStorage = {
    getItem(key) {
      reads.push(key);
      if (opts.storageThrows) throw new Error('storage blocked');
      return Object.prototype.hasOwnProperty.call(opts, 'stored') ? opts.stored : null;
    }
  };
  const win = {
    cardwall: opts.bridge,
    matchMedia: opts.noMatchMedia
      ? undefined
      : (query) => ({ media: query, matches: opts.prefersLight === true })
  };
  const doc = { documentElement: { dataset } };
  // The IIFE resolves window / document / localStorage from this scope.
  const run = new Function('window', 'document', 'localStorage', SRC);
  run(win, doc, localStorage);
  return { theme: dataset.theme, reads };
}

test('theme-boot: a stored light theme is applied on the first frame', () => {
  const r = boot({ stored: 'light' });
  assert.equal(r.theme, 'light');
  assert.deepEqual(r.reads, ['cardwall.theme'], 'reads the theme key');
});

test('theme-boot: a stored dark theme leaves the canvas black', () => {
  const r = boot({ stored: 'dark' });
  assert.equal(r.theme, undefined, 'the dark theme is the absent attribute');
});

test('theme-boot: auto resolves through the OS preference', () => {
  assert.equal(boot({ stored: 'auto', prefersLight: true }).theme, 'light');
  assert.equal(boot({ stored: 'auto', prefersLight: false }).theme, undefined);
});

test('theme-boot: auto without matchMedia degrades to dark', () => {
  const r = boot({ stored: 'auto', noMatchMedia: true });
  assert.equal(r.theme, undefined);
});

test('theme-boot: junk stored values never reach the canvas', () => {
  // Whitelist is strict: no case folding, no trimming, no coercion.
  for (const junk of ['', ' ', 'light ', ' light', 'Light', 'LIGHT', 'auto ', 'Auto',
    'blue', 'null', 'undefined', '0', '1', 'true', 'dark;light']) {
    const r = boot({ stored: junk });
    assert.equal(r.theme, undefined, `stored ${JSON.stringify(junk)} -> dark`);
  }
});

test('theme-boot: a missing key starts on dark', () => {
  const r = boot({});
  assert.equal(r.theme, undefined);
  assert.deepEqual(r.reads, ['cardwall.theme']);
});

test('theme-boot: storage that throws degrades to dark', () => {
  const r = boot({ storageThrows: true });
  assert.equal(r.theme, undefined);
});

test('theme-boot: the web edition never reads storage and always starts dark', () => {
  const r = boot({ bridge: { platform: 'web' }, stored: 'light' });
  assert.equal(r.theme, undefined, 'the browser ignores the stored theme');
  assert.deepEqual(r.reads, [], 'and never touches storage at all');
});

test('theme-boot: the desktop bridge (any OS platform) does read storage', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const r = boot({ bridge: { platform }, stored: 'light' });
    assert.equal(r.theme, 'light', `${platform} honours the stored theme`);
  }
});

test('theme-boot: the stored mode itself is preserved for the renderer', () => {
  // theme-boot only decides the FIRST frame; the renderer owns the mode from
  // then on. The stored value must therefore stay one of the three modes —
  // auto must not be rewritten to the resolved theme.
  const r = boot({ stored: 'auto', prefersLight: true });
  assert.equal(r.theme, 'light', 'resolves for the first frame');
  // The stubbed storage is untouched by the script beyond the read.
  assert.deepEqual(r.reads, ['cardwall.theme'], 'no write-back');
});
