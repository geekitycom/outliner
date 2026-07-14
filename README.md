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

```bash
npm install
npm run dev        # demo dev server at http://localhost:5174
npm run build      # build the library into dist/ (ESM + global + types + css)
npm run preview    # build the demo and serve it over http
npm run typecheck  # tsc --noEmit
```

## Distribution

`npm run build` produces a library in `dist/`, in two formats plus types and CSS:

| File | Format | Use |
| --- | --- | --- |
| `dist/outliner.js` | **ESM** (the default) | `import` from bundlers / modern apps |
| `dist/outliner.global.js` | **IIFE global** | plain `<script>` drop-in — exposes `window.Outliner` |
| `dist/outliner.compat.global.js` | **IIFE, legacy globals** | migrating an old Concord app — see below |
| `dist/outliner.css` | stylesheet | `<link>` it alongside either build |
| `dist/*.d.ts` | TypeScript types | editor/tooling support |

ESM is the modern default (`import { createOutliner } from '@local/outliner'`). The
global build is the opt-in, no-build-tool option — the way classic Concord was
included on a page. It exposes a single namespaced global rather than dozens of
loose functions:

```html
<link rel="stylesheet" href="outliner.css" />
<script src="outliner.global.js"></script>
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

### Migrating an old Concord app

`dist/outliner.compat.global.js` is the maximum-compatibility drop-in: it defines
`window.Outliner` *and* reproduces the classic `concordutils.js` global surface —
the bare `op*` functions, the `up`/`down`/`left`/`right` direction globals,
`initialOpmltext`, `appTypeIcons`, and the string helpers — so code written against
old Concord keeps working. Register your instance once, then call the old functions:

```html
<link rel="stylesheet" href="outliner.css" />
<script src="outliner.compat.global.js"></script>
<div id="outliner"></div>
<script>
  const o = Outliner.createOutliner(document.getElementById('outliner'))
  setDefaultOutliner(o)          // the op* helpers act on this instance
  opXmlToOutline(initialOpmltext)
  opExpand()                     // exactly as the old app called it
</script>
```

The only change from a classic Concord page is registering the instance with
`setDefaultOutliner(o)` in place of the old jQuery `$("#outliner").concord(...)`.
Use the plain `outliner.global.js` instead if you don't need the loose globals.

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
    insert: (node) => node.attributes.set('created', new Date().toUTCString()),
    expand: (node) => { /* e.g. lazy-load an include node */ },
  },
})

outliner.loadOpml(opmlString)          // OPML -> outline
outliner.expand(); outliner.collapse()
outliner.reorg(RIGHT)                   // demote the cursor headline
outliner.promote(); outliner.demote()
outliner.bold(); outliner.italic(); outliner.link('https://example.com')
outliner.toggleComment()
outliner.undo()
const opml = outliner.toOpml()          // outline -> OPML

// per-headline via the cursor handle:
outliner.cursor.attributes.set('type', 'rss')
outliner.cursor.getLineText()
```

The full command set the original example apps exercised is present:
expand/collapse (and all-levels/everything), move up/down/left/right, promote/demote,
insert/insertText/insertImage, bold/italic/strikethrough/link, comments,
render-mode toggle, undo, cut/copy/paste, OPML import/export, attributes, headers,
title, `visitAll`/`visitToSummit`, and remote `open`/`save` (now `fetch`-based).

## Upgrading from old Concord (`src/utils.ts`)

`src/utils.ts` is an **optional** compatibility layer — the modern equivalent of
`concordutils.js`, minus the jQuery. Old Concord apps drove a single `#outliner`
through global `op*` functions (`opExpand()`, `opReorg(dir, count)`,
`opOutlineToXml()`, …). Register your instance once and those same calls keep
working, each translated to the new `Outliner` API:

```ts
import { createOutliner } from './src'
import { setDefaultOutliner, opXmlToOutline, opExpand, opReorg, initialOpmltext } from './src/utils'

const outliner = createOutliner(document.getElementById('outliner')!)
setDefaultOutliner(outliner)

opXmlToOutline(initialOpmltext)   // start blank
opExpand()
opReorg('right', 1)               // same string directions as before
```

It also re-exports `appTypeIcons`, `initialOpmltext`, the lowercase direction
constants (`up`/`down`/`left`/`right`/…), and the string helpers
(`filledString`, `multipleReplaceAll`, `secondsSince`). `readText` is included
but now hits URLs directly (the old scripting.com proxy is gone), so it needs a
CORS-enabled endpoint. The layer is intentionally left out of the core `index.ts`
so it stays opt-in.

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

Run it over http (`npm run dev` / `npm run preview`); opening the HTML from `file://`
won't work because Chrome blocks ES-module scripts on `file://`.
