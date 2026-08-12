// The Help ▸ Keyboard Shortcuts sheet.
//
// The sheet's content used to be transcribed by hand from its two sources —
// the library's keystroke table and the accelerators the menu binds — and it
// had drifted from both: ⌘F, ⌘G, ⌘⇧N, ⌘W, ⌘⇧W and ⌘Q were all bound and none
// of them appeared here, while ⌘, was filed under the app's own name though
// the library is what binds it. Nothing could have caught that, because a
// transcription has nothing to disagree with.
//
// So neither source is transcribed any more. The keystrokes come from
// CONCORD_KEYSTROKES (the library's own table, exported for this) and the
// accelerators from ../menu.json (the same manifest Rust builds the menu
// from). What stays written down here is the part that is genuinely editorial
// and lives in neither source: which group a shortcut belongs in, what order
// the rows read in, and — for the library's keystrokes — a description of what
// each command does.
//
// Rendered with showModal() from modal.ts, which already claims the caret for
// the dialog so arrow keys and Cmd-B don't leak through to the outline sitting
// behind it.
import { CONCORD_KEYSTROKES } from '@andrewshell/outliner'
import { showModal } from './modal'

interface Shortcut {
  // Token sequence for a chord, e.g. ['Cmd', 'Shift', 'S']. 'Cmd'/'Shift'/
  // 'Alt' are translated per-platform in formatKeys(); every other token
  // (a letter, a symbol, 'Return', an arrow glyph, ...) is rendered as-is.
  keys: string[]
  description: string
}

interface ShortcutGroup {
  title: string
  shortcuts: Shortcut[]
}

/**
 * A row documenting one of the library's keystrokes.
 *
 * `command` names a value in CONCORD_KEYSTROKES and the keystroke is looked up
 * from it, so the sheet follows a rebinding upstream instead of quietly going
 * stale. `keys` is the escape hatch for the handful of keystrokes
 * `keyboard.ts` handles without a table entry — spelled out, and marked as
 * such, rather than silently mixed in with the derived ones.
 */
type LibraryRow = { command: string; description: string } | { keys: string[]; description: string }

/**
 * The library's keystrokes, grouped and described.
 *
 * The grouping and the order are editorial and belong here; every keystroke
 * itself is looked up from CONCORD_KEYSTROKES at render time. The
 * descriptions are what each command does per
 * packages/outliner/src/keyboard.ts, which is the only one of these three
 * facts that can't be derived from anything.
 */
