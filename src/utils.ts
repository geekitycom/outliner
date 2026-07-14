// Optional compatibility / convenience layer — the modern equivalent of the
// original concordutils.js. This is NOT part of the core outliner; it's a thin,
// opt-in shim for apps upgrading from the old jQuery Concord. Those apps drove a
// single "#outliner" through global op* functions; register your instance once
// with setDefaultOutliner() and the same op* calls keep working, translated to
// the new Outliner API.
//
//   import { createOutliner } from './index'
//   import { setDefaultOutliner, opExpand, opReorg, initialOpmltext } from './utils'
//
//   const outliner = createOutliner(document.getElementById('outliner')!)
//   setDefaultOutliner(outliner)
//   opXmlToOutline(initialOpmltext)
//   opExpand(); opReorg('right', 1)   // exactly as the old app called them

import type {
  Direction,
  NodeRef,
  OpmlAttributes,
  OutlinerCallbacks,
  OutlinerOptions,
} from './types'
import { Outliner } from './outliner'
import { EMPTY_OPML } from './constants'

export { appTypeIcons } from './icons'

/** The original name for the empty-outline OPML string. */
export const initialOpmltext = EMPTY_OPML

/** The default outliner selector, as in the original concordutils.js. */
export const defaultUtilsOutliner = '#outliner'

// Direction globals matched the old `var up = "up"` etc. so call sites read the
// same. (The core module exports the UPPERCASE variants.)
export const up: Direction = 'up'
export const down: Direction = 'down'
export const left: Direction = 'left'
export const right: Direction = 'right'
export const flatup: Direction = 'flatup'
export const flatdown: Direction = 'flatdown'

// --- default outliner registration ------------------------------------------

const instances = new WeakMap<HTMLElement, Outliner>()
let defaultOutliner: Outliner | null = null
let defaultSelector = '#outliner' // matches concordutils' defaultUtilsOutliner

// Old Concord callback names -> the modern ones the Outliner fires.
const LEGACY_CALLBACKS: Record<string, keyof OutlinerCallbacks> = {
  opInsert: 'insert',
  opCursorMoved: 'cursorMoved',
  opExpand: 'expand',
  opCollapse: 'collapse',
  opReorg: 'reorg',
  opHover: 'hover',
  opContextMenu: 'contextMenu',
  opKeystroke: 'keystroke',
}

function translateOptions(options?: OutlinerOptions): OutlinerOptions | undefined {
  if (!options?.callbacks) return options
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options.callbacks)) {
    out[LEGACY_CALLBACKS[key] ?? key] = value
  }
  return { ...options, callbacks: out as OutlinerCallbacks }
}

/** Get (or create) the outliner bound to a container element. */
export function getOrCreateOutliner(
  el: HTMLElement,
  options?: OutlinerOptions,
): Outliner {
  let o = instances.get(el)
  if (!o) {
    o = new Outliner(el, translateOptions(options))
    instances.set(el, o)
  } else if (options) {
    const t = translateOptions(options)!
    if (t.prefs) o.prefs(t.prefs)
    if (t.callbacks) o.setCallbacks(t.callbacks)
  }
  return o
}

/** Register the instance the op* helpers act on (the old `defaultUtilsOutliner`). */
export function setDefaultOutliner(outliner: Outliner): void {
  defaultOutliner = outliner
  instances.set(outliner.container, outliner)
}

/** Change the selector the op* helpers fall back to (default `#outliner`). */
export function setDefaultOutlinerSelector(selector: string): void {
  defaultSelector = selector
}

/**
 * The instance the op* helpers act on. Like the original concordutils, if none
 * has been registered it resolves (creating if needed) the element matching the
 * default selector (`#outliner`), so `op*` calls work before an explicit create.
 */
export function getDefaultOutliner(): Outliner {
  if (defaultOutliner) return defaultOutliner
  const el =
    typeof document !== 'undefined' ? document.querySelector(defaultSelector) : null
  if (el instanceof HTMLElement) {
    defaultOutliner = getOrCreateOutliner(el)
    return defaultOutliner
  }
  throw new Error(
    `outliner/utils: no default outliner and nothing matches "${defaultSelector}". ` +
      'Call setDefaultOutliner(outliner) first.',
  )
}

// --- classic jQuery plugin shim ---------------------------------------------

interface JQueryLike {
  0?: HTMLElement
}
interface JQueryStatic {
  fn: Record<string, unknown>
}

/**
 * If jQuery is present, register the classic `$(selector).concord(options)`
 * plugin, so an old Concord app can create the outliner exactly as before
 * (it returns the Outliner instance, which exposes `.op` / `.editor` / `.script`).
 * Legacy `opInsert`/`opExpand`/… callback names are translated automatically.
 * The created instance becomes the default for the op* helpers. Returns whether
 * it installed.
 */
export function installConcordJQueryPlugin(): boolean {
  const g = globalThis as unknown as { jQuery?: JQueryStatic }
  const $ = g.jQuery
  if (!$ || !$.fn) return false
  $.fn.concord = function (
    this: JQueryLike,
    options?: OutlinerOptions,
  ): Outliner | undefined {
    const el = this[0]
    if (!el) return undefined
    const o = getOrCreateOutliner(el, options)
    setDefaultOutliner(o)
    return o
  }
  return true
}

