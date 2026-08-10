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
