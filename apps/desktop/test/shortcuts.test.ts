import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CONCORD_KEYSTROKES } from '@andrewshell/outliner'
import { showShortcuts, DOCUMENTED_COMMANDS, UNDOCUMENTED_COMMANDS } from '../src/shortcuts'

// Characterisation tests for the Help > Keyboard Shortcuts sheet.
//
// These pin what the sheet renders, key by key and word for word. The expected
// values are written out as literals rather than read back out of the sheet's
// own tables, which would make the tests agree with the code by construction
// and catch nothing.
//
// Consequence worth stating plainly: these tests are EXPECTED to fail when the
// sheet's content changes. A failure here is not automatically a bug -- it is
// the sheet's content changing, and the failure is the prompt to confirm the
// change was intended and re-pin it.
//
// They were written against a sheet that hand-transcribed its content from two
// sources of truth (the keystroke table in packages/outliner/src/util.ts and
// the menu accelerators in src-tauri/src/lib.rs), pinning that output
// including the places it had fallen behind: Cmd-F and Cmd-G (Find, Find
// again), Cmd-Shift-N (New Window), Cmd-W (Close Tab), Cmd-Shift-W (Close
// Window) and Cmd-Q (Quit) were all bound but absent, and Cmd-, was filed
// under the app's own group though it is a library keystroke (toggle-expand).
// The sheet now derives its rows from those two sources -- CONCORD_KEYSTROKES
// and ../menu.json -- and every one of those omissions is corrected. The
// assertions that changed to say so are each marked CHANGED with the reason,
// which is what the pinning was for: the rows that were already right came
// through untouched, so the diff is exactly the drift and nothing else.

// The sheet renders its keystrokes one way on macOS (⌘⇧S) and another way
// everywhere else (Ctrl+Shift+S), choosing between them by matching /Mac/
// against navigator.userAgent. jsdom's default user agent names the Node
// platform ("darwin", "linux"), so it matches neither branch reliably and, worse,
// would make these tests read differently on a developer's Mac than on CI.
// Every test below therefore states the platform it is testing.
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
const WINDOWS_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

const REAL_USER_AGENT = window.navigator.userAgent

function setUserAgent(userAgent: string): void {
  // An own property on the navigator instance shadows the prototype getter,
  // and configurable lets the next test replace it again.
  Object.defineProperty(window.navigator, 'userAgent', {
    value: userAgent,
    configurable: true,
  })
}

afterEach(() => {
  setUserAgent(REAL_USER_AGENT)
})

/**
 * Open the sheet, take the content it rendered, and close it again.
 *
 * The close is not incidental. showModal() in src/modal.ts claims the caret
 * for the dialog's lifetime and only releases on the dialog's `close` event,
 * so a test that opened the sheet and walked away would leave that claim in
 * force for every test after it. Closing also detaches the dialog from the
 * document -- which is fine for the assertions, since the returned element is
 * held directly and its subtree is unchanged by being detached.
 */
async function renderShortcutsSheet(): Promise<HTMLElement> {
  const shown = showShortcuts()

  const dialog = document.querySelector<HTMLDialogElement>('dialog.app-modal')
  if (!dialog) throw new Error('the shortcuts sheet did not open a modal dialog')
  const content = dialog.firstElementChild as HTMLElement

  dialog.close()
  await shown

  return content
}

/** The group headings, in the order the sheet lays them out. */
function groupTitles(content: HTMLElement): string[] {
  return [...content.querySelectorAll('.shortcuts-group h3')].map((h) => h.textContent ?? '')
}

/**
 * The [keystroke, description] rows of one named group, in order.
 *
 * Looking the group up by its heading rather than by index keeps a failure
 * legible: reordering the groups then fails the one test that is about their
 * order, instead of failing every group's test with rows that look shuffled.
 */
function rowsOfGroup(content: HTMLElement, title: string): string[][] {
  const group = [...content.querySelectorAll('.shortcuts-group')].find(
    (section) => section.querySelector('h3')?.textContent === title,
  )
  if (!group) throw new Error(`the sheet has no "${title}" group`)

  return [...group.querySelectorAll('tbody tr')].map((row) =>
    [...row.querySelectorAll('td')].map((cell) => cell.textContent ?? ''),
  )
}

