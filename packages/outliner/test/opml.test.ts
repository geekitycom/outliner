import { describe, it, expect } from 'vitest'
import type { Outliner } from '../src'
import { mount, opml, bodyTree } from './helpers'

/** Find a node's `<li>` element anywhere in the live DOM by its headline text. */
function findByText(o: Outliner, text: string): HTMLLIElement {
  const all = Array.from(o.root.querySelectorAll('.concord-node')) as HTMLLIElement[]
  const found = all.find((el) => el.querySelector('.concord-text')?.textContent === text)
  if (!found) throw new Error(`no node with text ${text}`)
  return found
}

describe('OPML round-trip', () => {
  it('preserves a flat list', () => {
    const doc = opml('<outline text="a"/><outline text="b"/><outline text="c"/>')
    const o = mount(doc)
    expect(bodyTree(o.toOpml())).toEqual(bodyTree(doc))
  })

  it('preserves nesting', () => {
    const doc = opml(
      '<outline text="a"><outline text="a1"/><outline text="a2"><outline text="a2i"/></outline></outline><outline text="b"/>',
    )
    const o = mount(doc)
    expect(bodyTree(o.toOpml())).toEqual(bodyTree(doc))
  })

  it('preserves attributes on headlines', () => {
    const doc = opml(
      '<outline text="feed" type="rss" xmlUrl="http://x/rss"/><outline text="note" isComment="true"/>',
    )
    const o = mount(doc)
    const tree = bodyTree(o.toOpml())
    expect(tree[0].attrs).toMatchObject({ type: 'rss', xmlUrl: 'http://x/rss' })
    expect(tree[1].attrs).toMatchObject({ isComment: 'true' })
  })

  it('escapes special characters in text', () => {
    const doc = opml('<outline text="a &amp; b &lt;tag&gt; &quot;q&quot;"/>')
    const o = mount(doc)
    expect(bodyTree(o.toOpml())[0].text).toBe('a & b <tag> "q"')
  })

  it('redraw is a no-op on structure (regression for empty-body bug)', () => {
    const doc = opml('<outline text="a"><outline text="b"/></outline>')
    const o = mount(doc)
    o.redraw()
    expect(bodyTree(o.toOpml())).toEqual(bodyTree(doc))
  })
})

describe('head data model', () => {
  it('setHeaders({ title }) actually sets the title, and getTitle()/toOpml() agree', () => {
    // Regression: getHeaders() used to always override from a separate
    // `state.title` field, so a title passed through setHeaders() silently
    // never took effect.
    const o = mount(opml('<outline text="a"/>'))
    o.setTitle('Real Title')
    o.setHeaders({ title: 'Via setHeaders' })

    expect(o.getTitle()).toBe('Via setHeaders')
    const doc = new DOMParser().parseFromString(o.toOpml(), 'application/xml')
    expect(doc.querySelector('head > title')?.textContent).toBe('Via setHeaders')
  })

  it('setHeaders() merges into the authored map -- fields it omits (including title) survive', () => {
    const o = mount(opml('<outline text="a"/>'))
    o.setTitle('Keep Me')
    o.setHeaders({ customThing: 'x' })

    expect(o.getHeaders()).toMatchObject({ title: 'Keep Me', customThing: 'x' })

    // A second, narrower call still doesn't disturb title or unrelated keys.
    o.setHeaders({ anotherThing: 'y' })
    expect(o.getHeaders()).toMatchObject({
      title: 'Keep Me',
      customThing: 'x',
      anotherThing: 'y',
    })
  })

  it('after a save -> load round trip, getHeaders() contains no computed fields', () => {
    const o = mount(opml('<outline text="a"><outline text="b"/></outline>'))
    o.setTitle('Doc')
    o.setHeaders({ customThing: 'sticks around' })
    const saved = o.toOpml()
    // Sanity: the computed fields really were written to the saved OPML.
    expect(saved).toContain('<dateModified>')
    expect(saved).toContain('<expansionState>')
    expect(saved).toContain('<lastCursor>')

    const o2 = mount()
    o2.loadOpml(saved)

    expect(Object.keys(o2.getHeaders()).sort()).toEqual(['customThing', 'title'])
    expect(o2.getHeaders().title).toBe('Doc')
    expect(o2.getHeaders().customThing).toBe('sticks around')
  })

  it('unknown/custom head fields round-trip intact', () => {
    const raw =
      '<?xml version="1.0"?><opml version="2.0">' +
      '<head><title>t</title><customThing>hello</customThing></head>' +
      '<body><outline text="a"/></body></opml>'
    const o = mount(raw)

    expect(o.getHeaders().customThing).toBe('hello')
    const doc = new DOMParser().parseFromString(o.toOpml(), 'application/xml')
    expect(doc.querySelector('customThing')?.textContent).toBe('hello')
  })

  it('expansionState/lastCursor still restore expansion and cursor position on load', () => {
    const doc = opml(
      '<outline text="a"><outline text="b"><outline text="c"/></outline></outline><outline text="d"/>',
    )
    const o = mount(doc)
    // Everything loads collapsed by default; expand "a" so "b" is reachable,
    // then park the cursor there.
    o.op.setCursor(findByText(o, 'a'))
    o.expand()
    o.op.setCursor(findByText(o, 'b'))

    const saved = o.toOpml()

    const o2 = mount()
    o2.loadOpml(saved)

    expect(findByText(o2, 'a').classList.contains('collapsed')).toBe(false)
    expect(o2.cursor.getLineText()).toBe('b')
  })

  it('fires opHeadChange with the current authored headers on a title/headers change', () => {
    const o = mount(opml('<outline text="a"/>'))
    const seen: Array<Record<string, string>> = []
    o.setCallbacks({ opHeadChange: (headers) => seen.push({ ...headers }) })

    o.setTitle('New Title')
    expect(seen).toHaveLength(1)
    expect(seen[0].title).toBe('New Title')

    o.setHeaders({ customThing: 'x' })
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({ title: 'New Title', customThing: 'x' })
  })
})
