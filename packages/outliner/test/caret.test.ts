// Caret ownership (src/caret.ts): who the OS text insertion point belongs to,
// as a stack of owners. See docs/adr/0001 for why it is push-based and
// docs/adr/0002 for the API it replaced.
//
// Everything here is asserted through what a user would notice rather than
// through the module's own bookkeeping -- where the caret physically is
// (`document.activeElement`), and whether keystrokes still reach the outline.
// That is deliberate: the published surface is `claim()` and the disposable it
// hands back, precisely so nobody can branch on ownership, and a test suite
// that reached past that would be testing a shape the package refuses to give
// anyone else.
//
// The one thing worth saying about isolation: the stack is page-wide, not
// per-outline, so every test stages the ownership it needs from scratch (a
// `pasteBin.focus()`, usually) and releases every claim it takes. A leaked
// claim would suspend the outlines of every test that follows.
import { describe, it, expect } from 'vitest'
import { claim, DOWN } from '../src'
import type { Outliner } from '../src'
import { mount, opml, headlineCount, keydown, KEY } from './helpers'

/**
 * Whether a keystroke aimed at the page is still reaching this outline.
 *
 * Probed with Return -- which inserts a headline -- rather than with any flag,
 * because "the outline is live" is not a state anyone can observe; it is a
 * thing the outline does. The count comes from the DOM (`headlineCount`) and
 * not from `toOpml()`, which would commit a title-row edit in progress and so
 * release the very claim some of these tests are holding.
 */
function outlineIsLive(o: Outliner): boolean {
  const before = headlineCount(o)
  keydown(KEY.return)
  return headlineCount(o) > before
}

/** A focusable stand-in for a field outside the outline: a dialog, an app's
 *  search box, anything the caret module classifies as "not an outline"
 *  purely by not being inside a registered root. */
function field(): HTMLInputElement {
  const el = document.createElement('input')
  document.body.appendChild(el)
  return el
}

describe('claiming the caret', () => {
  it('a claim takes the caret and suspends the outline', () => {
    const o = mount(opml('<outline text="a"/>'))
    o.pasteBin.focus()
    expect(outlineIsLive(o)).toBe(true)

    const dialog = field()
    const release = claim({ kind: 'field', el: dialog })

    // Claiming *is* focusing: the claimant says "the caret belongs here now"
    // and the module moves it, so no caller anywhere else in the package has
    // to call .focus() and get the ordering right.
    expect(document.activeElement).toBe(dialog)
    expect(outlineIsLive(o)).toBe(false)

    dialog.blur()
    release()
  })

  it('releasing gives the caret back to whoever held it before', () => {
    const o = mount(opml('<outline text="a"/>'))
    o.pasteBin.focus()

    const dialog = field()
    const release = claim({ kind: 'field', el: dialog })
    // What a dialog closing does: the browser takes the caret off the element
    // being removed, then the app releases its claim.
    dialog.blur()
    release()

    expect(document.activeElement).toBe(o.pasteBin)
    expect(outlineIsLive(o)).toBe(true)
  })

  it('releasing puts an outline that was in text mode back in its headline', () => {
    // An outline knows two ways to hold the caret -- parked in the pasteBin in
    // navigation, in the cursor headline's text in text mode -- and a claimant
    // must not have to know which. This branch used to be written out twice
    // (setFocusRoot and resumeListening), and a guard added to one of them and
    // not the other is what made the title row stop taking clicks after a
    // hoist, since a hoist leaves the outline in text mode.
    const o = mount(opml('<outline text="a"/>'))
    o.pasteBin.focus()
    o.setTextMode(true)
    const headline = o.root.querySelector('.concord-text')

    const dialog = field()
    const release = claim({ kind: 'field', el: dialog })
    expect(document.activeElement).toBe(dialog)

    dialog.blur()
    release()

    expect(document.activeElement).toBe(headline)
    expect(o.isTextMode()).toBe(true)
  })

  it('a second claim outranks the first, and releasing it returns the caret to the first', () => {
    const o = mount(opml('<outline text="a"/>'))
    o.pasteBin.focus()

    const lower = field()
    const upper = field()
    const releaseLower = claim({ kind: 'field', el: lower })
    const releaseUpper = claim({ kind: 'field', el: upper })

    expect(document.activeElement).toBe(upper)
    expect(outlineIsLive(o)).toBe(false)

    upper.blur()
    releaseUpper()

    // Back to the claim underneath, not all the way back to the outline: one
    // suspender going away says nothing about the other.
    expect(document.activeElement).toBe(lower)
    expect(outlineIsLive(o)).toBe(false)

    lower.blur()
    releaseLower()
    expect(document.activeElement).toBe(o.pasteBin)
    expect(outlineIsLive(o)).toBe(true)
  })

  it('a click into an outline cannot take the caret off a claimant', () => {
    // Clicking into an outline normally hands it the caret (globals.ts), which
    // is how keystrokes follow you between two outlines on a page. A claim
    // outranks that: a stray click behind an open dialog must not put the
    // outline back in charge of the keyboard.
    const o = mount(opml('<outline text="a"/>'))
    o.pasteBin.focus()
    const dialog = field()
    const release = claim({ kind: 'field', el: dialog })

    o.root.querySelector('.concord-text')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )

    expect(document.activeElement).toBe(dialog)
    expect(outlineIsLive(o)).toBe(false)

    dialog.blur()
    release()
  })

  it('a programmatic cursor move cannot pull the caret out of a field', () => {
    // The guard that used to be copied out by hand at every site that reached
    // for .focus(). An app calling go()/find()/setCursor() while the user is
    // typing in a field of its own -- a find panel, the title row -- moved the
    // caret out from under them mid-keystroke. The cursor is the outline's own
    // sense of place and is free to move; the caret is not the outline's to
    // take while somebody else owns it.
    const o = mount(opml('<outline text="a"/><outline text="b"/>'))
    o.pasteBin.focus()
    const panel = field()
    const release = claim({ kind: 'field', el: panel })

    o.go(DOWN)
    expect(o.cursor.getLineText()).toBe('b') // the cursor moved...
    expect(document.activeElement).toBe(panel) // ...the caret did not

    o.find('a')
    expect(document.activeElement).toBe(panel)

    panel.blur()
    release()
  })
})

