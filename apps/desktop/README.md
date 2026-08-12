# GeekityFlow (desktop)

**GeekityFlow** is a Tauri v2 desktop app (workspace package `outliner-desktop`, bundle
identifier `com.geekity.flow`) that mounts `@andrewshell/outliner` full-window. It's
chrome-free — no toolbar — because the outliner is keyboard-driven; everything that would be a
toolbar button is a menu item or a keystroke instead. **Help → Keyboard Shortcuts** opens an
in-app modal listing them, derived from the menu manifest and the library's own keystroke table
rather than transcribed from either.

The workspace package name stays `outliner-desktop` (and the directory `apps/desktop`) — those
are internal identifiers used by `pnpm --filter` and CI, not user-visible, so renaming them
would churn the scripts for no benefit.

## Icon

`geekity_icon.svg` in this directory is the icon source; the set under `src-tauri/icons/` is
generated from it with `pnpm exec tauri icon geekity_icon.svg`. Re-run that after changing the
source, and delete the `android/` and `ios/` directories it also emits — this app has no mobile
target.

**Generate from the SVG, not the PNG.** `geekity_icon.png` is kept alongside it as the original
raster, but it's only 300×300 — below the 1024×1024 macOS wants — so generating from it upscales
every large Retina size. `tauri icon` accepts SVG directly and rasterizes each size from the
vector, which is why `icon.icns` carries a genuine 1024×1024 representation (verify with
`iconutil --convert iconset`).

One property of the artwork worth a deliberate decision: it's a **black glyph on transparency**
with no background plate, so against a dark Dock or in dark mode it has very little contrast.
Most macOS app icons fill the rounded-square canvas rather than sitting transparent on it. Left
as-is because that's a branding call, not a technical one — `tauri icon` can composite a
background via its manifest form (`{ "default": ..., "bg_color": "#fff" }`) if that changes.

## Running and building

From the repo root:

```bash
pnpm dev:desktop                                    # run it with HMR (no app icon — see below)
pnpm app:desktop                                    # build + launch a real .app bundle
pnpm --filter outliner-desktop tauri build           # bundle a distributable .app / .dmg / etc.
```

### Why `pnpm dev:desktop` shows a generic Dock icon

`tauri dev` produces **no `.app` bundle at all** — it compiles and runs the bare Mach-O
executable at `src-tauri/target/debug/app`. macOS takes an app's Dock and ⌘-Tab icon from a
bundle's `Contents/Resources/*.icns` via `CFBundleIconFile`, and a loose binary has nowhere to
put one, so it gets the generic executable icon. Nothing is wrong with the icon set when this
happens; the same build embeds it correctly in a bundle.

Neither Tauri nor `tao` exposes a runtime dock-icon setter (only `set_dock_visibility`), so
this can't be patched from Rust without dropping to `NSApplication setApplicationIconImage:`
through raw Objective-C bindings — not worth a new dependency for a dev-only cosmetic gap.

`pnpm app:desktop` is the way to see the real thing: it runs `tauri build --debug --bundles app`
and opens the result. Because it reuses the warm `target/debug` artifacts that `tauri dev`
already built, it takes seconds rather than the minutes a release build needs. What it doesn't
give you is HMR — it's a build, so re-run it after changes. Use `dev:desktop` for iterating and
`app:desktop` when you want to check icon, Dock behavior, or anything else that depends on
being a real bundle.

Requires the [Rust toolchain](https://rustup.rs) and Tauri's OS-level prerequisites (see the
[Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)) — needed for both
commands above, since `tauri dev`/`tauri build` compile the Rust side. Plain
`pnpm --filter outliner-desktop typecheck` / `build` only touch the TypeScript frontend and
don't need Rust.

## Multi-window

The app is multi-document, using **native macOS window tabs**: every document window is a tab,
and windows that share a tab group are drawn together in one titlebar/tab-bar the way Safari or
Finder windows are. **File > New** and **File > Open…** both open a new *tab* in the current
window's group rather than a standalone window — **File > New Window** is the explicit way to
start a fresh group.

- **New** (`Cmd/Ctrl-N`) — opens a new blank tab, grouped with the focused window (falls back to
  a standalone window if nothing is focused, which is otherwise never the normal case). Handled
  entirely in Rust (`create_document_window` in `src-tauri/src/lib.rs`) with no round trip to any
  frontend, since a blank document needs no state that only JS has — grouping only needs to know
  *which window is focused*, not anything about its document.
- **Open…** (`Cmd/Ctrl-O`) — native file picker runs in the focused window, then:
  - if that window is a **blank, untouched Untitled tab** (no path *and* not dirty), the chosen
    file loads into it in place — there's nothing to lose.
  - otherwise (it has a path, or is dirty, or both), that tab's document is left completely alone
    and the file opens in a **new tab**, grouped with the window that opened it
    (`open_path_in_new_tab` in `src-tauri/src/lib.rs`).
- **New Window** (`Cmd/Ctrl-Shift-N`) — opens a blank tab in a **standalone** window, starting a
  new tab group rather than joining the focused one. This is the one way to deliberately get a
  window that isn't grouped with anything.
- **Close Tab** (`Cmd/Ctrl-W`) — closes just the focused tab, running the same unsaved-changes
  prompt as the native close button (traffic-light / titlebar close). Under native tabbing each tab
  already *is* a window as far as Tauri/AppKit are concerned, so this closes one window. It's a
  **custom** menu item, not Tauri's predefined "close window" role with the label changed, which is
  what it originally was: AppKit draws that predefined role with a leading ✕ glyph, and one item
  carrying an image makes NSMenu reserve an image column for its whole group, indenting the
  neighbouring items and leaving the File menu visibly ragged. The custom item is routed in Rust by
  calling Tauri's `close()` (not `destroy()`) on the focused window, which fires the same
  `close-requested` event the traffic-light button does — so both routes still funnel through the
  single guard in `src/main.ts` rather than each needing their own prompt.
