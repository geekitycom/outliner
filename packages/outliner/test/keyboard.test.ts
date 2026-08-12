// The global keydown dispatcher (src/keyboard.ts): the switch that turns a
// keystroke into an outline command.
//
// None of this was reachable from the unit suite until caret ownership became
// push-based (docs/adr/0001). The old dispatcher asked which outline roots were
// *visible* to decide where a keystroke should go, and answered that with
// `offsetParent`, which jsdom always reports as null -- so under Vitest every
// keystroke dispatched to nobody and a test like the ones below would have
// passed no matter what the switch did. Ownership is now decided by focusin /
// focusout, which jsdom implements faithfully, so these tests exercise the real
// path: a real KeyboardEvent at `document`, the real ownership gate, the real
// commands.
//
// The tests assert what the document looks like afterwards -- headline text,
// tree shape, cursor position -- rather than which branch of the switch ran.
import { describe, it, expect } from 'vitest'
import { claim, DOWN, UP } from '../src'
import type { KeystrokeEvent } from '../src'
import { mount, opml, bodyTree, topTexts, headlineCount, keydown, KEY } from './helpers'

describe('keydown dispatch: who gets the keystroke', () => {
  it('sends the keystroke to the outline that owns the caret', () => {
    const o = mount(opml('<outline text="a"/>'))
    // Parking the caret in the pasteBin is how the outline holds it in
    // navigation -- the state a user is in whenever they are not typing into a
    // headline. Every test here starts by staging that explicitly rather than
    // relying on whatever the previous test left behind, because ownership is
    // page-wide state and the outline that owned the caret a moment ago may not
    // even be in the document any more.
    o.pasteBin.focus()

    keydown(KEY.return)

    expect(topTexts(o.toOpml())).toEqual(['a', ''])
  })

  it('does not send it to an outline while a field holds the caret', () => {
    const o = mount(opml('<outline text="a"/>'))
    o.pasteBin.focus()

    // A bare input standing in for anything outside the outline: an app's
    // search box, a dialog's text field. Nothing registers it or tells the
    // caret module about it -- it is a field purely because it is not inside a
    // registered outline, which is the whole of the classification rule.
    const field = document.createElement('input')
    document.body.appendChild(field)
    field.focus()

    keydown(KEY.return)
    keydown(KEY.down)

    expect(topTexts(o.toOpml())).toEqual(['a'])
  })

  it('does not send it to an outline that is suspended but still looks focused', () => {
    // The distinction that the old "are events enabled?" flag could not draw,
    // and the reason keyboard.ts asks about ownership rather than about focus.
    // A claim can be taken without the caret physically moving anywhere --
    // `Op.execFormat` does exactly that, and an app can too -- so the outline's
    // pasteBin still holds the caret here, and a dispatcher that trusted
    // `document.activeElement` would happily run the command.
    const o = mount(opml('<outline text="a"/>'))
    o.pasteBin.focus()
    const dialog = document.createElement('div')
    document.body.appendChild(dialog)
    const release = claim({ kind: 'field', el: dialog })
    expect(document.activeElement).toBe(o.pasteBin)

    keydown(KEY.return)
    expect(topTexts(o.toOpml())).toEqual(['a'])

    release()
    keydown(KEY.return)
    expect(topTexts(o.toOpml())).toEqual(['a', ''])
  })

  it('follows the caret between two outlines on one page', () => {
    // Two instances share one document-level listener, so "which outline?" is
    // answered entirely by ownership. This is the case that made the old
    // module-global focus root wrong rather than merely untestable: whichever
    // outline was constructed last claimed the global.
    const first = mount(opml('<outline text="first"/>'))
    const second = mount(opml('<outline text="second"/>'))

    first.pasteBin.focus()
    keydown(KEY.return)
    expect(topTexts(first.toOpml())).toEqual(['first', ''])
    expect(topTexts(second.toOpml())).toEqual(['second'])

    second.pasteBin.focus()
    keydown(KEY.return)
    expect(topTexts(second.toOpml())).toEqual(['second', ''])
    expect(topTexts(first.toOpml())).toEqual(['first', ''])
  })
})