describe('the keyboard shortcuts sheet', () => {
  beforeEach(() => {
    setUserAgent(MAC_USER_AGENT)
  })

  it('lays out its groups in a fixed order', async () => {
    const content = await renderShortcutsSheet()

    expect(groupTitles(content)).toEqual([
      'Moving',
      'Editing',
      'Reorganizing',
      'Formatting',
      'Expanding',
      'Clipboard',
      'GeekityFlow',
      'File',
      'Outliner',
    ])
  })

  it('is titled, and closes from a dialog-method form', async () => {
    const content = await renderShortcutsSheet()

    expect(content.querySelector('h2')?.textContent).toBe('Keyboard Shortcuts')

    // method="dialog" is what makes the button close the sheet without any
    // JavaScript of its own, and autofocus is what makes Return close it.
    const form = content.querySelector('form.shortcuts-close')
    expect(form?.getAttribute('method')).toBe('dialog')
    const closeButton = form?.querySelector('button')
    expect(closeButton?.textContent).toBe('Close')
    expect(closeButton?.autofocus).toBe(true)
  })

  it('lists the arrow keys under Moving', async () => {
    const content = await renderShortcutsSheet()

    expect(rowsOfGroup(content, 'Moving')).toEqual([
      ['↑', 'Move to the previous headline'],
      ['↓', 'Move to the next headline'],
      ['←', 'With headlines selected, move up to the parent'],
      ['→', 'With headlines selected, move down into the children'],
    ])
  })

  it('lists the text and headline commands under Editing', async () => {
    const content = await renderShortcutsSheet()

    expect(rowsOfGroup(content, 'Editing')).toEqual([
      ['Return', 'Insert a new headline'],
      ['⌘Return', 'Split the headline at the cursor into two'],
      ['Backspace', 'Delete the current headline (outside text editing)'],
      ['Delete', 'Delete the current headline (outside text editing)'],
      ['⌘Backspace', 'Join the headline with the previous one'],
      ['⌘A', 'Select all headlines'],
      ['⌘Z', 'Undo'],
      ['⌘/', 'Run selection — evaluate the headline as JavaScript'],
    ])
  })

  it('lists the reorg and promote/demote commands under Reorganizing', async () => {
    const content = await renderShortcutsSheet()

    expect(rowsOfGroup(content, 'Reorganizing')).toEqual([
      ['Tab', 'Demote — indent under the previous headline'],
      ['⇧Tab', "Promote — outdent to the parent's level"],
      ['⌘U', 'Move the headline up among its siblings'],
      ['⌘D', 'Move the headline down among its siblings'],
      ['⌘L', "Move the headline left — outdent to the parent's level"],
      ['⌘R', 'Move the headline right — indent under the previous headline'],
      ['⌘[', "Promote — this headline's children take its place"],
      ['⌘]', "Demote — following siblings become this headline's children"],
    ])
  })

  it('lists the styling commands under Formatting', async () => {
    const content = await renderShortcutsSheet()

    expect(rowsOfGroup(content, 'Formatting')).toEqual([
      ['⌘B', 'Bold the selected text'],
      ['⌘I', 'Italicize the selected text'],
      ['⌘`', 'Toggle render mode (plain text vs. rendered)'],
      ['⌘\\', 'Toggle comment on the headline'],
    ])
  })

  it('lists expand/collapse under Expanding, with the library keystrokes', async () => {
    const content = await renderShortcutsSheet()

    // CHANGED, deliberately: this row used to be filed under "GeekityFlow",
    // as though ⌘, were something the app bound. It isn't — 'meta-,' maps to
    // toggle-expand in CONCORD_KEYSTROKES, exactly like every row in the four
    // groups above it, and the app's own Expand/Collapse menu items have no
    // accelerator at all (precisely so they don't shadow this one). Filing it
    // under the app told the reader the opposite of the truth.
    expect(rowsOfGroup(content, 'Expanding')).toEqual([
      ['⌘,', "Expand or collapse the headline's children"],
    ])
  })

  it('accounts for every command the library binds a key to', () => {
    // The drift guard the transcribed sheet could never have. It asks the
    // library what it binds and checks the sheet has an answer for each
    // entry, so a keystroke added or rebound upstream surfaces here instead
    // of going quietly undocumented -- which is how ⌘F came to be missing.
    //
    // This one reads the module's own tables rather than the rendered DOM,
    // deliberately: the independent source it checks against is
    // CONCORD_KEYSTROKES, imported from the library, and there is no way to
    // ask the DOM which library command a rendered row came from.
    const accounted = new Set([...DOCUMENTED_COMMANDS, ...UNDOCUMENTED_COMMANDS])
    const unaccounted = [...new Set(Object.values(CONCORD_KEYSTROKES))].filter(
      (command) => !accounted.has(command),
    )

    expect(unaccounted).toEqual([])
  })

  it('skips exactly one library command, and says which', () => {
    // 'find' is bound (meta-F) but keyboard.ts's `case 'find': break` is a
    // no-op that never calls preventDefault, so the library documents nothing
    // by claiming it. The app implements Find itself, and the sheet lists ⌘F
    // from the menu manifest instead. Pinned so that adding a second skip is
    // a deliberate act with a reason, not a way to silence the test above.
    expect([...UNDOCUMENTED_COMMANDS]).toEqual(['find'])
  })

  it('lists cut/copy/paste under Clipboard', async () => {
    const content = await renderShortcutsSheet()

    expect(rowsOfGroup(content, 'Clipboard')).toEqual([
      ['⌘X', 'Cut'],
      ['⌘C', 'Copy'],
      ['⌘V', 'Paste'],
    ])
  })

  it('lists the document commands under File', async () => {
    const content = await renderShortcutsSheet()

    // CHANGED, deliberately: three rows added. The File menu binds seven
    // accelerators and the sheet showed four of them — New Window, Close Tab
    // and Close Window were bound, worked, and went undocumented. They are
    // now read from the same manifest the menu is built from, which is also
    // why the rows follow the File menu's own order rather than the order
    // someone happened to type them in.
    expect(rowsOfGroup(content, 'File')).toEqual([
      ['⌘N', 'New document'],
      ['⌘O', 'Open…'],
      ['⌘⇧N', 'New window, in a tab group of its own'],
      ['⌘W', 'Close this tab'],
      ['⌘⇧W', 'Close every tab in this window'],
      ['⌘S', 'Save'],
      ['⌘⇧S', 'Save As…'],
    ])
  })

  it('lists Quit under the app menu it actually belongs to', async () => {
    const content = await renderShortcutsSheet()

    // CHANGED, deliberately: ⌘Q was bound and undocumented. The group named
    // for the app now holds what the app menu really binds — Quit — rather
    // than a library keystroke misfiled under it (see Expanding above).
    expect(rowsOfGroup(content, 'GeekityFlow')).toEqual([
      ['⌘Q', 'Quit, prompting for every document with unsaved changes'],
    ])
  })

  it('lists Find and Find again under Outliner', async () => {
    const content = await renderShortcutsSheet()

    // CHANGED, deliberately, and this assertion is the inverse of the one it
    // replaces ("omits Find and Find again entirely"). Both are bound by the
    // Outliner menu, both work, and neither was mentioned anywhere on the
    // sheet. ⌘F is in the library's table too, mapped to a case that does
    // nothing — so the app's implementation is the only one there is, and its
    // description is the honest one to show.
    expect(rowsOfGroup(content, 'Outliner')).toEqual([
      ['⌘F', 'Find…'],
      ['⌘G', 'Find again — repeat the last search'],
    ])
  })

  it('does not repeat a keystroke the library rows already cover', async () => {
    const content = await renderShortcutsSheet()

    // Every accelerator in the Reorg menu deliberately shadows a library
    // keystroke with a call to the identical method (design note 9), so all
    // ten of its items are already documented by the Reorganizing,
    // Formatting and Editing groups. Listing them a second time under "Reorg"
    // would be the same shortcut twice with two descriptions.
    expect(groupTitles(content)).not.toContain('Reorg')

    const keystrokes = [...content.querySelectorAll('.shortcut-keys')].map((cell) => cell.textContent)
    expect(keystrokes.filter((keys) => keys === '⌘U')).toHaveLength(1)
    expect(keystrokes.filter((keys) => keys === '⌘\\')).toHaveLength(1)
    expect(new Set(keystrokes).size).toBe(keystrokes.length)
  })
})

