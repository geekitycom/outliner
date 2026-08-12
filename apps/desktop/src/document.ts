// Owns the current file path and dirty state, and three of the four file
// operations the menu (in src-tauri/src/lib.rs) drives: Open, Save, Save
// As. New is the odd one out — it always opens a brand-new tab and needs no
// state from this module, so Rust creates that tab directly with no round
// trip through here (see create_document_window in lib.rs).
//
// Module-level state (`outliner`, `currentPath` below) is safe per-tab: each
// Tauri window (and, now that this app has native tabs, each tab IS a
// window — see the README's "Multi-window" section) is a separate webview
// with its own JS realm, so there's exactly one copy of this module's state
// per tab automatically — no registry keyed by window label is needed.
import type { Outliner } from '@andrewshell/outliner'
import { EMPTY_OPML } from '@andrewshell/outliner'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open, save, message } from '@tauri-apps/plugin-dialog'
import { confirmDiscard } from './modal'

const OPML_FILTERS = [{ name: 'OPML', extensions: ['opml', 'xml'] }]

// Assigned once by initDocument(); every other export assumes it has run
// first, same precondition as calling any other method on a torn-down
// Outliner instance.
let outliner: Outliner
let currentPath: string | null = null

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

/**
 * What the user calls this document — its filename, or "Untitled" if it has
 * never been saved. Used for the window title and to name the document in
 * the unsaved-changes prompt, which matters when the quit flow walks several
 * open windows one at a time.
 */
function documentName(): string {
  return currentPath ? basename(currentPath) : 'Untitled'
}

/** Parses OPML/XML, surfacing malformed markup instead of loading garbage. */
function parseOpml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('not valid XML')
  }
  return doc
}

/**
 * Shared error surface for both file I/O failures and rejected Tauri
 * commands (e.g. a window permission that's missing from
 * capabilities/default.json — see the README's "Design notes" section).
 * `path` is used verbatim as the message's subject, not necessarily a
 * filesystem path.
 */
export async function reportError(action: string, path: string, err: unknown): Promise<void> {
  await message(`Could not ${action} "${basename(path)}": ${String(err)}`, {
    title: 'GeekityFlow',
    kind: 'error',
  })
}

// Last dirty value pushed to Rust via set_dirty, compared against on every
// syncTitle() call so the IPC call only fires when the value actually
// *changes* — syncTitle() runs on every keystroke (see initDocument below),
// and Rust's quit flow only needs to know when a window's dirty state
// flips, not a running commentary on every character typed.
let lastSentDirty: boolean | null = null

function syncTitle(): void {
  const dirty = isDirty()
  // Just the document's name, with no app-name suffix on unsaved documents:
  // this string is the *tab* label now, not only the window title, and
  // "Untitled — GeekityFlow" next to a plain "testing.opml" reads as
  // inconsistent while eating tab width that the filename needs.
  const base = documentName()
  const title = dirty ? `• ${base}` : base
  // setTitle() needs its own core:window:allow-set-title grant (core:default
  // only covers read-only window commands) — if that permission ever
  // regresses, fail loudly to devtools instead of silently, as it did
  // before this was caught.
  getCurrentWindow()
    .setTitle(title)
    .catch((err: unknown) => {
      console.error('setTitle failed:', err)
    })

  if (dirty !== lastSentDirty) {
    lastSentDirty = dirty
    // set_dirty is an app-defined command (like read_file/write_file), not
    // a plugin command, so it isn't ACL-gated — no capability entry needed.
    // Rust keeps its own copy of this window's dirty flag because the quit
    // flow (Cmd-Q, see main.ts's 'menu-quit' listener) has to know *before*
    // prompting anything whether there's anything to prompt about, and Rust
    // has no way to reach into this window's JS state on its own.
    invoke('set_dirty', { label: getCurrentWindow().label, dirty }).catch((err: unknown) => {
      console.error('set_dirty failed:', err)
    })
  }
}

export function isDirty(): boolean {
  return outliner.hasChanged()
}

/**
 * Wires the outliner up to dirty tracking and title sync, then loads a
 * blank document. Call once, right after mounting.
 */
