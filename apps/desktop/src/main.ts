import { createOutliner } from '@andrewshell/outliner'
import '@andrewshell/outliner/styles.css'
import './styles.css'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { initDocument, confirmClose, reportError } from './document'
import { installMenu } from './menu'

// Chrome-free: no toolbar, no buttons. The menu and this module are the
// only things that call into document.ts.
const container = document.getElementById('app') as HTMLElement
const outliner = createOutliner(container)
initDocument(outliner)
void installMenu()

// newDocument()/openDocument() run this same prompt internally before
// touching the document; the window's close button doesn't go through
// either of those, so it needs its own guard here.
const appWindow = getCurrentWindow()
void appWindow.onCloseRequested(async (event) => {
  event.preventDefault()
  if (await confirmClose()) {
    // destroy() needs its own core:window:allow-destroy grant (core:default
    // only covers read-only window commands, see the README's "Design
    // notes"). If that's ever missing again, report it instead of leaving
    // the close button silently doing nothing, as it did before this was
    // caught.
    try {
      await appWindow.destroy()
    } catch (err) {
      await reportError('close', 'window', err)
    }
  }
})
