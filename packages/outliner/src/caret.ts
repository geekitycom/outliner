// Caret ownership: which part of the interface the caret -- the OS text
// insertion point -- belongs to at a given moment, and the only place in this
// package that is allowed to move it. See docs/adr/0001 for why this is
// push-based, and CONTEXT.md for the difference between the *caret* (this
// module) and the outline's *cursor* (op.ts).
//
// Two rules make this module authoritative rather than advisory, and every
// other module in the package depends on both:
//
//  1. Ownership transitions *are* focus transitions. An owner knows how to
//     focus itself (an outline restores its own cursor or pasteBin; a field
//     just focuses its element), so nothing outside this file calls `.focus()`
//     or `.blur()`. Callers say "the caret belongs here now" and the module
//     decides whether that is allowed.
//
//  2. Classification is structural. A focus target that sits inside a
//     registered outline -- or *is* that outline's pasteBin, which lives
//     outside the root as a sibling -- belongs to that outline; anything else
//     is a field. That single containment test replaced four hand-written
//     guards that each spelled out "the title row owns its own focus" a
//     different way (two `closest('.concord-title-row')` checks, a CSS-class
//     allowlist, and an `input`/`textarea` match), and it covers dialogs and
//     app chrome that none of those four ever knew about.
//
// Note that containment deliberately does *not* distinguish navigation (caret
// parked in the pasteBin) from text mode (caret in a headline's
// `.concord-text`). Both resolve to the same outline owner, so switching
// between them causes no ownership change at all -- if it did, the stack would
// churn on every keystroke that toggles modes.

/**
 * Who the caret belongs to. `none` means nobody has taken it yet (or the last
 * field to hold it went away), which is the one state in which anyone may take
 * it without asking.
 */
export type CaretOwner =
  | { kind: 'outline'; root: HTMLElement }
  | { kind: 'field'; el: Element }
  | { kind: 'none' }

/**
 * What an outline has to tell this module to participate in ownership. The
 * outline supplies the behavior; this module supplies the policy -- which is
 * why nothing here knows what a cursor, a pasteBin or a title row is.
 */
export interface OutlineOwner {
  root: HTMLElement
  /** Whether `target` belongs to this outline (its subtree, plus its pasteBin). */
  owns(target: Element): boolean
  /** Take the caret back, however this outline does that. */
  focus(): void
  /** This outline just stopped owning the caret (drop transient UI). */
  lost(): void
}

interface Entry {
  owner: CaretOwner
}

// The stack. `stack[0]` is the *ambient* entry: what the browser most recently
// told us about, via focusin. Everything above it is an explicit claim, and the
// topmost entry -- claim or ambient -- is the owner.
//
// A claim freezes the ambient entry: while one is in force, wherever the
// browser actually puts the caret is none of our business, because the claimant
// has said it owns the caret until it releases. Without that freeze, a claimant
// that focuses its own field would see the ambient entry overwritten with
// itself (focus events fire *after* the element's own `focus` handler, which is
// where the title row claims), and releasing would then hand the caret straight
// back to the field that was trying to give it up -- the row could never be
// left.
const stack: Entry[] = [{ owner: { kind: 'none' } }]

const outlines: OutlineOwner[] = []
let listening = false

function claimInForce(): boolean {
  return stack.length > 1
}

function sameOwner(a: CaretOwner, b: CaretOwner): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'outline' && b.kind === 'outline') return a.root === b.root
  if (a.kind === 'field' && b.kind === 'field') return a.el === b.el
  return true
}

function outlineFor(root: HTMLElement): OutlineOwner | undefined {
  return outlines.find((o) => o.root === root)
}

/** Which owner `target` structurally belongs to. */
function ownerOf(target: Element): CaretOwner {
  const outline = outlines.find((o) => o.owns(target))
  return outline ? { kind: 'outline', root: outline.root } : { kind: 'field', el: target }
}

/**
 * Where the browser has actually left the caret, as an owner. `none` covers
 * both "nowhere" and "on the body", which is where a bare blur leaves it -- so
 * a caller can tell "somebody else is holding the caret" apart from "the caret
 * is going spare".
 */