export function initDocument(instance: Outliner): void {
  outliner = instance

  outliner.setCallbacks({
    // Structural ops (promote, reorg, delete, undo, ...) mutate the DOM
    // directly rather than through contenteditable, so they never fire an
    // `input` event below. opKeystroke fires *before* op.ts runs the
    // command it names, so the resync is deferred a tick with
    // queueMicrotask — by the time it runs, the op (and its own
    // markChanged() call, if any) has already happened.
    opKeystroke: () => queueMicrotask(syncTitle),

    // Mouse-driven expand/collapse (double-click a bullet, or a single
    // click in readonly mode) goes through op.ts's expand()/collapse(),
    // which fires this callback *before* the class mutation and before its
    // own markChanged() call — same ordering as opKeystroke above, so the
    // same queueMicrotask deferral is required (verified in op.ts, not
    // assumed).
    opExpand: () => queueMicrotask(syncTitle),
    opCollapse: () => queueMicrotask(syncTitle),

    // Deliberately NOT wiring opReorg here: verified in events.ts that a
    // mouse drag-reorder never calls op.reorg() at all — the `mouseup`
    // handler splices the DOM nodes directly and calls
    // editor.dragModeExit(), which sets the changed flag itself but fires
    // no callback. opReorg only fires for *keyboard*-driven reorganize
    // (Cmd-arrows, see keyboard.ts), which is already covered by
    // opKeystroke above, so wiring it would be dead code for the mouse
    // case this fix targets — the real fix for mouse drag is the `mouseup`
    // listener below.
    //
    // Deliberately NOT wiring opHover: it fires on every mousemove over a
    // headline, which would turn every hover into a title-bar write.
  })

  // markChanged() is only called by structural operations in op.ts — plain
  // text edits never reach it, so hasChanged() alone misses them. An `input`
  // event is the one signal every text edit fires.
  //
  // Bound to `root`, not `container`: the title row (prefs.titleRow, enabled
  // in main.ts) is a sibling of root *inside* container, so a container-level
  // listener would also mark the document dirty for every keystroke typed
  // into it — including an edit the user then cancels with Esc, leaving a
  // document that claims unsaved changes it doesn't have. A committed title
  // edit still marks the document changed: the library's own commit path
  // calls markChanged() itself (titleRow.ts), for both the root-title and
  // hoisted-rename cases — Op.setTitle alone does not.
  outliner.root.addEventListener('input', () => {
    outliner.markChanged()
    syncTitle()
  })

  // Mouse drag-reorder sets the changed flag via editor.dragModeExit() (see
  // the opReorg note above) but fires no callback to observe it. Catch it
  // with our own `mouseup` listener instead: `container` is a strict
  // ancestor of the library's `root` <ol> (outliner.ts creates `root`
  // inside `container`), so a bubbled `mouseup` here always runs *after*
  // the library's own root-level `mouseup` handler — including its call to
  // dragModeExit() — which means markChanged() has already completed by
  // the time syncTitle() below reads hasChanged(). No queueMicrotask
  // needed. Firing on every mouseup (not just drags) is harmless: syncTitle
  // is cheap and idempotent when nothing changed.
  outliner.container.addEventListener('mouseup', () => syncTitle())

  currentPath = null
  outliner.loadOpml(EMPTY_OPML)
  outliner.clearChanged()
  syncTitle()
}

/**
 * Runs the unsaved-changes prompt when the document is dirty and reports
 * whether it's safe to proceed — with the Save choice actually saved first,
 * and the whole thing aborted if that save is itself cancelled or fails.
 * Used by the window's own close guard (closeTab() in main.ts, for the
 * traffic light and the predefined Close Tab menu item) and, via this
 * window's 'menu-close-window-group' listener, by Rust's Close Window
 * flow when walking a tab group (see close_window_group in lib.rs) — New
 * and Open never need it: New always opens a fresh tab (nothing here to
 * discard) and Open either loads into an already-blank tab or opens a new
 * one, so neither ever discards this window's content.
 */
export async function confirmClose(): Promise<boolean> {
  if (!isDirty()) return true
  const choice = await confirmDiscard(documentName())
  if (choice === 'cancel') return false
  if (choice === 'save') return saveDocument()
  return true // discard
}

/**
 * Runs the same unsaved-changes prompt as confirmClose(), for a window
 * Rust's Quit flow (the state machine in src-tauri/src/flow.rs, run by
 * run_flow in lib.rs) has singled out as dirty in response to Cmd-Q. Not just confirmClose()
 * reused as-is, because the two callers need different things done with a
 * "discard" choice:
 *
 * - confirmClose()'s callers (closeTab() in main.ts for the traffic light/
 *   Close Tab; flow_response in lib.rs, via this window's own
 *   'menu-close-window-group' listener, for Close Window's tab-group walk)
 *   both destroy this window right after a truthy result, which drops its
 *   entry from Rust's dirty map on its own (see the Destroyed handler in
 *   lib.rs) — nothing further to clean up here.
 * - This window stays *open* through a quit — Rust works through every
 *   dirty window in turn, only exiting once they're all resolved, and
 *   "Don't Save" doesn't close anything. So the changed flag has to be
 *   cleared explicitly here: otherwise the window would still read as
 *   dirty when the quit flow's final app.exit(0) call re-triggers Rust's
 *   own ExitRequested check, which would then refuse to exit an app whose
 *   own quit flow just finished successfully. Making the state honest here
 *   (rather than giving Rust a "trust me" bypass flag) is what keeps that
 *   from happening.
 */
