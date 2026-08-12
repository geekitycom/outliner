// The opt-in title row (`OutlinerPrefs.titleRow`): a single row rendered
// above the outline that shows -- and edits -- whichever text describes
// "what you're currently looking at": the OPML title at the document root,
// or the text of the headline you're hoisted into. That headline isn't
// visible anywhere else while hoisted (only its children are, via
// `applyHoist` in op.ts), so this row is the only way to read or fix it.
//
// It lives as a sibling of `root`, never inside it: `root`'s children are
// exactly what `outlineToXml()`, `wipe()`, and the hoist stash/apply
// machinery walk and move (see op.ts). If the row were one of those
// children it could be serialized as a stray headline, or get stashed away
// and lost across a hoist. Its own markup is wrapped in a private
// `<ol class="concord">` (not `root`, and never registered with runtime.ts),
// shaped like a single node row -- `concord-node > concord-wrapper >
// node-icon + concord-text` -- so the existing row-metrics CSS
// (`.concord .concord-node .concord-wrapper ...` in styles.css, plus the
// per-instance typography rules `Outliner` generates) applies for free.
//
// It is also deliberately outside the outline's cursor model: only a click
// or Tab starts an edit, never the arrow keys that move the outline's own
// cursor (keyboard.ts and op.ts's traversal are untouched by this file).
// While the field is being edited it *claims the caret* (caret.ts), which is
// what suspends the outline's global keydown dispatch (bound on `document`,
// see globals.ts) so a stray Cmd-B or arrow key edits this field natively
// instead of reaching the outline.
//
// That claim is also the row's entire notion of "am I editing?". There used to
// be a private `editing` boolean beside it, and every bug fixed in this file
// was the same bug: the flag and the caret disagreeing. The flag outlived a
// session whose focus went away without a blur, which froze the row on stale
// text and made `beginEdit()` return early forever ("can't edit the title after
// saving"); clearing it in the wrong place unsuspended the outline while the
// field still had the caret. Held once, as the claim itself, those two can no
// longer drift apart: the row is editing exactly while it is holding a claim.
//
// One case still has to be reconciled against the DOM rather than the claim --
// the caret being taken with no event to hear about it. That is `refresh()`,
// and the reason is written out there.
import type { Outliner } from './outliner'
import { iconHtml } from './icons'
import { textOf } from './dom'
import { claim, drop, holds } from './caret'

interface BuiltRow {
  element: HTMLDivElement
  text: HTMLElement
}

export class TitleRow {
  /** The element inserted into / removed from the container as the
   *  `titleRow` pref is toggled. Never a child of `root`. */
  readonly element: HTMLDivElement
  private readonly text: HTMLElement
  /** The live claim on the caret, or null when no edit is open. Holding the
   *  disposable *is* holding the caret: there is no second flag saying so. */
  private release: (() => void) | null = null
  private previousText = ''
  /** The headline this edit began on, or null when it began on the document
   *  title. Resolved at beginEdit, not at commit — see beginEdit. */
  private editTarget: HTMLLIElement | null = null

  constructor(
    private o: Outliner,
    existing?: HTMLDivElement,
  ) {
    const built = existing
      ? { element: existing, text: existing.querySelector('.concord-text') as HTMLElement }
      : TitleRow.build()
    this.element = built.element
    this.text = built.text
    this.bind()
    // Subscribe rather than being called by name: setTitle()/setHeaders()
    // (and a fresh load) only ever call Outliner.fireHeadChange() -- they
    // have no idea this row exists. A second editable head field would
    // subscribe here the same way, needing no new plumbing in op.ts.
    this.o.onHeadChange(() => this.refresh())
  }

  private static build(): BuiltRow {
    const element = document.createElement('div')
    element.className = 'concord-title-row'
    // A private `<ol class="concord">`, distinct from `root`, purely so the
    // `.concord .concord-node .concord-wrapper ...` selectors in styles.css
    // (and any per-instance typography CSS `Outliner.applyTypography`
    // generates) match this row too, without duplicating those rules.
    const list = document.createElement('ol')
    list.className = 'concord'
    const node = document.createElement('li')
    node.className = 'concord-node concord-title-node'
    const wrapper = document.createElement('div')
    wrapper.className = 'concord-wrapper type-icon'
    wrapper.insertAdjacentHTML('afterbegin', iconHtml('text'))
    const text = document.createElement('div')
    text.className = 'concord-text'
    text.setAttribute('contenteditable', 'true')
    wrapper.appendChild(text)
    node.appendChild(wrapper)
    list.appendChild(node)
    element.appendChild(list)
    return { element, text }
  }

  private bind(): void {
    this.text.addEventListener('focus', () => this.beginEdit())
    this.text.addEventListener('blur', () => this.commit())
    this.text.addEventListener('keydown', (e) => this.onKeydown(e))
  }

  /** Whether an edit session is open, which is exactly "this row is holding
   *  the caret". Not a cached answer: the claim is the thing itself. */
  private editing(): boolean {
    return this.release !== null
  }