describe('releasing a claim is order-safe', () => {
  it('releasing the lower claim first does not strand the one above it', () => {
    // The stack removes an entry wherever it sits rather than popping the top,
    // so nothing has to guarantee that suspensions end in the order they
    // began. They do not: a dialog opened from a panel can outlive it, and the
    // title row commits itself from inside events it does not control.
    const o = mount(opml('<outline text="a"/>'))
    o.pasteBin.focus()

    const lower = field()
    const upper = field()
    const releaseLower = claim({ kind: 'field', el: lower })
    const releaseUpper = claim({ kind: 'field', el: upper })

    releaseLower()

    expect(document.activeElement).toBe(upper) // untouched: it never had the caret to lose
    expect(outlineIsLive(o)).toBe(false)

    upper.blur()
    releaseUpper()
    expect(outlineIsLive(o)).toBe(true)
  })

  it('the disposable is idempotent: releasing twice does not drop somebody else\'s claim', () => {
    // Without this, a claimant with two paths out -- the title row commits on
    // blur *and* on flush() -- would release once for real and once into
    // whatever claim happened to be on the stack by then, silently unsuspending
    // an outline somebody else was holding.
    const o = mount(opml('<outline text="a"/>'))
    o.pasteBin.focus()

    const lower = field()
    const upper = field()
    const releaseLower = claim({ kind: 'field', el: lower })
    const releaseUpper = claim({ kind: 'field', el: upper })

    upper.blur()
    releaseUpper()
    releaseUpper() // the no-op that must stay a no-op

    expect(outlineIsLive(o)).toBe(false) // `lower` is still holding it

    lower.blur()
    releaseLower()
    expect(outlineIsLive(o)).toBe(true)
  })
})