describe('keydown dispatch: moving the cursor', () => {
  it('the down arrow moves the cursor to the next headline, the up arrow back', () => {
    const o = mount(opml('<outline text="a"/><outline text="b"/><outline text="c"/>'))
    o.pasteBin.focus()

    keydown(KEY.down)
    expect(o.cursor.getLineText()).toBe('b')

    keydown(KEY.down)
    expect(o.cursor.getLineText()).toBe('c')

    keydown(KEY.up)
    expect(o.cursor.getLineText()).toBe('b')
  })

  it('in navigation the down arrow steps over a headline\'s subs, expanded or not', () => {
    // Concord's traversal, kept: in navigation the arrows walk *siblings*, so
    // "down" from "p" is "q" whether or not "p"'s subs are on screen. Asserting
    // it both ways round on one document is the point -- the expansion is the
    // only thing that differs between the two halves, and it changes nothing.
    const o = mount(
      opml('<outline text="p"><outline text="c1"/></outline><outline text="q"/>'),
    )
    o.pasteBin.focus()
    expect(o.subsExpanded()).toBe(false) // built collapsed: no expansionState

    keydown(KEY.down)
    expect(o.cursor.getLineText()).toBe('q')

    o.go(UP)
    o.expand()
    expect(o.subsExpanded()).toBe(true)
    keydown(KEY.down)
    expect(o.cursor.getLineText()).toBe('q')
  })

  it('in text mode the down arrow goes into the subs instead', () => {
    // The other half of the same case in the switch, and the reason it is
    // written out twice there: while text is being typed the arrows follow what
    // the eye sees -- the next line down the screen -- rather than the next
    // headline at this level.
    const o = mount(
      opml('<outline text="p"><outline text="c1"/></outline><outline text="q"/>'),
    )
    o.pasteBin.focus()
    o.expand()
    o.setTextMode(true)

    keydown(KEY.down)

    expect(o.cursor.getLineText()).toBe('c1')
  })
})

describe('keydown dispatch: editing commands', () => {
  it('Return inserts a headline below the cursor and drops into text mode', () => {
    const o = mount(opml('<outline text="a"/><outline text="b"/>'))
    o.pasteBin.focus()

    keydown(KEY.return)

    expect(topTexts(o.toOpml())).toEqual(['a', '', 'b'])
    expect(o.isTextMode()).toBe(true)
  })

  it('Return on an expanded headline inserts the new headline as its first sub', () => {
    // Concord's rule, kept: a Return goes wherever the eye expects the next
    // line to be, which is inside an open headline and after a closed one.
    const o = mount(opml('<outline text="p"><outline text="c1"/></outline>'))
    o.pasteBin.focus()
    o.expand()

    keydown(KEY.return)

    const tree = bodyTree(o.toOpml())
    expect(tree.map((n) => n.text)).toEqual(['p'])
    expect(tree[0].children.map((n) => n.text)).toEqual(['', 'c1'])
  })

  it('Tab reorgs the cursor headline under its previous sibling, Shift-Tab back out', () => {
    const o = mount(opml('<outline text="a"/><outline text="b"/>'))
    o.pasteBin.focus()
    o.go(DOWN) // cursor -> b

    keydown(KEY.tab)
    const nested = bodyTree(o.toOpml())
    expect(nested.map((n) => n.text)).toEqual(['a'])
    expect(nested[0].children.map((n) => n.text)).toEqual(['b'])

    keydown(KEY.tab, { shiftKey: true })
    expect(topTexts(o.toOpml())).toEqual(['a', 'b'])
  })

  it('Backspace in navigation deletes the cursor headline', () => {
    // In text mode the same key is a character delete that the browser handles
    // natively; the switch only takes it over when nothing is being typed
    // into. Staged in navigation, so this is the destructive branch.
    const o = mount(opml('<outline text="a"/><outline text="b"/>'))
    o.pasteBin.focus()
    expect(o.isTextMode()).toBe(false)

    keydown(KEY.backspace)

    expect(topTexts(o.toOpml())).toEqual(['b'])
  })

  it('Cmd-[ promotes the cursor headline\'s subs to sit alongside it', () => {
    // Promote acts on the cursor headline's *subs*, not on the headline -- the
    // trap CONTEXT.md calls out. "p" stays exactly where it is; its subs come
    // up to join it.
    const o = mount(
      opml('<outline text="p"><outline text="c1"/><outline text="c2"/></outline>'),
    )
    o.pasteBin.focus()

    keydown(KEY.leftBracket, { metaKey: true })

    expect(topTexts(o.toOpml())).toEqual(['p', 'c1', 'c2'])
  })

  it('Cmd-comma toggles the cursor headline between expanded and collapsed', () => {
    const o = mount(opml('<outline text="p"><outline text="c1"/></outline>'))
    o.pasteBin.focus()
    expect(o.subsExpanded()).toBe(false)

    keydown(KEY.comma, { metaKey: true })
    expect(o.subsExpanded()).toBe(true)

    keydown(KEY.comma, { metaKey: true })
    expect(o.subsExpanded()).toBe(false)
  })

  it('Cmd-Z undoes the headline the previous keystroke inserted', () => {
    const o = mount(opml('<outline text="a"/>'))
    o.pasteBin.focus()

    keydown(KEY.return)
    expect(topTexts(o.toOpml())).toEqual(['a', ''])

    keydown(KEY.z, { metaKey: true })
    expect(topTexts(o.toOpml())).toEqual(['a'])
  })

  it('a printable character in navigation types over the cursor headline', () => {
    // The fallback at the bottom of the handler, and the only path into text
    // mode that is not a deliberate command: type a letter at a headline you
    // are merely sitting on and you are now typing into it -- over the top of
    // it, Concord-style, with the old text cleared to make way. The character
    // itself is delivered by contenteditable rather than by this handler, so
    // what is observable here is the emptied headline, the mode change, and the
    // document being marked changed.
    const o = mount(opml('<outline text="a"/><outline text="b"/>'))
    o.pasteBin.focus()
    o.clearChanged()
    expect(o.isTextMode()).toBe(false)

    keydown(KEY.a)

    expect(o.isTextMode()).toBe(true)
    expect(o.cursor.getLineText()).toBe('')
    expect(topTexts(o.toOpml())).toEqual(['', 'b']) // the cursor headline, and only it
    expect(o.hasChanged()).toBe(true)
  })
})

