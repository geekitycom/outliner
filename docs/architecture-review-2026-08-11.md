# Architecture review — 11 Aug 2026

Deepening opportunities found by walking the codebase against the deep-module
vocabulary: **module**, **interface**, **implementation**, **depth**, **seam**,
**adapter**, **leverage**, **locality**. Scoping followed the churn — six of the
seven commits before this review were fixes to one 211-line feature, each landing
in a different module.

Candidate 1 has been built. Candidates 2–6 have not; this file is why they exist,
so a future review doesn't have to rediscover them and doesn't re-suggest what was
deliberately ruled out.

> **Line numbers** were accurate at commit `b949fd9`. Those in `packages/outliner/src`
> have since shifted (candidate 1 rewrote much of that area). The `apps/desktop` and
> Rust references are untouched and should still be exact.

## Ground rules this review worked under

`apps/desktop/README.md`'s eleven **Design notes** are ADRs in all but name. They
pre-emptively rule out, with load-bearing reasons: building menus in JS, a
predefined Quit item, `tauri-plugin-fs`, and tracking tab-group membership in Rust.
None of the candidates below contradict them except candidate 6, which is marked.

Three of those notes reference functions that have since been renamed —
`open_path_in_new_window` (now `open_path_in_new_tab`), `closeWindow()` (now
`closeTab()`), and `advance_quit`/`quit_response` (now
`advance_flow`/`advance_quit_step`/`flow_response`). Worth a docs pass.

---

## 1. Give the caret one owner — **DONE**

Shipped on `refactor/caret-ownership`. See `docs/adr/0001`, `docs/adr/0002`,
`CONTEXT.md`, and commit `6f4942e`. Unit tests 67 → 103, e2e 13 → 10; `keyboard.ts`
went from zero reachable coverage to 18 tests.

Two latent bugs found during the review were real and are fixed: a stale title-row
edit silently overwriting the next document opened (commit `063b23a`), and
overlapping suspensions cancelling each other so the outline stayed live behind an
open dialog.

---

## 2. One command catalogue, not four spellings — **DONE**

**Files:** `apps/desktop/src-tauri/src/lib.rs:710-992, 1116-1195` ·
`apps/desktop/src/main.ts:159-207` · `apps/desktop/src/shortcuts.ts:23-89` ·
`packages/outliner/src/util.ts` (`CONCORD_KEYSTROKES`) ·
`packages/outliner/example/main.ts`

**Problem.** Every menu item is hand-written four times across two languages:
`MenuItemBuilder::with_id("reorg-move-up")` → a `match` arm on the same string →
`emit_to(label, "menu-reorg-move-up")` → a `Record` key in TS. Getting the
`"menu-"` prefix wrong in any one of them fails silently — no compile error, no
runtime error, the menu item just does nothing.

All 23 arms of the match at `lib.rs:1116-1195` are identical modulo the string;
the whole block computes `format!("menu-{id}")`. The five ids needing special
handling are already dealt with by an early-return above it, and `_ => {}` is
already the unknown-item case.