const o = getDefaultOutliner

// --- op* glue routines (1:1 with concordutils.js) ---------------------------

export const opUndo = () => o().undo()
export const opCut = () => o().cut()
export const opCopy = () => o().copy()
export const opPaste = () => o().paste()
export const opReorg = (dir: Direction, count?: number) => o().reorg(dir, count)
export const opSetFont = (font: string, fontsize: number, lineheight?: number) =>
  o().setFont(font, fontsize, lineheight)
export const opPromote = () => o().promote()
export const opDemote = () => o().demote()
export const opBold = () => o().bold()
export const opItalic = () => o().italic()
export const opLink = (url: string) => o().link(url)
export const opSetTextMode = (flTextMode: boolean) => o().setTextMode(flTextMode)
export const opInTextMode = () => o().isTextMode()

export const opGetAtts = (): OpmlAttributes => o().cursor.attributes.getAll()
export const opGetOneAtt = (name: string) => o().cursor.attributes.get(name)
export const opHasAtt = (name: string) => o().cursor.attributes.has(name)
export const opSetOneAtt = (name: string, value: string) =>
  o().cursor.attributes.set(name, value)
export const opSetAtts = (atts: OpmlAttributes) => o().cursor.attributes.setAll(atts)
export const opAddAtts = (atts: OpmlAttributes) => o().cursor.attributes.add(atts)

export const opSetStyle = (css: string) => o().setStyle(css)
export const opGetLineText = () => o().getLineText()
export const opExpand = () => o().expand()
export const opExpandAllLevels = () => o().expandAllSubs()
export const opExpandEverything = () => o().expandEverything()
export const opCollapse = () => o().collapse()
export const opCollapseEverything = () => o().collapseEverything()

export const opIsComment = () => o().isComment()
export const opMakeComment = () => o().makeComment()
export const opUnComment = () => o().unComment()
export const opToggleComment = () => o().toggleComment()

export const opInsert = (s: string, dir?: Direction): NodeRef => o().insert(s, dir)
export const opInsertImage = (url: string) => o().insertImage(url)
export const opSetLineText = (s: string) => o().setLineText(s)
export const opDeleteSubs = () => o().deleteSubs()
export const opCountSubs = () => o().countSubs()
export const opHasSubs = () => opCountSubs() > 0
export const opSubsExpanded = () => o().subsExpanded()
export const opGo = (dir: Direction, ct?: number) => o().go(dir, ct)
export const opFirstSummit = () => {
  opGo(left, 32767)
  opGo(up, 32767)
}

export const opXmlToOutline = (xmltext: string) => o().loadOpml(xmltext)
export const opInsertXml = (xmltext: string, dir?: Direction) =>
  o().insertOpml(xmltext, dir)
export const opOutlineToXml = (
  ownerName?: string,
  ownerEmail?: string,
  ownerId?: string,
) => o().toOpml(ownerName, ownerEmail, ownerId)
export const opCursorToXml = () => o().cursorToOpml()
export const opSetTitle = (title: string) => o().setTitle(title)
export const opGetTitle = () => o().getTitle()
export const opHasChanged = () => o().hasChanged()
export const opClearChanged = () => o().clearChanged()
export const opMarkChanged = () => o().markChanged()
export const opRedraw = () => o().redraw()
export const opVisitAll = (cb: (node: NodeRef) => boolean | void) => o().visitAll(cb)
export const opWipe = () => o().wipe()

// --- string / misc helpers (ported verbatim, minus jQuery) ------------------

export function filledString(s: string, ct: number): string {
  let out = ''
  for (let i = 0; i < ct; i++) out += s
  return out
}

export function multipleReplaceAll(
  s: string,
  table: Record<string, string>,
  flCaseSensitive = false,
  startCharacters = '',
  endCharacters = '',
): string {
  const flags = flCaseSensitive ? 'g' : 'gi'
  for (const item of Object.keys(table)) {
    const pattern = (startCharacters + item + endCharacters).replace(
      /([.?*+^$[\]\\(){}|-])/g,
      '\\$1',
    )
    s = s.replace(new RegExp(pattern, flags), table[item])
  }
  return s
}

export function secondsSince(when: Date): number {
  return (Date.now() - when.getTime()) / 1000
}

/**
 * Fetch text from a URL and hand it to a callback. Modernized from the original
 * readText, which routed through a (now-defunct) scripting.com proxy. This calls
 * the URL directly, so it needs a CORS-enabled endpoint.
 */
export async function readText<T>(
  url: string,
  callback: (data: string, op?: T) => void,
  op?: T,
  flAcceptOpml = false,
): Promise<void> {
  const headers: Record<string, string> = {}
  if (flAcceptOpml) headers['Accept'] = 'text/x-opml'
  try {
    const res = await fetch(url, { headers })
    const data = await res.text()
    callback(data, op)
  } catch (err) {
    console.log('readText failed:', err)
  }
}
