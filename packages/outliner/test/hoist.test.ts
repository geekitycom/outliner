import { describe, it, expect } from 'vitest'
import { DOWN } from '../src'
import type { Outliner } from '../src'
import { mount, opml, bodyTree, topTexts } from './helpers'

/** The headline texts currently visible at the top of the (possibly hoisted) view. */
function viewTexts(o: Outliner): string[] {
  return Array.from(o.root.children)
    .filter((c) => c.classList.contains('concord-node'))
    .map((c) => c.querySelector('.concord-text')?.textContent ?? '')
}

/** Find a node's `<li>` element anywhere in the live DOM by its headline text. */
function findByText(o: Outliner, text: string): HTMLLIElement {
  const all = Array.from(o.root.querySelectorAll('.concord-node')) as HTMLLIElement[]
  const found = all.find((el) => el.querySelector('.concord-text')?.textContent === text)
  if (!found) throw new Error(`no node with text ${text}`)
  return found
}

function setCursorTo(o: Outliner, text: string): void {
  o.op.setCursor(findByText(o, text))
}

describe('hoist / de-hoist', () => {
  it('hoist focuses the view on the cursor subtree; de-hoist restores it', () => {
    const doc = opml(
      '<outline text="p"><outline text="c1"/><outline text="c2"/></outline><outline text="q"/>',
    )
    const o = mount(doc) // cursor starts on "p"
    expect(o.isHoisted()).toBe(false)
    expect(o.hoistDepth()).toBe(0)

    expect(o.hoist()).toBe(true)
    expect(o.isHoisted()).toBe(true)
    expect(o.hoistDepth()).toBe(1)
    expect(viewTexts(o)).toEqual(['c1', 'c2'])

    expect(o.deHoist()).toBe(true)
    expect(o.isHoisted()).toBe(false)
    expect(o.hoistDepth()).toBe(0)
    expect(viewTexts(o)).toEqual(['p', 'q'])
  })

  it('hoist returns false with no subs to hoist into', () => {
    const o = mount(opml('<outline text="a"/>'))
    expect(o.hoist()).toBe(false)
    expect(o.isHoisted()).toBe(false)
  })

  it('nested hoists stack, and deHoistAll() returns to the real root', () => {
    const doc = opml(
      '<outline text="a"><outline text="b"><outline text="c"/><outline text="d"/></outline><outline text="e"/></outline><outline text="f"/>',
    )
    const o = mount(doc) // cursor starts on "a"

    expect(o.hoist()).toBe(true) // hoist to a -> view [b, e]
    expect(viewTexts(o)).toEqual(['b', 'e'])
    expect(o.hoistDepth()).toBe(1)

    // hoist() acts on the cursor, which the first hoist parked on "b".
    expect(o.hoist()).toBe(true) // hoist to b -> view [c, d]
    expect(viewTexts(o)).toEqual(['c', 'd'])
    expect(o.hoistDepth()).toBe(2)

    expect(o.deHoistAll()).toBe(true)
    expect(o.isHoisted()).toBe(false)
    expect(o.hoistDepth()).toBe(0)
    expect(viewTexts(o)).toEqual(['a', 'f'])
    expect(bodyTree(o.toOpml())).toEqual(bodyTree(doc))
  })

  it('toOpml() returns the complete document while hoisted, at any depth', () => {
    const doc = opml(
      '<outline text="a"><outline text="b"><outline text="c"/><outline text="d"/></outline><outline text="e"/></outline><outline text="f"/>',
    )
    const o = mount(doc)
    const fullTree = bodyTree(doc)

    o.hoist() // -> view [b, e]
    expect(topTexts(o.toOpml())).toEqual(['a', 'f'])
    expect(bodyTree(o.toOpml())).toEqual(fullTree)
    // toOpml() must not itself disturb the hoisted view.
    expect(viewTexts(o)).toEqual(['b', 'e'])
    expect(o.isHoisted()).toBe(true)

    o.hoist() // -> view [c, d], depth 2
    expect(bodyTree(o.toOpml())).toEqual(fullTree)
    expect(viewTexts(o)).toEqual(['c', 'd'])
    expect(o.hoistDepth()).toBe(2)
  })

  it('toText() returns the complete document while hoisted, at any depth', () => {
    // The companion of the toOpml() case above. Both are *serializers*, so
    // both owe the caller the whole document however deep the view is
    // narrowed; a Save-As-Text made while hoisted that wrote only the hoisted
    // subtree would silently truncate the user's file. The expected strings
    // are written out literally rather than derived from `doc`, so this can
    // never agree with a broken implementation by construction.
    const doc = opml(
      '<outline text="a"><outline text="b"><outline text="c"/><outline text="d"/></outline><outline text="e"/></outline><outline text="f"/>',
    )
    const o = mount(doc)
    const fullText = 'a\n\tb\n\t\tc\n\t\td\n\te\nf\n'
    expect(o.toText()).toBe(fullText)

    o.hoist() // -> view [b, e]
    expect(o.toText()).toBe(fullText)
    // toText() must not itself disturb the hoisted view.
    expect(viewTexts(o)).toEqual(['b', 'e'])
    expect(o.isHoisted()).toBe(true)

    o.hoist() // -> view [c, d], depth 2
    expect(o.toText()).toBe(fullText)
    expect(viewTexts(o)).toEqual(['c', 'd'])
    expect(o.hoistDepth()).toBe(2)
  })

  it('getTitle() / getHeaders() reflect the full document regardless of hoist state', () => {
    const o = mount(opml('<outline text="p"><outline text="c1"/></outline>'))
    o.setTitle('My Doc')
    o.hoist()
    expect(o.getTitle()).toBe('My Doc')
    expect(o.getHeaders().title).toBe('My Doc')
  })

  it('edits made while hoisted survive de-hoisting', () => {
    const doc = opml(
      '<outline text="a"><outline text="b"><outline text="c"/><outline text="d"/></outline></outline>',
    )
    const o = mount(doc) // cursor -> a
    o.hoist() // -> view [b]
    o.hoist() // cursor parked on b -> view [c, d]

    setCursorTo(o, 'c')
    o.insert('new', DOWN) // c, new, d

    expect(o.deHoist()).toBe(true) // back to a's view [b]
    expect(o.deHoist()).toBe(true) // back to real root [a]
    expect(o.isHoisted()).toBe(false)

    const tree = bodyTree(o.toOpml())
    expect(tree.map((n) => n.text)).toEqual(['a'])
    expect(tree[0].children.map((n) => n.text)).toEqual(['b'])
    expect(tree[0].children[0].children.map((n) => n.text)).toEqual(['c', 'new', 'd'])
  })

  it('deHoist() / deHoistAll() return false when not hoisted', () => {
    const o = mount(opml('<outline text="a"><outline text="b"/></outline>'))
    expect(o.isHoisted()).toBe(false)
    expect(o.deHoist()).toBe(false)
    expect(o.deHoistAll()).toBe(false)
  })
})