- **Close Window** (`Cmd/Ctrl-Shift-W`) — closes **every tab in the focused window's tab group**,
  prompting one at a time for whichever are dirty (clean tabs close immediately, no prompt).
  Reuses the same Rust-side walk Quit uses (see below) rather than a second implementation — see
  "Design notes" for why, and for why the group's membership is read fresh from AppKit on every
  Close Window rather than tracked in a map.
- **Save** (`Cmd/Ctrl-S`) — writes to the current path, or falls through to Save As if there
  isn't one yet.
- **Save As…** (`Cmd/Ctrl-Shift-S`) — native save picker, updates the OPML `<head><title>` to
  the new file's basename, then writes.
- **Quit** (`Cmd/Ctrl-Q`) — checks *every* open tab app-wide, across every window and every tab
  group, not just the focused one. If none are dirty, the app exits immediately. Otherwise Rust
  works through the dirty tabs one at a time: focus the tab, ask its frontend to run the same
  unsaved-changes prompt Close Tab uses, and wait for an answer before moving on. Cancel at any
  tab aborts the whole quit — nothing else is prompted and no window closes. Save or Don't Save
  moves on to the next dirty tab (a failed or cancelled Save aborts the quit, same as Close Tab).
  Once every dirty tab is resolved, the app exits. See "Design notes" below for why this needed a
  custom menu item and a Rust-side dirty-state map, not just an `ExitRequested` handler.

Quit and Close Window are both driven by the same state machine in `src-tauri/src/flow.rs` —
`Flow`, `Input`, `Step`, and the one `advance` function over them — rather than two near-identical
walk-and-prompt implementations. `src-tauri/src/lib.rs` holds only the adapter (`run_flow`, the
`PendingFlow` slot it writes, and the shared `flow_response` command): it reads the world, asks
`advance` what to do, and carries out the steps it gets back. No Quit or Close Window decision is
made there. They differ only in *which* tabs they visit (every
dirty tab app-wide for Quit, versus the specific tab-group snapshot `close_window_group` captures
for Close Window) and in what happens once a tab resolves (Quit leaves it open; Close Window
destroys it). See "Design notes" below for the invariants this sharing has to preserve.

Because Open never discards a tab's content — it either loads into an already-blank tab or opens
a new one — only a tab's native close path, Close Window, and Quit need the unsaved-changes guard.
That prompt (**Save / Don't Save / Cancel**, via an in-app `<dialog>` — the dialog plugin's
`ask`/`confirm` are two-button only and have no room for Cancel) lives in `confirmClose()` (Close
Tab / the traffic light / Close Window's per-tab prompt) and `confirmQuit()` (Quit) in
`src/document.ts`, both built on the same `confirmDiscard()` prompt. Choosing Save actually saves
before proceeding, and aborts the whole close/quit if that save is cancelled or fails. Read/write
errors surface through the dialog plugin's `message()` rather than a thrown promise. The window
title tracks the current file and gets a leading `•` while the document is dirty.

`confirmDiscard()` is laid out like the macOS save alert it stands in for: a warning icon, a bold
question naming the document, a consequence line, and the three choices as full-width buttons
stacked vertically with Save tinted as the default. It takes the document's name as an argument
rather than saying "this document" — during a quit (or a Close Window group walk) the flow visits
several tabs in turn, and an anonymous prompt gives no clue *which* document is being asked about.
Save is both first in DOM order and focused, so Return activates it and the tint tells the user
so; Esc still maps to Cancel, so the destructive choice is never a default.

Each tab is its own Tauri webview window with its own JS realm, so `document.ts`'s module-level
`outliner`/`currentPath` state is automatically per-tab — no registry keyed by window label is
needed to keep multiple documents' state apart. The Rust-side `DirtyWindows` map (also keyed by
window label) works the same way: one entry per tab, regardless of which group that tab is
currently in.

### Window menu

A **Window** menu (no custom items beyond the standard Minimize/Zoom pair) is registered as the
app's windows menu via `Submenu::set_as_windows_menu_for_nsapp()`, which is what makes tabs
switchable from the keyboard at all: macOS automatically appends **Select Next Tab**
(`Cmd-Shift-]`) / **Select Previous Tab** (`Cmd-Shift-[`), **Merge All Windows**, **Move Tab to
New Window**, and the running list of open windows/tabs to any menu registered this way — none of
that is implemented by hand. See "Design notes" below for why this one call was cheap enough to be
worth adding, in contrast to the tab-grouping work above.

### Always-visible tab bar

macOS auto-hides a window's tab bar whenever its group has only one window in it — normally
harmless, but it breaks dragging: with no bar showing, there's nothing to drag a tab *to* (merging
a second window into a solo one) or *from* (pulling the only tab out to reorder/detach it), so a
solo window is stuck undraggable in either direction until a second tab happens to land in it some
other way. This app overrides that default, forcing every tab bar visible even for a single tab,
via `assert_tab_bar_visible` in `src-tauri/src/lib.rs`: on the main thread, if
`NSWindow.tabGroup()?.isTabBarVisible()` is false, it calls `-[NSWindow toggleTabBar:]` — the same
action "Show Tab Bar" runs — always checking first, since `toggleTabBar:` *toggles* and would hide
an already-visible bar if called blindly. This runs for every window `create_document_window`
builds, for the startup window in `setup()` (the one document window that function never builds),
and again, conditionally, on every window's `Focused(true)` event as a backstop for tab groups
AppKit forms on its own — see design note 11 below for why that backstop is conditional, not
unconditional, and for a known gap in it.

