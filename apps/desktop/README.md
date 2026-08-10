# Outliner (desktop)

A Tauri v2 desktop app (package name `outliner-desktop`, identifier `com.geekity.outliner`)
that mounts `@andrewshell/outliner` full-window. It's chrome-free — no toolbar — because the
outliner is keyboard-driven; everything that would be a toolbar button is a menu item or a
keystroke instead. **Help → Keyboard Shortcuts** opens an in-app modal listing them.

## Running and building

From the repo root:

```bash
pnpm dev:desktop                                    # run it (opens a native window)
pnpm --filter outliner-desktop tauri build           # bundle a distributable .app / .dmg / etc.
```

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

Because Open never discards a window's content — it either loads into an already-blank window
or opens a new one — only the window's native close path still needs the unsaved-changes guard.
That prompt (**Save / Don't Save / Cancel**, via an in-app `<dialog>` — the dialog plugin's
`ask`/`confirm` are two-button only and have no room for Cancel) lives in `confirmClose()` in
`src/document.ts`. Choosing Save there actually saves before proceeding, and aborts the whole
close if that save is cancelled or fails. Read/write errors surface through the dialog plugin's
`message()` rather than a thrown promise. The window title tracks the current file and gets a
leading `•` while the document is dirty.

Each window is its own Tauri webview with its own JS realm, so `document.ts`'s module-level
`outliner`/`currentPath` state is automatically per-window — no registry keyed by window label
is needed to keep multiple documents' state apart.

## Menu layout

- **Outliner** (macOS app menu) — About, Services, Hide/Hide Others/Show All, Quit
  (all predefined).
- **File** — New, Open…, Save, Save As…, Close Window (see above).
- **Edit** — Cut, Copy, Paste only. See "Design notes" below for why Undo and Select All are
  deliberately absent.
- **Help** — Keyboard Shortcuts (no accelerator; opens the shortcuts modal).

## Design notes

Four choices here look like omissions or overengineering but aren't — please don't "fix" them
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

**5. File I/O uses two custom Rust commands (`read_file` / `write_file` in
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

## Known limitations

- No autosave and no crash recovery — the unsaved-changes prompt is the only safety net.
- No recent-files list, and every new/opened window starts from the same in-app pickers; the
  app can't yet be launched (or handed a file) by double-clicking an `.opml` file in Finder.
- Help → Keyboard Shortcuts has no keyboard accelerator of its own. The conventional `Cmd-/`
  is already bound to the outliner's `run-selection`, and a menu accelerator would shadow it.