describe('keydown dispatch: readonly and the keystroke callback', () => {
  it('a readonly outline still moves its cursor but refuses to be edited', () => {
    // Readonly is not "ignore the keyboard": the cursor has to keep moving or
    // the outline cannot be read with the keyboard at all. The arrow keys and
    // the expand/collapse toggle are let through by hand in the handler; every
    // other keystroke returns before reaching the switch.
    const o = mount(opml('<outline text="a"/><outline text="b"/>'))
    o.prefs({ readonly: true })
    o.pasteBin.focus()

    keydown(KEY.down)
    expect(o.cursor.getLineText()).toBe('b')

    keydown(KEY.return)
    keydown(KEY.backspace)
    expect(topTexts(o.toOpml())).toEqual(['a', 'b'])
  })

  it('reports the decoded keystroke to the app, and only while the outline owns the caret', () => {
    // `opKeystroke` is how an app hangs its own commands off the outline's
    // keyboard (the desktop app's shortcuts do exactly this). It fires from
    // inside the same gate as the commands themselves, so an app cannot be
    // handed keystrokes the user is typing into a dialog over the top of it.
    const seen: string[] = []
    const o = mount(opml('<outline text="a"/><outline text="b"/>'))
    o.setCallbacks({ opKeystroke: (e: KeystrokeEvent) => void seen.push(e.keystroke) })
    o.pasteBin.focus()

    keydown(KEY.down)
    expect(seen).toEqual(['cursor-down'])

    const field = document.createElement('input')
    document.body.appendChild(field)
    field.focus()
    keydown(KEY.down)
    expect(seen).toEqual(['cursor-down'])
  })
})

describe('keydown dispatch: nothing reaches an outline nobody is looking at', () => {
  it('leaves a second outline alone while a claim covers the page', () => {
    // The state an app is in with a modal open: whatever the caret was doing
    // before, no outline on the page acts on a keystroke until the claim goes.
    const a = mount(opml('<outline text="a"/>'))
    const b = mount(opml('<outline text="b"/>'))
    a.pasteBin.focus()
    const modal = document.createElement('div')
    document.body.appendChild(modal)
    const release = claim({ kind: 'field', el: modal })

    keydown(KEY.return)
    keydown(KEY.backspace)

    expect(headlineCount(a)).toBe(1)
    expect(headlineCount(b)).toBe(1)
    release()
  })
})
