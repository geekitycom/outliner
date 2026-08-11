import { describe, it, expect } from 'vitest'
import type { Outliner } from '../src'
import { eventsEnabled } from '../src/runtime'
import { mount, opml, bodyTree } from './helpers'

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

  it('suspends the outline\'s global keydown dispatch while the field is focused', () => {
    const o = mount(opml('<outline text="a"/>'))
    o.prefs({ titleRow: true })
    expect(eventsEnabled()).toBe(true)

    const el = requireTitleRowText(o)
    el.focus()
    expect(eventsEnabled()).toBe(false)

    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    expect(eventsEnabled()).toBe(true)
  })
})
