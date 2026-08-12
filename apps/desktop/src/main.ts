import { createOutliner } from '@andrewshell/outliner'
import '@andrewshell/outliner/styles.css'
import './styles.css'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { initDocument, openPathAtBoot, confirmClose, confirmQuit, reportError } from './document'
import { createMenuActions, registerMenuListeners } from './actions'

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
//
// Which events those are is not written out here any more: both sides read
// ../menu.json, so this subscribes to `menu-{id}` for every custom item that
// has a handler, built from the same file Rust builds the menu from (see
// src/actions.ts). The listener and the emit can no longer disagree about a
// name, which is exactly how a menu item used to end up drawing perfectly and
// doing nothing.
registerMenuListeners((event, handler) => void appWindow.listen(event, handler), createMenuActions(outliner))

// 'menu-quit' and 'menu-close-window-group' are the two events Rust
// doesn't resolve a single focused window for before emitting (see
// build_menu's "quit"/"close-window" doc comments) — each is targeted at
// specific windows one at a time instead, walking through a dirty-window
// flow (advance_flow in src-tauri/src/lib.rs) that may or may not include
// this window on any given step.
void appWindow.listen('menu-quit', () => void handleFlowPrompt(confirmQuit))
void appWindow.listen('menu-close-window-group', () => void handleFlowPrompt(confirmClose))

// The native close button (red traffic light) doesn't go through the menu
// at all, so it needs its own guard here.
void appWindow.onCloseRequested(async (event) => {
  event.preventDefault()
  await closeTab()
})
