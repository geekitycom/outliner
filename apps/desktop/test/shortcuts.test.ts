import { describe, it, expect } from 'vitest'
import { showShortcuts } from '../src/shortcuts'

// Characterisation tests for the Help > Keyboard Shortcuts sheet.
//
// These pin what the sheet renders TODAY, key by key and word for word. That
// is deliberate and it is the whole point of the file: src/shortcuts.ts
// currently hand-transcribes its content from two sources of truth (the
// keystroke table in packages/outliner/src/util.ts and the accelerators in
// src-tauri/src/lib.rs), and the plan is to rewrite it to derive the rows from
// those sources instead of copying them. A rewrite like that is only safe if
// something independent knows what the user used to see -- so the expected
// values below are written out as literals rather than read back out of
// SHORTCUT_GROUPS, which would make the tests agree with the code by
// construction and catch nothing.
//
// Consequence worth stating plainly: these tests are EXPECTED to fail when the
// sheet's content changes. A failure here is not automatically a bug -- it is
// the sheet's content changing, and the failure is the prompt to confirm the
// change was intended and re-pin it.
//
// They pin the drift, too. The transcription has fallen behind the sources in
// four places (Cmd-F, Cmd-G, Cmd-Shift-W and Cmd-Shift-N are all bound but
// absent from the sheet, and Cmd-, is filed under the app's own group when it
// is really a library keystroke). None of that is corrected here. Pinning the
// current output including its mistakes is what makes the rewrite legible: the
// diff to these expectations then shows exactly which of the user-visible
// changes are the drift being fixed, instead of hiding them among rows that
// were already right.

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
  return [...content.querySelectorAll('.shortcuts-group h3')].map((h) => h.textContent)
}

describe('the keyboard shortcuts sheet', () => {
  it('lays out its groups in a fixed order', async () => {
    const content = await renderShortcutsSheet()

    expect(groupTitles(content)).toEqual([
      'Moving',
      'Editing',
      'Reorganizing',
      'Formatting',
      'GeekityFlow',
      'Clipboard',
      'File',
    ])
  })
})