describe('expandToLevel', () => {
  const doc = opml(
    '<outline text="a"><outline text="a1"><outline text="a1i"/></outline></outline><outline text="b"/>',
  )

  it('level 1 shows only the top level (equivalent to collapseEverything)', () => {
    const o = mount(doc)
    o.expandToLevel(1)
    expect(findByText(o, 'a').classList.contains('collapsed')).toBe(true)
    expect(findByText(o, 'a1').classList.contains('collapsed')).toBe(true)
  })

  it('level 2 reveals the immediate children of the top level', () => {
    const o = mount(doc)
    o.expandToLevel(2)
    expect(findByText(o, 'a').classList.contains('collapsed')).toBe(false)
    expect(findByText(o, 'a1').classList.contains('collapsed')).toBe(true)
  })

  it('level 3 reveals everything in this outline', () => {
    const o = mount(doc)
    o.expandToLevel(3)
    expect(findByText(o, 'a').classList.contains('collapsed')).toBe(false)
    expect(findByText(o, 'a1').classList.contains('collapsed')).toBe(false)
  })

  it('a level deeper than the outline is equivalent to expandEverything', () => {
    const o = mount(doc)
    o.expandToLevel(50)
    const collapsed = Array.from(o.root.querySelectorAll('.concord-node.collapsed'))
    expect(collapsed).toEqual([])
  })
})
