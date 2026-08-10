import { describe, it, expect } from 'vitest'
import { mount, opml, bodyTree } from './helpers'

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
