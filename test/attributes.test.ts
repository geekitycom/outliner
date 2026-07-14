import { describe, it, expect } from 'vitest'
import { mount, opml, bodyTree } from './helpers'

describe('node attributes (Concord names)', () => {
  it('setOne / getOne / getAll', () => {
    const o = mount(opml('<outline text="a"/>'))
    const attrs = o.cursor.attributes
    attrs.setOne('type', 'rss')
    attrs.setOne('note', 'hello')
    expect(attrs.getOne('type')).toBe('rss')
    expect(attrs.getAll()).toEqual({ type: 'rss', note: 'hello' })
  })

  it('exists / removeOne / makeEmpty', () => {
    const o = mount(opml('<outline text="a" type="link" url="http://x"/>'))
    const attrs = o.cursor.attributes
    expect(attrs.exists('url')).toBe(true)
    attrs.removeOne('url')
    expect(attrs.exists('url')).toBe(false)
    attrs.makeEmpty()
    expect(attrs.getAll()).toEqual({})
  })

  it('mirrors type to the opml-type DOM attribute', () => {
    const o = mount(opml('<outline text="a"/>'))
    o.cursor.attributes.setOne('type', 'rss')
    expect(o.cursor.element.getAttribute('opml-type')).toBe('rss')
  })

  it('attributes are serialized back into OPML', () => {
    const o = mount(opml('<outline text="a"/>'))
    o.cursor.attributes.setOne('type', 'photo')
    expect(bodyTree(o.toOpml())[0].attrs).toMatchObject({ type: 'photo' })
  })

  it('attributes survive cloneNode (the clone-safe design bet)', () => {
    const o = mount(opml('<outline text="a"/>'))
    o.cursor.attributes.setGroup({ type: 'rss', k: 'v' })
    const el = o.cursor.element
    const clone = el.cloneNode(true) as HTMLElement
    expect(clone.getAttribute('data-opml')).toBe(el.getAttribute('data-opml'))
  })
})
