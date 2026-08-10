// Outliner — a TypeScript port of Concord (Dave Winer / Small Picture's
// JavaScript outliner), with no jQuery, no Bootstrap, and inline SVG icons.
export { Outliner } from './outliner'
export type { InstanceState } from './outliner'
export { NodeRef } from './noderef'
export { VERSION, EMPTY_OPML } from './constants'
export { UP, DOWN, LEFT, RIGHT, FLATUP, FLATDOWN, NODIRECTION } from './constants'
export { appTypeIcons, ICONS, injectIconStyles, iconHtml } from './icons'
export {
  stopListening,
  resumeListening,
  getFocusRoot,
  setFocusRoot,
} from './runtime'
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