**`toggleTabBar:` does nothing on its own here — `enable_automatic_window_tabbing()` is what makes
it work.** `tao` calls `NSWindow.setAllowsAutomaticWindowTabbing(false)` inside *every* window it
builds (`platform_impl/macos/window.rs`, gated on an `automatic_tabbing` attribute Tauri doesn't
expose). With that off, AppKit refuses to show a tab bar for a group of one and `toggleTabBar:`
silently no-ops — instrumenting the call showed `isTabBarVisible()` reading back `false`
immediately after it. Explicit `addTabbedWindow:ordered:` is unaffected, which is why tabs could
be *created* while a lone window still showed no bar to drag onto. Because tao flips the flag off
again on every `build()`, it has to be re-enabled per window rather than once at startup.

**A debugging trap if you ever revisit this:** macOS persists "show tab bar" per app, so once the
bar has been shown successfully even once, it stays visible across launches — including launches
of a build where this fix is disabled. An A/B test run after the fix first worked reported the bar
visible *without* it. That means the absence of a regression on this machine proves nothing; test
a change to this code on a fresh app identity, or by explicitly hiding the bar first.

## Menu layout

Every **custom** item below is declared once in `menu.json` — id, label, accelerator, submenu,
grouping, description — and read from there by both the Rust menu builder and the frontend; see
design note 12 for why. The predefined native items are not in that file and never should be.

- **GeekityFlow** (macOS app menu) — About, Services, Hide/Hide Others/Show All (all predefined),
  and Quit (`Cmd/Ctrl-Q`, deliberately a *custom* item, not predefined — see "Design notes" below
  for why).
- **File** — New (`Cmd/Ctrl-N`), Open… (`Cmd/Ctrl-O`), New Window (`Cmd/Ctrl-Shift-N`), Close Tab
  (`Cmd/Ctrl-W`), Close Window (`Cmd/Ctrl-Shift-W`), Save (`Cmd/Ctrl-S`), Save As…
  (`Cmd/Ctrl-Shift-S`) — see "Multi-window" above for what each does. Save/Save As sit *below*
  the two Close items, not above them — deliberate, not a mistake: New/Open/New Window/Close
  Tab/Close Window are all about which tab or window you're looking at, and Save/Save As are
  about that tab's document, so the menu groups by "which window" before "which document."
- **Edit** — Cut, Copy, Paste only. See "Design notes" below for why Undo and Select All are
  deliberately absent.
- **Outliner** — modeled on Dave Winer's Drummer (drummer.land) Outliner menu:
  - **Expand** / **Collapse** (no accelerators) — expand/collapse the cursor headline's children
    one level.
  - **Expand All Subs** (no accelerator) — fully expands the cursor headline's subtree.
  - **Expand Everything** / **Collapse Everything** (no accelerators) — expand/collapse the
    entire document.
  - **Hoist** / **Dehoist** (no accelerators) — zoom the view onto the cursor headline's subtree,
    or pop one level back out. See the "Hoisting" section of `packages/outliner/README.md` for
    exact semantics.
  - **Find…** (`Cmd/Ctrl-F`) — prompts for search text and an optional "Match case" checkbox (an
    in-app modal, not `window.prompt`), then calls `find(text, { matchCase })`. A search that
    matches nothing reports "No match found" instead of failing silently.
  - **Find again** (`Cmd/Ctrl-G`) — repeats the last search via `findAgain()`. If Find… hasn't
    been run yet in this window, it opens the Find… prompt instead, since there's nothing to
    repeat.

  Only Find…/Find again get accelerators; every other item here is menu-only, even though MORE
  (which the old View menu mirrored) gave several of these items one, and Drummer itself omits
  them too:
  - Expand / Collapse skip `Cmd-,` / `Cmd-.` because `Cmd-,` is already bound to the outliner's
    own `toggle-expand` (`CONCORD_KEYSTROKES` in `packages/outliner/src/util.ts`); a menu
    accelerator here would shadow that keystroke.
  - Hoist / Dehoist skip `Cmd-H` / `Cmd--` because `Cmd-H` is Hide Application on modern macOS
    and already does that job in the GeekityFlow app menu.

  `Cmd-F` and `Cmd-G` were verified against `CONCORD_KEYSTROKES` before being assigned: `Cmd-F`
  (`meta-F`) maps to `find` there, but `keyboard.ts`'s `case 'find': break` is a no-op that never
  calls `preventDefault`, so the accelerator was free and is now backed by a real
  implementation; `Cmd-G` is absent from the table entirely.
