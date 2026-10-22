# cardwall (TreeNote)

**[中文](README.md)** · English | [中文](README.md)

<img src="docs/icon.png" width="92" align="right" alt="cardwall icon">

> TreeNote — the next shape of outline notes: your points arrange themselves into a hierarchy.

A force-directed **tidy-tree card wall** for notes. Break a thought into cards; the parent/child relationships can lay themselves out as a clean, layered tree diagram — same-depth nodes share a level, parents centred over their children. Drag any node anywhere and it stays there; press **one-click tidy** to snap the whole wall back into the standard tree.

Name as many boards as you like and open any of them from the home screen.

![settled](docs/settled.png)

## Home: named boards

Press `H`, or open the top-right `?` **Guidance** panel and hit **Home**. Name a board as you create it, switch whenever you want; deleted boards go to the system trash, so a misclick is undoable.

![home](docs/home.png)

## Download

[GitHub Releases](https://github.com/Franky100-pig/TreeNote/releases/latest) ships a macOS (arm64) dmg. It isn't code-signed, so the first launch needs **right-click → Open**, or run `xattr -dr com.apple.quarantine /Applications/cardwall.app`.

## Controls

| Action | Gesture |
|---|---|
| **Guidance** | Click the `?` at the top-right: a floating **Guidance** panel dims and **blurs + locks** the board behind it, listing every gesture and offering **Home / New board / Toggle theme**. `Esc` or ✕ closes it |
| Home / open another board | `H`, or hit **Home** inside Guidance; click any card to open |
| Rename the current board | Click the board name in Guidance's "Current board" section (or "rename" on a home card) |
| Edit a card | Hover it → click ✎ on the action bar, **or just double-click** (Escape cancels, Enter commits) |
| **New child node** | Hover it → click ＋: a child card fans out **below-right** of this card (never on top of the parent) and opens straight into edit mode |
| Delete a card | Hover it → click ✕ (or select and press Delete / Backspace) |
| New card | Double-click empty canvas (attaches to the nearest card within 320px, otherwise it becomes a root) |
| Re-parent | Drop a card onto another one (dropping onto your own descendant is blocked, to avoid cycles) |
| **One-click tidy** | Click the "一键整洁" button or press `T`: re-flow the **whole wall into the standard tree**. The button dips on press and shows "整理中…" while it works |
| **Free drag** | Drag any node where you like — it **stays where you drop it** (no snap-back) and the wall becomes free-placed; while dragging, the node and its subtree follow the cursor, everything else holds |
| Pan / zoom | Drag empty canvas / scroll wheel (anchored at the cursor, 0.2–2.5) |
| Debug overlay | `F3` or `Cmd+Shift+D`: fps, card count, sim time, scale, peak speed, mechanical energy, tree target, velocity vectors |
| Toggle theme | `Cmd/Ctrl+Shift+L`: black canvas ⇄ paper-light; the choice is remembered |

The **Guidance** panel floats above the canvas while blurring and locking the board behind it:

![guidance](docs/guidance.png)

Hovering a card floats an action bar out of its top-right corner (✎ / ＋ / ✕) and temporarily **freezes** that card (it stops being integrated) so the bar can't slide away while you float around and your click can't miss. Editing pauses the physics world; committing resumes it.

## Physics: tidy tree, not rope

Every card has a **deterministic tree target** (tidy-tree / Reingold–Tilford style, leaf-packing):

- **Same level, same row**: nodes at the same depth share a horizontal line (parent above, child below, `levelGap` apart)
- **Parent centred over children**: a parent sits at the midpoint of its outermost children
- **No subtree overlap**: leaves are packed left-to-right along a shared cursor at `nodeGap` spacing

But the spring is **off by default**: since v0.6 the wall starts in **free placement** — every card sits where you left it and nothing tugs on its neighbour, and a drop never snaps back. The spring only engages when you press **one-click tidy** (or when you first open a board), easing the whole wall into the standard tree.

When engaged, every card is pulled to its target by a **critically damped spring** (`k = 40`, critical damping `2√k ≈ 12.6`) — it eases onto the target in ~0.6 s with no overshoot, and **never translates a whole branch rigidly**: each card arrives on its own depending on its distance, and the whole tree just resolves into one clean diagram.

The layout is **deterministic**: the same structure always packs into the same diagram — no randomness. At rest in tidy mode the wall is one tidy tree; at rest in free mode each card is frozen in place, untugged.

### Free drag feels

- **Drag any node**: it stays exactly where you drop it, and the wall becomes free-placed — no snap-back to the tree, no rigid translation of the whole board.
- **Drag carries the subtree**: in either mode, the card you grab brings its **whole subtree** along, following the cursor; everything else stays put and is not tugged.
- **Dragging a root while tidy**: if the board is currently tidy (just opened or just tidied), dragging the root re-anchors the whole tree on the root in your hand; dragging a child makes its subtree follow while the rest only **leans `childLean = 0.12`** toward the hand (the root moves only ~12%). The moment you let go, the wall switches back to free mode.

**Where does it stop?** The card you dragged **stays where you let go**, and so does everything else — the wall is now free-placed and no longer auto-arranges. To re-flow the whole wall into the standard tree, press **one-click tidy** (button or `T`).

### Key parameters (`CONFIG` in `renderer/physics.js`)

| Parameter | Value | Meaning |
|---|---|---|
| `dt` / `k` / `maxSpeed` | 1/60 s / 40 / 3000 | Fixed step, spring stiffness toward the tree target, speed clamp |
| `nodeGap` / `levelGap` / `rootGap` | 300 / 220 / 360 px | Leaf spacing / vertical level spacing / gap between separate root trees |
| `childLean` | 0.12 | Fraction the rest of the tree leans toward the hand when a child is dragged (root moves ~12%) |
| `repulsion` / `repulsionCutoff` | 22000 / 520 px | Soft anti-overlap guard, applied **only while dragging** (`a = repulsion / d`) |
| `wakeRadius` / `wakeStrength` | 520 / 0.4 | Drag wake: the moving card pushes neighbours aside by distance |
| `driftImpulse` / `driftChance` | 3 px/s / 0.0002 | A very faint, reproducible Brownian "breath" at rest (occasionally wakes a card for one ripple) |
| `sleepSpeed` / `sleepForce` / `sleepSteps` | 0.6 px/s / 30 px/s² / 60 steps | Sleep criteria: slow enough, weak enough net force, for long enough → stop integrating |

In tidy mode a card sits exactly on its tree target (the spring is zero and no other force acts), so the wall is a **fixed picture**, not a pile of cards that jitters forever; and because repulsion only acts during a drag, a quiet card's net force falls below the sleep threshold and it truly goes to sleep. In free mode the same holds — cards simply hold where you left them, untugged.

### The top bar keeps just two buttons

Since v0.7 the top bar does less on purpose: only **one-click tidy** and a `?` (**Guidance**) at the far right. Home, the board name, the hint text and the theme toggle all moved into the **Guidance** panel — pressing `?` floats it above the canvas, **blurs and locks the board behind it**, and only `Esc` / ✕ / an in-panel action dismisses it. The canvas stays clean and the main action stays one click away.

**Every node belongs to the tree**: there is no "pin" exception anymore, so one-click tidy re-flows every card; in free mode each card simply holds where you left it.

### Layouts settle down

Auto-layout is deterministic, not a random initial guess. Quiet cards **fall asleep** after 60 quiet steps: integration stops and the position freezes bit for bit, until some force genuinely exceeds the threshold and wakes it. So a settled layout is a fixed wall, not a pile of cards that jitters forever. Drift is only an occasional wake-up that lets one card float once — a ripple, not a continuous tremble.

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
npm test           # physics unit tests (14)
npm run smoke      # eleven-layer self-check: render / camera / debug / theme / interaction / editor / toolbar / guidance / persist / home / load
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
main.js                 Electron main process: window, library IPC, atomic vault writes, eleven-layer smoke assertions
preload.js              contextBridge: listBoards / createBoard / openBoard / saveBoard / renameBoard / deleteBoard
index.html styles.css    Shell, theme tokens, card / edge / debug-panel styles
renderer/theme-boot.js  Applies the saved theme on the first frame (no light-mode flash)
renderer/physics.js     Tidy-tree layout + critically damped spring integrator (UMD, shared by Node tests and the browser)
renderer/app.js         World container, edge geometry, fixed-step loop, camera, editing, persistence wiring
renderer/interaction.js Pan / cursor-anchored zoom / dragging / re-parenting
renderer/debug.js       F3 overlay
renderer/sample.js      The sample tree shown on first launch
build/icon.svg          Icon source; build/icon.icns is rasterised from it
test/physics.test.mjs   14 unit tests
```

Every colour comes from the semantic tokens at the top of `styles.css` (`--bg` / `--surface` / `--ink` / `--edge` …), so one token block *is* a theme: `:root` is the default dark (pure black canvas) and `[data-theme="light"]` overrides the same tokens for the paper-light look. To add a third theme, copy a token block and teach `applyTheme` one more name — no component styles need to change.

## License

MIT
