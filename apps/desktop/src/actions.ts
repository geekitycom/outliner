// What each custom menu item does, keyed by its id in ../menu.json.
//
// This is the one part of a menu item that can't live in the manifest: a
// closure doesn't serialise. Everything else about an item -- its id, label,
// accelerator, submenu, grouping, description -- is data that Rust and this
// side both read from the same file, so the only thing left to keep in step is
// "does every id have something to run", and test/menu.test.ts asserts exactly
// that. Adding an item to menu.json without adding it here fails that test
// rather than shipping a menu item that draws correctly and does nothing.
import { UP, DOWN, LEFT, RIGHT } from '@andrewshell/outliner'
import type { Outliner } from '@andrewshell/outliner'
import { openDocument, saveDocument, saveDocumentAs } from './document'
import { showShortcuts } from './shortcuts'
import { promptFind, findAgain } from './find'
import { MENU_ITEMS, menuEventName } from './menu'

/**
 * The menu items with no entry in the actions table, because Rust never asks
 * this window to handle them.
 *
 * Each acts on *windows* rather than on one document's contents, which is a
 * job only the backend can do: New and New Window build one (a blank document
 * needs no state this side has), Close Tab calls Tauri's `close()` on the
 * focused window so the traffic-light guard in main.ts handles it, and Close
 * Window and Quit walk a whole tab group -- or every dirty window app-wide --
 * one at a time. Those last two do come back to this window mid-walk, but
 * through their own flow events (`menu-quit`, `menu-close-window-group`) and
 * main.ts's handleFlowPrompt, which owns the window-local guard that stops a
 * second prompt stacking on top of the first.
 *
 * Listed rather than left implicit so that the "every item has a handler" test
 * has something to check against: an id can be absent from the table only by
 * appearing here, which is a deliberate act with a reason attached.
 */
export const ROUTED_IN_RUST: readonly string[] = [
  'new',
  'new-window',
  'close-tab',
  'close-window',
  'quit',
]

/**
 * Builds the table of menu-item handlers for one window's outliner.
 *
 * Takes the Outliner rather than reaching for a module-level one because each
 * tab is its own webview with its own instance, and this table is built once
 * per tab in main.ts alongside it.
 */
export function createMenuActions(outliner: Outliner): Record<string, () => void> {
  return {
    // File. New is absent (Rust builds the window itself); the two Close items
    // and Quit are absent for the reasons in ROUTED_IN_RUST above.
    open: () => void openDocument(),
    save: () => void saveDocument(),
    'save-as': () => void saveDocumentAs(),

    // Outliner. Every one of these is a no-argument library call, which is why
    // it's a table and not a growing if/else chain. expand()/collapse() call
    // markChanged() internally -- expansion state is part of the saved OPML --
    // so they legitimately mark the document changed and the title's `•` picks
    // that up like any other edit; nothing here needs to suppress that.
    expand: () => outliner.expand(),
    'expand-all-subs': () => outliner.expandAllSubs(),
    'expand-everything': () => outliner.expandEverything(),
    collapse: () => outliner.collapse(),
    'collapse-everything': () => outliner.collapseEverything(),
    hoist: () => outliner.hoist(),
    dehoist: () => outliner.deHoist(),
    // Find… and Find again are the odd ones out in that menu: they need UI (a
    // prompt) or extra state (whether a search has happened in this window
    // yet), so they route to find.ts rather than straight to the library.
    find: () => void promptFind(outliner),
    'find-again': () => void findAgain(outliner),

    // Reorg. Unlike every other accelerator in this app, the eight bound here
    // (Cmd-U/D/L/R, Cmd-\, Cmd-/, Cmd-[, Cmd-]) duplicate keys the outliner's
    // own keydown handler already binds via CONCORD_KEYSTROKES
    // (packages/outliner/src/util.ts) -- and on macOS the menu wins that race
    // and shadows the library's handler entirely. That's fine *here* because
    // it was verified against packages/outliner/src/keyboard.ts: the shadowed
    // cases ('reorg-up'/'reorg-down'/'reorg-left'/'reorg-right'/'promote'/
    // 'demote'/'toggle-comment'/'run-selection') are thin unconditional
    // wrappers around these exact same Outliner methods, with no text-mode
    // branching or cursor-state guard the menu path would skip -- so shadowing
    // them changes nothing observable. That is NOT true of Edit menu's Undo/
    // Select All (a predefined item there would invoke the webview's native
    // undo/select instead of the outliner's own), which is why those stay
    // unbound; see design note 3 in README.md.
    'reorg-move-up': () => outliner.reorg(UP),
    'reorg-move-down': () => outliner.reorg(DOWN),
    'reorg-move-left': () => outliner.reorg(LEFT),
    'reorg-move-right': () => outliner.reorg(RIGHT),
    'reorg-toggle-comment': () => outliner.toggleComment(),
    'reorg-run-selection': () => outliner.runSelection(),
    'reorg-delete-line': () => outliner.deleteLine(),
    'reorg-promote': () => outliner.promote(),
    'reorg-demote': () => outliner.demote(),
    'reorg-sort': () => outliner.sort(),

    // Help.
    'keyboard-shortcuts': () => void showShortcuts(),
  }
}

/**
 * Subscribes one listener per handled menu item.
 *
 * Driven by the manifest rather than by the actions table's own key order, so
 * the events subscribed to are exactly the events Rust dispatches, in the same
 * order, derived from the same file. `listen` is passed in rather than
 * imported: main.ts must supply `appWindow.listen` specifically, never the
 * bare `listen()` from @tauri-apps/api/event -- see its comment there for the
 * multi-window bug that one caused -- and passing it in also lets the tests
 * observe what got subscribed without a webview.
 */
export function registerMenuListeners(
  listen: (event: string, handler: () => void) => void,
  actions: Record<string, () => void>,
): void {
  for (const item of MENU_ITEMS) {
    const run = actions[item.id]
    if (run) listen(menuEventName(item.id), run)
  }
}
