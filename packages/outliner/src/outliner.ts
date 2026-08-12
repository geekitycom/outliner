// The public Outliner class — a modern TypeScript facade over the ported
// internals (Editor / Op / Script). One instance per container element.
import type {
  Direction,
  FindOptions,
  KeystrokeEvent,
  NodeRef as NodeRefApi,
  OpmlHeaders,
  OutlinerCallbacks,
  OutlinerOptions,
  OutlinerPrefs,
} from './types'
import { Editor } from './editor'
import { Op } from './op'
import { Script } from './script'
import { NodeRef } from './noderef'
import { bindEvents } from './events'
import { injectIconStyles } from './icons'
import { installGlobals } from './globals'
import { TitleRow } from './titleRow'
import { register } from './runtime'
import { place, registerOutline, suspended } from './caret'
import type { OutlineOwner } from './caret'

export interface InstanceState {
  prefs: OutlinerPrefs
  callbacks: OutlinerCallbacks
  // The single store for OPML `<head>` data -- title included. `title` is
  // just another key here (see `Op.getTitle`/`setTitle`), always present
  // (seeded in the constructor) so `outlineToXml()` never has to special-case
  // its absence. Computed fields (`COMPUTED_HEAD_FIELDS`) are deliberately
  // never written here -- see `Op.outlineToXml`/`xmlToOutline`.
  headers: OpmlHeaders
  renderMode?: boolean
  changed: boolean
  change: HTMLElement[] | null
  changeTextMode: boolean
  changeRange?: Range
  draggingChange: HTMLElement[] | null
  currentChange: HTMLElement[] | null
  clipboard: HTMLLIElement[] | null
  dragging: boolean
  mousedown: boolean
  dropdown: HTMLElement | null
  nodeRanges: WeakMap<Element, Range>
  id?: string
  openUrl?: string
  saveUrl?: string
}

export class Outliner {
  readonly container: HTMLElement
  readonly root: HTMLOListElement
  readonly pasteBin: HTMLDivElement
  readonly editor: Editor
  readonly op: Op
  readonly script: Script
  readonly state: InstanceState
  private readonly titleRowCtl: TitleRow
  // Whether the constructor has finished. Per-instance, not module-global:
  // as a global it was flipped true by whichever Outliner was built last, so
  // a second instance made the first one's `isReady()` lie -- and the first
  // instance's pasteBinFocus() started working halfway through the second
  // one's constructor.
  private ready = false
  // Internal head-change subscribers. Views composed into this instance
  // (currently just the title row) register here via `onHeadChange()`
  // instead of op.ts calling them by name -- op.ts only ever calls
  // `fireHeadChange()`, so a second editable head field needs no new call
  // site there. Library consumers should use `OutlinerCallbacks.opHeadChange`
  // instead of this -- it fires alongside every listener registered here.
  private readonly headListeners: Array<(headers: OpmlHeaders) => void> = []
  // Work deferred until this outline gets the caret back -- see `onResume()`.
  private readonly resumeListeners: Array<() => void> = []

  constructor(container: HTMLElement, options?: OutlinerOptions) {
    this.container = container
    injectIconStyles()

    // Reuse an existing root (and title row, if any) if the container
    // already holds one.
    const existingRoot = container.querySelector(':scope > .concord-root') as HTMLOListElement | null
    const existingTitleRow = container.querySelector(':scope > .concord-title-row') as HTMLDivElement | null
    if (existingRoot) {
      this.root = existingRoot
      this.pasteBin = container.querySelector(':scope > .pasteBin') as HTMLDivElement
    } else {
      const root = document.createElement('ol')
      root.className = 'concord concord-root'
      container.appendChild(root)
      this.root = root
      const pasteBin = document.createElement('div')
      pasteBin.className = 'pasteBin'
      pasteBin.setAttribute('contenteditable', 'true')
      Object.assign(pasteBin.style, {
        position: 'absolute',
        height: '1px',
        width: '1px',
        outline: 'none',
        overflow: 'hidden',
      })
      container.appendChild(pasteBin)
      this.pasteBin = pasteBin
    }

    this.state = {
      prefs: {},
      callbacks: {},
      headers: { title: '' },
      renderMode: undefined,
      changed: false,
      change: null,
      changeTextMode: false,
      changeRange: undefined,
      draggingChange: null,
      currentChange: null,
      clipboard: null,
      dragging: false,
      mousedown: false,
      dropdown: null,
      nodeRanges: new WeakMap(),
    }

    this.editor = new Editor(this)
    this.op = new Op(this)
    this.script = new Script(this)
    // Not attached to the DOM here -- prefs() below (or a later prefs()
    // call) is what inserts it, so a fresh container with no options sees
    // no row at all, matching the pref's default-off behavior.
    this.titleRowCtl = new TitleRow(this, existingTitleRow ?? undefined)

    register(this.root, this)
    registerOutline(this.caretOwner())
    installGlobals()
    bindEvents(this)

    if (options) {
      if (options.prefs) this.prefs(options.prefs)
      if (options.callbacks) this.state.callbacks = options.callbacks
    }
    this.ready = true
  }

