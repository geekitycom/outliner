import { createOutliner, UP, DOWN, LEFT, RIGHT } from '@andrewshell/outliner'
import '@andrewshell/outliner/styles.css'
import './styles.css'
import { getCurrentWindow } from '@tauri-apps/api/window'
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
// titleRow shows the OPML <head><title> above the outline, and the headline
// you're inside while hoisted — the one place that headline's text is
// visible at all, since hoisting shows its children rather than itself.
// Off by default in the library, so this app opts in explicitly.
const outliner = createOutliner(container, { prefs: { titleRow: true } })
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
// Close Tab/the traffic light (closeTab()) or from a Rust-driven flow —
// Cmd-Q or Close Window's tab-group walk (handleFlowPrompt() below).
// Guards against these racing each other and stacking a second <dialog> on
// top of the first — e.g. Cmd-Q arriving for this window while its own
// Close Tab prompt is still awaiting an answer. Rust's PendingFlow state
// (src-tauri/src/lib.rs) already stops a second Cmd-Q/Cmd-Shift-W from
// starting a second *flow*, but that doesn't cover this window-local case,
// since Close Tab's prompt isn't part of any Rust-driven flow at all.
let unsavedPromptOpen = false

// Shared by the native close button's guard further down and the File >
// Close Tab menu item. Neither needs its own listener here: the menu item
// is handled in Rust by calling Tauri's `close()` on the focused window
// (see the "close-tab" branch in on_menu_event), which fires the same
// `close-requested` event the red traffic-light button does — so both
// routes land in the onCloseRequested handler below and run this one
// unsaved-changes prompt before anything actually closes.
async function closeTab(): Promise<void> {
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

// Shared by Quit's per-window prompt and Close Window's per-tab prompt —
// both are Rust-driven flows (advance_flow in src-tauri/src/lib.rs) that
// emit an event to one window at a time and wait for flow_response before
// moving on to the next window (or finishing) — see the README's "Quit"
// design note for the full shape, which Close Window's tab-group walk
// reuses. `confirm` is which prompt decides "is it safe to proceed":
// confirmQuit() for Quit (it also clears this window's own changed state,
// since Quit leaves the window open — see confirmQuit's own doc comment in
// document.ts for why that matters there); confirmClose() for Close
// Window (it doesn't need to clear anything itself, since Rust destroys
// the window right after a truthy response — same as closeTab() above).
async function handleFlowPrompt(confirm: () => Promise<boolean>): Promise<void> {
  if (unsavedPromptOpen) {
    // Another prompt already owns this window's dialog (Close Tab racing
    // a Rust-driven flow aimed at the same window — see
    // unsavedPromptOpen's comment above). Report "cancel" rather than
    // leaving Rust's flow waiting for a response that would otherwise
    // never come: aborting is always the safe outcome here, never a
    // silent data loss.
    await invoke('flow_response', { label: appWindow.label, proceed: false })
    return
  }
  unsavedPromptOpen = true
  let proceed: boolean
  try {
    proceed = await confirm()
  } finally {
    unsavedPromptOpen = false
  }
  await invoke('flow_response', { label: appWindow.label, proceed })
}

// The app menu lives entirely in Rust (src-tauri/src/lib.rs) because a JS
// menu's action callbacks run in the webview that *created* the menu — the
// wrong window as soon as a second one opens, and a dead one once that
// window closes. Rust resolves whichever window is focused and emits these
// events to it specifically (emit_to, not a broadcast emit), so each event
// always lands on the one document the user is actually looking at.
// These MUST be `appWindow.listen`, never the bare `listen()` from
// @tauri-apps/api/event. That one defaults to `{ kind: 'Any' }`, and Tauri's
// match_any_or_filter (src/event/listener.rs) short-circuits on an `Any`
// listener: `*target == EventTarget::Any || filter(...)`. An `Any` listener
// therefore receives EVERY emit, including an `emit_to` aimed at a different
// window — silently defeating the targeting Rust does. That shipped, and it
// meant every menu command ran in every open window at once: Save wrote all
// open documents, the Reorg/Outliner items edited all of them, and Open put
// a file picker on every window, where the background windows' sheets were
// invisible and app-modal, wedging the app hard enough to need a force quit.
// appWindow.listen registers `{ kind: 'Window', label }`, which emit_to's
// `AnyLabel { label }` still matches (see filter_target in
// src/manager/mod.rs), so targeting finally works as intended.
//
// listen() also needs no extra *permission* — core:event:default comes with
// core:default — but it does need the capability to apply to this window at
// all. capabilities/default.json originally scoped itself to `"windows":
// ["main"]`, which silently left every Rust-created window (win-1, win-2,
// ...) with no permissions: listen() was denied, so the whole menu was dead
// in second and subsequent windows. It's a `"*"` glob now. Permission and
// window scope are two separate gates; granting one doesn't grant the other.
void appWindow.listen('menu-open', () => void openDocument())
void appWindow.listen('menu-save', () => void saveDocument())
void appWindow.listen('menu-save-as', () => void saveDocumentAs())
void appWindow.listen('menu-keyboard-shortcuts', () => void showShortcuts())
// 'menu-quit' and 'menu-close-window-group' are the two events Rust
// doesn't resolve a single focused window for before emitting (see
// build_menu's "quit"/"close-window" doc comments) — each is targeted at
// specific windows one at a time instead, walking through a dirty-window
// flow (advance_flow in src-tauri/src/lib.rs) that may or may not include
// this window on any given step.
void appWindow.listen('menu-quit', () => void handleFlowPrompt(confirmQuit))
void appWindow.listen('menu-close-window-group', () => void handleFlowPrompt(confirmClose))

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
  void appWindow.listen(event, action)
}
// Find… and Find again are the odd ones out: they need UI (a prompt for
// Find…) or extra state (Find again has to know whether a search has
// happened yet), so they're routed to find.ts instead of the flat table
// above.
void appWindow.listen('menu-find', () => void promptFind(outliner))
void appWindow.listen('menu-find-again', () => void findAgain(outliner))

