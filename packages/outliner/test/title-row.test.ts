import { describe, it, expect } from 'vitest'
import { Outliner } from '../src'
import { mount, opml, bodyTree, headlineCount, keydown, KEY } from './helpers'

/** The title row's editable field, or null if the row isn't in the DOM. */
function titleRowText(o: Outliner): HTMLElement | null {
  return o.container.querySelector<HTMLElement>('.concord-title-row .concord-text')
}

function requireTitleRowText(o: Outliner): HTMLElement {
  const el = titleRowText(o)
  if (!el) throw new Error('title row not found')
  return el
}

/**
 * OPML with the `dateModified` header blanked out.
 *
 * outlineToXml() stamps `new Date().toUTCString()` on every call, at
 * second resolution. Comparing two serializations raw would pass almost
 * always and fail whenever the two calls happen to straddle a second tick —
 * the worst kind of flake, since it is rare, timing-dependent, and looks
 * like a real regression. Blanking the one genuinely time-varying header
 * keeps the comparison exact everywhere it matters.
 */
function opmlSansTimestamp(xml: string): string {
  return xml.replace(/<dateModified>[^<]*<\/dateModified>/, '<dateModified/>')
}

/**
 * Type into the row, then take focus away *without* letting its `blur`
 * through — what a native Save/Open panel does. This is the state an edit
 * session can outlive, so it's the setup for anything that has to cope with a
 * session whose caret is already gone.
 *
 * `once` matters: the suppressor must swallow exactly this one blur. Left
 * installed it would also eat the blur of a later deliberate commit.
 */
function typeThenLoseFocusWithoutBlur(o: Outliner, text: string): void {
  const el = requireTitleRowText(o)
  el.focus()
  el.textContent = text
  el.addEventListener('blur', (e) => e.stopImmediatePropagation(), {
    capture: true,
    once: true,
  })
  o.pasteBin.focus()
}

/** An OPML document whose `<head><title>` is `title`. */
function opmlTitled(title: string, body: string): string {
  return opml(body).replace('<title>t</title>', `<title>${title}</title>`)
}

/** Click into the row, type `text`, then commit (Enter) or cancel (Escape). */
function editTitleRow(o: Outliner, text: string, key: 'Enter' | 'Escape'): void {
  const el = requireTitleRowText(o)
  el.focus()
  el.textContent = text
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  )
}