  /**
   * This instance as a caret owner (see caret.ts). Everything the caret module
   * knows about an outline is here:
   *
   *  - `owns` is the containment test. The pasteBin is named explicitly because
   *    it is a *sibling* of `root`, not a descendant, yet the caret sitting in
   *    it is the outline being navigated rather than a field being typed into.
   *  - `focus` is the one place the "text mode or navigation?" branch is
   *    written. It used to appear twice in runtime.ts -- in setFocusRoot() and
   *    again in resumeListening() -- and the bug that a title-row guard was
   *    added to only one of the two branches had to be fixed twice for exactly
   *    that reason.
   *  - `lost` drops the UI that only makes sense while this outline holds the
   *    caret, and banks the text selection so `focus` can put it back.
   *
   * The selection save/restore pair used to be the first line of
   * `stopListening()` and the last line of `resumeListening()`, which is why it
   * only ever worked for callers who went through that one door: open a modal
   * any other way and the user came back to a caret at the start of the
   * headline. Hanging it off the ownership transition instead means it happens
   * however the caret leaves and however it comes back. There is no "did I save
   * anything" flag to go stale, either: `nodeRanges` (editor.ts) *is* that
   * record, keyed by the headline, and `restoreSelection()` is a no-op when it
   * holds nothing for the cursor.
   */
  private caretOwner(): OutlineOwner {
    return {
      root: this.root,
      owns: (target) => this.root.contains(target) || this.pasteBin.contains(target),
      focus: () => {
        if (this.op.inTextMode()) {
          this.op.focusCursor()
          this.editor.restoreSelection()
        } else {
          this.pasteBinFocus()
        }
        this.drainResume()
      },
      lost: () => {
        this.editor.hideContextMenu()
        this.editor.dragModeExit()
        // Banked while the caret is still in the headline: `lost` runs on the
        // ownership transition, which is *before* the claimant focuses itself,
        // so the range is still live here and gone a moment later.
        if (this.op.inTextMode()) this.editor.saveSelection()
      },
    }
  }

  /**
   * Run whatever was deferred by `onResume()`, now that this outline has the
   * caret back.
   *
   * Guarded on `suspended()` because a claim can be released while another is
   * still in force -- two overlapping suspensions is the case docs/adr/0002
   * exists for -- and also because an outline claims the caret *for itself*
   * during `Op.execFormat`, which would otherwise run deferred work in the
   * middle of a document.execCommand sequence with the cursor deliberately
   * blurred.
   */
  private drainResume(): void {
    if (suspended()) return
    const pending = this.resumeListeners.splice(0)
    for (const cb of pending) cb()
  }

  // --- internals used across modules ---------------------------------------

  isReady(): boolean {
    return this.ready
  }

  /** Whether this outline is acting on input at all, or has been suspended by
   *  something that claimed the caret. `Op.link()` is the caller that matters:
   *  an app can call it from its own modal, where the selection it is supposed
   *  to wrap in an anchor is not live. */
  eventsEnabled(): boolean {
    return !suspended()
  }

  /**
   * Defer `cb` until this outline has the caret back.
   *
   * The one survivor of the old no-arg focus API (docs/adr/0002). Its only
   * caller is `Op.link()`, which defers itself when the outline is suspended --
   * and that path exists for the Concord compatibility layer's `opLink`, where
   * an old app collects a URL in its own modal and calls in while that modal
   * still holds the caret. Compat is a documented, separately-built artifact,
   * so quietly dropping the link would be a real regression.
   *
   * It used to be drained by `resumeListening()`, i.e. by whoever happened to
   * lift the *global* suspension. It now drains from this instance's `focus`
   * hook above, so the trigger is the outline genuinely getting the caret back
   * -- from any path, and only once every claim over it has been released.
   */
  onResume(cb: () => void): void {
    this.resumeListeners.push(cb)
  }

