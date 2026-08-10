import { createOutliner } from '@andrewshell/outliner'
import '@andrewshell/outliner/styles.css'
import './styles.css'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import {
  initDocument,
  openPathAtBoot,
  openDocument,
  saveDocument,
  saveDocumentAs,
  confirmClose,
  confirmQuit,
  reportError,
} from './document'
import { showShortcuts } from './shortcuts'
import { promptFind, findAgain } from './find'

// Chrome-free: no toolbar, no buttons. The menu (built in Rust, see
// src-tauri/src/lib.rs) and this module are the only things that call into
// document.ts.
const container = document.getElementById('app') as HTMLElement
const outliner = createOutliner(container)
initDocument(outliner)

// A window spawned for a specific file (via File > Open, see
// create_document_window in lib.rs) gets that file's path in its URL query
// string rather than as a post-creation event — an event could arrive
// before this window's listen() calls below are registered, silently
// dropping it. The query string has no such race: it's already present
// when this script starts running.
const bootPath = new URLSearchParams(location.search).get('path')
if (bootPath) void openPathAtBoot(bootPath)

const appWindow = getCurrentWindow()

// True while this window has an unsaved-changes prompt open, whether from
// Close Window/the traffic light (closeWindow()) or from Cmd-Q (handleMenuQuit()
// below). Guards against the two racing each other and stacking a second
// <dialog> on top of the first — e.g. Cmd-Q arriving for this window while
// its own Close Window prompt is still awaiting an answer. Rust's
// QuitInProgress flag (src-tauri/src/lib.rs) already stops a second Cmd-Q
// from starting a second *quit flow*, but that doesn't cover this
// window-local case, since Close Window's prompt isn't part of any quit
// flow at all.
let unsavedPromptOpen = false

// Shared by the Close Window menu item (via the 'menu-close-window'
// listener below) and the native close button's guard further down, so
// both routes run the same unsaved-changes prompt before actually closing.
async function closeWindow(): Promise<void> {
  if (unsavedPromptOpen) return
  unsavedPromptOpen = true
  try {
    if (await confirmClose()) {
      // destroy() needs its own core:window:allow-destroy grant (core:default
      // only covers read-only window commands, see the README's "Design
      // notes"). If that's ever missing again, report it instead of leaving
      // the close button silently doing nothing, as it did before this was
      // caught.
      try {
        await appWindow.destroy()
      } catch (err) {
        await reportError('close', 'window', err)
      }
    }
  } finally {
    unsavedPromptOpen = false
  }
}

// Rust's quit flow (advance_quit in src-tauri/src/lib.rs) emits this to one
// dirty window at a time and waits for quit_response before moving on to
// the next one or exiting — see the README's "Quit" design note for the
// full flow. confirmQuit() (not confirmClose()) runs the actual prompt: it
// reuses the same confirmDiscard() UI, but on "Don't Save" it also clears
// this document's changed state, which confirmClose()'s callers don't need
// since they destroy the window right after instead of leaving it open.
async function handleMenuQuit(): Promise<void> {
  if (unsavedPromptOpen) {
    // Another prompt already owns this window's dialog (Close Window
    // racing a Cmd-Q aimed at the same window — see unsavedPromptOpen's
    // comment above). Report "cancel" rather than leaving Rust's quit flow
    // waiting for a response that would otherwise never come: aborting the
    // quit is always the safe outcome here, never a silent data loss.
    await invoke('quit_response', { label: appWindow.label, proceed: false })
    return
  }
  unsavedPromptOpen = true
  let proceed: boolean
  try {
    proceed = await confirmQuit()
  } finally {
    unsavedPromptOpen = false
  }
  await invoke('quit_response', { label: appWindow.label, proceed })
}

// The app menu lives entirely in Rust (src-tauri/src/lib.rs) because a JS
// menu's action callbacks run in the webview that *created* the menu — the
// wrong window as soon as a second one opens, and a dead one once that
// window closes. Rust resolves whichever window is focused and emits these
// events to it specifically (emit_to, not a broadcast emit), so each event
// always lands on the one document the user is actually looking at.
// listen() needs no extra *permission* — core:event:default comes with
// core:default — but it does need the capability to apply to this window at
// all. capabilities/default.json originally scoped itself to `"windows":
// ["main"]`, which silently left every Rust-created window (win-1, win-2,
// ...) with no permissions: listen() was denied, so the whole menu was dead
// in second and subsequent windows. It's a `"*"` glob now. Permission and
// window scope are two separate gates; granting one doesn't grant the other.
void listen('menu-open', () => void openDocument())
void listen('menu-save', () => void saveDocument())
void listen('menu-save-as', () => void saveDocumentAs())
void listen('menu-keyboard-shortcuts', () => void showShortcuts())
void listen('menu-close-window', () => void closeWindow())
// 'quit' is the one menu item Rust doesn't resolve a focused window for
// before emitting (see build_menu's "quit" MenuItemBuilder doc comment) —
// it's targeted at specific dirty windows one at a time instead, which may
// or may not include this one.
void listen('menu-quit', () => void handleMenuQuit())

// Outliner menu: every no-argument operation maps straight to a library
// call, so they're driven from a table instead of a growing if/else chain —
// see the Outliner section of README.md's "Menu layout" for what each one
// does. expand()/collapse() call markChanged() internally (expansion state
// is part of the saved OPML), so these legitimately mark the document dirty
// and the title's `•` picks that up like any other edit — nothing here
// needs to suppress that.
const OUTLINER_ACTIONS: Record<string, () => void> = {
  'menu-expand': () => outliner.expand(),
  'menu-collapse': () => outliner.collapse(),
  'menu-expand-all-subs': () => outliner.expandAllSubs(),
  'menu-expand-everything': () => outliner.expandEverything(),
  'menu-collapse-everything': () => outliner.collapseEverything(),
  'menu-hoist': () => outliner.hoist(),
  'menu-dehoist': () => outliner.deHoist(),
}
for (const [event, action] of Object.entries(OUTLINER_ACTIONS)) {
  void listen(event, action)
}
// Find… and Find again are the odd ones out: they need UI (a prompt for
// Find…) or extra state (Find again has to know whether a search has
// happened yet), so they're routed to find.ts instead of the flat table
// above.
void listen('menu-find', () => void promptFind(outliner))
void listen('menu-find-again', () => void findAgain(outliner))

// The native close button (red traffic light) doesn't go through the menu
// at all, so it needs its own guard here.
void appWindow.onCloseRequested(async (event) => {
  event.preventDefault()
  await closeWindow()
})