describe('title row (opt-in via prefs.titleRow)', () => {
  it('is off by default: no row in the DOM', () => {
    const o = mount(opml('<outline text="a"/>'))
    expect(titleRowText(o)).toBeNull()
  })

  it('enabling via prefs adds it; disabling removes it', () => {
    const o = mount(opml('<outline text="a"/>'))
    expect(titleRowText(o)).toBeNull()

    o.prefs({ titleRow: true })
    expect(titleRowText(o)).not.toBeNull()
    expect(o.container.querySelectorAll('.concord-title-row').length).toBe(1)

    o.prefs({ titleRow: false })
    expect(titleRowText(o)).toBeNull()
  })

  it('a readonly row cannot be typed into, however readonly arrived', () => {
    // `contenteditable` is the whole of "can this be typed into" -- there is no
    // other gate between a keypress and a character landing in the field.
    // Blocking only the *commit* (which `beginEdit()` already did) left a row
    // that accepted every keystroke, showed the text, and then silently threw
    // it away, which reads as a broken document rather than a protected one.
    //
    // Both arrival paths are checked because they are different code: readonly
    // set at construction runs through `prefs()` once, from the constructor,
    // *after* the row has already been built with `contenteditable="true"`.
    const container = document.createElement('div')
    document.body.appendChild(container)
    const born = new Outliner(container, { prefs: { titleRow: true, readonly: true } })
    expect(requireTitleRowText(born).getAttribute('contenteditable')).toBe('false')

    const later = mount(opml('<outline text="a"/>'))
    later.prefs({ titleRow: true })
    expect(requireTitleRowText(later).getAttribute('contenteditable')).toBe('true')
    later.setReadonly(true)
    expect(requireTitleRowText(later).getAttribute('contenteditable')).toBe('false')

    // And it comes back: readonly is a mode, not a one-way door.
    later.setReadonly(false)
    expect(requireTitleRowText(later).getAttribute('contenteditable')).toBe('true')
  })

  it('going readonly mid-edit abandons the edit rather than committing it', () => {
    // The one place the row's usual "settle an interrupted edit as a commit"
    // rule has to invert. Everywhere else, committing keeps text the user typed
    // on purpose; here committing would write the document change that turning
    // readonly on exists to forbid -- and the caller asking for readonly is the
    // app (the file is locked, this is a preview), not the user finishing a
    // thought. So the edit is abandoned, the field goes back to what it said
    // before, and the title is untouched.
    const o = mount(opmlTitled('Original', '<outline text="a"/>'))
    o.prefs({ titleRow: true })
    const el = requireTitleRowText(o)
    el.focus()
    el.textContent = 'Typed But Not Committed'

    o.setReadonly(true)

    expect(o.getTitle()).toBe('Original')
    expect(requireTitleRowText(o).textContent).toBe('Original')
    // The abandoned edit must also have handed the caret back, or the outline
    // stays suspended forever behind a field nobody can even type in.
    keydown(KEY.down)
    expect(o.cursor.getLineText()).toBe('a')
  })

  it('at the root, shows the OPML title', () => {
    const o = mount(opml('<outline text="a"/>'))
    o.setTitle('My Document')
    o.prefs({ titleRow: true })
    expect(requireTitleRowText(o).textContent).toBe('My Document')
  })

  it('updates via setHeaders() too, through the same head-change notification setTitle uses', () => {
    // Regression: setHeaders() never used to refresh the row at all (only
    // setTitle() called Op -> Outliner.refreshTitleRow() directly), so a
    // title set through setHeaders() would silently never reach the row.
    // Both now go through Outliner.fireHeadChange(), which the row
    // subscribes to once in its constructor -- no per-field wiring needed.
    const o = mount(opml('<outline text="a"/>'))
    o.prefs({ titleRow: true })

    o.setHeaders({ title: 'Via setHeaders' })

    expect(requireTitleRowText(o).textContent).toBe('Via setHeaders')
  })

  it('committing an edit at the root updates getTitle() and the serialized OPML', () => {
    const o = mount(opml('<outline text="a"/>'))
    o.prefs({ titleRow: true })

    editTitleRow(o, 'Renamed Doc', 'Enter')

    expect(o.getTitle()).toBe('Renamed Doc')
    const doc = new DOMParser().parseFromString(o.toOpml(), 'application/xml')
    expect(doc.querySelector('head > title')?.textContent).toBe('Renamed Doc')
  })

  it('while hoisted, shows the hoisted headline\'s text', () => {
    const doc = opml('<outline text="p"><outline text="c1"/></outline><outline text="q"/>')
    const o = mount(doc) // cursor starts on "p"
    o.prefs({ titleRow: true })
    expect(requireTitleRowText(o).textContent).toBe('t') // the document title (see opml() helper)

    o.hoist()
    expect(requireTitleRowText(o).textContent).toBe('p')
  })

  it('committing an edit while hoisted renames the hoisted headline and survives de-hoisting', () => {
    const doc = opml('<outline text="p"><outline text="c1"/></outline><outline text="q"/>')
    const o = mount(doc)
    o.prefs({ titleRow: true })
    o.hoist()

    editTitleRow(o, 'p renamed', 'Enter')
    expect(requireTitleRowText(o).textContent).toBe('p renamed')

    o.deHoist()
    const tree = bodyTree(o.toOpml())
    expect(tree.map((n) => n.text)).toEqual(['p renamed', 'q'])
  })

  it('hoist then de-hoist: the row goes back to showing the document title', () => {
    const doc = opml('<outline text="p"><outline text="c1"/></outline>')
    const o = mount(doc)
    o.setTitle('Doc Title')
    o.prefs({ titleRow: true })

    o.hoist()
    expect(requireTitleRowText(o).textContent).toBe('p')

    o.deHoist()
    expect(requireTitleRowText(o).textContent).toBe('Doc Title')
  })

  it('loadOpml of a new document refreshes the row', () => {
    const o = mount(opml('<outline text="a"/>'))
    o.setTitle('First')
    o.prefs({ titleRow: true })
    expect(requireTitleRowText(o).textContent).toBe('First')

    o.loadOpml(opml('<outline text="z"/>').replace('<title>t</title>', '<title>Second</title>'))
    expect(requireTitleRowText(o).textContent).toBe('Second')
  })

  it('discards an uncommitted edit when a different document loads', () => {
    const o = mount(opmlTitled('DOC-A', '<outline text="a"/>'))
    o.prefs({ titleRow: true })

    typeThenLoseFocusWithoutBlur(o, 'TYPED-BY-USER')
    o.loadOpml(opmlTitled('DOC-B', '<outline text="z"/>'))

    // The pending edit belonged to DOC-A, which is gone. Committing it here
    // wrote the typed text into DOC-B's head -- and because the load's own
    // clearChanged() runs afterwards, it did so without marking the document
    // changed, so the wrong title was invisible until it hit disk on the
    // next save.
    expect(o.getTitle()).toBe('DOC-B')
    expect(requireTitleRowText(o).textContent).toBe('DOC-B')
  })

  it('toOpml() is byte-identical whether the row is enabled or disabled', () => {
    const doc = opml(
      '<outline text="a"><outline text="a1"/></outline><outline text="b"/>',
    )
    const enabled = mount(doc)
    enabled.prefs({ titleRow: true })

    const disabled = mount(doc)

    expect(opmlSansTimestamp(enabled.toOpml())).toBe(opmlSansTimestamp(disabled.toOpml()))
  })

  it('toOpml() output is unaffected by enabling the row even while hoisted', () => {
    const doc = opml(
      '<outline text="a"><outline text="a1"/></outline><outline text="b"/>',
    )
    const enabled = mount(doc)
    enabled.prefs({ titleRow: true })
    enabled.hoist()

    const disabled = mount(doc)
    disabled.hoist()

    expect(opmlSansTimestamp(enabled.toOpml())).toBe(opmlSansTimestamp(disabled.toOpml()))
  })

  it('Esc cancels an edit without changing anything', () => {
    const o = mount(opml('<outline text="a"/>'))
    o.setTitle('Original')
    o.prefs({ titleRow: true })
    o.clearChanged()

    editTitleRow(o, 'Should not stick', 'Escape')

    expect(requireTitleRowText(o).textContent).toBe('Original')
    expect(o.getTitle()).toBe('Original')
    expect(o.hasChanged()).toBe(false)
  })

  // --- moved down from the e2e suite -----------------------------------------
  //
  // These used to live in e2e/title-row.spec.ts because the focus machinery was
  // unreachable from jsdom: it decided which outline was in charge by asking
  // `offsetParent`, which jsdom always reports as null, so keystroke dispatch
  // did nothing at all under Vitest and a unit test would have passed whether
  // or not the bug it named existed. Ownership is now pushed from focusin /
  // focusout (docs/adr/0001), which jsdom implements faithfully, so they run
  // here -- in a fraction of the time, and against the same code.

  it('toOpml() includes a title typed but not yet blurred out of', () => {
    // Cmd-S straight from the field. Serializing has to settle the open edit
    // first, or the document written to disk carries the *previous* title --
    // and nothing on screen would say so.
    const o = mount(opml('<outline text="a"/>'))
    o.prefs({ titleRow: true })

    const el = requireTitleRowText(o)
    el.focus()
    el.textContent = 'Unblurred'

    expect(o.toOpml()).toContain('<title>Unblurred</title>')
  })

  it('toText() includes a headline typed but not yet blurred out of', () => {
    // The same Cmd-S-straight-from-the-field case as above, for the *other*
    // document serializer. `toOpml()` flushed the row; `toText()` went
    // straight to the tree, so a "save as text" taken mid-edit wrote the
    // previous text.
    //
    // Hoisted, deliberately: at the root the row edits the document title,
    // which `toText()` doesn't emit at all, so the whole defect would be
    // invisible there. Hoisted, the row edits a *headline* -- the one whose
    // subs are on screen, and which is visible nowhere else -- so the missing
    // flush loses body content, not just a title, and the file on disk names
    // the section by its old name with nothing on screen saying so.
    const o = mount(opml('<outline text="p"><outline text="c"/></outline>'))
    o.prefs({ titleRow: true })
    o.hoist() // cursor starts on "p"; the row now edits "p" itself

    const el = requireTitleRowText(o)
    el.focus()
    el.textContent = 'Renamed'

    expect(o.toText()).toContain('Renamed')
  })

  it('an edit started on the title lands on the title, even if a hoist intervenes', () => {
    const o = mount(opml('<outline text="a"><outline text="a1"/></outline>'))
    o.prefs({ titleRow: true })

    // Start editing the *document title*, then lose focus the way a native
    // menu does -- with no blur -- so the pending edit is settled by the next
    // refresh rather than by the field itself.
    typeThenLoseFocusWithoutBlur(o, 'My Notes')

    // Now hoist. That refresh settles the edit, and the row's target has
    // already flipped from the document title to the hoisted headline.
    // Resolving the target at commit time wrote "My Notes" into the newly
    // hoisted headline -- renaming the wrong thing and dropping the title edit
    // entirely. The target is captured when the edit begins, so it still lands
    // on the title.
    o.hoist()

    expect(o.getTitle()).toBe('My Notes')

    o.deHoist()
    expect(bodyTree(o.toOpml()).map((n) => n.text)).toEqual(['a'])
  })

  it('typing in the row does not reach the outline', () => {
    const o = mount(opml('<outline text="a"/><outline text="b"/>'))
    o.prefs({ titleRow: true })
    o.pasteBin.focus() // the outline owns the caret to begin with
    const before = headlineCount(o)

    const el = requireTitleRowText(o)
    el.focus()

    // Tab would reorg a headline and Return would insert one, if the outline's
    // keydown handling were still live while this field has the caret. Both
    // routes are exercised: at the field, which is the path a real keystroke
    // takes and which the row also stops propagating, and at the document,
    // which is the dispatcher's own doorstep and so leaves caret ownership as
    // the only thing that can refuse it.
    keydown(KEY.x, {}, el)
    keydown(KEY.tab, {}, el)
    keydown(KEY.return)
    keydown(KEY.down)

    // Counted from the DOM rather than from toOpml(), which would flush the
    // row's open edit and with it the very claim under test (see
    // `headlineCount` in helpers).
    expect(headlineCount(o)).toBe(before)
    expect(o.cursor.getLineText()).toBe('a')
    expect(o.isTextMode()).toBe(false)

    el.blur() // commit, so the row's claim on the caret doesn't outlive the test
  })

  // The next two are *duplicated* in e2e/title-row.spec.ts on purpose. They
  // turn on what happens when focus is taken away without a blur -- a native
  // Save or Open panel -- and that is the one place jsdom only approximates
  // Chromium: here the missing blur is staged by suppressing the event, where
  // in a real browser it genuinely never fires. Running both copies means a
  // divergence between the two shows up as a failing test rather than as a bug
  // report, which is exactly what we want to hear about. The cheap copy runs on
  // every change; the expensive one keeps it honest.

  it('still refreshes after focus is lost without a blur', () => {
    const o = mount(opmlTitled('DOC-A', '<outline text="a"/>'))
    o.prefs({ titleRow: true })

    typeThenLoseFocusWithoutBlur(o, 'TYPED-BY-USER')
    o.loadOpml(opmlTitled('Opened File', '<outline text="z"/>'))

    // The session that outlived its focus used to make refresh() a permanent
    // no-op, so the row froze on stale text: open a file and the outline
    // underneath changes while the row still names the document you closed.
    expect(requireTitleRowText(o).textContent).toBe('Opened File')
  })

  it('is still editable after focus is lost without a blur', () => {
    const o = mount(opmlTitled('DOC-A', '<outline text="a"/>'))
    o.prefs({ titleRow: true })

    typeThenLoseFocusWithoutBlur(o, 'Typed Before Saving')

    // The stuck session also made beginEdit() return early forever -- the
    // "can't edit the title after saving" bug. A second click has to open a
    // fresh edit, on top of committing the one that was left open.
    editTitleRow(o, 'Edited After Save', 'Enter')

    expect(requireTitleRowText(o).textContent).toBe('Edited After Save')
    expect(o.getTitle()).toBe('Edited After Save')
  })

  it('suspends the outline\'s keystrokes while the field has the caret', () => {
    // Asserted through what the user would see rather than through
    // `eventsEnabled()`, which this test used to inspect: the question is not
    // whether some flag is set, it is whether a keystroke typed into the title
    // row also reorganizes the outline behind it. (The flag reading was also
    // the only thing this could check while keystroke dispatch was inert under
    // jsdom -- it no longer is, so there is no reason to settle for it.)
    const o = mount(opml('<outline text="a"/><outline text="b"/>'))
    o.prefs({ titleRow: true })
    o.pasteBin.focus()
    const el = requireTitleRowText(o)

    el.focus()
    keydown(KEY.return)
    keydown(KEY.down)
    expect(headlineCount(o)).toBe(2) // no headline inserted
    expect(o.cursor.getLineText()).toBe('a') // the cursor stayed put

    // Committing the edit hands the caret back, and the outline is an outline
    // again on the very next keystroke.
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    keydown(KEY.return)
    expect(headlineCount(o)).toBe(3)
  })
})