  /** Push the current "what you're looking at" text into the title row, if
   *  one is attached. This is *not* about head data changing -- that goes
   *  through `fireHeadChange()` below, which the row subscribes to itself.
   *  This is for when the view *target* changes instead (hoist/de-hoist/undo
   *  can switch the row between "document title" and "hoisted headline",
   *  even though no head field was touched), which op.ts still calls
   *  directly since it's a single, fixed relationship, not something a new
   *  head field would ever need to hook into. */
  refreshTitleRow(): void {
    this.titleRowCtl.refresh()
  }

  /** Subscribe to authored head-data changes (see `fireHeadChange`). Internal
   *  composition mechanism, not part of the public API -- library consumers
   *  should set `OutlinerCallbacks.opHeadChange` instead, which fires
   *  alongside every listener registered here. */
  onHeadChange(listener: (headers: OpmlHeaders) => void): void {
    this.headListeners.push(listener)
  }

  /**
   * The one choke point op.ts calls whenever authored `<head>` data changes
   * -- `setTitle`, `setHeaders`, or a fresh load. Notifies every internal
   * subscriber (the title row) and the external `opHeadChange` callback.
   * Adding a second editable head field needs no new plumbing here or in
   * op.ts -- its setter just calls this same method.
   */
  fireHeadChange(headers: OpmlHeaders): void {
    for (const listener of this.headListeners) listener(headers)
    this.state.callbacks.opHeadChange?.(headers)
  }

  fireCallback(name: keyof OutlinerCallbacks, node: NodeRefApi): void {
    const cb = this.state.callbacks[name] as ((n: NodeRefApi) => void) | undefined
    if (cb) cb(node)
  }

  fireKeystroke(event: KeystrokeEvent): void {
    this.state.callbacks.opKeystroke?.(event)
  }