describe('overlapping suspensions (docs/adr/0002)', () => {
  // The bug this whole module exists for. `stopListening()` did nothing when
  // already stopped and `resumeListening()` re-enabled the outline for
  // everyone, so two suspenders -- the title row mid-edit and the desktop
  // app's modal -- cancelled each other: whichever released first left the
  // outline live behind the other's dialog, with arrow keys and Return going
  // straight through to the document underneath. A no-arg resume cannot know
  // whether its caller is the one who suspended, which is why the fix had to
  // change the signature rather than the body.
  const titleField = (o: Outliner): HTMLElement => {
    const el = o.container.querySelector<HTMLElement>('.concord-title-row .concord-text')
    if (!el) throw new Error('title row not found')
    return el
  }

  it('a dialog opening over a title-row edit keeps the outline suspended', () => {
    const o = mount(opml('<outline text="a"/>'))
    o.setTitle('Original')
    o.prefs({ titleRow: true })
    o.pasteBin.focus()

    // Suspension A: the user starts typing in the title row.
    const row = titleField(o)
    row.focus()
    row.textContent = 'Typed By User'
    expect(outlineIsLive(o)).toBe(false)

    // Suspension B: a modal opens over the top of it, exactly as
    // apps/desktop/src/modal.ts does it -- claim first, then show, which moves
    // the caret to the dialog's autofocused button and so blurs the row,
    // committing its edit and dropping suspension A from underneath.
    const dialog = document.createElement('dialog')
    const button = document.createElement('button')
    dialog.appendChild(button)
    document.body.appendChild(dialog)
    const release = claim({ kind: 'field', el: dialog })
    button.focus()
    expect(o.getTitle()).toBe('Typed By User') // A committed on its way out

    // The bug, in one assertion: the outline behind the open dialog went live
    // the moment the row committed.
    expect(outlineIsLive(o)).toBe(false)

    // And it comes back only when the dialog itself is done.
    button.blur()
    release()
    dialog.remove()
    expect(outlineIsLive(o)).toBe(true)
  })

  it('a dialog closing under a title-row edit leaves the row still suspending the outline', () => {
    // The same pair released the other way round, which is the half a
    // last-one-out scheme gets wrong in the opposite direction: the panel goes
    // away while the user is still typing in the row, and the outline must
    // stay out of the keyboard's way.
    const o = mount(opml('<outline text="a"/>'))
    o.prefs({ titleRow: true })
    o.pasteBin.focus()

    const panel = field()
    const releasePanel = claim({ kind: 'field', el: panel })

    const row = titleField(o)
    row.focus() // the row claims on top of the panel
    expect(document.activeElement).toBe(row)

    releasePanel() // the older, lower claim goes first

    expect(document.activeElement).toBe(row) // still typing, caret untouched
    expect(outlineIsLive(o)).toBe(false)

    // Close the edit out. Wiping the document between tests (test/setup.ts)
    // does not release a claim -- the stack is page-wide and knows nothing
    // about test boundaries -- so an edit left open here would suspend every
    // outline in every test that follows.
    row.blur()
  })
})

describe('the caret going nowhere', () => {
  it('the outline keeps its keystrokes when the caret is blurred to nowhere', () => {
    // A click on page chrome, or a native panel opening, blurs whatever held
    // the caret without giving it to anything. That is not the user leaving
    // the outline, and the outline is the only owner with a way to take the
    // caret back, so it stays the owner -- this is what makes an outliner keep
    // working after you click the page background.
    const o = mount(opml('<outline text="a"/>'))
    o.pasteBin.focus()

    o.pasteBin.blur()
    expect(document.activeElement).toBe(document.body)

    expect(outlineIsLive(o)).toBe(true)
  })

  it('a field blurred to nowhere gives the caret up, and a click hands it to the outline', () => {
    // A field has no way to take the caret back, so leaving a departed one in
    // charge would lock every outline on the page out of the keyboard for the
    // rest of the session. Ownership drops to nobody instead, and the next
    // click into an outline is what puts it back in charge.
    const o = mount(opml('<outline text="a"/>'))
    o.pasteBin.focus()
    const panel = field()
    panel.focus()
    expect(outlineIsLive(o)).toBe(false)

    panel.blur()
    panel.remove()
    expect(outlineIsLive(o)).toBe(false) // nobody owns it: still not the outline's keystroke

    o.root.querySelector('.concord-text')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    expect(outlineIsLive(o)).toBe(true)
  })

  it('the caret moving between the pasteBin and a headline is not a change of owner', () => {
    // Containment classification deliberately does not tell navigation from
    // text mode: both are the same outline, so toggling between them causes no
    // ownership transition at all. If it did, the stack would churn on every
    // keystroke that switches modes -- and every claim underneath would be
    // re-examined for it.
    const o = mount(opml('<outline text="a"/><outline text="b"/>'))
    o.pasteBin.focus()
    expect(outlineIsLive(o)).toBe(true)

    const headline = o.root.querySelector<HTMLElement>('.concord-text')
    headline?.focus()
    expect(outlineIsLive(o)).toBe(true)

    o.pasteBin.focus()
    expect(outlineIsLive(o)).toBe(true)
  })
})