There is a third copy in prose: `shortcuts.ts` hand-transcribes 30
keystroke→description pairs and says so in its own header ("transcribed from the
two sources of truth rather than guessed"). It has already drifted — it omits
`Cmd-F`, `Cmd-G`, `Cmd-Shift-W` and `Cmd-Shift-N`, and files `Cmd-,` under the app's
own group when it is a library keystroke.

**Solution.** One catalogue — `{ id, label, accel, run }` — that the Rust menu, the
dispatch, the TS listeners, the shortcuts sheet, and the demo toolbar all derive
from instead of restating.

**Wins.** Leverage: one entry, five consumers · deletes ~80 lines of Rust · the
silent-typo failure mode disappears · the shortcuts sheet cannot drift · locality:
adding an item touches one file.

**Does not contradict design note 1.** The menu stays built in Rust and dispatch
stays `emit_to`-the-focused-window. This removes the restatement of ids, not the
architecture that note defends.

**Shipped** on `refactor/command-catalogue`, as `apps/desktop/menu.json` — a shared
JSON manifest read by both languages (Rust via `include_str!` + serde, TS via
`src/menu.ts`), described in design note 12 of `apps/desktop/README.md`. Three
deliberate departures from the sketch above:

- **The catalogue holds no `run`.** A closure doesn't serialise, so behaviour stays
  in TypeScript (`src/actions.ts`), keyed by the manifest's ids, with a test
  asserting every id has a handler or is one of the five window-level items Rust
  routes itself. Everything *else* about an item is data.
- **A shared file, not codegen.** Generating one side from the other makes the two
  agree as of the last generator run; reading the same bytes makes disagreement
  unrepresentable. `src-tauri/build.rs` validates the file independently (through
  `serde_json::Value`, not the crate's structs), so a malformed manifest fails
  `cargo check` rather than the running app.
- **The demo toolbar was left alone.** `packages/outliner/example/main.ts` is the
  library's demo; wiring it to the desktop app's menu manifest would point a
  package at an app that depends on it. What the library did gain is an export of
  `CONCORD_KEYSTROKES`, which is what the shortcuts sheet needed.

Result: the 23-arm `match` is one `emit_to`, and the sheet's drift is fixed —
`Cmd-F`, `Cmd-G`, `Cmd-Shift-N`, `Cmd-W`, `Cmd-Shift-W` and `Cmd-Q` are documented
and `Cmd-,` is filed as the library keystroke it is. Desktop tests 12 → 41, Rust
tests 0 → 5.

Worth being honest about the line count, since "deletes ~80 lines of Rust" was
claimed above: 239 lines came out of `lib.rs` and roughly the same number went back
in as manifest plumbing, most of it doc comment, so production `lib.rs` is about
where it started (a 268-line test module is the rest of its growth). `main.ts` did
shrink, 218 → 152. The win was never the line count — it is that the four places an
id could be mistyped are now one place it can't be.

---

## 3. Give the quit/close flow a pure core — **DONE**

**Files:** `apps/desktop/src-tauri/src/lib.rs:174-322` (`flow_response`,
`advance_flow`, `advance_quit_step`, `advance_close_group_step`), `:1268-1275`

**Problem.** The most defensive code in the repo is the only code with no test.
Decision and effect interleave line by line: every step takes `&AppHandle` and
reaches through it for `state::<DirtyWindows>()`, `get_webview_window()`,
`set_focus()`, `emit_to()`, `destroy()`, `exit()`. There is no seam, so none of it
is testable without a running app.

"A window may have vanished since we read the map" is defended **three separate
times** — `:243-252`, `:298-301`, `:1268-1275` — each with different recovery,
because there is no accessor holding the invariant.

**Solution.** Extract `next_step(flow, dirty, live) -> Step`, pure over three plain
values. The three staleness checks collapse into one intersection inside it; the
Tauri calls become a thin adapter that executes the returned `Step`.

**Wins.** Quit deadlocks become table tests · two adapters justify the seam
(`AppHandle` in prod, plain maps in tests) · locality: re-entrancy reasoning in one
place.

**Prerequisite, and it is cheap.** `.github/workflows/ci.yml` has **no Rust
toolchain step**, and `pnpm build` only runs Vite. A `lib.rs` that does not compile
passes CI today. Add `cargo check` before touching any of this.

**Shipped** as `apps/desktop/src-tauri/src/flow.rs` — 910 lines, and the only
occurrence of the string `tauri` in it is the comment saying it imports nothing from
`tauri`. That absence is the seam. Rust tests 5 → 20.

Two departures from the sketch above, both improvements:

- **The `(dirty, live)` pair got a name.** `Windows::new(&map, &labels)` intersects
  them once at construction, so `is_dirty` *cannot* answer true for a window that
  is not live. The three staleness checks didn't so much collapse as become
  unrepresentable — which is stronger than three checks agreeing by discipline.
- **Starting and continuing a flow are the same function.** `advance(pending, input,
  windows)` takes `StartQuit` / `StartCloseGroup` / `Resolved` alike, which puts the
  re-entrancy guard in one place instead of one per flow.

The prerequisite was satisfied first — and earned its keep immediately. The `rust`
job's very first run on `main` failed, exposing a pre-existing macOS-only
`tabbing_identifier` call in `create_document_window` that had never been compiled
for Linux.

### Follow-up: the flow can stall if a window dies mid-prompt — **DONE**

**Not introduced by this work — the old code had the same race**, with its liveness
check sitting microseconds earlier in the same sequence. Recorded here because the
pure core now makes it cheap to fix and to test, which it previously was not.

`run_flow` reads a `Windows` snapshot, asks the machine what to do, and executes the
resulting `Step`s. If a window is destroyed *between* the snapshot and its `Prompt`
step landing, the prompt goes to a window that no longer exists. No response ever
comes back, `PendingFlow` stays `Some`, and because the re-entrancy guard correctly
refuses to start a second walk on top of a running one, **every subsequent Cmd-Q
does nothing.** The app cannot be quit from its own menu, with no visible prompt
explaining why.

The window is genuinely small, and `WindowEvent::Destroyed` cleanup makes it smaller
still — but the failure mode is "app cannot be quit", which is the same class of
bug design note 8 exists to prevent.

Two directions, neither explored:

- Have the adapter re-check liveness at the moment it executes a `Prompt`, and feed
  a synthetic `Resolved { response: Proceed }` back into the machine when the target
  has gone. Keeps all the policy in the pure core; the adapter only reports what it
  observed.
- Treat an un-emittable `Prompt` as a failed step and let the machine decide. Same
  shape, more general, needs `Step` execution to be fallible.

Either is a table test in `flow.rs` plus a few lines in the adapter. The reason to
prefer the first is that it keeps the adapter free of judgement: "this window is
gone" is an observation, "therefore skip it" is a decision.

**Shipped** as the first direction, with one departure from the sketch: the adapter
reports a new `Input::Vanished { label }` rather than a synthetic
`Resolved { Proceed }`. The synthetic answer would have had the adapter claim a
person answered a prompt nobody ever saw, and the machine would then have acted on
that claim — `MarkClean` *inserts*, so it would resurrect a dirty-map entry the
`Destroyed` cleanup had already dropped, and on the Close Window walk it would have
produced a `Destroy` justified by a choice the user never made. `Vanished` says only
what was seen; `flow.rs` decides that the walk steps over it and carries on, by
re-driving through the dead-window handling that already existed. Rust tests 20 → 22,
one per flow.

---

## 4. Make the Document a module — **Worth exploring**

**Files:** `apps/desktop/src/document.ts:24-25, 69, 71-100, 193-235, 306-347` ·
`apps/desktop/src-tauri/src/lib.rs:62`

**Problem.** There is no `Document` type. "Is it dirty, where does it live, what is
it called" is an implicit tuple spread over the library's `changed` flag, a
module-level `currentPath`, a `lastSentDirty` IPC cache, Rust's `DirtyWindows` map,
the OPML head title, and the OS window title. `syncTitle()` reconciles them by hand.

Module-level `let`s plus module-scope Tauri imports make the file untestable — one
document per test *file*, with no way to reset.

> **Correction.** This review originally called `confirmQuit` and `confirmClose`
> near-duplicates "differing only in which side calls `destroy()`", and proposed
> making both destroy from the same side so one would disappear. **That is wrong —
> do not do it.** `confirmQuit` clears the changed flag on the discard path because
> the window *stays open* through a quit: Rust walks every dirty window and only
> exits once all are resolved. Skip that and the flow's own `app.exit(0)`
> re-triggers the `ExitRequested` dirty check, and the app refuses to quit against
> its own exit call. `confirmClose`'s window is destroyed, so its dirty-map entry
> drops on its own. The difference is which window survives, and the duplication is
> earning its keep. The 23-line doc comment explains this rather than apologising
> for it.

The Save-As heuristic at `document.ts:332` is the tell:

```ts
if (current === '' || current === 'Untitled') { … }
```

That is "has the user authored a title yet?" written as a string comparison against
a constant owned by the *other* package (`constants.ts`, `EMPTY_OPML`). The head
store has no notion of authored-vs-default — which is the fact commit `85dbd63`
actually needed, and it still has no regression test.

**Solution.** A `Document` module owning `{ path, outliner }` with one `state()`
accessor, constructed with its file and window adapters rather than importing them.

**Wins.** First tests in the desktop app · one close path, not two · locality: title
policy in one module · the Rust mirror gets a single writer.

---

## 5. Make the edit session explicit — **Partly absorbed by candidate 1**

**Files:** `packages/outliner/src/titleRow.ts`

**Already done.** The ownership half. `editing` is no longer a cached boolean — it
is `this.release !== null`, i.e. holding the caret claim *is* the state, so there is
no second copy to disagree with reality.

**What remains.** `previousText` and `editTarget` are still ad-hoc session data, and
`commit()` writes directly to two different stores with two different escaping rules
(`editor.escape` into `innerHTML` for a hoisted headline; a raw string into the
headers map for the title). It takes no `saveState()`, so **a title-row rename is
the one edit in the app that undo cannot reach.**

A session module that *returns* a described `Edit` rather than performing one would
make "what does this edit mean" pure and testable, leaving application to the caller.

**Also uncovered, still live:** `beginEdit` returns early when readonly, but the
field stays `contenteditable="true"` and `setReadonly` only toggles a class — so a
readonly title row can still be typed into. Nothing asserts otherwise.

**One finding that did not survive contact.** The review predicted `refresh()`'s
stale-commit branch would disappear, because "editing but not focused" would become
unrepresentable. It doesn't. A claim deliberately freezes the caret module's ambient
bookkeeping, so a claimant cannot hear about the caret being taken behind its back,
and an explicit reconciliation survives as
`if (this.editing() && !holds(this.text)) this.commit()`. Latent bug 1 is therefore
prevented by the explicit `abortEdit()` on load, **not** by construction.

---

## 6. Split the model out of `op.ts` — **Speculative; contradicts a recorded decision**

**Files:** `packages/outliner/src/op.ts` · `editor.ts` · `events.ts`

**Problem.** The DOM is the model. Cursor, selection, expansion, text mode,
dirtiness and per-node OPML attributes are all CSS classes and `data-` attributes on
live `<li>` elements, and every operation is a DOM mutation. Roughly 150 of `op.ts`'s
1,200 code lines are structure; the other ~1,050 mix structure with class-stamping,
scrolling, focus and `execCommand`. `expand()` is one line of model change wrapped in
25 lines of scroll layout. `bold()`/`italic()` have no model representation at all —
the result is whatever `contentEditable` produced, re-read out of `innerHTML` later.

**Contradicts** `packages/outliner/README.md`: *"The internals mirror the original
module boundaries so the translation stays verifiable method-for-method."* That is
load-bearing and should not be reopened lightly. Worth revisiting only if the port is
considered settled — and if so, the precedent already exists inside `op.ts`:
`applyHoist`/`undoHoist`/`withFullTree` are documented as "pure DOM — no
cursor/callback side effects", with side effects pushed out to the public wrappers.
That is exactly the seam this candidate generalises.

---

## Smaller defects, worth fixing regardless

| Where | What |
|---|---|
| `op.ts` `outlineToText()` | Omits `withFullTree()`, unlike `outlineToXml()`. While hoisted, `toOpml()` returns the whole document but `toText()` returns only the hoisted subtree. |
| `op.ts` `redraw()` | Round-trips through `xmlToOutline`, which clears the hoist stack — so `setRenderMode()`/`redraw()` silently de-hoist. |
| `op.ts` `expand()` | Fires `opExpand` *before* the early return, so the callback fires when nothing expands. |
| `op.ts` `state.currentChange` | Written once, never read. Vestigial from Concord. |
| `op.ts` | `scrollEnabled` / `pixelsAboveOutlineArea` are unreachable constants. |
| `noderef.ts` `insertXml` | Duplicates `Op.insertXml` minus expansion-state handling. `NodeRef.isComment` duplicates `Script.isComment`. |
| `events.ts` | Open-codes `setTextMode` + `setCursor` to dodge their side effects, and reparents nodes directly instead of going through `op.reorg`. |
| `editor.ts` | Re-exports five `dom.ts` functions as instance properties, widening the interface for nothing. |
| `keyboard.ts` | The `default:` arm sets `keyCaptured = false` unconditionally, so an app setting `captured` on `opKeystroke` for an *unmapped* keystroke has that flag overwritten and the type-over fallback runs anyway. Pre-existing ported behaviour; may be Concord fidelity rather than a bug. |

## Facade note

`Outliner` exposes ~78 methods, of which ~63 are one-line delegations to `op`/`script`.
It does not encapsulate: `editor`, `op`, `script`, `root`, `pasteBin`, `container` and
`state` are all public, and internally everything skips the facade. The deletion test
is genuinely ambiguous here — it earns its keep as the published interface, the renames,
`NodeRef` wrapping, and `toOpml()`'s title-row flush ordering — so this is listed as an
observation, not a candidate.
