// Outliner — a TypeScript port of Concord (Dave Winer / Small Picture's
// JavaScript outliner), with no jQuery, no Bootstrap, and inline SVG icons.
export { Outliner } from './outliner'
export type { InstanceState } from './outliner'
export { NodeRef } from './noderef'
export { VERSION, EMPTY_OPML } from './constants'
export { UP, DOWN, LEFT, RIGHT, FLATUP, FLATDOWN, NODIRECTION } from './constants'
export { appTypeIcons, ICONS, injectIconStyles, iconHtml } from './icons'
// The keystroke table, so an embedding app can see which keys the outliner
// already claims instead of guessing or transcribing them. See its doc comment
// in util.ts for what goes wrong without it — both failures are silent.
export { CONCORD_KEYSTROKES } from './util'
// Caret ownership, in place of the no-arg `stopListening()` /
// `resumeListening()` / `getFocusRoot()` / `setFocusRoot()` API removed at
// 0.2.0 (docs/adr/0002). Suspending the outliner means taking the caret for
// your own element and calling the disposable you get back when you are done
// with it:
//
//     const release = claim({ kind: 'field', el: dialog })
//     dialog.addEventListener('close', () => release(), { once: true })
//
// The disposable carries the identity the old pair could not, so two suspenders
// — a dialog opening over a field that is already being typed in — no longer
// release each other. Note that there is no accessor for *who* owns the caret:
// an app that branches on that is one step from moving the caret itself, which
// is the class of bug this module exists to make unrepresentable.
export { claim } from './caret'
export type { CaretOwner } from './caret'
export type {
  Direction,
  OpmlAttributes,
  OpmlHeaders,
  TypeIcons,
  OutlinerPrefs,
  OutlinerOptions,
  OutlinerCallbacks,
  NodeRef as NodeRefApi,
  NodeAttributesApi,
  KeystrokeEvent,
  FindOptions,
} from './types'

import { Outliner } from './outliner'
import type { OutlinerOptions } from './types'

/** Convenience factory: mount an outliner on a container element. */
export function createOutliner(
  container: HTMLElement,
  options?: OutlinerOptions,
): Outliner {
  return new Outliner(container, options)
}
