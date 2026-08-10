import { createOutliner } from '@andrewshell/outliner'
import '@andrewshell/outliner/styles.css'
import './styles.css'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import {
  initDocument,
  openPathAtBoot,
  openDocument,
  saveDocument,
  saveDocumentAs,
  confirmClose,
  reportError,
} from './document'
import { showShortcuts } from './shortcuts'
import { promptExpandTo } from './expand-to'

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

// Shared by the Close Window menu item (via the 'menu-close-window'
// listener below) and the native close button's guard further down, so
// both routes run the same unsaved-changes prompt before actually closing.
async function closeWindow(): Promise<void> {
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
}

// The app menu lives entirely in Rust (src-tauri/src/lib.rs) because a JS
// menu's action callbacks run in the webview that *created* the menu — the
// wrong window as soon as a second one opens, and a dead one once that
// window closes. Rust resolves whichever window is focused and emits these
// events to it specifically (emit_to, not a broadcast emit), so each event
// always lands on the one document the user is actually looking at.
// listen()/emit_to() need no extra capability grant: core:event:default is
// part of core:default, already present in capabilities/default.json.
void listen('menu-open', () => void openDocument())
void listen('menu-save', () => void saveDocument())
void listen('menu-save-as', () => void saveDocumentAs())
void listen('menu-keyboard-shortcuts', () => void showShortcuts())
void listen('menu-close-window', () => void closeWindow())

// View menu: every no-argument operation maps straight to a library call,
// so they're driven from a table instead of a growing if/else chain — see
// the View section of README.md's "Menu layout" for what each one does.
// expand()/collapse() call markChanged() internally (expansion state is
// part of the saved OPML), so these legitimately mark the document dirty
// and the title's `•` picks that up like any other edit — nothing here
// needs to suppress that.
const VIEW_ACTIONS: Record<string, () => void> = {
  'menu-expand-subheads': () => outliner.expand(),
  'menu-collapse-subheads': () => outliner.collapse(),
  'menu-expand-all': () => outliner.expandAllSubs(),
  'menu-expand-document': () => outliner.expandEverything(),
  'menu-collapse-document': () => outliner.collapseEverything(),
  // Full View, per MORE: pop out of any hoist, then expand everything, so
  // the whole document is visible with nothing hidden or hoisted away.
  'menu-full-view': () => {
    outliner.deHoistAll()
    outliner.expandEverything()
  },
  'menu-hoist': () => outliner.hoist(),
  'menu-de-hoist': () => outliner.deHoist(),
  'menu-de-hoist-all': () => outliner.deHoistAll(),
}
for (const [event, action] of Object.entries(VIEW_ACTIONS)) {
  void listen(event, action)
}
// Expand To… is the odd one out: it needs a level number from the user
// first, via the in-app prompt in expand-to.ts.
void listen('menu-expand-to', () => void promptExpandTo(outliner))

// The native close button (red traffic light) doesn't go through the menu
// at all, so it needs its own guard here.
void appWindow.onCloseRequested(async (event) => {
  event.preventDefault()
  await closeWindow()
})