function actualOwner(): CaretOwner {
  if (typeof document === 'undefined') return { kind: 'none' }
  const el = document.activeElement
  if (!el || el === document.body || el === document.documentElement) return { kind: 'none' }
  return ownerOf(el)
}

function focusOwner(o: CaretOwner): void {
  if (o.kind === 'outline') outlineFor(o.root)?.focus()
  else if (o.kind === 'field') (o.el as HTMLElement).focus?.()
}

/**
 * Apply a change to the stack and, if it moved ownership away from an outline,
 * tell that outline. This is what closes a context menu and exits drag mode on
 * the outline you just left -- behavior that used to be hand-coded inside
 * `setFocusRoot`, and so only happened on the one path that went through it.
 */
function transition(mutate: () => void): void {
  const before = owner()
  mutate()
  const after = owner()
  if (sameOwner(before, after)) return
  if (before.kind === 'outline') outlineFor(before.root)?.lost()
}

/** Who owns the caret. A pure read -- deliberately free of side effects, unlike
 *  the `getFocusRoot()` it replaces, which focused something as a side effect of
 *  being *asked a question*. Internal to the package: the published surface is
 *  `claim()` and the disposable it hands back, so that a consumer cannot write
 *  code that branches on ownership and then goes and moves the caret itself. */
export function owner(): CaretOwner {
  return stack[stack.length - 1].owner
}

/**
 * Whether a claim is in force -- whether some field (the title row while it is
 * being typed in, an app's modal dialog) has taken the caret and not yet handed
 * it back. This is the gate every *outline-side* handler sits behind: the mouse
 * and clipboard wiring in events.ts, the document mouseup in globals.ts,
 * `Outliner.eventsEnabled()`.
 *
 * Deliberately not "does this outline own the caret". A click into an outline
 * that isn't the owner yet must still work, and at mousedown time ownership has
 * not moved -- focus is the default action of the very event being handled. The
 * thing those handlers have to refuse is running while somebody has explicitly
 * suspended the outline, and "explicitly suspended" is exactly a claim.
 *
 * Note that an outline claiming the caret for itself (`Op.execFormat`) counts
 * as suspension too, which is what it wants: those handlers must not run while
 * it is driving execCommand through a blurred cursor.
 */
export function suspended(): boolean {
  return claimInForce()
}

/**
 * Whether the browser has actually left the caret on `el`.
 *
 * The reality check, as opposed to `owner()`'s bookkeeping: a claim freezes the
 * ambient entry, so while one is in force the module has stopped listening to
 * where the caret physically is. A claimant that can be robbed without being
 * told -- the title row, when a native Save or Open panel takes focus and no
 * blur ever reaches the field -- needs to reconcile against this before
 * believing its own claim. See `TitleRow.refresh()`.
 */
export function holds(el: Element): boolean {
  return typeof document !== 'undefined' && document.activeElement === el
}

function onFocusIn(event: FocusEvent): void {
  if (claimInForce()) return
  const target = event.target
  if (!(target instanceof Element)) return
  // Focus landing on the body (or the html element) is the caret going
  // *nowhere*, not a new owner taking it -- treat it exactly like the bare
  // focusout below and leave ownership alone, so a click on empty page chrome
  // doesn't quietly hand the outline's caret to `document.body`.
  if (target === document.body || target === document.documentElement) return
  transition(() => {
    stack[0].owner = ownerOf(target)
  })
}

function onFocusOut(event: FocusEvent): void {
  if (claimInForce()) return
  // Something else is taking the caret; its focusin records the transition.
  if (event.relatedTarget !== null) return
  // The caret went nowhere. An outline *keeps* ownership here, because a trip
  // to `body` (a click on page chrome, a native panel opening) is not the user
  // leaving the outline, and the outline is the only owner with a way to take
  // the caret back -- the document mouseup in globals.ts, or a released claim.
  // A field has no such path, so leaving a departed field in charge would lock
  // the outline out for the rest of the session.
  if (stack[0].owner.kind !== 'field') return
  transition(() => {
    stack[0].owner = { kind: 'none' }
  })
}

