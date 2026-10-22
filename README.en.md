# cardwall (TreeNote)

**[中文](README.md)** · English | [中文](README.md)

<img src="docs/icon.png" width="92" align="right" alt="cardwall icon">

> The next version of taking digital notes — but your notes should be able to float.

A force-directed **floating card wall** for notes. Break a thought into cards, drag them wherever you like, and leave them there. Every card you haven't touched is tied to a **fixed-length rope**, so it drifts when you pull on a neighbour and settles the moment you let go.

Name as many boards as you like and open any of them from the home screen.

![settled](docs/settled.png)

## Home: named boards

Press `H` or the `←` in the top-left to go home. Name a board as you create it, switch whenever you want; deleted boards go to the system trash, so a misclick is undoable.

![home](docs/home.png)

## Download

[GitHub Releases](https://github.com/Franky100-pig/TreeNote/releases/latest) ships a macOS (arm64) dmg. It isn't code-signed, so the first launch needs **right-click → Open**, or run `xattr -dr com.apple.quarantine /Applications/cardwall.app`.

## Controls

| Action | Gesture |
|---|---|
| Home / open another board | `H` or the `←` in the top-left; click any card to open |
| Rename the current board | Click the board name in the toolbar (or "rename" on a home card) |
| Edit a card | Hover it → click ✎ on the action bar, **or just double-click** (Escape cancels, Enter commits) |
| New child node | Hover it → click ＋ (the new card spawns to its right and enters edit mode) |
| Delete a card | Hover it → click ✕ (or select and press Delete / Backspace) |
| New card | Double-click empty canvas (attaches to the nearest card within 320px, otherwise it becomes a root) |
| Re-parent | Drop a card onto another one (dropping onto your own descendant is blocked, to avoid cycles) |
| Free dragging | Drag a card anywhere. The card in your hand follows the pointer, **it and its whole subtree are tugged along by the ropes**, and neighbours drift away in the wake by distance. On release it goes back to the force field, and the rope pulls it to its own length |
| Pin / unpin | Select a card and press `P`: pinned means completely still (subtree included), unpinned hands it back to the force field (works even with the pointer still on the card) |
| Pan / zoom | Drag empty canvas / scroll wheel (anchored at the cursor, 0.2–2.5) |
| Debug overlay | `F3` or `Cmd+Shift+D`: fps, card count, sim time, scale, peak speed, mechanical energy, anchors, velocity vectors |
| Toggle theme | `Cmd/Ctrl+Shift+L`: black canvas ⇄ paper-light; the choice is remembered |

Hovering a card floats an action bar out of its top-right corner (✎ / ＋ / ✕) and temporarily **freezes** that card (it stops being integrated) so the bar can't slide away while you float around and your click can't miss. Editing pauses the physics world; committing resumes it.

## Physics: ropes, not springs

Every card is tied by a **fixed-length rope** — root cards to the world origin, child cards to their parent. The rope constrains distance only, never angle, which means:

- Children can **swing** around their parent, and a dragged parent **tugs** them along instead of translating the whole branch rigidly
- The rope **pulls but never pushes** (it goes slack when you move closer), so there's none of the springy bounce
- Resistance splits in two: critical damping along the rope (no rebound) plus a little tangential damping, like a wet rope

One piece of physics can't be argued with: **a free angle means no restoring force** (tangential stiffness is only `F/r`, about 0.6 at 400px), so a whole wall slowly rotates around its anchors. Hence a very weak layer of **angle memory** (`anchorStiffness` 30, half as stiff as the rope itself): while you drag you still see the swing, and on release it slowly pulls the direction back toward where it came from.

Measured on a 6-card tree dragged 400px: **visually still after 1.9–3.3 s, fully asleep after 3.3–5.1 s**, then zero creep (< 0.1px / 5s). Set `anchorStiffness` to 0 for a pure free-swinging rope — prettier, but the wall takes half a minute to stop.

### Key parameters (`CONFIG` in `renderer/physics.js`)

| Parameter | Value | Meaning |
|---|---|---|
| `dt` / `damping` / `maxSpeed` | 1/60 s / 0.93 / 3000 | Fixed step, per-step damping (bleeds the swing away), speed clamp |
| `repulsion` / `repulsionCutoff` | 90000 / 800px | `a = repulsion / d`, centre-distance repulsion (water-like, not springy) |
| `childRopeLength` | 200px | Rope length: roots to the world origin, children to their parent. Distance locked, angle free |
| `ropeStiffness` | 60 | Rope tension stiffness. Children are pulled but never pushed; roots are moored both ways, otherwise the whole wall drifts off |
| `ropeDampRatio` | 1.0 | **Radial** damping ratio (critical): the velocity component along the rope is eaten, so nothing bounces back |
| `swingDamp` | 0.4 | **Tangential** damping: 0 = longest swing, 1 = swing and settle are equally damped |
| `anchorStiffness` | 30 | Angle memory: tugs the card a little toward its nominal direction. 0 = pure free swing |
| `wakeRadius` / `wakeStrength` | 520px / 1.5 | Drag wake: the card in your hand pushes neighbours away by distance. Push-only, so it can't self-excite |
| `ringBaseRadius` / `ringSpacing` | 220 / 60 | Root ring radius (also the root rope length), increment per extra card on a level |
| `driftImpulse` / `driftChance` | 14 px/s / 0.0009 | Occasional drift (seeded, reproducible; roughly every 18 s, and it doubles as a wake-up) |
| `sleepSpeed` / `sleepForce` / `sleepSteps` | 0.6 px/s / 30 px/s² / 60 steps | Sleep criteria: slow enough, weak enough net force, for long enough → stop integrating |

The resting distance isn't the rope length: repulsion pushes the equilibrium outward, and a lone child's analytic balance is `K·(d−L) = repulsion/d` (K = `ropeStiffness + anchorStiffness`) — the unit tests use that closed form as a regression. A card with `childRopeLength` 200px actually stops around 197px, which is repulsion pushing the equilibrium out. Not a bug.

### Pinning is protection, not a shackle

`pinned` means "you have not touched this card yet, so leave it where it is". It
opts the card out of **every** force — including the rope — so a pinned card
neither drifts nor gets towed when its parent is dragged.

- A **newly created card** is pinned: you just put it there, so it should stay
- The moment you **drag a card**, it **and its whole subtree** are unpinned,
  permanently. You have taken it into the physics, so it belongs to the float
  now, and dragging its parent can tow it along
- **`P`** is the manual override, in either direction. Unpinning releases the
  subtree too: a card that rejoins the float while its children stay pinned is
  still a card that cannot be dragged around by its parent

That is the answer to "can one node carry the others": yes, as long as that
card is not pinned.

### Layouts settle down

Auto-layout is only a **first guess**. Unpinned cards **fall asleep** after 60 quiet steps: integration stops and the position freezes bit for bit, until some force genuinely exceeds the threshold and wakes it. So a settled layout is a fixed wall, not a pile of cards that jitters forever. Drift drops to roughly once every 18 s per card — just enough to wake one card and let it float once. A ripple, not a continuous tremble.

## Where your data lives

- Default path: `~/Library/Application Support/cardwall/vault/boards/<id>.json` (macOS), one file per board
- The library has **no index file**: the directory *is* the index, and every file carries its own `name`
- Writes are atomic: write `.tmp` first, then rename; the previous version is kept as `.bak`
- Renaming only edits the `name` inside the file (no file move, no id change), so the open board never loses its reference
- Deletes go to the system trash (`shell.trashItem`), so they're recoverable
- A 0.3-era single `vault/board.json` is migrated automatically into a board named 我的第一幅图 ("my first board") — upgrading never loses your wall
- The main process sanitises every board it reads: unknown fields dropped, overlong text truncated, duplicate ids and dangling / self-referencing parents rejected
- `CARDWALL_VAULT_DIR=/tmp/xxx` overrides the location for debugging

## Development

```bash
npm install
npm start          # normal launch
npm test           # physics unit tests (15)
npm run smoke      # nine-layer self-check: render / camera / debug / theme / interaction / editor / toolbar / persist / home / load
npm run dist       # package the macOS dmg → dist/cardwall-<version>-arm64.dmg
```

`npm run smoke` opens a hidden window, drives the real listeners with synthetic events, and only exits 0 if every layer passes.

Behind a mainland-China network, build with mirrors (a direct electron zip download otherwise times out):

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/" \
npm run dist
```

### Layout of the code

```
main.js                 Electron main process: window, library IPC, atomic vault writes, nine-layer smoke assertions
preload.js              contextBridge: listBoards / createBoard / openBoard / saveBoard / renameBoard / deleteBoard
index.html styles.css    Shell, theme tokens, card / edge / debug-panel styles
renderer/theme-boot.js  Applies the saved theme on the first frame (no light-mode flash)
renderer/physics.js     Force-directed integrator (UMD, shared by Node tests and the browser)
renderer/app.js         World container, edge geometry, fixed-step loop, camera, editing, persistence wiring
renderer/interaction.js Pan / cursor-anchored zoom / dragging / re-parenting
renderer/debug.js       F3 overlay
renderer/sample.js      The sample tree shown on first launch
build/icon.svg          Icon source; build/icon.icns is rasterised from it
test/physics.test.mjs   15 unit tests
```

Every colour comes from the semantic tokens at the top of `styles.css` (`--bg` / `--surface` / `--ink` / `--edge` …), so one token block *is* a theme: `:root` is the default dark (pure black canvas) and `[data-theme="light"]` overrides the same tokens for the paper-light look. To add a third theme, copy a token block and teach `applyTheme` one more name — no component styles need to change.

## License

MIT
