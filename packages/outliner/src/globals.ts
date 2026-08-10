// Document-level listeners, installed once for the whole page. Ported from the
// $(document).on(...) calls at the bottom of the original concord.js.
import { eventsEnabled, outlinerForRoot, getFocusRoot, updateFocusRootFromEvent } from './runtime'
import { handleKeydown } from './keyboard'

let installed = false

export function installGlobals(): void {
  if (installed) return
  installed = true

  document.addEventListener('keydown', handleKeydown)

  document.addEventListener('mouseup', (event) => {
    if (!eventsEnabled()) return
    const roots = document.querySelectorAll('.concord-root')
    if (roots.length === 0) return
    const target = event.target as Element
    if (
      target.matches('a') ||
      target.matches('input') ||
      target.matches('textarea') ||
      target.closest('a') ||
      target.classList.contains('dropdown-menu') ||
      target.closest('.dropdown-menu')
    ) {
      return
    }
    const context = target.closest('.concord-root')
    if (!context) {
      roots.forEach((root) => {
        const o = outlinerForRoot(root)
        if (o) {
          o.editor.hideContextMenu()
          o.editor.dragModeExit()
        }
      })
      getFocusRoot()
    }
  })

  document.addEventListener('click', updateFocusRootFromEvent)
  document.addEventListener('dblclick', updateFocusRootFromEvent)
}
