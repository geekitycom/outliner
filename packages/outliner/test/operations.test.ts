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

  it('opExpand fires only when something actually expands', () => {
    // The README advertises opExpand as the hook for work that should happen
    // *because* a headline opened -- "e.g. lazy-load an include node". Firing
    // it on an expand that does nothing makes that work run repeatedly, on
    // every redundant expand, for a headline whose subs are already on screen.
    const o = mount(opml('<outline text="p"><outline text="c"/></outline>'))
    const seen: string[] = []
    o.setCallbacks({ opExpand: (node) => void seen.push(node.getLineText()) })

    // Built collapsed (no expansionState in the head), so this one really opens.
    o.expand()
    expect(seen).toEqual(['p'])

    // Already expanded: nothing changes, so nothing should be announced.
    o.expand()
    expect(seen).toEqual(['p'])

    // A headline with no subs at all can never expand either. This is the case
    // a bullet click reaches (events.ts: `subsExpanded()` is false for a
    // childless headline, so the click routes to expand()).
    o.go(DOWN) // cursor -> c, a leaf
    o.expand()
    expect(seen).toEqual(['p'])
  })

  it('the bulk expand/collapse operations mark the document changed', () => {
    // Expansion state is saved with the document (`<head><expansionState>`),
    // so changing it changes what a save would write. `expand()`/`collapse()`
    // have always marked; the bulk forms altered exactly the same class on
    // many headlines at once and (bar expandToLevel) said nothing, so a
    // "collapse everything" the user did on purpose could be lost on quit
    // without ever being offered a save.
    const doc = opml(
      '<outline text="p"><outline text="c"><outline text="g"/></outline></outline>',
    )

    const everything = mount(doc) // built collapsed: no expansionState in the head
    expect(everything.hasChanged()).toBe(false)
    everything.expandEverything()
    expect(everything.hasChanged()).toBe(true)

    const subs = mount(doc)
    subs.expandAllSubs() // cursor is on "p"
    expect(subs.hasChanged()).toBe(true)

    const collapsed = mount(doc)
    collapsed.expandEverything()
    collapsed.clearChanged()
    collapsed.collapseEverything()
    expect(collapsed.hasChanged()).toBe(true)

    const level = mount(doc)
    level.expandToLevel(2)
    expect(level.hasChanged()).toBe(true)
  })

  it('a bulk expand/collapse that changes nothing does not mark the document changed', () => {
    // The same standard `expand()` is held to: the callback and the changed
    // flag both mean "this actually happened". Marking on a no-op leaves the
    // user with an unsaved-changes prompt on quit for a keystroke that altered
    // nothing -- and teaches them the prompt is noise.
    const doc = opml(
      '<outline text="p"><outline text="c"><outline text="g"/></outline></outline>',
    )

    const everything = mount(doc)
    everything.expandEverything()
    everything.clearChanged()
    everything.expandEverything() // already fully expanded
    expect(everything.hasChanged()).toBe(false)

    const subs = mount(doc)
    subs.expandAllSubs()
    subs.clearChanged()
    subs.expandAllSubs()
    expect(subs.hasChanged()).toBe(false)

    const collapsed = mount(doc)
    collapsed.collapseEverything() // built collapsed already
    expect(collapsed.hasChanged()).toBe(false)

    const level = mount(doc)
    level.expandToLevel(2)
    level.clearChanged()
    level.expandToLevel(2)
    expect(level.hasChanged()).toBe(false)
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