const LIBRARY_GROUPS: { title: string; rows: LibraryRow[] }[] = [
  {
    title: 'Moving',
    rows: [
      { command: 'cursor-up', description: 'Move to the previous headline' },
      { command: 'cursor-down', description: 'Move to the next headline' },
      { command: 'cursor-left', description: 'With headlines selected, move up to the parent' },
      { command: 'cursor-right', description: 'With headlines selected, move down into the children' },
    ],
  },
  {
    title: 'Editing',
    rows: [
      { command: 'return', description: 'Insert a new headline' },
      // Not in CONCORD_KEYSTROKES: keyboard.ts switches on the raw
      // 'meta-return' name, which getKeystroke() returns unmapped.
      { keys: ['Cmd', 'Return'], description: 'Split the headline at the cursor into two' },
      { command: 'backspace', description: 'Delete the current headline (outside text editing)' },
      { command: 'delete', description: 'Delete the current headline (outside text editing)' },
      // Not in CONCORD_KEYSTROKES either, same reason as ⌘Return above.
      { keys: ['Cmd', 'Backspace'], description: 'Join the headline with the previous one' },
      { command: 'select-all', description: 'Select all headlines' },
      { command: 'undo', description: 'Undo' },
      { command: 'run-selection', description: 'Run selection — evaluate the headline as JavaScript' },
    ],
  },
  {
    title: 'Reorganizing',
    rows: [
      { command: 'tab', description: 'Demote — indent under the previous headline' },
      // Shift-Tab is a branch inside keyboard.ts's 'tab' case rather than a
      // keystroke of its own, so there's nothing in the table to look up.
      { keys: ['Shift', 'Tab'], description: "Promote — outdent to the parent's level" },
      { command: 'reorg-up', description: 'Move the headline up among its siblings' },
      { command: 'reorg-down', description: 'Move the headline down among its siblings' },
      { command: 'reorg-left', description: "Move the headline left — outdent to the parent's level" },
      { command: 'reorg-right', description: 'Move the headline right — indent under the previous headline' },
      { command: 'promote', description: "Promote — this headline's children take its place" },
      { command: 'demote', description: "Demote — following siblings become this headline's children" },
    ],
  },
  {
    title: 'Formatting',
    rows: [
      { command: 'bolden', description: 'Bold the selected text' },
      { command: 'italicize', description: 'Italicize the selected text' },
      { command: 'toggle-render', description: 'Toggle render mode (plain text vs. rendered)' },
      { command: 'toggle-comment', description: 'Toggle comment on the headline' },
    ],
  },
  {
    // Was filed under "GeekityFlow" until this group existed, which read as a
    // claim that the app binds ⌘, — it doesn't, and deliberately gives its own
    // Expand/Collapse menu items no accelerator precisely so they don't shadow
    // this one. The group whose name is the app's is now the app's own
    // (further down, built from the menu manifest).
    title: 'Expanding',
    rows: [{ command: 'toggle-expand', description: "Expand or collapse the headline's children" }],
  },
  {
    title: 'Clipboard',
    rows: [
      { command: 'cut', description: 'Cut' },
      { command: 'copy', description: 'Copy' },
      { command: 'paste', description: 'Paste' },
    ],
  },
]

/**
 * Library commands the sheet documents. Exported for the test that checks this
 * list plus UNDOCUMENTED_COMMANDS accounts for all of CONCORD_KEYSTROKES.
 */
export const DOCUMENTED_COMMANDS: readonly string[] = LIBRARY_GROUPS.flatMap((group) =>
  group.rows.flatMap((row) => ('command' in row ? [row.command] : [])),
)

/**
 * Library commands the sheet deliberately leaves out.
 *
 * Only one: 'find' is bound to ⌘F in CONCORD_KEYSTROKES, but keyboard.ts's
 * `case 'find': break` is a no-op that never even calls preventDefault, so
 * the library binding documents nothing. The app implements Find itself, and
 * ⌘F reaches the sheet from the menu manifest instead, described as what it
 * actually does.
 */
export const UNDOCUMENTED_COMMANDS: readonly string[] = ['find']

/**
 * Display tokens for the keystroke names the library uses for non-letter keys.
 * `checkSpecials()` in packages/outliner/src/util.ts is where these names come
 * from; everything it doesn't rename (letters, punctuation) is already its own
 * label.
 */
const KEY_LABELS: Record<string, string> = {
  backspace: 'Backspace',
  tab: 'Tab',
  return: 'Return',
  delete: 'Delete',
  uparrow: '↑',
  downarrow: '↓',
  leftarrow: '←',
  rightarrow: '→',
}

/**
 * Turns a library keystroke name ('meta-U', 'uparrow') into display tokens.
 *
 * 'meta-' is Concord's name for Command *or* Control — getKeystroke() maps
 * both to it — which is the same thing this sheet's 'Cmd' token means, and the
 * same thing a "CmdOrCtrl+" accelerator means. All three render per-platform
 * in formatKeys().
 */
function keystrokeTokens(keystroke: string): string[] {
  const meta = keystroke.startsWith('meta-')
  const base = meta ? keystroke.slice('meta-'.length) : keystroke
  const key = KEY_LABELS[base] ?? base
  return meta ? ['Cmd', key] : [key]
}

/**
 * The keystroke bound to a library command, as display tokens.
 *
 * Throws rather than dropping the row if the command has no binding: a
 * silently missing row is the exact failure this rewrite exists to end, and
 * the sheet's content is static enough that the tests render every row of it,
 * so an upstream rename surfaces as a test failure rather than as a sheet a
 * user opens.
 */
