// The Outliner ▸ Find… / Find again prompt: asks for search text, then calls
// outliner.find()/findAgain(). Built on the existing showModal() (see
// modal.ts), which already brackets stopListening()/resumeListening() around
// the dialog so arrow keys and Cmd-B don't leak through to the outline
// sitting behind it — not window.prompt(), which is a blocking browser
// dialog with no such bracketing and is unreliable inside a webview.
import type { Outliner } from '@andrewshell/outliner'
import { message } from '@tauri-apps/plugin-dialog'
import { showModal } from './modal'

// find()/findAgain() have no public "has a search happened yet" accessor
// (Op.lastSearch is private, see packages/outliner/src/op.ts) — so Find
// again needs its own memory of whether Find… has ever been run, and what
// for, to tell "nothing to repeat" apart from "no further match" and to
// name the query in the not-found message below. Module-level state is
// fine here: like document.ts's outliner/currentPath, each window is its
// own JS realm, so this is naturally per-window.
let hasSearched = false
let lastQueryText = ''

function buildContent(): { form: HTMLElement; input: HTMLInputElement; matchCaseInput: HTMLInputElement } {
  const form = document.createElement('form')
  form.method = 'dialog'
  form.className = 'find'

  // Named `hint`, not `message`, so it doesn't shadow the dialog plugin's
  // message() imported above.
  const hint = document.createElement('p')
  hint.textContent = 'Find:'
  form.appendChild(hint)

  const input = document.createElement('input')
  input.type = 'text'
  input.autofocus = true
  form.appendChild(input)

  // matchCase is a plain checkbox — cheap to expose, and find()'s default
  // (case-insensitive) isn't always what the user wants. wrap isn't
  // exposed: it only changes what happens after the last match, which
  // isn't worth a second control in a one-line prompt.
  const matchCaseLabel = document.createElement('label')
  matchCaseLabel.className = 'find-match-case'
  const matchCaseInput = document.createElement('input')
  matchCaseInput.type = 'checkbox'
  matchCaseLabel.appendChild(matchCaseInput)
  matchCaseLabel.appendChild(document.createTextNode(' Match case'))
  form.appendChild(matchCaseLabel)

  const buttons = document.createElement('div')
  buttons.className = 'find-buttons'
  form.appendChild(buttons)

  // Find is first in DOM order (not Cancel) so it's the form's implicit
  // "default button" — pressing Return in the text field submits 'ok',
  // which is what a user typing a search and hitting Return expects. The
  // .find-buttons CSS reverses the visual order so Cancel still reads
  // left-of Find.
  const okButton = document.createElement('button')
  okButton.type = 'submit'
  okButton.value = 'ok'
  okButton.textContent = 'Find'
  buttons.appendChild(okButton)

  const cancelButton = document.createElement('button')
  cancelButton.type = 'submit'
  cancelButton.value = 'cancel'
  cancelButton.textContent = 'Cancel'
  buttons.appendChild(cancelButton)

  return { form, input, matchCaseInput }
}

/**
 * Tell the user a search came up empty, rather than failing silently — a
 * search that never marks the document dirty and moves nothing is
 * otherwise indistinguishable from the menu item having done nothing at
 * all. Reuses the same dialog-plugin message() call as reportError() in
 * document.ts, just with kind: 'info' instead of 'error' since this isn't
 * a failure.
 */
async function notFound(text: string): Promise<void> {
  await message(`No match found for "${text}".`, { title: 'GeekityFlow', kind: 'info' })
}

/**
 * Opens the Outliner ▸ Find… prompt and, if the user confirms with
 * non-empty text, calls `outliner.find()`. Cancel, Esc, or a blank value is
 * silently ignored — there's nothing to search for.
 */
export async function promptFind(outliner: Outliner): Promise<void> {
  const { form, input, matchCaseInput } = buildContent()
  const choice = await showModal(form)
  if (choice !== 'ok') return // cancelled, or dismissed with Esc

  const text = input.value.trim()
  if (!text) return

  hasSearched = true
  lastQueryText = text
  const found = outliner.find(text, { matchCase: matchCaseInput.checked })
  if (!found) await notFound(text)
}

/**
 * Outliner ▸ Find again: repeats the last search. `findAgain()` returns
 * `false` both when there's no further match *and* when there was never a
 * previous search at all — those need different handling, and the library
 * has no way to tell them apart from the outside (see the module comment
 * above), so this module tracks `hasSearched` itself and opens the Find…
 * prompt instead of repeating a search that was never made.
 */
export async function findAgain(outliner: Outliner): Promise<void> {
  if (!hasSearched) {
    await promptFind(outliner)
    return
  }

  const found = outliner.findAgain()
  if (!found) await notFound(lastQueryText)
}
