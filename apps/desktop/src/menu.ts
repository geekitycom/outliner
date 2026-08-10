// The app-wide menu, built entirely in JS with the Tauri v2 menu API and
// installed with setAsAppMenu() — no Rust-side menu code, no event
// plumbing. Every action callback here calls straight into document.ts (or
// shortcuts.ts for Help), the same functions the plan wires the app up to
// everywhere else.
import { Menu, Submenu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu'
import { newDocument, openDocument, saveDocument, saveDocumentAs } from './document'
import { showShortcuts } from './shortcuts'

async function buildAppSubmenu(): Promise<Submenu> {
  return Submenu.new({
    text: 'Outliner',
    items: [
      await PredefinedMenuItem.new({ item: { About: null } }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await PredefinedMenuItem.new({ item: 'Services' }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await PredefinedMenuItem.new({ item: 'Hide' }),
      await PredefinedMenuItem.new({ item: 'HideOthers' }),
      await PredefinedMenuItem.new({ item: 'ShowAll' }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await PredefinedMenuItem.new({ item: 'Quit' }),
    ],
  })
}

async function buildFileSubmenu(): Promise<Submenu> {
  return Submenu.new({
    text: 'File',
    items: [
      // Cmd-N/O/S/Shift-S are all safe accelerators: they're absent from
      // CONCORD_KEYSTROKES (packages/outliner/src/util.ts), so the
      // outliner's keydown handler falls into its `default:` branch, which
      // sets keyCaptured = false and never calls preventDefault. Nothing to
      // shadow here.
      await MenuItem.new({ text: 'New', accelerator: 'CmdOrCtrl+N', action: () => void newDocument() }),
      await MenuItem.new({ text: 'Open…', accelerator: 'CmdOrCtrl+O', action: () => void openDocument() }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({ text: 'Save', accelerator: 'CmdOrCtrl+S', action: () => void saveDocument() }),
      await MenuItem.new({
        text: 'Save As…',
        accelerator: 'CmdOrCtrl+Shift+S',
        action: () => void saveDocumentAs(),
      }),
    ],
  })
}

async function buildEditSubmenu(): Promise<Submenu> {
  return Submenu.new({
    text: 'Edit',
    items: [
      // Cut/Copy/Paste ONLY — do not add Undo or Select All here. On macOS
      // the app menu gets first crack at a key equivalent, and both Cmd-Z
      // (`undo`) and Cmd-A (`select-all`) are captured with
      // preventDefault() by the outliner's own keyboard handler
      // (packages/outliner/src/keyboard.ts). A predefined Undo or SelectAll
      // item here would silently steal those keystrokes before the
      // outliner ever sees them, breaking its own undo/select-all.
      // Cut/Copy/Paste are the opposite case: keyboard.ts's `case 'cut'`
      // only preventDefaults when the line is empty, and `case 'copy':
      // case 'paste': break` never does — both deliberately fall through
      // to WKWebView's native clipboard handling, which needs these menu
      // items present to work at all.
      await PredefinedMenuItem.new({ item: 'Cut' }),
      await PredefinedMenuItem.new({ item: 'Copy' }),
      await PredefinedMenuItem.new({ item: 'Paste' }),
    ],
  })
}

async function buildHelpSubmenu(): Promise<Submenu> {
  return Submenu.new({
    text: 'Help',
    items: [
      // No accelerator. The obvious Cmd-/ is already bound to
      // `run-selection` in the outliner (CONCORD_KEYSTROKES in
      // packages/outliner/src/util.ts) — giving this item Cmd-/ would
      // shadow that keystroke the same way an Edit-menu Undo would shadow
      // Cmd-Z.
      await MenuItem.new({ text: 'Keyboard Shortcuts', action: () => void showShortcuts() }),
    ],
  })
}

/** Builds and installs the app-wide menu. Call once at startup. */
export async function installMenu(): Promise<void> {
  const [appSubmenu, fileSubmenu, editSubmenu, helpSubmenu] = await Promise.all([
    buildAppSubmenu(),
    buildFileSubmenu(),
    buildEditSubmenu(),
    buildHelpSubmenu(),
  ])

  const menu = await Menu.new({
    items: [appSubmenu, fileSubmenu, editSubmenu, helpSubmenu],
  })

  await menu.setAsAppMenu()
}