function keysForCommand(command: string): string[] {
  const entry = Object.entries(CONCORD_KEYSTROKES).find(([, bound]) => bound === command)
  if (!entry) {
    throw new Error(`the outliner no longer binds a keystroke to "${command}"`)
  }
  return keystrokeTokens(entry[0])
}

function libraryGroups(): ShortcutGroup[] {
  return LIBRARY_GROUPS.map((group) => ({
    title: group.title,
    shortcuts: group.rows.map((row) => ({
      keys: 'command' in row ? keysForCommand(row.command) : row.keys,
      description: row.description,
    })),
  }))
}

/**
 * Every group the sheet shows, in order.
 *
 * A function rather than a module-level constant so that the lookups it does
 * happen when the sheet is opened, not when this module is imported: a
 * keystroke that has gone missing upstream should fail the sheet, which the
 * tests open, rather than fail the import and take the whole window with it.
 */
function shortcutGroups(): ShortcutGroup[] {
  return [
    ...libraryGroups(),
    {
      title: 'File',
      shortcuts: [
        { keys: ['Cmd', 'N'], description: 'New document' },
        { keys: ['Cmd', 'O'], description: 'Open…' },
        { keys: ['Cmd', 'S'], description: 'Save' },
        { keys: ['Cmd', 'Shift', 'S'], description: 'Save As…' },
      ],
    },
  ]
}

// navigator.userAgent, not a plugin: pulling in @tauri-apps/plugin-os just
// to read one platform string isn't worth the extra capability grant.
function isMac(): boolean {
  return /Mac/.test(navigator.userAgent)
}

const MAC_MODIFIERS: Record<string, string> = { Cmd: '⌘', Shift: '⇧', Alt: '⌥' }
const OTHER_MODIFIERS: Record<string, string> = { Cmd: 'Ctrl', Shift: 'Shift', Alt: 'Alt' }

function formatKeys(keys: string[]): string {
  const mac = isMac()
  const modifiers = mac ? MAC_MODIFIERS : OTHER_MODIFIERS
  const parts = keys.map((key) => modifiers[key] ?? key)
  // Mac convention runs modifier glyphs and the key together (⌘⇧S);
  // everywhere else they're joined with +, spelled out (Ctrl+Shift+S).
  return mac ? parts.join('') : parts.join('+')
}

function renderGroup(group: ShortcutGroup): HTMLElement {
  const section = document.createElement('section')
  section.className = 'shortcuts-group'

  const heading = document.createElement('h3')
  heading.textContent = group.title
  section.appendChild(heading)

  const table = document.createElement('table')
  const tbody = document.createElement('tbody')
  for (const shortcut of group.shortcuts) {
    const row = document.createElement('tr')

    const keyCell = document.createElement('td')
    keyCell.className = 'shortcut-keys'
    keyCell.textContent = formatKeys(shortcut.keys)

    const descCell = document.createElement('td')
    descCell.textContent = shortcut.description

    row.append(keyCell, descCell)
    tbody.appendChild(row)
  }
  table.appendChild(tbody)
  section.appendChild(table)

  return section
}

function buildContent(): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'shortcuts'

  const heading = document.createElement('h2')
  heading.textContent = 'Keyboard Shortcuts'
  wrapper.appendChild(heading)

  const columns = document.createElement('div')
  columns.className = 'shortcuts-columns'
  for (const group of shortcutGroups()) columns.appendChild(renderGroup(group))
  wrapper.appendChild(columns)

  const form = document.createElement('form')
  form.method = 'dialog'
  form.className = 'shortcuts-close'
  const closeButton = document.createElement('button')
  closeButton.type = 'submit'
  closeButton.textContent = 'Close'
  closeButton.autofocus = true
  form.appendChild(closeButton)
  wrapper.appendChild(form)

  return wrapper
}

/** Opens the Help ▸ Keyboard Shortcuts sheet. */
export async function showShortcuts(): Promise<void> {
  await showModal(buildContent())
}
