// A small reusable modal built on the native <dialog> element. It only knows
// how to show some content and resolve once the dialog closes — the
// unsaved-changes prompt below is the first caller, and the Help ▸ Keyboard
// Shortcuts sheet (a later commit) is the second, which is why this stays
// generic rather than baking in "confirm discard" specifics.
import { claim } from '@andrewshell/outliner'

/**
 * Show `content` in a modal <dialog> and resolve with its `returnValue` once
 * it closes.
 *
 * The dialog claims the caret for its whole lifetime, so arrow keys and Cmd-B
 * don't leak through to the outline sitting behind it. Releasing is wired to
 * the dialog's `close` event rather than chained onto a button click, so it
 * still runs when the dialog is dismissed with Esc instead of an explicit
 * button — and releasing hands the caret back to whoever had it before the
 * dialog opened, which is why nothing here has to know that the thing behind it
 * is an outline, let alone whether it was mid-edit.
 *
 * This replaces a stopListening()/resumeListening() bracket that was not
 * reentrant: opening this dialog while the outliner's title row was being typed
 * in did nothing (already stopped), and closing it re-enabled events for
 * everyone — including the title row, whose field still had the caret. The
 * claim is per-dialog, so overlapping suspensions now nest instead of
 * cancelling each other (docs/adr/0002).
 *
 * The claim goes in before showModal(), deliberately. The claim records who
 * held the caret at the moment it was taken, and that is who gets it back on
 * release; claiming afterwards would record the dialog's own autofocused button
 * as the thing to restore, and that button is about to be removed from the
 * document, so the caret would end up nowhere.
 */
export function showModal(content: HTMLElement): Promise<string> {
  const dialog = document.createElement('dialog')
  dialog.className = 'app-modal'
  dialog.appendChild(content)
  document.body.appendChild(dialog)

  const release = claim({ kind: 'field', el: dialog })

  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        // Before remove(), so the caret is handed back while the dialog is
        // still in the document and the browser has somewhere to move it from.
        release()
        dialog.remove()
        resolve(dialog.returnValue)
      },
      { once: true },
    )
    dialog.showModal()
  })
}

export type DiscardChoice = 'save' | 'discard' | 'cancel'

// The warning triangle, inline rather than an asset file: the app bundles no
// images, and the outliner library itself renders every icon as inline SVG
// (src/icons.ts), so this keeps to the same approach.
const WARNING_ICON = `
<svg class="confirm-discard-icon" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <path d="M32 6.5c2.1 0 4 1.1 5.1 2.9l24 41.4c1 1.8 1 4 0 5.8a5.9 5.9 0 0 1-5.1 2.9H8a5.9 5.9 0 0 1-5.1-2.9c-1-1.8-1-4 0-5.8l24-41.4A5.9 5.9 0 0 1 32 6.5z"
        fill="#e0a91f" stroke="#c8901a" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M32 22v18" stroke="#fff" stroke-width="6.5" stroke-linecap="round"/>
  <circle cx="32" cy="49.5" r="3.6" fill="#fff"/>
</svg>`

/**
 * "You have unsaved changes" prompt with three outcomes. This can't be the
 * dialog plugin's own ask()/confirm() — those only ever offer two buttons,
 * which has no room for Cancel alongside Save and Don't Save.
 *
 * Laid out like the macOS save alert it stands in for: warning icon, a bold
 * question naming the document, a consequence line, then full-width buttons
 * stacked vertically with Save as the tinted default.
 *
 * `documentName` is what the user calls this document — a filename, or
 * "Untitled" for one never saved. Naming it matters when several windows are
 * open and the quit flow walks through them one at a time: an anonymous
 * "This document has unsaved changes" gives no clue *which* document is
 * being asked about.
 */
export function confirmDiscard(documentName: string): Promise<DiscardChoice> {
  const form = document.createElement('form')
  form.method = 'dialog'
  form.className = 'confirm-discard'
  form.insertAdjacentHTML('beforeend', WARNING_ICON)

  const heading = document.createElement('h2')
  heading.className = 'confirm-discard-heading'
  // textContent, not innerHTML — a filename can contain < or & and this is
  // the one part of the dialog built from outside data.
  heading.textContent = `Do you want to save the changes you made to ${documentName}?`
  form.appendChild(heading)

  const detail = document.createElement('p')
  detail.className = 'confirm-discard-detail'
  detail.textContent = "Your changes will be lost if you don't save them."
  form.appendChild(detail)

  const buttons = document.createElement('div')
  buttons.className = 'confirm-discard-buttons'
  form.appendChild(buttons)

  const addButton = (label: string, value: DiscardChoice, primary = false) => {
    const button = document.createElement('button')
    button.type = 'submit'
    button.value = value
    button.textContent = label
    if (primary) {
      button.className = 'primary'
      // First in DOM order *and* focused, so Return activates it — matching
      // the tint, which is what tells the user Return does. Esc still maps
      // to 'cancel' below, so the destructive choice is never a default.
      button.autofocus = true
    }
    buttons.appendChild(button)
  }

  // DOM order is display order here (the buttons stack vertically), so this
  // is also the visual top-to-bottom order, as in the macOS alert.
  addButton('Save', 'save', true)
  addButton("Don't Save", 'discard')
  addButton('Cancel', 'cancel')

  return showModal(form).then((value): DiscardChoice => {
    // A submit button's value becomes dialog.returnValue. Esc closes the
    // dialog natively (a `cancel` event, no form submission) and leaves
    // returnValue at its default of '' — which must map to 'cancel', not to
    // a silent discard of the user's changes.
    if (value === 'save' || value === 'discard') return value
    return 'cancel'
  })
}
