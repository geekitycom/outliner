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

## File operations

- **New** (`Cmd/Ctrl-N`) — loads a blank document.
- **Open…** (`Cmd/Ctrl-O`) — native file picker, reads the chosen `.opml`/`.xml` file, parses
  it as OPML.
- **Save** (`Cmd/Ctrl-S`) — writes to the current path, or falls through to Save As if there
  isn't one yet.
- **Save As…** (`Cmd/Ctrl-Shift-S`) — native save picker, updates the OPML `<head><title>` to
  the new file's basename, then writes.

New and Open discard the current document, so both go through `confirmClose()` first when it's
dirty, which prompts **Save / Don't Save / Cancel** via an in-app `<dialog>` (the dialog
plugin's `ask`/`confirm` are two-button only, so this can't be the plugin's own prompt).
Choosing Save there actually saves before proceeding, and aborts the whole operation if that
save is cancelled or fails. The same prompt guards the window's close button. Read/write errors
surface through the dialog plugin's `message()` rather than a thrown promise. The window title tracks the current file and gets a leading `•` while the document is
dirty — see `src/document.ts` for how dirty state is kept in sync with typing, mouse-driven
structural edits, and save/load.

## Menu layout

- **Outliner** (macOS app menu) — About, Services, Hide/Hide Others/Show All, Quit
  (all predefined).
- **File** — New, Open…, Save, Save As… (see above).
- **Edit** — Cut, Copy, Paste only. See "Design notes" below for why Undo and Select All are
  deliberately absent.
- **Help** — Keyboard Shortcuts (no accelerator; opens the shortcuts modal).

## Design notes

Three choices here look like omissions but aren't — please don't "complete" them without
reading this first.

**1. The Edit menu has no Undo or Select All.** On macOS, the app menu gets first crack at a
key equivalent. The outliner's own keyboard handler
(`packages/outliner/src/keyboard.ts`) captures `Cmd-Z` (undo) and `Cmd-A` (select-all) with
`preventDefault()` — its own outline-level undo and select-all, not the browser's. A
predefined `Undo`/`SelectAll` menu item bound to those same accelerators would intercept the
keystroke at the OS menu layer before the webview ever sees it, silently breaking the
outliner's versions in favor of a no-op (or a native text-field undo/select that doesn't apply
here). Cut/Copy/Paste don't have this problem — the outliner's keyboard handler deliberately
lets those three fall through to the native handler — and WKWebView actually *needs* the menu
items present for its native clipboard handling to work at all, which is why those three (and
only those three) are predefined items in the Edit menu.

**2. `core:default` (in `capabilities/default.json`) only grants read-only window
permissions.** It includes things like `allow-title` and `allow-get-all-windows`, but *not*
`allow-set-title`, `allow-destroy`, `allow-set-size`, `allow-center`, `allow-minimize`, or any
other window command that changes state. A denied permission fails silently — the promise
rejects but nothing surfaces it by default — which is exactly how the window title (and its `•`
dirty marker) and the red traffic-light close button ended up doing nothing for a while: the app
called `setTitle()`/`destroy()` without either permission granted, and both call sites `void`-ed
the returned promise. Both are now covered by explicit `core:window:allow-set-title` and
`core:window:allow-destroy` entries, and both call sites now surface a rejection (see
`syncTitle()` in `src/document.ts` and the `onCloseRequested` handler in `src/main.ts`). Any
*new* window operation (`setSize`, `center`, `minimize`, `setFullscreen`, ...) needs its own
explicit `core:window:allow-*` entry added to `capabilities/default.json` — check
`src-tauri/gen/schemas/macOS-schema.json` for the exact permission string, and don't assume
`core:default` already covers it.

**3. File I/O uses two custom Rust commands (`read_file` / `write_file` in
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
- No recent-files list, and the app opens a blank document on every launch; it can't be
  launched by double-clicking an `.opml` file in Finder.
- Help → Keyboard Shortcuts has no keyboard accelerator of its own. The conventional `Cmd-/`
  is already bound to the outliner's `run-selection`, and a menu accelerator would shadow it.