// Reorg menu: same one-call-per-item shape as OUTLINER_ACTIONS above, kept
// as its own table (rather than folded into that one) so it stays obvious
// at a glance which menu each entry belongs to now that there are two.
//
// Unlike every other accelerator in this app, the eight below (Cmd-U/D/L/R,
// Cmd-\, Cmd-/, Cmd-[, Cmd-]) are bound in Rust (see reorg_submenu's doc
// comment in src-tauri/src/lib.rs) even though they duplicate keys the
// outliner's own keydown handler already binds via CONCORD_KEYSTROKES
// (packages/outliner/src/util.ts) — on macOS the menu wins that race and
// shadows the outliner's handler entirely. That's fine *here* because it
// was verified against packages/outliner/src/keyboard.ts: the shadowed
// cases ('reorg-up'/'reorg-down'/'reorg-left'/'reorg-right'/'promote'/
// 'demote'/'toggle-comment'/'run-selection') are thin unconditional
// wrappers around these exact same Outliner methods, with no text-mode
// branching or cursor-state guard the menu path would skip — so shadowing
// them changes nothing observable. That is NOT true of Edit menu's Undo/
// Select All (a predefined item there would invoke the webview's native
// undo/select instead of the outliner's own), which is why those stay
// unbound; see design note 3 in README.md.
const REORG_ACTIONS: Record<string, () => void> = {
  'menu-reorg-move-up': () => outliner.reorg(UP),
  'menu-reorg-move-down': () => outliner.reorg(DOWN),
  'menu-reorg-move-left': () => outliner.reorg(LEFT),
  'menu-reorg-move-right': () => outliner.reorg(RIGHT),
  'menu-reorg-toggle-comment': () => outliner.toggleComment(),
  'menu-reorg-run-selection': () => outliner.runSelection(),
  'menu-reorg-delete-line': () => outliner.deleteLine(),
  'menu-reorg-promote': () => outliner.promote(),
  'menu-reorg-demote': () => outliner.demote(),
  'menu-reorg-sort': () => outliner.sort(),
}
for (const [event, action] of Object.entries(REORG_ACTIONS)) {
  void appWindow.listen(event, action)
}

// The native close button (red traffic light) doesn't go through the menu
// at all, so it needs its own guard here.
void appWindow.onCloseRequested(async (event) => {
  event.preventDefault()
  await closeTab()
})
