// A read/write handle to one headline, handed to callbacks and traversal.
// Replaces the original "cursor context op" (a ConcordOp bound to a fixed node).
import type { Outliner } from './outliner'
import type { Direction, NodeRef as NodeRefApi } from './types'
import { DOWN, LEFT, RIGHT } from './constants'
import { NodeAttributes } from './attributes'
import {
  childNodes,
  childOl,
  getNodeAttributes,
  nodeParents,
  textOf,
} from './dom'

export class NodeRef implements NodeRefApi {
  attributes: NodeAttributes

  constructor(
    private o: Outliner,
    readonly element: HTMLLIElement,
  ) {
    this.attributes = new NodeAttributes(o, () => this.element)
  }

  getLineText(): string {
    let text = textOf(this.element)?.innerHTML ?? ''
    const m = text.match(/^(.+)<br>\s*$/)
    if (m) text = m[1]
    return this.o.editor.unescape(text)
  }

  level(): number {
    return nodeParents(this.element).length + 1
  }

  countSubs(): number {
    return childNodes(this.element).length
  }

  subsExpanded(): boolean {
    return (
      !this.element.classList.contains('collapsed') &&
      childNodes(this.element).length > 0
    )
  }

  isComment(): boolean {
    const own = getNodeAttributes(this.element)['isComment']
    if (own !== undefined) return own === 'true'
    return nodeParents(this.element).some(
      (p) => getNodeAttributes(p)['isComment'] === 'true',
    )
  }

  toOpml(): string {
    return this.o.editor.opml(this.element, true)
  }

  visitLevel(cb: (child: NodeRefApi) => void): void {
    for (const child of childNodes(this.element)) {
      cb(new NodeRef(this.o, child))
    }
  }

  deleteSubs(): void {
    if (childNodes(this.element).length > 0) {
      this.o.op.saveState()
      childOl(this.element)?.replaceChildren()
      this.o.op.markChanged()
    }
  }

  clearChanged(): boolean {
    return this.o.op.clearChanged()
  }

  insertOpml(opml: string, dir: Direction = RIGHT): boolean {
    this.o.op.saveState()
    const node = this.element
    let level = nodeParents(node).length + 1
    if (dir === RIGHT) level += 1
    else if (dir === LEFT) level -= 1

    const doc = new DOMParser().parseFromString(opml, 'application/xml')
    const body = doc.querySelector('body')
    const nodes: HTMLLIElement[] = []
    if (body) {
      for (const outline of Array.from(body.children)) {
        if (outline.tagName.toLowerCase() === 'outline') {
          nodes.push(this.o.editor.build(outline, true, level))
        }
      }
    }
    switch (dir) {
      case RIGHT: {
        const ol = childOl(node, true)!
        for (const n of nodes) ol.appendChild(n)
        node.classList.remove('collapsed')
        break
      }
      case DOWN: {
        let anchor: Element = node
        for (const n of nodes) {
          anchor.insertAdjacentElement('afterend', n)
          anchor = n
        }
        break
      }
      default: {
        let anchor: Element = node
        for (const n of nodes) {
          anchor.insertAdjacentElement('afterend', n)
          anchor = n
        }
      }
    }
    this.o.op.markChanged()
    return true
  }

  /** @deprecated use {@link insertOpml} */
  insertXml(opml: string, dir?: Direction): boolean {
    return this.insertOpml(opml, dir)
  }
}