- **Reorg** — modeled on Dave Winer's Drummer (drummer.land) Reorg menu, including its grouping
  and separators:
  - **Move Up** / **Move Down** / **Move Left** / **Move Right** (`Cmd/Ctrl-U` / `-D` / `-L` /
    `-R`) — `reorg(UP/DOWN/LEFT/RIGHT)`: move the cursor headline within its siblings or across
    outline levels.
  - **Toggle comment** (`Cmd/Ctrl-\`) — `toggleComment()`.
  - **Run selection** (`Cmd/Ctrl-/`) — `runSelection()`.
  - **Delete Line** (no accelerator) — `deleteLine()`.
  - **Promote** (`Cmd/Ctrl-[`) / **Demote** (`Cmd/Ctrl-]`) — `promote()` / `demote()`.
  - **Sort** (no accelerator) — `sort()`.

  Unlike the Outliner menu above, every item here that has a Drummer accelerator keeps it —
  `Cmd-U/D/L/R`, `Cmd-\`, `Cmd-/`, `Cmd-[`, `Cmd-]` are all bound, even though every one of them
  duplicates a key `CONCORD_KEYSTROKES` (`packages/outliner/src/util.ts`) already binds in the
  outliner's own keydown handler, and on macOS the menu wins that race and shadows the handler
  entirely. That's deliberate here, not an oversight, and it does not contradict the Outliner
  menu's restraint or the Edit menu's missing Undo/Select All — see design note 9 below for why.
- **Window** — Minimize, Zoom (both predefined), then whatever macOS appends automatically —
  Select Next/Previous Tab, Merge All Windows, Move Tab to New Window, and the running list of
  open windows/tabs. See the "Window menu" subsection under "Multi-window" above.
- **Help** — Keyboard Shortcuts (no accelerator; opens the shortcuts modal).

## Design notes

Twelve choices here look like omissions or overengineering but aren't — please don't "fix" them
without reading this first.

**1. The menu is built in Rust (`build_menu` in `src-tauri/src/lib.rs`), not JS.** It used to be
built with `@tauri-apps/api/menu` and installed with `setAsAppMenu()` — that worked fine for a
single window, but breaks under multi-window in a way that's easy to miss: a JS menu item's
`action` callback runs in *the webview that built the menu*, not whichever window is currently
focused. With several documents open, clicking File > Save would always save the window that
happened to install the menu — silently the wrong document as soon as a second window exists —
and once that window closes, its JS context is gone and the whole menu stops responding, even
though it's still visible. Native predefined items (Cut/Copy/Paste, Close Window, Quit, ...)
never had this problem: macOS routes them through the OS responder chain to whichever window is
actually focused, with no app code involved. Custom items that need document state (New, Open,
Save, Save As, Keyboard Shortcuts) are wired up in Rust's `on_menu_event` handler, which resolves
the focused window (`focused_window` in `lib.rs` — a small scan over `webview_windows()`, since
`Manager::get_focused_window` needs tauri's `unstable` feature, which this crate doesn't enable)
and emits an event to *just that window's label* with `emit_to` — never a plain broadcast `emit`,
which would fire in every open window and (for Save, say) write
every open document to disk at once. If you're tempted to move the menu back into JS for
convenience, this is why it can't work once there's more than one window. New is the one
exception: it needs no document state at all, so Rust creates its window directly with no
frontend involvement.

**2. New windows learn their file path from the URL query string, not a post-creation
event.** `create_document_window` builds each new window's URL as
`index.html?path=<percent-encoded path>`; `main.ts` reads it at boot with
`new URLSearchParams(location.search)`. An event emitted right after `WebviewWindowBuilder::build()`
could reach the new window before its `listen()` calls have registered, silently dropping the
path — the query string has no such race, since it's already present in the URL before any of
the new window's JS runs.

**3. The Edit menu has no Undo or Select All.** On macOS, the app menu gets first crack at a
key equivalent. The outliner's own keyboard handler
(`packages/outliner/src/keyboard.ts`) captures `Cmd-Z` (undo) and `Cmd-A` (select-all) with
`preventDefault()` — its own outline-level undo and select-all, not the browser's. A
predefined `Undo`/`SelectAll` menu item bound to those same accelerators would intercept the
keystroke at the OS menu layer before the webview ever sees it, silently breaking the
outliner's versions in favor of a no-op (or a native text-field undo/select that doesn't apply
here). Cut/Copy/Paste don't have this problem — the outliner's keyboard handler deliberately
lets those three fall through to the native handler — and WKWebView actually *needs* the menu
items present for its native clipboard handling to work at all, which is why those three (and
only those three) are predefined items in the Edit menu. Same reasoning covers Help > Keyboard
Shortcuts having no accelerator of its own: the conventional `Cmd-/` is already bound to the
outliner's `run-selection`, so giving the menu item that accelerator would shadow it the same
way an Edit-menu Undo would shadow Cmd-Z.

**4. `core:default` (in `capabilities/default.json`) only grants read-only window
permissions.** It includes things like `allow-title` and `allow-get-all-windows`, but *not*
`allow-set-title`, `allow-destroy`, `allow-set-size`, `allow-center`, `allow-minimize`, or any
other window command that changes state. A denied permission fails silently — the promise
rejects but nothing surfaces it by default — which is exactly how the window title (and its `•`
dirty marker) and the red traffic-light close button ended up doing nothing for a while: the app
called `setTitle()`/`destroy()` without either permission granted, and both call sites `void`-ed
the returned promise. Both are now covered by explicit `core:window:allow-set-title` and
`core:window:allow-destroy` entries, and both call sites now surface a rejection (see
`syncTitle()` in `src/document.ts` and `closeWindow()` in `src/main.ts`). Any *new* window
operation (`setSize`, `center`, `minimize`, `setFullscreen`, ...) needs its own explicit
`core:window:allow-*` entry added to `capabilities/default.json` — check
`src-tauri/gen/schemas/macOS-schema.json` for the exact permission string, and don't assume
`core:default` already covers it. Multi-window support itself needed **no new entries**:
window creation happens entirely in Rust via `WebviewWindowBuilder` (never exposed to the
frontend as an invokable command), and resolving/emitting to the focused window are plain Rust
API calls, not IPC — the ACL only gates frontend-to-backend `invoke()` calls. `listen()` on the
frontend side needed nothing new either: `core:event:default` (which covers `allow-listen`) is
already pulled in by `core:default`. The custom `open_path_in_new_window` command follows the
same pattern as `read_file`/`write_file` below — an app-defined command, not a plugin command,
so it isn't ACL-gated at all.

**5. A capability has two independent gates: which permissions it grants, and which
*windows* it applies to.** Granting a permission does nothing for a window the capability
doesn't cover. `capabilities/default.json` shipped with `"windows": ["main"]` (the default
from `tauri init`, written when the app was single-window). Once multi-window landed, every
Rust-created window — labelled `win-1`, `win-2`, ... — matched no capability at all and so had
*no* permissions: `setTitle()` was denied (the window title stayed stuck on the literal
"GeekityFlow" set by `WebviewWindowBuilder`), `destroy()` was denied, the dialog pickers were
denied, and `listen()` was denied, which silently killed the **entire menu** in every window
but the first. The giveaway that this was permissions rather than logic: `read_file` and
`write_file` kept working, because app-defined commands aren't ACL-gated — so an opened
document still displayed its contents and the failure looked purely cosmetic. The `windows`
field is now a `"*"` glob: every window this app creates is a document window with identical
needs, and a glob can't drift out of sync with the label scheme in `lib.rs` the way an
explicit list can. A future window type that genuinely needs *narrower* permissions should get
its own capability file rather than narrowing this one.

**6. File I/O uses two custom Rust commands (`read_file` / `write_file` in
`src-tauri/src/lib.rs`) instead of `tauri-plugin-fs`.** `tauri-plugin-fs` scopes filesystem
access by path pattern declared up front in capabilities. A path the user just picked from the
native Open/Save dialog isn't in any such scope — there's no way to declare "whatever the user
picks next" ahead of time. Making the plugin work at all would mean granting a blanket `"**"`
scope, i.e. unrestricted filesystem access from the frontend. The two commands here are ten
lines of `std::fs::read_to_string` / `std::fs::write` with errors mapped to strings for the
frontend to show via the dialog plugin's `message()` — a much smaller, path-specific grant than
opening up the fs plugin. `@tauri-apps/plugin-dialog` is still used for the native pickers
themselves (`dialog:default` in `capabilities/default.json`, i.e. `allow-message` /
`allow-open` / `allow-save`) — only the actual disk reads/writes are custom.

**7. Quit (`Cmd/Ctrl-Q`) is a custom menu item, not the predefined `.quit()` — resist the urge
to "simplify" it back.** Every *other* native item in the app submenu (About, Services,
Hide/Hide Others/Show All) is predefined, and design note 1 above explains why predefined is
usually the right call. Quit is the exception, for a reason that's easy to miss: the predefined
Quit item maps to Cocoa's `sel!(terminate:)` (muda's macOS menu backend), which sends
`terminate:` straight to `NSApplication` — and neither this app nor `tao` (the windowing crate
underneath Tauri) ever gets a chance to intervene first. Verified directly against `tao`
0.35.3's source: there is no `applicationShouldTerminate` handler anywhere in it. The obvious
fix for "Cmd-Q discards unsaved changes" is switching `.run(context)` to
`.build(context)?.run(|app, event| ...)` and handling `RunEvent::ExitRequested` with
`api.prevent_exit()` — and that fix *is* necessary (see `run()` in `src-tauri/src/lib.rs`), but
on its own it does **not** catch Cmd-Q: `ExitRequested` only fires for exits "requested by user
interaction" (in practice, the last window closing) or triggered programmatically via
`AppHandle::exit`/`restart`. A predefined Quit item's `terminate:` bypasses all of that — the
process just tears down mid-edit, discarding whatever's unsaved in every open window, with no
Rust-side hook that ever runs. A *custom* menu item doesn't have this problem: it emits a menu
event like every other custom item here (see the `"quit"` entry in `menu.json`, which `build_menu`
turns into a menu item, and the `"quit"` case in `on_menu_event`), which keeps Cmd-Q inside code
this app controls instead of
handing it straight to the OS. If you're looking at this thinking "why isn't Quit just
`.quit()` like Close Window is `.close_window()`" — this is why, and switching it back
silently reintroduces the data loss it exists to prevent.

**8. Dirty state is tracked twice, once per window in JS and once for the whole app in Rust —
and the second copy has to be cleaned up on window destruction, or quit can hang forever.**
Rust needs to know, before Quit prompts anyone, which of the open windows have unsaved changes
— but dirty state (`isDirty()` / `hasChanged()`) lives entirely in each window's JS, and Rust has
no way to reach into a webview's JS state on demand. So it's pushed instead of pulled: `set_dirty`
(an app-defined command, like `read_file`/`write_file` in design note 6 — no capability grant
needed) writes into a `Mutex<HashMap<String, bool>>` keyed by window label, managed as Tauri
state. `syncTitle()` in `src/document.ts` is the single call site — it already runs on every
change that could flip dirty state (typing, structural ops, mouse-driven expand/collapse/reorder,
save, load; see its own doc comments for why each of those triggers it) — and it only calls
`set_dirty` when the value actually *changes* from what was last sent, not on every keystroke, so
this isn't an IPC round trip per character typed.

The map entry **must** be removed when a window is destroyed, and this has to happen in Rust
(`on_window_event`'s `WindowEvent::Destroyed` case in `run()`), not in the frontend: a destroyed
webview can't run any more JS, so it can never send a final "I'm gone" `set_dirty` call itself.
Without this cleanup, closing a dirty window through Close Window or the traffic light (both of
which already resolve or discard the prompt before destroying it, but don't clear the *Rust-side*
map entry themselves) would leave a stale `true` behind forever — and the next Quit would try to
focus and prompt a window that no longer exists, hanging with no visible window to show the
prompt in and no way to ever quit. `flow::Windows` (`src-tauri/src/flow.rs`) also defends against
this same staleness — a window can vanish between reading the map and acting on it — but it does
so as a *backstop for the gap before `Destroyed` arrives*, not as a substitute for the cleanup:
without the cleanup the map grows an entry per window ever opened. That defence used to be written
out three separate times, in Quit's walk, in Close Window's walk and in the `ExitRequested` veto,
each with its own recovery; it is now one intersection taken at `Windows::new`, which every one of
those three consults. A label that isn't live can't come back dirty from it, so no caller gets the
chance to forget the rule, and the machine asks the adapter to `Forget` the entry as it passes.

One more wrinkle worth knowing about if you're reading `flow.rs`: the quit flow's own
`app.exit(0)` at the end triggers `RunEvent::ExitRequested` right back into the handler design
note 7 describes. If the dirty map still said "dirty" at that moment, the app would refuse to quit
against its own exit call. The fix isn't a bypass flag — it's making the state honest: when the
user picks Don't Save during a quit prompt, `confirmQuit()` in `document.ts` actually calls
`outliner.clearChanged()` (which `confirmClose()`'s "discard" branch doesn't need to, since
closing the window drops its map entry anyway via the `Destroyed` cleanup above). The machine only
ever emits `Step::Exit` when a fresh `Windows` says nothing live is dirty, so by the time the
adapter calls `app.exit(0)` the map is genuinely empty and `ExitRequested`'s dirty check passes it
through cleanly. Both halves of that are pinned by tests in `flow.rs`
(`quit_only_exits_once_the_dirty_state_is_honestly_clean`), which is the main thing the split
bought: the deadlock is now something a test can disagree with rather than something a comment
asserts.

**9. The Reorg menu binds accelerators that shadow the outliner's own keydown handler — on
purpose, and this is consistent with design note 3, not a contradiction of it.** `Cmd-U`,
`Cmd-D`, `Cmd-L`, `Cmd-R`, `Cmd-\`, `Cmd-/`, `Cmd-[`, and `Cmd-]` are all already bound inside
`packages/outliner/src/keyboard.ts` via `CONCORD_KEYSTROKES` (`packages/outliner/src/util.ts`),
mapped to `reorg-up`/`reorg-down`/`reorg-left`/`reorg-right`/`toggle-comment`/`run-selection`/
`promote`/`demote`. On macOS the app menu gets first crack at a key equivalent (the same fact
design note 3 uses to explain why Edit has no Undo/Select All), so every one of these menu
accelerators shadows the outliner's own handling of the same key — the outliner's keydown
handler never sees the keystroke at all once the menu item exists.

The difference from Undo/Select All is what each shadowed handler actually does once you read
it. Checked directly against `keyboard.ts`: every one of these eight cases is a thin,
unconditional wrapper around the exact same `Outliner` method the menu item calls — `case
'reorg-up': ... op.reorg(UP); break`, `case 'promote': ... op.promote(); break`, `case
'toggle-comment': if (isComment()) unComment(); else makeComment(); break` (which is exactly
what `Outliner.toggleComment()` does internally, via `Script.toggleComment()`), and so on for
the rest. None of them branch on text-editing mode or guard on cursor state the way, say, `case
'select-all'` does (it calls the browser's `document.execCommand('selectAll', ...)` in text mode
but a DOM-level selection walk otherwise) — so replacing "the keydown handler runs this case"
with "the menu item calls this same method directly" changes nothing observable. Shadowing a
call with an identical call is behavior-preserving. A predefined Undo/Select All menu item would
instead have invoked the *webview's* native undo/select-all — a genuinely different operation
from the outliner's own — which is why those two stay unbound and always will.

The Outliner menu's own restraint (design note in "Menu layout" above, and the `expand`/
`collapse`/hoist reasoning in `build_menu`) is a separate, narrower case: `Cmd-,` is bound to
`toggle-expand` and `Cmd-H` is claimed by Hide Application, and binding either here would shadow
a *different* outcome than clicking the menu item produces (or collide with an unrelated app
menu item) — not the "identical wrapper" situation the Reorg menu is in. The two menus reaching
different conclusions isn't inconsistency; it's the same rule (never shadow a keystroke whose
outcome the menu item wouldn't reproduce) applied to two different sets of facts.

**10. Native window tabs needed raw AppKit for the grouping/ungrouping itself, but not for tab
switching — and tab-group membership is queried from AppKit, never tracked in Rust.** Three
separate decisions, worth pulling apart:

*Why grouping needed objc2 at all.* Tauri exposes `WebviewWindowBuilder::tabbing_identifier`,
which reaches tao's `setTabbingIdentifier` — but that only makes a window *eligible* to be tabbed
together with others sharing the same identifier; it doesn't let this app *choose* which window a
new tab joins, or force one at all. Whether same-identifier windows actually merge into one tab
group is entirely up to the user's own macOS "Prefer tabs when opening documents" setting (System
Settings > Desktop & Dock) once `tabbing_identifier` is the only lever pulled — tao exposes no
`tabbingMode` setter and no `addTabbedWindow:ordered:`. Since File > New and File > Open both need
to *deterministically* join the focused window's group regardless of that system setting (that's
the whole point of "New opens a tab, not a window"), this app has to call
`-[NSWindow addTabbedWindow:ordered:]` itself — which means going straight through objc2, the only
route tao/Tauri leave open to it. `group_as_tab` in `src-tauri/src/lib.rs` is the one place that
happens; `objc2`/`objc2-app-kit` are pinned in `src-tauri/Cargo.toml` to the exact versions already
resolved transitively through tao (verify with `cargo tree -p objc2 -i` — everything should
converge on one copy), so cargo unifies onto a single `NSWindow` type rather than linking two
incompatible copies of the objc2 runtime.

*Why tab switching didn't.* Select Next/Previous Tab, Merge All Windows, and friends are *also*
AppKit features with no tao equivalent — but unlike grouping, Tauri already wraps the one call
that's needed: `Submenu::set_as_windows_menu_for_nsapp()`. Registering a plain "Window" submenu
(Minimize + Zoom, the usual native pair) this way makes macOS append the whole tab-switching UI
automatically, no objc2 required. That asymmetry — raw AppKit for grouping, a one-line Tauri call
for switching — is why the two ended up implemented so differently rather than either both getting
custom AppKit code or both being skipped.

*Why group membership is queried, not tracked.* `close_window_group`/`tab_group_labels` ask
AppKit's `tabbedWindows` fresh every time Close Window runs, rather than consulting some
`Mutex<HashMap<String, Vec<String>>>` this crate maintained itself. A tracked map was tempting —
it would avoid the `run_on_main_thread` round trip — but the user can drag a tab out of a group
into its own window, or drag it into a *different* group, entirely through the OS's own tab UI,
with no event this app can observe. Any Rust-side copy of "which tabs are in which group" would
start drifting out of sync the first time that happens, and Close Window is exactly the feature
where acting on a stale group (closing tabs that already left, or missing ones that joined) would
be visibly wrong. Querying AppKit directly means the answer is never stale, at the cost of one
`run_on_main_thread` hop per Close Window press — a price paid only when the feature is actually
used, not on every tab open/drag.

All of the AppKit-touching code (`group_as_tab`, `tab_group_labels`, `assert_tab_bar_visible`,
`assert_tab_bar_visible_on_focus`, `SendableNsWindow`) runs its actual message sends inside
`AppHandle::run_on_main_thread`, never assuming the caller is already on the main thread — AppKit
itself isn't thread-safe, so this matters regardless of how confident the call site looks. In
practice, every call site (the menu-event handler, the `open_path_in_new_tab` command, and the
`on_window_event` handler) already runs on the main thread as of this writing — Tauri's own
`tauri-runtime-wry` detects that and runs the closure immediately in place rather than queuing it
— but `run_on_main_thread` is what keeps that an implementation detail instead of a correctness
requirement this code would silently break if it ever stopped being true.

**11. The tab bar is forced visible for single-tab groups, at the cost of a known gap around
drag-out — investigated, not assumed, and the tradeoff is deliberate.** macOS hides a window's
tab bar whenever its group has exactly one window, which turns out to be a real bug for this app,
not a cosmetic one: with the bar hidden there's no drop target to drag a second tab onto (or drag
the lone tab off of), so a solo window can get stuck permanently undraggable in either direction.
`assert_tab_bar_visible` (`src-tauri/src/lib.rs`) overrides this — check
`tabGroup()?.isTabBarVisible()`, call `toggleTabBar:` only if it's false — using the same
`SendableNsWindow`/`run_on_main_thread` pattern `group_as_tab` established, and always checking
first for the same reason: `toggleTabBar:` toggles, so calling it unconditionally on an
already-visible bar would hide it.

Three things had to be worked out rather than assumed:

*Timing.* `NSWindow.tabGroup()`'s own doc comment calls it "lazily created on demand," which
raised the question of whether it's reliably non-nil immediately after
`WebviewWindowBuilder::build()` returns, before the window is fully on screen, or whether the
assert has to be deferred. Without an interactive way to test this (verifying it would mean
running the actual app, which is outside what this change could do), the honest answer is: not
fully confirmed either way. The design leans on two things instead of one single assumption
holding: this app never builds a window with `.visible(false)`, so `build()` returning already
means the OS's window-creation call has completed, which is the more likely place for
lazy-initialization to be forced regardless of on-screen compositing state — and, as a backstop
regardless of whether that reasoning holds, `assert_tab_bar_visible_on_focus` (below) re-checks
the same window on its very next focus event, which for a just-created window is normally within
milliseconds. A single missed assert right after `build()` is not a dead end.

*Every path that forms a group.* `create_document_window` asserts on the window it just built —
covering New, New Window, and Open's new-tab case — after any `group_as_tab` call, so it applies
whether the window joined an existing group or started a new one. The one document window
`create_document_window` never builds is the startup window declared in `tauri.conf.json`
(labeled `"main"`), so `setup()` fetches it by label and asserts on it directly.

*Drag-out.* When the user drags the last tab out of a group, AppKit forms a brand-new group on
its own — no `WebviewWindowBuilder::build()` call happens, so there's no creation-time hook to
assert from. The chosen backstop is `WindowEvent::Focused(true)` on the app-wide
`on_window_event` handler already in `run()` (a freshly detached window becomes key essentially
immediately after the drag completes), reusing an already-registered event rather than adding a
new one. This is where "don't fight the user" (point 4 below) became the binding constraint: an
*unconditional* reassert on every focus would also pop a tab bar the user just deliberately hid
(via Cmd-Shift-\ or the tab bar's own right-click menu — this app has no View menu, so those are
the only ways to hide it) back open the next time they click into that window, which would be a
new, self-inflicted annoyance in exchange for fixing the original one. `TabGroupSeen` — a
`Mutex<HashMap<String, usize>>` keyed by window label, storing the tab group's own pointer
address, managed as Tauri state — exists purely to gate this: `assert_tab_bar_visible_on_focus`
only reasserts when the focused window's current tab group is a *different* object than the one
last recorded for its label, which is what a drag-out (or a merge) produces and a plain refocus of
an unchanged group does not. Pointer identity was chosen over
`NSWindowTabGroup.identifier()` deliberately — nothing here confirms whether that identifier
string actually varies per physical group, and every group is unambiguously a distinct
Objective-C object either way, so comparing objects can't be wrong the way comparing an
unverified string could be.

**Known gap, called out rather than silently accepted:** if a tab is dragged out and then
dragged back into a group that AppKit happens to represent with the exact same `NSWindowTabGroup`
object it started in, `TabGroupSeen` reads that as "unchanged" and skips the reassert. Whether
AppKit ever actually does that — reusing a group object across a detach-and-rejoin, as opposed to
always minting a fresh one — was not established, again for lack of a way to test it
interactively as part of this change. `TabGroupSeen` is explicitly *not* a general group-
membership map (see `tab_group_labels`'s own doc comment for why membership itself is always
queried fresh, never tracked) — it is scoped as narrowly as possible, to just this one
change-detection job, specifically so a wrong guess here stays contained to "the tab bar
occasionally doesn't force itself back on after an edge-case drag sequence" rather than
resurfacing the stale-group bugs that design decision was written to avoid.

**12. Every custom menu item is declared once, in `menu.json`, which both languages read — and
the menu is still built in Rust.** An item used to be written out four times: a
`MenuItemBuilder` in `build_menu`, a `match` arm on its id in `on_menu_event`, the
`"menu-<id>"` string that arm emitted, and the listener for that same string in `main.ts`. All 23
arms of that match were identical modulo the string — the whole block computed
`format!("menu-{id}")` — and a fifth copy existed as prose in `src/shortcuts.ts`. Every one of
those copies could be mistyped with **no compile error, no runtime error and no symptom**: the
menu item drew perfectly and did nothing when clicked. That is the failure this exists to make
unrepresentable, and it's worth being precise about how: the point isn't that four copies are
tedious to update, it's that nothing anywhere could tell you they disagreed.

`menu.json` carries each item's id, label, accelerator, submenu, whether a separator precedes it,
and a one-line description. Rust embeds it with `include_str!` and deserializes it with serde
(`build_menu` builds the custom items from it; `on_menu_event`'s dispatch is now a single
`emit_to(label, menu_event_name(id))`); `src/menu.ts` imports the same file for the frontend.
A **shared file, not a generator**: codegen would have made the two sides agree at the moment the
generator last ran, whereas reading the same bytes makes disagreement unrepresentable rather than
merely detectable, and it costs one JSON parse at startup.

Four consequences worth knowing before editing any of this:

- **The menu is still built in Rust, and design note 1 above still binds.** This moved the
  strings, not the construction. A JS-built menu's `action` callback runs in the webview that
  built the menu, so File > Save saves the wrong document as soon as a second window exists.
  Adding an item to `menu.json` does not make it a frontend concern.
- **Predefined native items are deliberately not in the manifest.** Cut/Copy/Paste, About,
  Services, Hide, Minimize, Zoom and everything macOS appends to the Window menu are routed by
  the OS through the responder chain to the focused window, with no app code involved — they have
  no id to dispatch and no event to listen for. The manifest covers the custom items, which are
  exactly the ones this app has to route itself.
- **Behaviour can't be serialised, so it stays in TypeScript** — `src/actions.ts`, keyed by the
  manifest's own ids, with a test asserting every id either has a handler or is one of the five
  window-level items Rust routes itself (`new`, `new-window`, `close-tab`, `close-window`,
  `quit`). Those five keep their explicit branches in `on_menu_event` because each does something
  genuinely different with *windows*, which is not a matter of asking one document's frontend a
  question.
- **A manifest that's wrong is a build failure, not a runtime surprise.** `src-tauri/build.rs`
  parses and validates the same file (through `serde_json::Value`, deliberately not through the
  crate's own structs — an independent reading is the only kind that can disagree) before the
  crate compiles, so malformed JSON, a misspelled field name, a duplicate id or a dangling
  submenu reference fails `cargo check`. A misspelled `"acclerator"` would otherwise deserialize
  happily into an item with no accelerator and no complaint.

The Help ▸ Keyboard Shortcuts sheet is the fifth consumer: it derives its app rows from this
manifest and its library rows from `CONCORD_KEYSTROKES` (exported from `@andrewshell/outliner`
for exactly this), so it can no longer drift from either. It had — `Cmd-F`, `Cmd-G`, `Cmd-Shift-N`,
`Cmd-W`, `Cmd-Shift-W` and `Cmd-Q` were all bound and undocumented, and `Cmd-,` was filed under
the app's own group though the library binds it. What stays hand-written there is only what
neither source contains: which group a shortcut belongs in, what order the rows read in, and what
each library command does.

## Known limitations

- The always-visible tab bar's drag-out backstop has one theoretical edge case: dragging a tab
  out and immediately back into a group AppKit represents with the exact same object it started
  in would be read as "unchanged" and skip re-forcing the bar visible. Not confirmed to actually
  happen — see design note 11 above for the full reasoning and why the risk was scoped narrowly
  on purpose rather than left unaddressed.
- No autosave and no crash recovery — the unsaved-changes prompt is the only safety net.
- No recent-files list, and every new/opened window starts from the same in-app pickers; the
  app can't yet be launched (or handed a file) by double-clicking an `.opml` file in Finder.
- Help → Keyboard Shortcuts has no keyboard accelerator of its own. The conventional `Cmd-/`
  is already bound to the outliner's `run-selection`, and a menu accelerator would shadow it.
- Outliner menu items are never greyed out based on document state (e.g. Dehoist when nothing is
  hoisted, the way Drummer greys it out). Keeping that in sync would need a frontend→Rust round
  trip on every cursor move just to answer "does this apply right now" — skipped. The underlying
  library methods (`hoist`/`deHoist`) already return `false` harmlessly when they don't apply, so
  clicking one of these when it doesn't make sense is a no-op rather than an error.
