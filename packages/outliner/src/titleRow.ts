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
// While the field is focused, stopListening()/resumeListening() (runtime.ts)
// suspend the outline's global keydown dispatch (bound on `document`, see
// globals.ts) so a stray Cmd-B or arrow key edits this field natively
// instead of reaching the outline.
import type { Outliner } from './outliner'
import { iconHtml } from './icons'
import { textOf } from './dom'
import { stopListening, resumeListening } from './runtime'

interface BuiltRow {
  element: HTMLDivElement
  text: HTMLElement
}

export class TitleRow {
  /** The element inserted into / removed from the container as the
   *  `titleRow` pref is toggled. Never a child of `root`. */
  readonly element: HTMLDivElement
  private readonly text: HTMLElement
  private editing = false
  private previousText = ''

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

  /** Whether the field genuinely owns focus right now. `editing` alone can
   *  lie — see `refresh()`. */
  private hasFocus(): boolean {
    return typeof document !== 'undefined' && document.activeElement === this.text
  }

  /**
   * Commit an edit that is still open.
   *
   * Called before serializing so a title the user has typed but not yet
   * blurred out of still makes it into the saved document — pressing Cmd-S
   * straight from the field would otherwise write the *previous* title.
   */
  flush(): void {
    if (this.editing) this.commit()
  }

  private beginEdit(): void {
    // A `focus` event while `editing` is still true means the previous
    // session never ended (see `refresh()` for how that happens). Close it
    // out instead of returning early, which used to leave the row inert for
    // the rest of the session — the "can't edit the title after saving" bug.
    if (this.editing) this.commit()
    if (this.o.prefs().readonly) return
    this.editing = true
    this.previousText = this.text.textContent ?? ''
    stopListening()
  }

  private onKeydown(e: KeyboardEvent): void {
    // Belt-and-suspenders: stopListening() above already makes the
    // document-level dispatcher (keyboard.ts) a no-op, but stop propagation
    // too so nothing upstream ever sees these keys while this field owns
    // them.
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      this.text.blur() // -> commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      this.cancel()
    }
  }

  private commit(): void {
    if (!this.editing) return
    this.editing = false
    resumeListening()
    const value = this.text.textContent ?? ''
    if (value === this.previousText) return // no-op edit: don't dirty the document
    const node = this.o.op.hoistedNode()
    if (node) {
      const t = textOf(node)
      if (t) t.innerHTML = this.o.editor.escape(value)
    } else {
      this.o.setTitle(value)
    }
    this.o.op.markChanged()
  }

  private cancel(): void {
    this.editing = false
    this.text.textContent = this.previousText
    resumeListening()
    this.text.blur() // no-op on commit(): editing is already false
  }

  /** Force-cancel an in-progress edit, e.g. when the row is being removed
   *  from the DOM because the `titleRow` pref was turned off mid-edit. */
  abortEdit(): void {
    if (this.editing) this.cancel()
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
   * "Mid-edit" is reconciled against who actually holds focus, not just the
   * `editing` flag. The flag can outlive the edit: `commit()` runs from the
   * field's `blur`, and focus can leave without one — a native Save or Open
   * panel taking focus does exactly that. A stuck flag made this method a
   * permanent no-op, so the row froze on stale text (open a file, body
   * updates, title still reads "Untitled") and `beginEdit()` returned early
   * forever, so the row could never be typed in again.
   */
  refresh(): void {
    if (this.editing && !this.hasFocus()) this.commit()
    if (this.editing) return
    this.text.textContent = this.currentText()
  }

  private currentText(): string {
    const node = this.o.op.hoistedNode()
    if (node) return this.o.editor.unescape(textOf(node)?.innerHTML ?? '')
    return this.o.op.getTitle()
  }
}
