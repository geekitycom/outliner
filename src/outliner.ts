// The public Outliner class — a modern TypeScript facade over the ported
// internals (Editor / Op / Script). One instance per container element.
import type {
  Direction,
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
import {
  register,
  onResume as runtimeOnResume,
  eventsEnabled as runtimeEventsEnabled,
} from './runtime'

let ready = false

export interface InstanceState {
  prefs: OutlinerPrefs
  callbacks: OutlinerCallbacks
  headers: OpmlHeaders
  title: string
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

  constructor(container: HTMLElement, options?: OutlinerOptions) {
    this.container = container
    injectIconStyles()

    // Reuse an existing root if the container already holds one.
    const existingRoot = container.querySelector(':scope > .concord-root') as HTMLOListElement | null
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
      headers: {},
      title: '',
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
    }
    return prefs
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
    this.op.xmlToOutline(opml, setFocus, rawHtml)
  }

  toOpml(ownerName?: string, ownerEmail?: string, ownerId?: string): string {
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
  go(dir: Direction, count?: number, multiple?: boolean): boolean {
    return this.op.go(dir, count, multiple)
  }
  countSubs(): number {
    return this.op.countSubs()
  }
  subsExpanded(): boolean {
    return this.op.subsExpanded()
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
      this.op.xmlToOutline(text)
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
