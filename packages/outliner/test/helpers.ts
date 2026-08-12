import { Outliner } from '../src'

/** A normalized outline node, ignoring OPML head/timestamps. */
export interface OutlineNode {
  text: string
  attrs: Record<string, string>
  children: OutlineNode[]
}

/** Mount an outliner on a fresh container, optionally loading OPML. */
export function mount(opml?: string): Outliner {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const o = new Outliner(container)
  if (opml) o.loadOpml(opml)
  return o
}

/** Wrap a `<body>` fragment in a minimal OPML document. */
export function opml(body: string): string {
  return `<?xml version="1.0"?><opml version="2.0"><head><title>t</title></head><body>${body}</body></opml>`
}

/** Parse OPML into a normalized tree (head + timestamps excluded). */
export function bodyTree(opmlText: string): OutlineNode[] {
  const doc = new DOMParser().parseFromString(opmlText, 'application/xml')
  const body = doc.querySelector('body')
  const outlines = (el: Element | null): Element[] =>
    Array.from(el?.children ?? []).filter(
      (c) => c.tagName.toLowerCase() === 'outline',
    )
  const walk = (outline: Element): OutlineNode => {
    const attrs: Record<string, string> = {}
    for (const a of Array.from(outline.attributes)) {
      if (a.name !== 'text') attrs[a.name] = a.value
    }
    return {
      text: outline.getAttribute('text') ?? '',
      attrs,
      children: outlines(outline).map(walk),
    }
  }
  return outlines(body).map(walk)
}

/** The top-level headline texts of an OPML document. */
export function topTexts(opmlText: string): string[] {
  return bodyTree(opmlText).map((n) => n.text)
}

/**
 * Character codes for the keystrokes the tests dispatch, named the way a
 * person would say them. `getKeystroke()` (util.ts) decodes these into
 * Concord's keystroke names — `13` into `'return'`, `meta` + `219` into
 * `'promote'` — so these are the codes, not the commands.
 */
export const KEY = {
  backspace: 8,
  tab: 9,
  return: 13,
  escape: 27,
  left: 37,
  up: 38,
  right: 39,
  down: 40,
  a: 65,
  x: 88,
  z: 90,
  comma: 188,
  leftBracket: 219,
  rightBracket: 221,
} as const

/**
 * Dispatch a real keydown where the outline's global dispatcher listens for
 * one — at `document`, which is where globals.ts binds `handleKeydown`.
 *
 * `which` has to be installed by hand. jsdom leaves `which`/`keyCode` at 0 on
 * an event built from a `KeyboardEventInit`, and keyboard.ts reads
 * `event.which || event.keyCode` rather than `event.key`: it is a port of
 * Concord's document handler and its whole keystroke table is keyed on
 * character codes. An event built without `which` therefore decodes as the
 * keystroke `'0'`, falls out of the switch, and the test passes for a reason
 * that has nothing to do with what it meant to check — so this helper exists
 * partly to make that impossible to forget.
 *
 * Dispatching at `document` deliberately skips the field-level
 * `stopPropagation()` in titleRow.ts, leaving *caret ownership* as the only
 * thing that can refuse the keystroke. That is the stronger test: it is the
 * guard that has to hold for a dialog, an app's own chrome, and anything else
 * that never gets a listener of its own.
 */
export function keydown(
  which: number,
  init: KeyboardEventInit = {},
  target: EventTarget = document,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'which', { value: which })
  target.dispatchEvent(event)
  return event
}

/**
 * How many headlines the outline is showing, counted straight from the DOM.
 *
 * Deliberately not `bodyTree(o.toOpml()).length`: `toOpml()` flushes a
 * title-row edit that is still open (`TitleRow.flush()`, so Cmd-S saves what is
 * on screen), and flushing releases the row's claim on the caret. A test that
 * measured the outline this way while the row was mid-edit would dismantle the
 * very suspension it was trying to observe.
 */
export function headlineCount(o: Outliner): number {
  return o.root.querySelectorAll('.concord-node').length
}
