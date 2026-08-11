# Outliner

A **TypeScript port of [Concord](https://github.com/scripting/concord)** — a keyboard-driven
outliner (the editor at the core of Little Outliner and Fargo) whose native file format is
[OPML](http://opml.org/).

> Concord is a JavaScript outliner written by Kyle Shank in 2013, maintained by Dave Winer
> since, GPL-licensed.

All credit for the original outliner goes to Kyle Shank and Dave Winer; this project is a
dependency-modernizing port of their work. This port keeps Concord's behavior but replaces
its dependencies:

| Original | Outliner |
| --- | --- |
| jQuery 1.9.1 | none — native DOM + a small `dom.ts` helper layer |
| Bootstrap | none — the demo uses plain CSS |
| Font Awesome | inline SVG icons, applied as CSS masks (`src/icons.ts`) |
| `$.fn.concord` plugin, `op`/`editor`/`script` objects | a typed `Outliner` class with a clean method API |
| loose JS | strict TypeScript, Vite build |

GPL-3.0, same as the upstream project. See `LICENSE.txt`.

## Run it

This package lives in a pnpm workspace; run `pnpm install` once at the repo root, then
run these from `packages/outliner/` (or from the root with
`pnpm --filter @andrewshell/outliner <script>`):

```bash
pnpm dev        # demo dev server at http://localhost:5174
pnpm build      # build the library into dist/ (ESM + global + types + css)
pnpm preview    # build the demo and serve it over http
pnpm typecheck  # tsc --noEmit
pnpm test       # run the Vitest suite (jsdom)
pnpm test:watch # Vitest watch mode
pnpm test:e2e   # run the Playwright suite (chromium; installs once)
```

## Tests

Two tiers:

- **Unit/integration — Vitest + jsdom** (`test/`, `pnpm test`): the structural,
  browser-independent logic where the risk lives — OPML round-trip, the structural
  operations (insert / reorg / promote / demote / expand-collapse / delete), `undo`,
  the `insertText` multi-line parser, attributes (including that `data-opml` survives
  `cloneNode`), and `getKeystroke` command mapping.
- **E2E — Playwright + Chromium** (`e2e/`, `pnpm test:e2e`): the browser-only
  behaviors jsdom can't — real editing (type / Return / Tab), `execCommand`
  formatting, readonly, and the **Concord compat drop-in** (jQuery `$().concord()`
  plugin + `op*` globals, via a self-contained fixture). Requires
  `pnpm exec playwright install chromium` once.

CI (`.github/workflows/ci.yml`) runs both (lint, typecheck, unit tests, build in one
job; the Playwright suite in another). The `pre-push` hook runs the fast unit suite;
E2E is left to CI.

## Distribution

`pnpm build` produces a library in `dist/`, in two formats plus types and CSS:

| File | Format | Use |
| --- | --- | --- |
| `dist/outliner.js` | **ESM** (the default) | `import` from bundlers / modern apps |
| `dist/outliner.global.js` | **IIFE global** | plain `<script>` drop-in — exposes `window.Outliner` |
| `dist/outliner.compat.global.js` | **IIFE, legacy globals** | migrating an old Concord app — see below |
| `dist/outliner.css` | stylesheet | `<link>` it alongside either build |
| `dist/*.d.ts` | TypeScript types | editor/tooling support |

> **Publish with pnpm, not npm.** In the repo, `exports` points at `src/` so other
> workspace packages (the desktop app) compile the library from source and get HMR.
> `publishConfig.exports` rewrites those entries to `dist/` in the tarball — but that
> rewrite is a pnpm feature, applied by `pnpm publish` / `pnpm pack` only. Running
> `npm publish` here would ship a package whose `exports` point at `src/`.

### Install

```bash
npm install @andrewshell/outliner
```

```ts
import { createOutliner } from '@andrewshell/outliner'
import '@andrewshell/outliner/styles.css'
```

Published to npm, so it's also on the CDNs that mirror npm — no build step:

```
https://cdn.jsdelivr.net/npm/@andrewshell/outliner/dist/outliner.global.js
https://unpkg.com/@andrewshell/outliner/dist/outliner.global.js
https://esm.sh/@andrewshell/outliner                                  # ESM in the browser
```

ESM is the modern default. The global build is the opt-in, no-build-tool option —
the way classic Concord was included on a page. It exposes a single namespaced
global rather than dozens of loose functions:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@andrewshell/outliner/dist/outliner.css" />
<script src="https://cdn.jsdelivr.net/npm/@andrewshell/outliner/dist/outliner.global.js"></script>
<div id="outliner"></div>
<script>
  const o = Outliner.createOutliner(document.getElementById('outliner'), {
    prefs: { typeIcons: Outliner.appTypeIcons },
  })
  o.loadOpml(Outliner.EMPTY_OPML)
  o.expand()
</script>
```

(Everything exported from `src/index.ts` — `createOutliner`, the `Outliner` class,
`EMPTY_OPML`, the direction constants, `appTypeIcons`, etc. — is a property of the
`Outliner` global.)

Migrating an old Concord app? See [Migrating from old Concord](#migrating-from-old-concord).

## Using the library

```ts
import { createOutliner, appTypeIcons, UP, DOWN, LEFT, RIGHT } from './src'
import './src/styles.css'

const outliner = createOutliner(document.getElementById('outliner')!, {
  prefs: {
    outlineFont: 'Georgia, serif',
    outlineFontSize: 17,
    outlineLineHeight: 24,
    renderMode: true,
    typeIcons: appTypeIcons,
  },
  callbacks: {
    opInsert: (node) => node.attributes.setOne('created', new Date().toUTCString()),
    opExpand: (node) => { /* e.g. lazy-load an include node */ },
  },
})

outliner.loadOpml(opmlString)          // OPML -> outline
outliner.expand(); outliner.collapse()
outliner.expandToLevel(2)               // collapse everything, then reveal down to level 2
outliner.reorg(RIGHT)                   // demote the cursor headline
outliner.promote(); outliner.demote()
outliner.bold(); outliner.italic(); outliner.link('https://example.com')
outliner.toggleComment()
outliner.undo()
const opml = outliner.toOpml()          // outline -> OPML

// hoist ("zoom in" on a subtree, like MORE's Hoist/De-Hoist):
outliner.hoist()                        // focus the view on the cursor headline
outliner.isHoisted(); outliner.hoistDepth()
outliner.deHoist()                      // pop one level
outliner.deHoistAll()                   // back to the real root

// find / find-again (like Drummer's Find.../Find again):
outliner.find('budget')                 // case-insensitive, wraps by default
outliner.find('Budget', { matchCase: true, wrap: false })
outliner.findAgain()                    // repeat the last search from the cursor

// per-headline via the cursor handle (classic Concord attribute names):
outliner.cursor.attributes.setOne('type', 'rss')
outliner.cursor.getLineText()
```

The full command set the original example apps exercised is present:
expand/collapse (all-levels/everything/to-a-level), hoist/de-hoist,
move up/down/left/right, promote/demote,
insert/insertText/insertImage, bold/italic/strikethrough/link, comments,
render-mode toggle, undo, cut/copy/paste, OPML import/export, attributes, headers,
title, find/find-again, `visitAll`/`visitToSummit`, and remote `open`/`save`
(now `fetch`-based).

### Hoisting

`hoist()` focuses the view on the cursor headline, so its subs become the top
level — like zooming into a subtree. `deHoist()` pops one level; `deHoistAll()`
returns to the real root. Hoists nest, so this is a stack (`hoistDepth()` tells
you how deep). `hoist()` returns `false` when there's no cursor, or the cursor
has no subs to hoist into; `deHoist()`/`deHoistAll()` return `false` when not
currently hoisted.

Hoisting is purely a view operation on the live DOM (the displaced part of the
tree is stashed as detached elements, not round-tripped through OPML), so
in-place edits made while hoisted — and the collapsed/expanded state and
cursor position of the parts you can currently see — are preserved exactly
when you de-hoist. Critically, **`toOpml()`, `getTitle()`, and `getHeaders()`
always reflect the complete document, regardless of hoist state** — a `save()`
made while hoisted writes out the whole outline, not just the hoisted
subtree. `expandToLevel()` also nests correctly: it always operates on
whatever's currently at the top of the view (the real root, or the hoisted
node), the same as `expand()`/`collapse()` do.

### Head data

An OPML document's `<head>` — title plus whatever else was written there — is
one store: `getHeaders()`/`setHeaders()` read and write the same map
`getTitle()`/`setTitle()` are accessors over, so `title` is just another key
in it. There's no separate title field to fall out of sync with the map (that
used to be possible: `setHeaders({ title: ... })` could silently lose to a
`state.title` field `getHeaders()` always read from instead).

```ts
outliner.setTitle('Weekly Notes')       // same store as...
outliner.setHeaders({ owner: 'andrew' }) // ...this
outliner.getHeaders() // { title: 'Weekly Notes', owner: 'andrew' }
```

`setHeaders()` **merges** into the existing map (`Object.assign` semantics):
every key you pass overwrites the current value, and every key you don't
mention is left alone. This is deliberate — patching in one custom field
must not silently wipe out the title or any other field you didn't mention.
If you want replace-all semantics instead, spread a `getHeaders()` snapshot
together with your changes and pass that.

**Computed vs. authored.** `dateModified`, `expansionState`, and
`lastCursor` are generated fresh by `toOpml()` on every call — they're
implementation detail (a save timestamp, which nodes are expanded, where the
cursor was), not something a user authors. The full, extensible list lives
in one place, `COMPUTED_HEAD_FIELDS` (`src/constants.ts`). They're still
*consumed* on load — `expansionState` restores which headlines are expanded,
`lastCursor` restores the cursor position — but `loadOpml()` never copies
them into the authored map, so `getHeaders()` never reports them, including
after a save → load round trip. `setHeaders()` silently ignores an attempt
to set one of these names, for the same reason. Any other field, known or
not, round-trips through `<head>` untouched.

**Reacting to a head change.** `OutlinerCallbacks.opHeadChange(headers)`
(alongside `opInsert`/`opExpand`/`opReorg`/…, see `setCallbacks()`) fires
whenever authored head data changes — `setTitle()`, `setHeaders()`, or a
fresh `loadOpml()` — with the complete authored map, the same shape
`getHeaders()` returns. This is how the title row itself stays in sync: it
subscribes to the same notification internally rather than being called by
name from the model layer, so adding a second editable head field (an
"owner" row, say) needs no new plumbing in `op.ts` — its setter just needs
to update the map and let the existing notification fire.

### Title row

`prefs: { titleRow: true }` (default `false`) adds a row above the outline,
laid out like a headline but with a text-document icon instead of the usual
bullet. It shows — and lets you edit — whichever text answers "what am I
currently looking at":

- **At the document root**, that's the OPML title (`getTitle()`/`setTitle()`).
- **While hoisted**, that's the text of the headline you're hoisted *into* —
  which isn't visible anywhere else while hoisted, since only its children
  are shown. The row is the only way to read or fix it without de-hoisting
  first.

It's editable in both states: click it (or Tab into it) to start editing;
**Enter or blur commits, Esc cancels** and restores the previous text.
Committing at the root calls `setTitle()`; committing while hoisted renames
the hoisted headline in place (and marks the document changed, like any
other edit) — the rename survives `deHoist()`/`deHoistAll()`.

It is **deliberately outside the outline's cursor model** — arrow keys never
land on it, and it's never part of `toOpml()` output (enabling or disabling
it doesn't change a single byte of the serialized document). Toggle it any
time after construction with `outliner.prefs({ titleRow: true })`.

### Finding

`find(text, options?)` searches headline **text** (not markup — `<b>`/`<i>`/links
inside a headline don't get in the way, and don't get matched by tag name either)
starting *after* the current cursor, moving the cursor to the first match and
returning whether one was found. Matching is case-insensitive by default;
`{ matchCase: true }` makes it exact. `{ wrap: false }` stops at the end instead
of the default wrap-to-the-top behavior. `findAgain()` repeats the last search
(same text and options) from wherever the cursor is now — `false` if there was
no previous search, or nothing further matches.

Three behaviors worth knowing:

- **Search order is document order** — a top-to-bottom walk as the outline
  would read if fully expanded — reusing the same tree-walking helpers
  (`_walk_down`, `childNodes`) as `outlineToXml()`, not raw DOM sibling order.
- **A match inside a collapsed subtree is still found**, and finding one
  expands every collapsed ancestor needed to make it visible before moving the
  cursor there. Because expansion state is itself persisted in the OPML
  (`<head><expansionState>`), revealing a match this way marks the document
  changed — the same rule `expand()` follows. A search that matches nothing
  never marks the document changed, whether or not it wrapped.
- **Hoisting narrows what's searched.** Like `outlineToXml()`, `find()` walks
  from `root`; unlike `outlineToXml()`, it does *not* go through
  `withFullTree()` first. While hoisted, the displaced parts of the document
  are detached DOM (see Hoisting above) and simply unreachable from `root`, so
  `find()`/`findAgain()` only search the current hoisted view — consistent
  with the user having deliberately narrowed focus — and can never land the
  cursor on a detached node outside it.

## Migrating from old Concord

`src/compat.ts` (built into `dist/outliner.compat.global.js`) is an **optional**
compatibility layer — the modern equivalent of `concordutils.js`, minus the jQuery.
It's left out of the core `index.ts` so it stays opt-in. It reproduces the classic
surface so old code keeps working:

- the bare `op*` functions, the `up`/`down`/`left`/`right` direction globals,
  `initialOpmltext`, `appTypeIcons`, `defaultUtilsOutliner`, and the string helpers
  (`filledString`, `multipleReplaceAll`, `secondsSince`, `readText`);
- a **`$("#outliner").concord(options)` jQuery plugin** (installed if jQuery is
  present) — creation works as before, returning an instance with `.op`/`.editor`/`.script`;
- Concord's original names throughout — callbacks (`opInsert`, `opExpand`, `opHover`,
  …) and node/attribute methods (`attributes.getOne`/`setOne`/`exists`/…,
  `NodeRef.insertXml`) — so callback code works unchanged, no translation needed;
- `op*` calls before an explicit create auto-resolve/create the `#outliner` element,
  matching the original `defaultUtilsOutliner`.

**Drop-in, no build tools** — swap only the library tags; keep your jQuery/Bootstrap:

```html
<!-- was: jquery + bootstrap + fontawesome + concordutils.js + concordstyles.css + concord.js -->
<script src="jquery.min.js"></script>            <!-- keep your app's own jQuery/Bootstrap -->
<script src="outliner.compat.global.js"></script>
<link rel="stylesheet" href="outliner.css" />
<div id="outliner"></div>
<script>
  // unchanged classic Concord code:
  $("#outliner").concord({ prefs: { typeIcons: appTypeIcons } })
  opXmlToOutline(initialOpmltext)
  opExpand()
</script>
```

**With a bundler (ESM)** — import the helpers and register your instance:

```ts
import { createOutliner } from './src'
import { setDefaultOutliner, opXmlToOutline, opExpand, opReorg, initialOpmltext } from './src/compat'

const outliner = createOutliner(document.getElementById('outliner')!)
setDefaultOutliner(outliner)
opXmlToOutline(initialOpmltext)
opExpand()
opReorg('right', 1)               // same string directions as before
```

Verified by running Concord's own example0 and example1 against this build.
`readText` now hits URLs directly (the old scripting.com proxy is gone), so it needs
a CORS-enabled endpoint. Known minor gap: the `keystroke` callback receives the
modern `KeystrokeEvent` (`{ keystroke, captured, domEvent }`), not the raw jQuery
event, so old handlers reading `event.which` see `undefined` — use `event.domEvent.which`.

## Architecture

The internals mirror the original module boundaries so the translation stays
verifiable method-for-method; the public `Outliner` facade is the modern surface.

| File | Role |
| --- | --- |
| `outliner.ts` | public `Outliner` class + per-instance state |
| `op.ts` | operations (cursor movement, edit, reorg, OPML I/O, undo) — from `ConcordOp` |
| `editor.ts` | DOM build/serialize, selection, drag, paste — from `ConcordEditor` |
| `events.ts` | pointer/paste/drag wiring via native event delegation — from `ConcordEvents` |
| `keyboard.ts` | the global keydown command switch |
| `attributes.ts` / `noderef.ts` | per-node OPML attributes; the callback node handle |
| `script.ts` | comment nodes |
| `runtime.ts` / `globals.ts` | focus root, event gating, document listeners (the old `concord` singleton) |
| `dom.ts` / `icons.ts` / `util.ts` | jQuery-replacement helpers, SVG icon registry, string/keystroke utils |

### Notable porting decisions

- **`$.clone(true, true)`** (deep-clone *with data and events*) drove undo, drag,
  and copy/paste. Two changes replace it: (1) **event delegation** on the root, so
  cloned nodes need no handler copying; (2) per-node OPML attributes are serialized
  into a **`data-opml`** DOM attribute, so `cloneNode(true)` preserves them. Root-level
  state moved off jQuery `.data()` onto the instance, keyed back from the DOM through a
  `WeakMap` registry.
- **`document.execCommand`** (bold/italic/link/insertText) is kept. It's deprecated but
  universally supported; replacing it is a separate, behavior-risky effort.
- **Icons** are a single registry (`ICONS`) rendered as CSS `mask-image`s. A node's icon
  is just a `data-icon` attribute (clone-safe); comment and drag-target glyphs are CSS
  overrides, exactly as Font Awesome `content` glyphs worked before.
- **Remote `open`/`save`/`import`** were pointed at `concord.smallpicture.com` (long
  gone). The methods remain, now using `fetch`; you supply your own endpoints. The demo
  itself does no persistence — like the original example0, it just loads a sample outline
  on open.

## Status

Verified in-browser: OPML load, SVG icon rendering (caret + type icons + comment),
expand/collapse, click-to-edit, Return-to-insert, Tab reorg, undo, and callbacks all
work with no console errors. The original example1 (Bootstrap menubar) and example2
(reader) were intentionally not ported — only the outliner logic they called was.

Run it over http (`pnpm dev` / `pnpm preview`); opening the HTML from `file://`
won't work because Chrome blocks ES-module scripts on `file://`.