/** Register an outline as a possible owner. Idempotent per root. */
export function registerOutline(outline: OutlineOwner): void {
  const existing = outlines.findIndex((o) => o.root === outline.root)
  if (existing >= 0) outlines[existing] = outline
  else outlines.push(outline)
  if (listening || typeof document === 'undefined') return
  listening = true
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('focusout', onFocusOut)
}

export function unregisterOutline(root: HTMLElement): void {
  const i = outlines.findIndex((o) => o.root === root)
  if (i >= 0) outlines.splice(i, 1)
  if (stack[0].owner.kind === 'outline' && stack[0].owner.root === root) {
    stack[0].owner = { kind: 'none' }
  }
}

/**
 * Take the caret for `owner` until the returned disposable is called. Releasing
 * gives it back to whoever held it before the claim and focuses them, so a
 * caller that suspends the outline (the title row while it is being typed in, a
 * modal dialog) never has to work out what to restore.
 *
 * The disposable is idempotent, and releasing out of order is safe: the entry
 * is removed wherever it sits rather than popped, so an early release can't
 * strand a claim made after it.
 */
export function claim(o: CaretOwner): () => void {
  const entry: Entry = { owner: o }
  transition(() => {
    stack.push(entry)
  })
  focusOwner(o)
  let released = false
  return () => {
    if (released) return
    released = true
    const i = stack.indexOf(entry)
    if (i < 1) return
    const wasTop = i === stack.length - 1
    transition(() => {
      stack.splice(i, 1)
    })
    // Focus unconditionally when the claim was the top one, even if the owner
    // beneath compares equal: a claimant hands the caret back precisely because
    // it has finished doing something odd with it (op.execFormat leaves it
    // blurred), and the owner underneath expects to be put back the way it
    // likes -- for an outline that means its cursor or its pasteBin, not
    // wherever the claimant left things.
    if (wasTop) restore()
  }
}

/**
 * Hand the caret to `o` outright and focus it -- the "you are looking at this
 * one now" move, used when a pointer lands in an outline that wasn't the owner.
 * Ignored while a claim is in force, since the claimant outranks a stray click.
 */
export function hand(o: CaretOwner): void {
  if (claimInForce()) return
  transition(() => {
    stack[0].owner = o
  })
  focusOwner(o)
}

/**
 * Put the caret on `el`, provided `el`'s owner already owns the caret (or
 * nobody does). Returns whether the caret ended up there.
 *
 * This is the guard that used to be written out by hand at every site that
 * reached for `.focus()`, and it is why a programmatic cursor move -- `go()`,
 * `find()`, `setCursor()` from an app -- can no longer yank the caret out of
 * the title row or a dialog while the user is typing there.
 */
export function place(el: HTMLElement): boolean {
  const current = owner()
  if (current.kind !== 'none' && !sameOwner(current, ownerOf(el))) return false
  el.focus()
  return typeof document === 'undefined' || document.activeElement === el
}

/** Let go of `el`, if it is holding the caret. */
export function drop(el: Element): void {
  if (typeof document === 'undefined') return
  if (document.activeElement !== el) return
  ;(el as HTMLElement).blur?.()
}

/**
 * Give the caret back to whoever owns it, wherever the browser has left it --
 * unless some *other* owner is physically holding it, in which case they keep
 * it. Handing back is not a claim: it may not take the caret off anyone.
 *
 * That exception is load-bearing rather than defensive. A second click into the
 * title row lands while the row's previous edit is still open, so its `focus`
 * handler closes that edit out — which releases the claim, from inside the very
 * focus event that has just given the field the caret. Restoring blindly to the
 * owner underneath (the outline, which is what the ambient entry still says,
 * because a claim freezes it) would bounce the caret straight back out of the
 * row, and the row would be unclickable for the rest of the session. Focus
 * landing on the *body* is not another owner holding it: that is where a bare
 * blur leaves things, and it is precisely when the owner should be put back.
 */
export function restore(): void {
  const current = owner()
  const actual = actualOwner()
  if (actual.kind !== 'none' && !sameOwner(actual, current)) return
  focusOwner(current)
}