describe('the keyboard shortcuts sheet away from macOS', () => {
  beforeEach(() => {
    setUserAgent(WINDOWS_USER_AGENT)
  })

  it('spells the modifiers out and joins them with +', async () => {
    const content = await renderShortcutsSheet()

    // Same three added rows as the macOS File test above; the point being
    // asserted here is unchanged — that a "CmdOrCtrl+Shift+N" accelerator
    // renders as Ctrl+Shift+N away from macOS.
    expect(rowsOfGroup(content, 'File')).toEqual([
      ['Ctrl+N', 'New document'],
      ['Ctrl+O', 'Open…'],
      ['Ctrl+Shift+N', 'New window, in a tab group of its own'],
      ['Ctrl+W', 'Close this tab'],
      ['Ctrl+Shift+W', 'Close every tab in this window'],
      ['Ctrl+S', 'Save'],
      ['Ctrl+Shift+S', 'Save As…'],
    ])
  })

  it('leaves non-modifier keys alone, including the arrows', async () => {
    const content = await renderShortcutsSheet()

    // Only Cmd/Shift/Alt are translated; every other token renders as-is, so
    // the arrow glyphs stay glyphs rather than becoming words.
    expect(rowsOfGroup(content, 'Moving').map((row) => row[0])).toEqual(['↑', '↓', '←', '→'])
    expect(rowsOfGroup(content, 'Reorganizing')[1][0]).toBe('Shift+Tab')
    expect(rowsOfGroup(content, 'Editing')[1][0]).toBe('Ctrl+Return')
  })
})
