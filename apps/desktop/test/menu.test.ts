import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UP, DOWN, LEFT, RIGHT } from '@andrewshell/outliner'
import type { Outliner } from '@andrewshell/outliner'
import { MENU_ITEMS, menuEventName } from '../src/menu'
import { createMenuActions, registerMenuListeners, ROUTED_IN_RUST } from '../src/actions'
import { openDocument, saveDocument, saveDocumentAs } from '../src/document'
import { promptFind, findAgain } from '../src/find'
import { showShortcuts } from '../src/shortcuts'

// The frontend half of the menu manifest's contract.
//
// menu.json is read by two languages that cannot check each other: Rust builds
// the menu from it and emits `menu-{id}` to the focused window, and this side
// listens for that name and runs something. Nothing in either compiler notices
// when the two halves stop agreeing -- the menu item still draws, still
// dispatches, and simply does nothing when clicked. The Rust tests
// (src-tauri/src/lib.rs) pin the names it emits; these pin the names this side
// listens for, and that every manifest item has a handler at all.
//
// Both sets of expectations are written out as literals rather than derived
// from the manifest, for the reason the shortcuts characterisation tests give:
// an expectation computed from the thing under test agrees with it by
// construction and can never disagree.

// These three modules reach for Tauri APIs (invoke, the dialog plugin, the
// current window) that only exist inside a real webview. The actions table is
// about *which* function each menu item calls, not what those functions then
// do, so stubbing the modules keeps these tests to that question.
vi.mock('../src/document', () => ({
  openDocument: vi.fn(),
  saveDocument: vi.fn(),
  saveDocumentAs: vi.fn(),
}))
vi.mock('../src/find', () => ({ promptFind: vi.fn(), findAgain: vi.fn() }))
vi.mock('../src/shortcuts', () => ({ showShortcuts: vi.fn() }))

/**
 * A stand-in for the Outliner instance main.ts mounts.
 *
 * Only the methods the menu drives, each a spy: this is a test of the wiring
 * between a menu id and a library call, and a real Outliner would need a DOM
 * container, a document, and a cursor to answer the same question.
 */
function stubOutliner(): Outliner & Record<string, ReturnType<typeof vi.fn>> {
  const methods = [
    'expand',
    'collapse',
    'expandAllSubs',
    'expandEverything',
    'collapseEverything',
    'hoist',
    'deHoist',
    'reorg',
    'toggleComment',
    'runSelection',
    'deleteLine',
    'promote',
    'demote',
    'sort',
  ]
  const stub: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const method of methods) stub[method] = vi.fn()
  return stub as unknown as Outliner & Record<string, ReturnType<typeof vi.fn>>
}

