# GeekityFlow (desktop)

**GeekityFlow** is a Tauri v2 desktop app (workspace package `outliner-desktop`, bundle
identifier `com.geekity.flow`) that mounts `@andrewshell/outliner` full-window. It's
chrome-free — no toolbar — because the outliner is keyboard-driven; everything that would be a
toolbar button is a menu item or a keystroke instead. **Help → Keyboard Shortcuts** opens an
in-app modal listing them.

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

The app is multi-document: **File > New** and **File > Open…** each get their own window rather
than replacing what's in the current one.

- **New** (`Cmd/Ctrl-N`) — always opens a brand-new blank window. Handled entirely in Rust
  (`create_document_window` in `src-tauri/src/lib.rs`) with no round trip to any frontend, since
  a blank document needs no state that only JS has.
- **Open…** (`Cmd/Ctrl-O`) — native file picker runs in the focused window, then:
  - if that window is a **blank, untouched Untitled document** (no path *and* not dirty),
    the chosen file loads into it in place — there's nothing to lose.
  - otherwise (it has a path, or is dirty, or both), that window's document is left completely
    alone and the file opens in a **new** window instead.
- **Close Window** (`Cmd/Ctrl-W`) — closes just the focused window, running the same
  unsaved-changes prompt as the native close button (traffic-light / titlebar close). Closing
  the last open window quits the app — this is Tauri's default behavior on every platform, so
  there's no custom "reopen on Dock click" handling.
- **Save** (`Cmd/Ctrl-S`) — writes to the current path, or falls through to Save As if there
  isn't one yet.
- **Save As…** (`Cmd/Ctrl-Shift-S`) — native save picker, updates the OPML `<head><title>` to
  the new file's basename, then writes.
- **Quit** (`Cmd/Ctrl-Q`) — checks *every* open window, not just the focused one. If none are
  dirty, the app exits immediately. Otherwise Rust works through the dirty windows one at a
  time: focus the window, ask its frontend to run the same unsaved-changes prompt Close Window
  uses, and wait for an answer before moving on. Cancel at any window aborts the whole quit —
  nothing else is prompted and no window closes. Save or Don't Save moves on to the next dirty
  window (a failed or cancelled Save aborts the quit, same as Close Window). Once every dirty
  window is resolved, the app exits. See "Design notes" below for why this needed a custom menu
  item and a Rust-side dirty-state map, not just an `ExitRequested` handler.

Because Open never discards a window's content — it either loads into an already-blank window
or opens a new one — only the window's native close path and Quit still need the unsaved-changes
guard. That prompt (**Save / Don't Save / Cancel**, via an in-app `<dialog>` — the dialog plugin's
`ask`/`confirm` are two-button only and have no room for Cancel) lives in `confirmClose()` (Close
Window / the traffic light) and `confirmQuit()` (Quit) in `src/document.ts`, both built on the
same `confirmDiscard()` prompt. Choosing Save actually saves before proceeding, and aborts the
whole close/quit if that save is cancelled or fails. Read/write errors surface through the dialog
plugin's `message()` rather than a thrown promise. The window title tracks the current file and
gets a leading `•` while the document is dirty.

Each window is its own Tauri webview with its own JS realm, so `document.ts`'s module-level
`outliner`/`currentPath` state is automatically per-window — no registry keyed by window label
is needed to keep multiple documents' state apart.

## Menu layout

- **GeekityFlow** (macOS app menu) — About, Services, Hide/Hide Others/Show All (all predefined),
  and Quit (`Cmd/Ctrl-Q`, deliberately a *custom* item, not predefined — see "Design notes" below
  for why).
- **File** — New, Open…, Save, Save As…, Close Window (see above).
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
- **Help** — Keyboard Shortcuts (no accelerator; opens the shortcuts modal).

## Design notes

Nine choices here look like omissions or overengineering but aren't — please don't "fix" them
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
event like every other custom item here (see the "quit" `MenuItemBuilder` in `build_menu` and
the `"quit"` case in `on_menu_event`), which keeps Cmd-Q inside code this app controls instead of
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
prompt in and no way to ever quit. `advance_quit` in `lib.rs` also defends against this same
staleness independently (a window can vanish between reading the map and looking it up), but the
`Destroyed` cleanup is what keeps the map from accumulating stale entries in the first place.

One more wrinkle worth knowing about if you're reading `advance_quit`/`quit_response`: the quit
flow's own `app.exit(0)` at the end triggers `RunEvent::ExitRequested` right back into the
handler design note 7 describes. If the dirty map still said "dirty" at that moment, the app
would refuse to quit against its own exit call. The fix isn't a bypass flag — it's making the
state honest: when the user picks Don't Save during a quit prompt, `confirmQuit()` in
`document.ts` actually calls `outliner.clearChanged()` (which `confirmClose()`'s "discard" branch
doesn't need to, since closing the window drops its map entry anyway via the `Destroyed` cleanup
above). By the time `advance_quit` calls `app.exit(0)`, the map is genuinely empty, so
`ExitRequested`'s dirty check passes it through cleanly.

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

## Known limitations

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
