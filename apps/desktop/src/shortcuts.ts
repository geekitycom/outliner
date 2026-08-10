// The Help ▸ Keyboard Shortcuts sheet. Content is transcribed from the two
// sources of truth rather than guessed: the keystroke-name mapping in
// packages/outliner/src/util.ts (CONCORD_KEYSTROKES, lines 33-63) and what
// each of those names actually does in packages/outliner/src/keyboard.ts.
// Rendered with showModal() from modal.ts, which already brackets
// stopListening()/resumeListening() around the dialog so arrow keys and
// Cmd-B don't leak through to the outline sitting behind it.
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

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Moving',
    shortcuts: [
      { keys: ['↑'], description: 'Move to the previous headline' },
      { keys: ['↓'], description: 'Move to the next headline' },
      { keys: ['←'], description: 'With headlines selected, move up to the parent' },
      { keys: ['→'], description: 'With headlines selected, move down into the children' },
    ],
  },
  {
    title: 'Editing',
    shortcuts: [
      { keys: ['Return'], description: 'Insert a new headline' },
      { keys: ['Cmd', 'Return'], description: 'Split the headline at the cursor into two' },
      { keys: ['Backspace'], description: 'Delete the current headline (outside text editing)' },
      { keys: ['Delete'], description: 'Delete the current headline (outside text editing)' },
      { keys: ['Cmd', 'Backspace'], description: 'Join the headline with the previous one' },
      { keys: ['Cmd', 'A'], description: 'Select all headlines' },
      { keys: ['Cmd', 'Z'], description: 'Undo' },
      { keys: ['Cmd', '/'], description: 'Run selection — evaluate the headline as JavaScript' },
    ],
  },
  {
    title: 'Reorganizing',
    shortcuts: [
      { keys: ['Tab'], description: 'Demote — indent under the previous headline' },
      { keys: ['Shift', 'Tab'], description: "Promote — outdent to the parent's level" },
      { keys: ['Cmd', 'U'], description: 'Move the headline up among its siblings' },
      { keys: ['Cmd', 'D'], description: 'Move the headline down among its siblings' },
      { keys: ['Cmd', 'L'], description: "Move the headline left — outdent to the parent's level" },
      { keys: ['Cmd', 'R'], description: 'Move the headline right — indent under the previous headline' },
      { keys: ['Cmd', '['], description: "Promote — this headline's children take its place" },
      { keys: ['Cmd', ']'], description: "Demote — following siblings become this headline's children" },
    ],
  },
  {
    title: 'Formatting',
    shortcuts: [
      { keys: ['Cmd', 'B'], description: 'Bold the selected text' },
      { keys: ['Cmd', 'I'], description: 'Italicize the selected text' },
      { keys: ['Cmd', '`'], description: 'Toggle render mode (plain text vs. rendered)' },
      { keys: ['Cmd', '\\'], description: 'Toggle comment on the headline' },
    ],
  },
  {
    title: 'GeekityFlow',
    shortcuts: [{ keys: ['Cmd', ','], description: "Expand or collapse the headline's children" }],
  },
  {
    title: 'Clipboard',
    shortcuts: [
      { keys: ['Cmd', 'X'], description: 'Cut' },
      { keys: ['Cmd', 'C'], description: 'Copy' },
      { keys: ['Cmd', 'V'], description: 'Paste' },
    ],
  },
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
  for (const group of SHORTCUT_GROUPS) columns.appendChild(renderGroup(group))
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
