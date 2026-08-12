// Document-level listeners, installed once for the whole page. Ported from the
// $(document).on(...) calls at the bottom of the original concord.js.
import { outlinerForRoot } from './runtime'
import { hand, restore, suspended } from './caret'
import { handleKeydown } from './keyboard'

let installed = false

export function installGlobals(): void {
  if (installed) return
  installed = true

  document.addEventListener('keydown', handleKeydown)

  document.addEventListener('mouseup', (event) => {
    // While anyone has claimed the caret -- the title row mid-edit, an app's
    // modal -- this handler must not run at all: its whole job is to pull the
    // caret back into an outline, which is precisely what a claim forbids.
    if (suspended()) return
    const roots = document.querySelectorAll('.concord-root')
    if (roots.length === 0) return
    const target = event.target as Element
    // What is left of the original allowlist. The entries for `input`,
    // `textarea` and `.concord-title-row` are gone: they all meant "this
    // element owns its own focus", which is now a fact about caret ownership
    // rather than a list of selectors -- restore() below gives the caret back
    // to whoever owns it, so a click that landed in a field is a no-op instead
    // of a snatch. These two are not focus rules and so do not follow: a link
    // may be about to navigate, and the dropdown is the outline's own context
    // menu, rendered into the container *outside* the root.
    if (
      target.matches('a') ||
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
      // A click on the page background blurs whatever held the caret without
      // giving it to anything, so the outline has to ask for it back -- this is
      // the "the outline stays live while you click around the page" behavior.
      restore()
    }
  })

  // A pointer landing in an outline makes that outline the owner. Clicks on a
  // headline's text move the caret by themselves, but a click on a wrapper or a
  // node icon does not -- events.ts calls preventDefault() there -- so with two
  // outliners on a page this is what stops keystrokes carrying on going to the
  // one you clicked *away* from.
  const handOver = (event: Event) => {
    const target = event.target as Element | null
    const root = target?.closest('.concord-root') as HTMLElement | null
    if (root) hand({ kind: 'outline', root })
  }
  document.addEventListener('click', handOver)
  document.addEventListener('dblclick', handOver)
}
