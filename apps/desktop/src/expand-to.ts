// The View ▸ Expand To… prompt: asks for a level number, then calls
// outliner.expandToLevel(). Built on the existing showModal() (see
// modal.ts), which already brackets stopListening()/resumeListening()
// around the dialog so arrow keys and Cmd-B don't leak through to the
// outline sitting behind it — not window.prompt(), which is a blocking
// browser dialog with no such bracketing and is unreliable inside a
// webview.
import type { Outliner } from '@andrewshell/outliner'
import { showModal } from './modal'

function buildContent(): { form: HTMLElement; input: HTMLInputElement } {
  const form = document.createElement('form')
  form.method = 'dialog'
  form.className = 'expand-to'

  const message = document.createElement('p')
  // Numbering matches expandToLevel's own doc comment (outliner.ts): 1-based,
  // 1 = top-level only, 2 = top-level plus their immediate children, etc.
  message.textContent =
    'Expand to level (1 = top-level headlines only, 2 = top-level plus their immediate children, and so on):'
  form.appendChild(message)

  const input = document.createElement('input')
  input.type = 'number'
  input.min = '1'
  input.step = '1'
  input.value = '1'
  input.autofocus = true
  form.appendChild(input)

  const buttons = document.createElement('div')
  buttons.className = 'expand-to-buttons'
  form.appendChild(buttons)

  // Expand is first in DOM order (not Cancel) so it's the form's implicit
  // "default button" — pressing Return in the number field submits 'ok',
  // which is what a user typing a level and hitting Return expects. The
  // .expand-to-buttons CSS reverses the visual order so Cancel still reads
  // left-of Expand.
  const okButton = document.createElement('button')
  okButton.type = 'submit'
  okButton.value = 'ok'
  okButton.textContent = 'Expand'
  buttons.appendChild(okButton)

  const cancelButton = document.createElement('button')
  cancelButton.type = 'submit'
  cancelButton.value = 'cancel'
  cancelButton.textContent = 'Cancel'
  buttons.appendChild(cancelButton)

  return { form, input }
}

/**
 * Opens the View ▸ Expand To… prompt and, if the user confirms with a valid
 * level, calls `outliner.expandToLevel()`. Anything else — Cancel, Esc, a
 * blank/zero/negative/non-integer value — is silently ignored rather than
 * coerced into some default level.
 */
export async function promptExpandTo(outliner: Outliner): Promise<void> {
  const { form, input } = buildContent()
  const choice = await showModal(form)
  if (choice !== 'ok') return // cancelled, or dismissed with Esc

  const level = Number(input.value)
  if (!Number.isInteger(level) || level < 1) return

  outliner.expandToLevel(level)
}
