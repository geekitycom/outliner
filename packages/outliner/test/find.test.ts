import { describe, it, expect } from 'vitest'
import type { Outliner } from '../src'
import { mount, opml } from './helpers'

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

function cursorText(o: Outliner): string {
  return o.op.getCursor()?.querySelector('.concord-text')?.textContent ?? ''
}

describe('find / findAgain', () => {
  it('finds a match and moves the cursor there', () => {
    const o = mount(
      opml('<outline text="apple"/><outline text="banana"/><outline text="cherry"/>'),
    )
    // cursor starts on "apple"
    expect(o.find('banana')).toBe(true)
    expect(cursorText(o)).toBe('banana')
  })

  it('is case-insensitive by default; matchCase respects case', () => {
    const o = mount(opml('<outline text="Alpha"/><outline text="beta"/>'))
    expect(o.find('ALPHA', { wrap: false })).toBe(false) // "Alpha" is before the cursor, no wrap
    setCursorTo(o, 'beta')
    expect(o.find('alpha')).toBe(true) // wraps and matches case-insensitively
    expect(cursorText(o)).toBe('Alpha')

    setCursorTo(o, 'beta')
    expect(o.find('ALPHA', { matchCase: true })).toBe(false)
    expect(cursorText(o)).toBe('beta')
  })

  it('searches headline text, not markup', () => {
    const o = mount(opml('<outline text="&lt;b&gt;bold&lt;/b&gt; word"/>'))
    // The headline is built with escaped HTML in the text; searching for the
    // tag name itself must not match, only the rendered text should.
    expect(o.find('bold')).toBe(true)
    expect(cursorText(o)).toBe('bold word')
  })

  it('findAgain() advances to the next match in document order', () => {
    const doc = opml(
      '<outline text="root cat"><outline text="child cat"/></outline><outline text="sibling cat"/>',
    )
    const o = mount(doc) // cursor starts on "root cat"
    expect(o.find('cat')).toBe(true)
    expect(cursorText(o)).toBe('child cat')
    expect(o.findAgain()).toBe(true)
    expect(cursorText(o)).toBe('sibling cat')
    expect(o.findAgain()).toBe(true) // wraps back around
    expect(cursorText(o)).toBe('root cat')
  })

  it('a match inside a collapsed subtree is found and its ancestors are expanded', () => {
    const doc = opml(
      '<outline text="a"><outline text="b"><outline text="needle"/></outline></outline>',
    )
    const o = mount(doc)
    setCursorTo(o, 'b')
    o.collapse()
    expect(findByText(o, 'b').classList.contains('collapsed')).toBe(true)
    setCursorTo(o, 'a')
    o.clearChanged() // collapse()/setCursor() above already marked changed; isolate find's own effect
    expect(o.hasChanged()).toBe(false)

    expect(o.find('needle')).toBe(true)
    expect(cursorText(o)).toBe('needle')
    expect(findByText(o, 'b').classList.contains('collapsed')).toBe(false)
    // Revealing the match expanded a collapsed ancestor -- that persists in
    // expansionState, so it marks the document changed.
    expect(o.hasChanged()).toBe(true)
  })

  it('wraps around after the last match by default, and stops at the end with wrap: false', () => {
    const o = mount(opml('<outline text="x1"/><outline text="mid"/><outline text="x2"/>'))
    setCursorTo(o, 'x2')

    expect(o.find('x', { wrap: false })).toBe(false)
    expect(cursorText(o)).toBe('x2')

    expect(o.find('x', { wrap: true })).toBe(true)
    expect(cursorText(o)).toBe('x1')
  })

  it('no match returns false, leaves the cursor unmoved, and does not mark the document changed', () => {
    const o = mount(opml('<outline text="a"/><outline text="b"/>'))
    setCursorTo(o, 'a')
    expect(o.hasChanged()).toBe(false)
    expect(o.find('nonexistent')).toBe(false)
    expect(cursorText(o)).toBe('a')
    expect(o.hasChanged()).toBe(false)
  })

  it('findAgain() with no prior search returns false', () => {
    const o = mount(opml('<outline text="a"/>'))
    expect(o.findAgain()).toBe(false)
  })

  it('find while hoisted only searches the hoisted view, not the stashed-away siblings', () => {
    const doc = opml(
      '<outline text="p"><outline text="c1"/><outline text="c2 target"/></outline><outline text="q target"/>',
    )
    const o = mount(doc) // cursor on "p"
    expect(o.hoist()).toBe(true) // view narrows to [c1, c2 target]

    // "q target" lives outside the hoisted view (in the stashed-away sibling
    // of the hoisted node) and must not be found or crash the search.
    expect(o.find('target')).toBe(true)
    expect(cursorText(o)).toBe('c2 target')
    // wrap: false -- no further match after the cursor within the hoisted
    // view ("q target" is outside it, stashed away by the hoist).
    expect(o.find('target', { wrap: false })).toBe(false)
    expect(cursorText(o)).toBe('c2 target')
  })
})