  /**
   * Commit an edit that is still open.
   *
   * Called before serializing so a title the user has typed but not yet
   * blurred out of still makes it into the saved document — pressing Cmd-S
   * straight from the field would otherwise write the *previous* title.
   *
   * Committing is deliberately a thing this row can be *asked* to do, rather
   * than something that only happens on the way out of the field. Tying it to
   * the caret being handed back — the obvious simplification once ownership
   * moved into caret.ts — would mean Cmd-S could only save what was on screen
   * by first throwing the user out of the field they are typing in.
   */
  flush(): void {
    if (this.editing()) this.commit()
  }

  private beginEdit(): void {
    // A `focus` event while a claim is still open means the previous session
    // never ended (a native Save or Open panel takes focus with no blur ever
    // reaching the field). Close it out instead of returning early, which used
    // to leave the row inert for the rest of the session — the "can't edit the
    // title after saving" bug.
    if (this.editing()) this.commit()
    if (this.o.prefs().readonly) return
    this.previousText = this.text.textContent ?? ''
    // Capture *what is being edited* now, not when the edit commits. The row
    // shows the document title at the root and the hoisted headline while
    // hoisted, and a hoist can land between the two: typing a title and then
    // hoisting used to write that text into the newly hoisted headline
    // instead — renaming the wrong thing and losing the title edit. The
    // target is whatever the field was showing when the user started typing.
    this.editTarget = this.o.op.hoistedNode()
    // Last, and only once the edit is really starting (a readonly row returns
    // above without claiming). Claiming as a *field* is what makes the outline
    // decline to take the caret back — `place()` refuses for every caller at
    // once — and what stops the outline acting on keystrokes meant for this
    // field. The claim carries this row's identity, so a modal opening and
    // closing over the top of it cannot release it: that mutual cancellation
    // between two suspenders is the bug docs/adr/0002 exists for.
    this.release = claim({ kind: 'field', el: this.text })
  }

  private onKeydown(e: KeyboardEvent): void {
    // Belt-and-suspenders: the claim above already makes the document-level
    // dispatcher (keyboard.ts) a no-op, but stop propagation too so nothing
    // upstream ever sees these keys while this field owns them.
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      drop(this.text) // -> blur -> commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      this.cancel()
    }
  }

  private commit(): void {
    const release = this.release
    if (!release) return
    // Cleared before anything else runs. Releasing the caret hands it back to
    // the outline, which fires head-change and refresh work that re-enters this
    // class; every one of those paths has to see a row that is no longer
    // editing, or `refresh()` goes on refusing to update the text.
    this.release = null
    const node = this.editTarget
    this.editTarget = null
    release()
    const value = this.text.textContent ?? ''
    if (value === this.previousText) return // no-op edit: don't dirty the document
    if (node) {
      // No isConnected guard here, deliberately: a hoisted headline is
      // *supposed* to be detached. applyHoist() stashes the displaced part of
      // the tree in a DocumentFragment and restores it on de-hoist, so the
      // node this edit targets is off-document for the whole hoist. Skipping
      // detached nodes silently dropped every rename made while hoisted.
      const t = textOf(node)
      if (t) t.innerHTML = this.o.editor.escape(value)
    } else {
      this.o.setTitle(value)
    }
    this.o.op.markChanged()
  }

  private cancel(): void {
    const release = this.release
    this.release = null
    this.editTarget = null
    this.text.textContent = this.previousText
    release?.()
    drop(this.text) // the blur reaches commit(), already a no-op: the claim is gone
  }

  /** Force-cancel an in-progress edit, e.g. when the row is being removed
   *  from the DOM because the `titleRow` pref was turned off mid-edit. */
  abortEdit(): void {
    if (this.editing()) this.cancel()
  }

  /** Mirror `root`'s readonly state onto the row's own `<ol>` so the cursor
   *  styling matches (actual edit blocking is enforced in `beginEdit`). */
  setReadonly(readonly: boolean): void {
    this.element.querySelector('ol')?.classList.toggle('readonly', readonly)
  }

  /**
   * Push the current "what you're looking at" text into the field. A no-op
   * while the user has it mid-edit, so an external change doesn't clobber
   * what they're typing.
   *
   * "Mid-edit" is reconciled against where the caret physically is, not just
   * against the claim. A claim freezes caret.ts's ambient bookkeeping — that is
   * the whole point of one — so the row cannot be *told* that a native Save or
   * Open panel has taken the caret away without a blur ever reaching the field.
   * (There is no event to be told by: that is what makes the case hard.) An
   * unreconciled session made this method a permanent no-op, so the row froze
   * on stale text — open a file, the body updates, the title still reads
   * "Untitled" — and every later click re-entered `beginEdit()` on a session
   * belonging to a document that no longer exists.
   *
   * Settling it as a *commit* rather than a cancel is deliberate: the text in
   * the field is the user's, typed on purpose, and this is the last chance to
   * keep it. `Outliner.loadOpml()` calls `abortEdit()` first for the one case
   * where keeping it would be wrong — the edit belongs to the document being
   * replaced.
   */
  refresh(): void {
    if (this.editing() && !holds(this.text)) this.commit()
    if (this.editing()) return
    this.text.textContent = this.currentText()
  }

  private currentText(): string {
    const node = this.o.op.hoistedNode()
    if (node) return this.o.editor.unescape(textOf(node)?.innerHTML ?? '')
    return this.o.op.getTitle()
  }
}
