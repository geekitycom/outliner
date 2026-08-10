import { createOutliner } from '@andrewshell/outliner'
import '@andrewshell/outliner/styles.css'
import './styles.css'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { initDocument, confirmClose } from './document'

// Chrome-free: no toolbar, no buttons. The menu (a later commit) and this
// module are the only things that call into document.ts.
const container = document.getElementById('app') as HTMLElement
const outliner = createOutliner(container)
initDocument(outliner)

// newDocument()/openDocument() run this same prompt internally before
// touching the document; the window's close button doesn't go through
// either of those, so it needs its own guard here.
const appWindow = getCurrentWindow()
void appWindow.onCloseRequested(async (event) => {
  event.preventDefault()
  if (await confirmClose()) {
    await appWindow.destroy()
  }
})
