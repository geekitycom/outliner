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
import {
  register,
  onResume as runtimeOnResume,
  eventsEnabled as runtimeEventsEnabled,
} from './runtime'

let ready = false

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
  // Internal head-change subscribers. Views composed into this instance
  // (currently just the title row) register here via `onHeadChange()`
  // instead of op.ts calling them by name -- op.ts only ever calls
  // `fireHeadChange()`, so a second editable head field needs no new call
  // site there. Library consumers should use `OutlinerCallbacks.opHeadChange`
  // instead of this -- it fires alongside every listener registered here.
  private readonly headListeners: Array<(headers: OpmlHeaders) => void> = []

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
    installGlobals()
    bindEvents(this)

    if (options) {
      if (options.prefs) this.prefs(options.prefs)
      if (options.callbacks) this.state.callbacks = options.callbacks
    }
    ready = true
  }

  // --- internals used across modules ---------------------------------------

  isReady(): boolean {
    return ready
  }

  eventsEnabled(): boolean {
    return runtimeEventsEnabled()
  }

  onResume(cb: () => void): void {
    runtimeOnResume(cb)
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

  pasteBinFocus(): void {
    if (!ready || typeof navigator === 'undefined') return
    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(navigator.userAgent)) return
    if (!this.root.isConnected) return
    // Never steal focus away from the title row (prefs.titleRow) while the
    // user is in it. Three separate paths reach here — setFocusRoot(),
    // resumeListening(), and the document-level mouseup in globals.ts — and
    // they chain: focusCursor() below blurs the row, the row's blur commits,
    // commit() calls resumeListening(), which lands back here. The row could
    // never be clicked into at all. Guarding the one place they all funnel
    // through fixes every path at once, where patching each caller wouldn't.
    // Committing is unaffected: the row blurs itself *before* commit() runs,
    // so by then this check passes and focus returns to the outline.
    const active = typeof document !== 'undefined' ? document.activeElement : null
    if (active && active.closest('.concord-title-row')) return
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
    this.pasteBin.focus()
    if (this.pasteBin === document.activeElement) document.execCommand('selectAll')
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

  toOpml(ownerName?: string, ownerEmail?: string, ownerId?: string): string {
    // Commit a title the user has typed but not yet blurred out of, so
    // saving straight from the field writes what's on screen rather than
    // the previous title.
    this.titleRowCtl.flush()
    return this.op.outlineToXml(ownerName, ownerEmail, ownerId)
  }

  toText(): string {
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
