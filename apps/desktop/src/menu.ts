// The frontend's view of the shared menu manifest (../menu.json).
//
// The same file Rust embeds with include_str! and builds the app menu from
// (build_menu in src-tauri/src/lib.rs). Importing it here rather than
// re-listing its ids is the whole point of having it: an item used to be
// written out four times across two languages -- a MenuItemBuilder, a match
// arm on its id, the `menu-{id}` string that arm emitted, and the listener for
// that string here -- and mistyping any one of them produced no compile error,
// no runtime error, and a menu item that quietly did nothing.
//
// This module deliberately contains no behaviour. What a menu item *does*
// can't be serialised into JSON, so it stays in src/actions.ts, keyed by the
// ids below and checked against them by test/menu.test.ts.
import manifest from '../menu.json'

/** One submenu that holds custom items. */
export interface SubmenuSpec {
  /** Referenced by each item's `submenu`; also the key Rust builds against. */
  key: string
  /**
   * What the menu bar draws — and, in the Help ▸ Keyboard Shortcuts sheet,
   * the heading of this submenu's group of shortcuts.
   */
  title: string
}

/** One custom menu item. */
export interface MenuItemSpec {
  /** Also the event name, prefixed: see {@link menuEventName}. */
  id: string
  label: string
  /**
   * A Tauri accelerator string ("CmdOrCtrl+Shift+S"), absent for the
   * menu-only items. The shortcuts sheet renders these per-platform; nothing
   * on this side binds them, since the accelerator belongs to the native menu
   * item and macOS gets first crack at the keystroke.
   */
  accelerator?: string
  submenu: string
  separatorBefore?: boolean
  /** What this item does, in the shortcuts sheet's voice. */
  description: string
}

/**
 * The submenus that hold custom items, in menu-bar order.
 *
 * Edit and Window are absent: every item in them is a predefined native item,
 * routed by macOS through the responder chain with no app code involved, so
 * neither has anything for this side to handle or to document.
 */
export const MENU_SUBMENUS: readonly SubmenuSpec[] = manifest.submenus

/** Every custom menu item, in menu order. */
export const MENU_ITEMS: readonly MenuItemSpec[] = manifest.items

/**
 * The event a custom menu item dispatches to the window that's focused when
 * it's chosen.
 *
 * Must agree, character for character, with `menu_event_name` in
 * src-tauri/src/lib.rs. That agreement is what test/menu.test.ts and the Rust
 * test of the same name pin from their respective sides, each against a
 * written-out list of the 23 names rather than against the other's code.
 */
export function menuEventName(id: string): string {
  return `menu-${id}`
}

/** The manifest title of a submenu, or the key itself if it has none. */
export function submenuTitle(key: string): string {
  return MENU_SUBMENUS.find((submenu) => submenu.key === key)?.title ?? key
}