describe('the menu actions table', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('has a handler for every menu item that is not routed in Rust', async () => {
    const actions = createMenuActions(stubOutliner())

    const unhandled = MENU_ITEMS.map((item) => item.id).filter(
      (id) => !(id in actions) && !ROUTED_IN_RUST.includes(id),
    )

    // The failure this catches: adding an item to menu.json, wiring it up in
    // Rust, and forgetting the frontend half -- which produces a menu item
    // that looks finished and does nothing at all when clicked.
    expect(unhandled).toEqual([])
  })

  it('leaves exactly the five window-level items to Rust', async () => {
    // New and New Window create a window; Close Tab closes one; Close Window
    // and Quit walk a whole group of them one at a time. None is a matter of
    // asking one document's frontend to do something, so none has an entry in
    // the actions table. Quit and Close Window do reach this window during
    // such a walk, but through their own flow events and main.ts's
    // handleFlowPrompt, which needs the window-local guard state that lives
    // there -- see main.ts.
    expect([...ROUTED_IN_RUST]).toEqual(['new', 'new-window', 'close-tab', 'close-window', 'quit'])

    const actions = createMenuActions(stubOutliner())
    for (const id of ROUTED_IN_RUST) {
      expect(actions[id]).toBeUndefined()
    }
  })

  it('has no handler for an id that is not a menu item at all', async () => {
    // The reverse drift: a handler left behind after its item was renamed or
    // removed from menu.json would never fire again, and nothing else would
    // say so.
    const ids = new Set(MENU_ITEMS.map((item) => item.id))
    const orphans = Object.keys(createMenuActions(stubOutliner())).filter((id) => !ids.has(id))

    expect(orphans).toEqual([])
  })

  it('registers one listener per handled item, named for its id', async () => {
    const listened: string[] = []
    registerMenuListeners((event) => listened.push(event), createMenuActions(stubOutliner()))

    // The 23 event names Rust emits, transcribed from the on_menu_event code
    // that emitted them one hand-written arm at a time. Rust asserts it still
    // emits exactly these (see every_dispatched_item_emits_the_event_its_
    // listener_expects in src-tauri/src/lib.rs); this asserts this side still
    // listens for exactly these. Between them, the two literals are what stop
    // the manifest from renaming an event out from under either half.
    expect(listened).toEqual([
      'menu-open',
      'menu-save',
      'menu-save-as',
      'menu-expand',
      'menu-expand-all-subs',
      'menu-expand-everything',
      'menu-collapse',
      'menu-collapse-everything',
      'menu-hoist',
      'menu-dehoist',
      'menu-find',
      'menu-find-again',
      'menu-reorg-move-up',
      'menu-reorg-move-down',
      'menu-reorg-move-left',
      'menu-reorg-move-right',
      'menu-reorg-toggle-comment',
      'menu-reorg-run-selection',
      'menu-reorg-delete-line',
      'menu-reorg-promote',
      'menu-reorg-demote',
      'menu-reorg-sort',
      'menu-keyboard-shortcuts',
    ])
  })

  it('names an event after its item id', async () => {
    expect(menuEventName('reorg-move-up')).toBe('menu-reorg-move-up')
  })
})

describe('what each menu item does', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Transcribed from the OUTLINER_ACTIONS and REORG_ACTIONS tables main.ts
  // carried before the manifest: menu id, the Outliner method it calls, and
  // the arguments it passes.
  const LIBRARY_CALLS: [string, string, unknown[]][] = [
    ['expand', 'expand', []],
    ['expand-all-subs', 'expandAllSubs', []],
    ['expand-everything', 'expandEverything', []],
    ['collapse', 'collapse', []],
    ['collapse-everything', 'collapseEverything', []],
    ['hoist', 'hoist', []],
    ['dehoist', 'deHoist', []],
    ['reorg-move-up', 'reorg', [UP]],
    ['reorg-move-down', 'reorg', [DOWN]],
    ['reorg-move-left', 'reorg', [LEFT]],
    ['reorg-move-right', 'reorg', [RIGHT]],
    ['reorg-toggle-comment', 'toggleComment', []],
    ['reorg-run-selection', 'runSelection', []],
    ['reorg-delete-line', 'deleteLine', []],
    ['reorg-promote', 'promote', []],
    ['reorg-demote', 'demote', []],
    ['reorg-sort', 'sort', []],
  ]

  it.each(LIBRARY_CALLS)('%s calls outliner.%s', (id, method, args) => {
    const outliner = stubOutliner()
    createMenuActions(outliner)[id]()

    expect(outliner[method]).toHaveBeenCalledWith(...args)
  })

  it('routes the document commands to document.ts', () => {
    const actions = createMenuActions(stubOutliner())

    actions['open']()
    expect(openDocument).toHaveBeenCalled()
    actions['save']()
    expect(saveDocument).toHaveBeenCalled()
    actions['save-as']()
    expect(saveDocumentAs).toHaveBeenCalled()
  })

  it('routes Find and Find again to find.ts, with the outliner to search', () => {
    const outliner = stubOutliner()
    const actions = createMenuActions(outliner)

    actions['find']()
    expect(promptFind).toHaveBeenCalledWith(outliner)
    actions['find-again']()
    expect(findAgain).toHaveBeenCalledWith(outliner)
  })

  it('opens the shortcuts sheet', () => {
    createMenuActions(stubOutliner())['keyboard-shortcuts']()

    expect(showShortcuts).toHaveBeenCalled()
  })
})