export async function confirmQuit(): Promise<boolean> {
  if (!isDirty()) return true
  const choice = await confirmDiscard(documentName())
  if (choice === 'cancel') return false
  if (choice === 'save') return saveDocument()
  // discard: see doc comment above for why this clears the flag itself
  // instead of leaving it to whatever closed the window in confirmClose()'s
  // case (nothing closes this window during a quit).
  outliner.clearChanged()
  syncTitle()
  return true
}

/**
 * Reads `path` from disk and loads it into *this* window in place, on the
 * assumption that whatever was here before is safe to discard (callers are
 * responsible for that: either it's an untouched blank document, or this is
 * a brand-new window that never had anything else in it).
 */
async function loadFromDisk(path: string): Promise<void> {
  let contents: string
  try {
    contents = await invoke<string>('read_file', { path })
  } catch (err) {
    await reportError('open', path, err)
    return
  }

  let doc: Document
  try {
    doc = parseOpml(contents)
  } catch {
    await reportError('open', path, 'not a valid OPML file')
    return
  }

  outliner.loadOpml(doc)
  outliner.clearChanged()
  currentPath = path
  syncTitle()
}

/**
 * Loads `path` at window startup — main.ts calls this when it finds a
 * `?path=` query param, which is how a window created by Open (see below)
 * or by a future "open with" integration learns what to load. No
 * confirmClose() guard: the window just booted, so there's nothing in it
 * yet to discard.
 */
export async function openPathAtBoot(path: string): Promise<void> {
  await loadFromDisk(path)
}

/**
 * File > Open. Shows the native picker, then either loads the chosen file
 * into this window or hands it to a new tab grouped with this one,
 * depending on whether this window already "belongs" to a document:
 *
 * - blank AND untouched (no path, not dirty) — nothing to lose, load here.
 * - anything else (has a path, or is dirty, or both) — this window's
 *   document is left completely alone and the new file opens in a new tab
 *   instead (see open_path_in_new_tab in src-tauri/src/lib.rs — it groups
 *   the new tab with whichever window invoked this command, i.e. this
 *   one). That means no confirmClose() prompt on this path either: we're
 *   not discarding this window's content, just not touching it.
 */
export async function openDocument(): Promise<void> {
  const selected = await open({ filters: OPML_FILTERS })
  if (typeof selected !== 'string') return // dialog cancelled

  if (currentPath === null && !isDirty()) {
    await loadFromDisk(selected)
    return
  }

  try {
    await invoke('open_path_in_new_tab', { path: selected })
  } catch (err) {
    await reportError('open', selected, err)
  }
}

export async function saveDocument(): Promise<boolean> {
  if (!currentPath) return saveDocumentAs()

  try {
    await invoke('write_file', { path: currentPath, contents: outliner.toOpml() })
  } catch (err) {
    await reportError('save', currentPath, err)
    return false
  }
  outliner.clearChanged()
  syncTitle()
  return true
}

export async function saveDocumentAs(): Promise<boolean> {
  const selected = await save({ defaultPath: currentPath ?? undefined, filters: OPML_FILTERS })
  if (!selected) return false // dialog cancelled

  // Give the saved file a sensible <head><title> when it doesn't have one of
  // its own — but never overwrite a title the user set.
  //
  // This used to assign the filename unconditionally. That was harmless when
  // the OPML title had no UI at all, and became data loss the moment the
  // title row made it visible and editable: type a title, save, and Save As
  // silently replaced it with the filename. Only a document still carrying
  // the untouched default gets the filename now.
  const current = outliner.getTitle().trim()
  if (current === '' || current === 'Untitled') {
    outliner.setTitle(basename(selected))
  }

  try {
    await invoke('write_file', { path: selected, contents: outliner.toOpml() })
  } catch (err) {
    await reportError('save', selected, err)
    return false
  }
  currentPath = selected
  outliner.clearChanged()
  syncTitle()
  return true
}
