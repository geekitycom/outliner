// Vanilla DOM helpers that replace the jQuery idioms Concord relied on.
import type { OpmlAttributes } from './types'

/** Build a single element from an HTML string. */
export function htmlToElement<T extends Element = HTMLElement>(html: string): T {
  const tpl = document.createElement('template')
  tpl.innerHTML = html.trim()
  return tpl.content.firstElementChild as unknown as T
}

/** The nearest ancestor-or-self `.concord-node`, or null. */
export function closestNode(el: Element | null): HTMLLIElement | null {
  return (el?.closest('.concord-node') as HTMLLIElement) ?? null
}

/** The `.concord-node` ancestors of `el`, nearest first (excludes self). */
export function nodeParents(el: Element): HTMLLIElement[] {
  const out: HTMLLIElement[] = []
  let p = el.parentElement
  while (p) {
    if (p.classList.contains('concord-node')) out.push(p as HTMLLIElement)
    p = p.parentElement
  }
  return out
}

/**
 * The immediate `.concord-node` children.
 *
 * For a node `<li>`, these live inside its child `<ol>`. For the root, which is
 * itself the `<ol class="concord-root">`, the `.concord-node`s are direct
 * children — so iterate the element itself in that case.
 */
export function childNodes(el: Element): HTMLLIElement[] {
  const ol = el.tagName === 'OL' ? el : directChild(el, 'ol')
  if (!ol) return []
  return Array.from(ol.children).filter((c) =>
    c.classList.contains('concord-node'),
  ) as HTMLLIElement[]
}

/** First direct child element matching a tag/class selector. */
export function directChild(el: Element, selector: string): HTMLElement | null {
  for (const c of Array.from(el.children)) {
    if (c.matches(selector)) return c as HTMLElement
  }
  return null
}

/** Previous sibling that is a `.concord-node`. */
export function prevNode(li: Element): HTMLLIElement | null {
  let s = li.previousElementSibling
  while (s) {
    if (s.classList.contains('concord-node')) return s as HTMLLIElement
    s = s.previousElementSibling
  }
  return null
}

/** Next sibling that is a `.concord-node`. */
export function nextNode(li: Element): HTMLLIElement | null {
  let s = li.nextElementSibling
  while (s) {
    if (s.classList.contains('concord-node')) return s as HTMLLIElement
    s = s.nextElementSibling
  }
  return null
}

/** The `.concord-wrapper` of a node. */
export function wrapperOf(li: Element): HTMLElement | null {
  return directChild(li, '.concord-wrapper')
}

/** The `.concord-text` (contenteditable) of a node. */
export function textOf(li: Element): HTMLElement | null {
  const w = wrapperOf(li)
  return w ? directChild(w, '.concord-text') : null
}

/** The `.node-icon` span of a node. */
export function iconOf(li: Element): HTMLElement | null {
  const w = wrapperOf(li)
  return w ? directChild(w, '.node-icon') : null
}

/** The child `<ol>` of a node (creating it if asked). */
export function childOl(li: Element, create = false): HTMLOListElement | null {
  let ol = directChild(li, 'ol') as HTMLOListElement | null
  if (!ol && create) {
    ol = document.createElement('ol')
    li.appendChild(ol)
  }
  return ol
}

// --- clone-safe per-node OPML attribute storage -----------------------------
// Stored as JSON in a `data-opml` attribute so cloneNode(true) preserves it.

export function getNodeAttributes(li: Element): OpmlAttributes {
  const raw = li.getAttribute('data-opml')
  if (!raw) return {}
  try {
    return JSON.parse(raw) as OpmlAttributes
  } catch {
    return {}
  }
}

export function setNodeAttributes(li: Element, attrs: OpmlAttributes): void {
  const keys = Object.keys(attrs)
  if (keys.length === 0) {
    li.removeAttribute('data-opml')
  } else {
    li.setAttribute('data-opml', JSON.stringify(attrs))
  }
}

// --- selection helpers ------------------------------------------------------

/** Current selection Range if it lives inside a `.concord-node`, else null. */
export function getConcordRange(): Range | null {
  const sel = window.getSelection()
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0)
    const container = range.startContainer as Element
    const el =
      container.nodeType === Node.ELEMENT_NODE
        ? (container as Element)
        : container.parentElement
    if (el && el.closest('.concord-node')) {
      return range
    }
  }
  return null
}

/** Replace the document selection with `range`. */
export function applyRange(range: Range): void {
  const sel = window.getSelection()
  if (!sel) return
  sel.removeAllRanges()
  sel.addRange(range)
}

/** Put the caret at the end of a contenteditable element's contents. */
export function caretToEnd(el: Element): void {
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  applyRange(range)
}
