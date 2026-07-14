import { describe, it, expect } from 'vitest'
import { UP, DOWN, RIGHT } from '../src'
import { mount, opml, bodyTree, topTexts } from './helpers'

describe('structural operations', () => {
  it('insert adds a sibling after the cursor', () => {
    const o = mount(opml('<outline text="a"/>'))
    o.insert('b', DOWN)
    expect(topTexts(o.toOpml())).toEqual(['a', 'b'])
  })

  it('reorg down swaps the cursor past its next sibling', () => {
    const o = mount(opml('<outline text="a"/><outline text="b"/>'))
    // cursor starts on the first node (a)
    o.reorg(DOWN)
    expect(topTexts(o.toOpml())).toEqual(['b', 'a'])
  })

  it('reorg up swaps the cursor before its previous sibling', () => {
    const o = mount(opml('<outline text="a"/><outline text="b"/>'))
    o.go(DOWN) // cursor -> b
    o.reorg(UP)
    expect(topTexts(o.toOpml())).toEqual(['b', 'a'])
  })

  it('promote lifts the cursor children to siblings', () => {
    const o = mount(
      opml('<outline text="p"><outline text="c1"/><outline text="c2"/></outline>'),
    )
    o.promote()
    expect(topTexts(o.toOpml())).toEqual(['p', 'c1', 'c2'])
  })

  it('demote nests following siblings under the cursor', () => {
    const o = mount(opml('<outline text="a"/><outline text="b"/><outline text="c"/>'))
    o.demote()
    const tree = bodyTree(o.toOpml())
    expect(tree.map((n) => n.text)).toEqual(['a'])
    expect(tree[0].children.map((n) => n.text)).toEqual(['b', 'c'])
  })

  it('reorg right (Tab) makes the cursor a child of its previous sibling', () => {
    const o = mount(opml('<outline text="a"/><outline text="b"/>'))
    o.go(DOWN) // cursor -> b
    o.reorg(RIGHT)
    const tree = bodyTree(o.toOpml())
    expect(tree.map((n) => n.text)).toEqual(['a'])
    expect(tree[0].children.map((n) => n.text)).toEqual(['b'])
  })

  it('deleteLine removes the cursor headline', () => {
    const o = mount(opml('<outline text="a"/><outline text="b"/>'))
    o.deleteLine()
    expect(topTexts(o.toOpml())).toEqual(['b'])
  })

  it('expand / collapse toggle the collapsed class', () => {
    const o = mount(opml('<outline text="p"><outline text="c"/></outline>'))
    // built collapsed with no expansionState
    expect(o.cursor.element.classList.contains('collapsed')).toBe(true)
    o.expand()
    expect(o.cursor.element.classList.contains('collapsed')).toBe(false)
    o.collapse()
    expect(o.cursor.element.classList.contains('collapsed')).toBe(true)
  })
})

describe('undo', () => {
  it('reverts an insert', () => {
    const doc = opml('<outline text="a"/>')
    const o = mount(doc)
    o.insert('b', DOWN)
    expect(topTexts(o.toOpml())).toEqual(['a', 'b'])
    o.undo()
    expect(bodyTree(o.toOpml())).toEqual(bodyTree(doc))
  })

  it('reverts a reorg', () => {
    const doc = opml('<outline text="a"/><outline text="b"/>')
    const o = mount(doc)
    o.reorg(DOWN)
    expect(topTexts(o.toOpml())).toEqual(['b', 'a'])
    o.undo()
    expect(topTexts(o.toOpml())).toEqual(['a', 'b'])
  })
})

describe('insertText (multi-line parser)', () => {
  it('parses tab-indented text into nested headlines', () => {
    const o = mount(opml('<outline text="root"/>'))
    o.insertText('a\n\tb')
    const tree = bodyTree(o.toOpml())
    expect(tree.map((n) => n.text)).toEqual(['root', 'a'])
    expect(tree[1].children.map((n) => n.text)).toEqual(['b'])
  })

  it('parses a flat multi-line block into siblings', () => {
    const o = mount(opml('<outline text="root"/>'))
    o.insertText('one\ntwo\nthree')
    expect(topTexts(o.toOpml())).toEqual(['root', 'one', 'two', 'three'])
  })
})