  /** Park the caret in the pasteBin over the cursor headline -- the outline's
   *  navigation-mode way of holding the caret, so keystrokes are outline
   *  commands and a copy has something to copy from. The title-row guard that
   *  used to sit here is gone: `place()` below declines whenever a different
   *  owner holds the caret, for every caller at once. */
  pasteBinFocus(): void {
    if (!this.ready || typeof navigator === 'undefined') return
    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(navigator.userAgent)) return
    if (!this.root.isConnected) return
    const node = this.op.getCursor()
    if (!node) return
    const rect = node.getBoundingClientRect()
    Object.assign(this.pasteBin.style, {
      position: 'absolute',
      top: rect.top + window.scrollY + 'px',
      left: rect.left + window.scrollX + 'px',
      zIndex: '1000',
    })
    const t = this.pasteBin.textContent
    if (t === '' || t === '\n') this.pasteBin.textContent = '...'
    this.op.focusCursor()
    if (place(this.pasteBin)) document.execCommand('selectAll')
  }

  setCustomStyle(css: string): void {
    this.container.querySelectorAll('style.customStyle').forEach((el) => el.remove())
    const style = document.createElement('style')
    style.className = 'customStyle'
    style.textContent = css
    this.root.insertAdjacentElement('beforebegin', style)
  }

  // --- preferences ----------------------------------------------------------

  prefs(newPrefs?: OutlinerPrefs): OutlinerPrefs {
    const prefs = this.state.prefs
    if (newPrefs) {
      Object.assign(prefs, newPrefs)
      if (prefs.readonly) this.root.classList.add('readonly')
      else this.root.classList.remove('readonly')
      if (prefs.renderMode !== undefined) this.state.renderMode = prefs.renderMode
      this.applyTypography(prefs)
      if (newPrefs.css) this.op.setStyle(newPrefs.css)
      this.applyTitleRowPref(prefs)
    }
    return prefs
  }

  /** Insert/remove the title row from the DOM to match `prefs.titleRow`,
   *  called on every `prefs()` update (not just at construction) so it can
   *  be toggled after the fact. */
  private applyTitleRowPref(prefs: OutlinerPrefs): void {
    this.titleRowCtl.setReadonly(prefs.readonly === true)
    if (prefs.titleRow) {
      if (!this.titleRowCtl.element.isConnected) {
        this.root.insertAdjacentElement('beforebegin', this.titleRowCtl.element)
      }
      this.titleRowCtl.refresh()
    } else {
      this.titleRowCtl.abortEdit()
      this.titleRowCtl.element.remove()
    }
  }

  private applyTypography(prefs: OutlinerPrefs): void {
    this.container.querySelectorAll('style.prefsStyle').forEach((el) => el.remove())
    const style: Record<string, string> = {}
    if (prefs.outlineFont) style['font-family'] = prefs.outlineFont
    if (prefs.outlineFontSize) {
      const size = Number(prefs.outlineFontSize)
      style['font-size'] = size + 'px'
      style['min-height'] = size + 6 + 'px'
      style['line-height'] = size + 6 + 'px'
    }
    if (prefs.outlineLineHeight) {
      const lh = Number(prefs.outlineLineHeight)
      style['min-height'] = lh + 'px'
      style['line-height'] = lh + 'px'
    }
    const cssId = this.container.id ? '#' + this.container.id : ''
    const decls = (skip?: string) =>
      Object.keys(style)
        .filter((k) => k !== skip)
        .map((k) => `${k}: ${style[k]};`)
        .join('')
    let css = ''
    css += `${cssId} .concord .concord-node .concord-wrapper .concord-text {${decls()}}\n`
    css += `${cssId} .concord .concord-node .concord-wrapper .node-icon {${decls('font-family')}}\n`
    const pad = prefs.outlineLineHeight ?? prefs.outlineFontSize
    if (pad !== undefined) {
      css += `${cssId} .concord .concord-node .concord-wrapper {padding-left: ${pad}px}\n`
      css += `${cssId} .concord ol {padding-left: ${pad}px}\n`
    }
    const styleEl = document.createElement('style')
    styleEl.className = 'prefsStyle'
    styleEl.textContent = css
    this.root.insertAdjacentElement('beforebegin', styleEl)
  }

  setFont(font: string, fontSize: number, lineHeight?: number): void {
    this.prefs({ outlineFont: font, outlineFontSize: fontSize, outlineLineHeight: lineHeight })
  }

  setReadonly(readonly: boolean): void {
    this.prefs({ readonly })
  }

  setStyle(css: string): void {
    this.op.setStyle(css)
  }

  setCallbacks(callbacks: OutlinerCallbacks): void {
    this.state.callbacks = callbacks
  }

  // --- content I/O ----------------------------------------------------------

  loadOpml(opml: string | Document, setFocus = true, rawHtml = false): void {
    // Discard -- never commit -- a title-row edit still in progress. The edit
    // belongs to the document being replaced, so committing it writes one
    // document's text into another's head.
    //
    // This isn't hypothetical: refresh() commits a session whose focus went
    // away without a blur (a native Save/Open panel does exactly that), and
    // xmlToOutline fires the head-change notification the row refreshes from.
    // The commit therefore landed *after* the new headers were installed,
    // overwriting the freshly loaded title -- and the load's own
    // clearChanged() ran afterwards, so it left no dirty marker behind. The
    // wrong title stayed invisible until the next save wrote it to disk.
    //
    // Aborting here rather than inside xmlToOutline is deliberate: redraw()
    // (render-mode toggle) also goes through xmlToOutline, and there the
    // document is the *same* one, so there's nothing stale to discard.
    this.titleRowCtl.abortEdit()
    this.op.xmlToOutline(opml, setFocus, rawHtml)
  }

  // Both of these are *serializers* — they produce the document a caller is
  // about to write somewhere — so both settle a pending title-row edit before
  // walking the tree. The rule is drawn at serializers on purpose, and the two
  // halves of it matter separately:
  //
  // A serializer flushes because the alternative is a file on disk that
  // disagrees with the screen, with nothing to warn the user: Cmd-S taken
  // while the caret is still in the row wrote the *previous* text and looked
  // like it had worked.
  //
  // A *getter* deliberately does not — `getTitle()`/`getHeaders()` stay
  // side-effect-free even though they too can read a stale-looking value
  // mid-edit. Flushing commits the edit, marks the document changed and hands
  // the caret back out of the field, so a getter that flushed would move the
  // caret as a side effect of being asked a question. That is exactly the
  // anti-pattern docs/adr/0001 exists to remove (`getFocusRoot()` used to
  // steal the caret merely by being called). A caller who wants the pending
  // text settled can say so — Enter, or a blur — and one who is only reading
  // gets to read without changing anything.
  toOpml(ownerName?: string, ownerEmail?: string, ownerId?: string): string {
    this.titleRowCtl.flush()
    return this.op.outlineToXml(ownerName, ownerEmail, ownerId)
  }

  toText(): string {
    // Missing here for as long as `toOpml()` had it, which made the two
    // serializers disagree about the same document at the same moment for the
    // second time (see `Op.outlineToText`, which had to be taught about hoist
    // for the same reason).
    //
    // It bites hardest while hoisted. At the root the row edits the document
    // title, which `toText()` never emits, so a stale read is invisible;
    // hoisted, the row edits the *headline* the view is hoisted into — text
    // that appears nowhere else on screen — so a "save as text" taken mid-edit
    // silently wrote body content that was one rename out of date.
    this.titleRowCtl.flush()
    return this.op.outlineToText()
  }

  cursorToOpml(subsOnly = false): string {
    return subsOnly ? this.op.cursorToXmlSubsOnly() : this.op.cursorToXml()
  }

  insertXml(opml: string | Document, dir?: Direction): boolean {
    return this.op.insertXml(opml, dir)
  }

  wipe(): void {
    this.op.wipe()
  }

  // --- structure operations -------------------------------------------------

  insert(text: string, dir?: Direction, rawHtml?: boolean): NodeRef {
    return this.op.setCursorContext(this.op.insert(text, dir, rawHtml))
  }
  insertImage(url: string): void {
    this.op.insertImage(url)
  }
  insertText(text: string): void {
    this.op.insertText(text)
  }
  deleteLine(): void {
    this.op.deleteLine()
  }
  deleteSubs(): void {
    this.op.deleteSubs()
  }
  reorg(dir: Direction, count?: number): boolean {
    return this.op.reorg(dir, count)
  }
  promote(): void {
    this.op.promote()
  }
  demote(): void {
    this.op.demote()
  }
  sort(): void {
    this.op.sort()
  }

  // --- expand / collapse ----------------------------------------------------

  expand(): void {
    this.op.expand()
  }
  collapse(): void {
    this.op.collapse()
  }
  expandAllSubs(): void {
    this.op.expandAllLevels()
  }
  expandEverything(): void {
    this.op.fullExpand()
  }
  collapseEverything(): void {
    this.op.fullCollapse()
  }
  /**
   * Collapse everything, then expand so headlines are visible down through
   * `level` (1-based: 1 = top-level only, 2 = top-level plus their immediate
   * children, and so on). A level deeper than the outline goes is equivalent
   * to `expandEverything()`.
   */
  expandToLevel(level: number): void {
    this.op.expandToLevel(level)
  }
  go(dir: Direction, count?: number, multiple?: boolean): boolean {
    return this.op.go(dir, count, multiple)
  }
  countSubs(): number {
    return this.op.countSubs()
  }
  subsExpanded(): boolean {
    return this.op.subsExpanded()
  }

  // --- hoist ------------------------------------------------------------

  /**
   * Hoist the view onto the cursor headline, so its subs become the top
   * level — like zooming into a subtree. Hoists nest (a stack); pop one
   * level with `deHoist()`, or return to the real root with `deHoistAll()`.
   * `toOpml()`, `getTitle()`, and `getHeaders()` always reflect the complete
   * document regardless of hoist state.
   *
   * Returns false if there is no cursor, or the cursor has no subs to hoist
   * into.
   */
  hoist(): boolean {
    return this.op.hoist()
  }
  /** Pop one level of hoist. Returns false if not currently hoisted. */
  deHoist(): boolean {
    return this.op.deHoist()
  }
  /** Return to the real root, popping every level of hoist. Returns false if not currently hoisted. */
  deHoistAll(): boolean {
    return this.op.deHoistAll()
  }
  isHoisted(): boolean {
    return this.op.isHoisted()
  }
  /** How many levels deep the hoist stack is (0 = not hoisted). */
  hoistDepth(): number {
    return this.op.hoistDepth()
  }

  // --- find / find-again ------------------------------------------------------

  /**
   * Search headline text starting after the current cursor, in document
   * (top-to-bottom, as displayed) order, and move the cursor to the first
   * match — expanding any collapsed ancestors so it's actually visible.
   * Case-insensitive unless `matchCase` is set; wraps around to the top after
   * the last match unless `wrap: false`. Remembers the search so
   * `findAgain()` can repeat it. Returns whether a match was found.
   *
   * Only headlines reachable from the current view are searched: while
   * hoisted, that's the hoisted subtree, not the whole document (the
   * displaced parts are detached DOM, same as `toOpml()` treats them as
   * still-real but temporarily out of view). A match found inside a
   * *collapsed* subtree, though, is still found -- collapsed nodes stay
   * attached, just visually hidden -- and finding one marks the document
   * changed (expansion state is persisted in the OPML), same as `expand()`
   * would. A search that matches nothing never marks the document changed.
   */
  find(text: string, options?: FindOptions): boolean {
    return this.op.find(text, options)
  }
  /** Repeat the last `find()` from the current cursor. Returns false if there's no previous search, or no further match. */
  findAgain(): boolean {
    return this.op.findAgain()
  }

  // --- formatting -----------------------------------------------------------

  bold(): void {
    this.op.bold()
  }
  italic(): void {
    this.op.italic()
  }
  strikethrough(): void {
    this.op.strikethrough()
  }
  link(url: string): void {
    this.op.link(url)
  }
  getLineText(): string | null {
    return this.op.getLineText()
  }
  setLineText(text: string): boolean {
    return this.op.setLineText(text)
  }

  // --- clipboard / history --------------------------------------------------

  cut(): void {
    this.op.cut()
  }
  copy(): void {
    this.op.copy()
  }
  paste(): void {
    this.op.paste()
  }
  undo(): boolean {
    return this.op.undo()
  }

  // --- modes ----------------------------------------------------------------

  setTextMode(on: boolean): void {
    this.op.setTextMode(on)
  }
  isTextMode(): boolean {
    return this.op.inTextMode()
  }
  setRenderMode(on: boolean): boolean {
    return this.op.setRenderMode(on)
  }
  getRenderMode(): boolean {
    return this.op.getRenderMode()
  }

  // --- title / headers / change ---------------------------------------------

  getTitle(): string {
    return this.op.getTitle()
  }
  setTitle(title: string): boolean {
    return this.op.setTitle(title)
  }
  getHeaders(): OpmlHeaders {
    return this.op.getHeaders()
  }
  setHeaders(headers: OpmlHeaders): boolean {
    return this.op.setHeaders(headers)
  }
  hasChanged(): boolean {
    return this.op.changed()
  }
  clearChanged(): boolean {
    return this.op.clearChanged()
  }
  markChanged(): boolean {
    return this.op.markChanged()
  }
  redraw(): void {
    this.op.redraw()
  }

  // --- comments -------------------------------------------------------------

  isComment(): boolean {
    return this.script.isComment()
  }
  makeComment(): boolean {
    return this.script.makeComment()
  }
  unComment(): boolean {
    return this.script.unComment()
  }
  toggleComment(): void {
    this.script.toggleComment()
  }
  runSelection(): void {
    this.op.runSelection()
  }

  // --- traversal & cursor ---------------------------------------------------

  visitAll(cb: (node: NodeRefApi) => boolean | void): void {
    this.op.visitAll(cb)
  }
  visitToSummit(cb: (node: NodeRefApi) => boolean): void {
    this.op.visitToSummit(cb)
  }

  /** A handle to the current bar-cursor headline. */
  get cursor(): NodeRef {
    return this.op.getCursorRef()
  }

  // --- remote open / save (fetch-based; endpoints must be provided) ---------

  async open(id: string, openUrl: string): Promise<void> {
    const params = new URLSearchParams()
    if (/^http.+$/.test(id)) params.set('url', id)
    else params.set('id', id)
    try {
      const res = await fetch(openUrl, { method: 'POST', body: params })
      const text = await res.text()
      // Through loadOpml(), not op.xmlToOutline() directly, so a remote open
      // discards a pending title-row edit the same way a local one does.
      this.loadOpml(text)
    } catch {
      if (this.root.querySelectorAll('.concord-node').length === 0) this.op.wipe()
    }
  }

  async save(id: string, saveUrl: string): Promise<unknown> {
    if (!this.op.changed()) return undefined
    const opml = this.op.outlineToXml()
    const body = new URLSearchParams({ opml, id })
    const res = await fetch(saveUrl, { method: 'POST', body })
    this.op.clearChanged()
    return res.json().catch(() => undefined)
  }
}
