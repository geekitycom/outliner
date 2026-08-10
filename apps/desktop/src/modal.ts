// A small reusable modal built on the native <dialog> element. It only knows
// how to show some content and resolve once the dialog closes — the
// unsaved-changes prompt below is the first caller, and the Help ▸ Keyboard
// Shortcuts sheet (a later commit) is the second, which is why this stays
// generic rather than baking in "confirm discard" specifics.
import { stopListening, resumeListening } from '@andrewshell/outliner'

/**
 * Show `content` in a modal <dialog> and resolve with its `returnValue` once
 * it closes.
 *
 * stopListening()/resumeListening() bracket the dialog's whole lifetime so
 * arrow keys and Cmd-B don't leak through to the outline sitting behind it.
 * resumeListening() is wired to the dialog's `close` event rather than
 * chained onto a button click, so it still runs when the dialog is dismissed
 * with Esc instead of an explicit button.
 */
export function showModal(content: HTMLElement): Promise<string> {
  const dialog = document.createElement('dialog')
  dialog.className = 'app-modal'
  dialog.appendChild(content)
  document.body.appendChild(dialog)

  stopListening()

  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        resumeListening()
        dialog.remove()
        resolve(dialog.returnValue)
      },
      { once: true },
    )
    dialog.showModal()
  })
}

export type DiscardChoice = 'save' | 'discard' | 'cancel'

/**
 * "You have unsaved changes" prompt with three outcomes. This can't be the
 * dialog plugin's own ask()/confirm() — those only ever offer two buttons,
 * which has no room for Cancel alongside Save and Don't Save.
 */
export function confirmDiscard(): Promise<DiscardChoice> {
  const form = document.createElement('form')
  form.method = 'dialog'
  form.className = 'confirm-discard'

  const message = document.createElement('p')
  message.textContent = 'This document has unsaved changes.'
  form.appendChild(message)

  const buttons = document.createElement('div')
  buttons.className = 'confirm-discard-buttons'
  form.appendChild(buttons)

  const addButton = (label: string, value: DiscardChoice, autofocus = false) => {
    const button = document.createElement('button')
    button.type = 'submit'
    button.value = value
    button.textContent = label
    button.autofocus = autofocus
    buttons.appendChild(button)
  }

  addButton("Don't Save", 'discard')
  // Cancel is the safe default: it's what Esc falls back to below, so it
  // gets the initial focus too.
  addButton('Cancel', 'cancel', true)
  addButton('Save', 'save')

  return showModal(form).then((value): DiscardChoice => {
    // A submit button's value becomes dialog.returnValue. Esc closes the
    // dialog natively (a `cancel` event, no form submission) and leaves
    // returnValue at its default of '' — which must map to 'cancel', not to
    // a silent discard of the user's changes.
    if (value === 'save' || value === 'discard') return value
    return 'cancel'
  })
}
