// The operations layer. Ported from Concord's ConcordOp. Every method acts on
// the live bar cursor (`.concord-cursor`).
import type { Outliner } from './outliner'
import type { Direction, FindOptions, OpmlHeaders } from './types'
import { UP, DOWN, LEFT, RIGHT, FLATUP, FLATDOWN, COMPUTED_HEAD_FIELDS } from './constants'
import { NodeAttributes } from './attributes'
import { NodeRef } from './noderef'
import { escapeXml } from './util'
import {
  childNodes,
  childOl,
  getConcordRange,
  nodeParents,
  nextNode,
  prevNode,
  textOf,
} from './dom'

const scrollEnabled = true
const pixelsAboveOutlineArea = 0

function firstNodeParent(el: Element): HTMLLIElement | null {
  return nodeParents(el)[0] ?? null
}

/**
 * One level of hoist. `node` is the headline that was hoisted to — it stays
 * exactly where it was in the real tree (only its children are moved), so
 * finding it again after de-hoisting requires no bookkeeping beyond this
 * reference. `stash` holds the direct children `root` had *before* this
 * hoist, detached but otherwise untouched (never round-tripped through
 * OPML), so collapsed state, cursor markers, and any DOM the caller is
 * holding onto all survive intact.
 */
interface HoistFrame {
  node: HTMLLIElement
  stash: DocumentFragment
}

/** The remembered parameters of the last `find()`, so `findAgain()` can repeat it. */
interface SearchState {
  text: string
  matchCase: boolean
  wrap: boolean
}

export class Op {
  attributes: NodeAttributes
  private hoistStack: HoistFrame[] = []
  private lastSearch: SearchState | null = null

  constructor(private o: Outliner) {
    this.attributes = new NodeAttributes(o, () => this.getCursor())
  }

  private get root(): HTMLElement {
    return this.o.root
  }

  // --- tree walking ---------------------------------------------------------

  _walk_up(context: HTMLLIElement): HTMLLIElement | null {
    const prev = prevNode(context)
    if (!prev) return firstNodeParent(context)
    return this._last_child(prev)
  }

  _walk_down(context: HTMLLIElement): HTMLLIElement | null {
    const next = nextNode(context)
    if (next) return next
    const parent = firstNodeParent(context)
    return parent ? this._walk_down(parent) : null
  }

  _last_child(context: HTMLLIElement): HTMLLIElement {
    if (context.classList.contains('collapsed')) return context
    const kids = childNodes(context)
    if (kids.length === 0) return context
    return this._last_child(kids[kids.length - 1])
  }

  // --- cursor & modes -------------------------------------------------------

  getCursor(): HTMLLIElement | null {
    return this.root.querySelector('.concord-cursor') as HTMLLIElement | null
  }

  getCursorRef(): NodeRef {
    return this.setCursorContext(this.getCursor()!)
  }

  setCursorContext(node: HTMLLIElement): NodeRef {
    return new NodeRef(this.o, node)
  }

  inTextMode(): boolean {
    return this.root.classList.contains('textMode')
  }

  focusCursor(): void {
    // Never pull focus out of the title row (prefs.titleRow). It sits
    // outside `root` and owns its own editing session, and this is one of
    // the two ways the outline reclaims focus — `Outliner.pasteBinFocus()`
    // is the other, guarded the same way.
    //
    // Both need it, and guarding only one is what caused a bug worth
    // remembering: `resumeListening()` and `setFocusRoot()` each pick
    // between these two by `inTextMode()`, so with only pasteBinFocus()
    // guarded the row stayed clickable while the outline was idle and became
    // completely unclickable once it was editing a headline — the state a
    // hoist leaves it in. Guarding the two primitives covers every caller;
    // guarding callers one at a time did not.
    if (typeof document !== 'undefined') {
      const active = document.activeElement
      if (active && active.closest('.concord-title-row')) return
    }
    textOf(this.getCursor() ?? this.root)?.focus()
  }

  blurCursor(): void {
    const c = this.getCursor()
    if (c) textOf(c)?.blur()
  }

  setCursor(node: HTMLLIElement, multiple?: boolean, multipleRange?: boolean): void {
    this.root
      .querySelectorAll('.concord-cursor')
      .forEach((el) => el.classList.remove('concord-cursor'))
    node.classList.add('concord-cursor')
    if (this.inTextMode()) {
      this.o.editor.edit(node)
    } else {
      this.o.editor.select(node, multiple, multipleRange)
      this.o.pasteBinFocus()
    }
    this.o.fireCallback('opCursorMoved', this.setCursorContext(node))
    this.o.editor.hideContextMenu()
  }

  setTextMode(textMode: boolean): void {
    if (this.o.prefs().readonly) return
    if (this.inTextMode() === textMode) return
    if (textMode) {
      this.root.classList.add('textMode')
      this.o.editor.editorMode()
      const c = this.getCursor()
      if (c) this.o.editor.edit(c)
    } else {
      this.root.classList.remove('textMode')
      this.root
        .querySelectorAll('.editing')
        .forEach((el) => el.classList.remove('editing'))
      this.blurCursor()
      const c = this.getCursor()
      if (c) this.o.editor.select(c)
    }
  }

  // --- change tracking ------------------------------------------------------

  changed(): boolean {
    return this.o.state.changed === true
  }

  clearChanged(): boolean {
    this.o.state.changed = false
    return true
  }

  markChanged(): boolean {
    this.o.state.changed = true
    if (!this.inTextMode()) {
      this.root
        .querySelectorAll('.concord-node.dirty')
        .forEach((el) => el.classList.remove('dirty'))
    }
    return true
  }

  saveState(): boolean {
    this.o.state.change = this.o.editor.cloneChildren()
    this.o.state.changeTextMode = this.inTextMode()
    if (this.inTextMode()) {
      const range = getConcordRange()
      this.o.state.changeRange = range ? range.cloneRange() : undefined
    } else {
      this.o.state.changeRange = undefined
    }
    return true
  }

  undo(): boolean {
    const stateBefore = this.o.editor.cloneChildren()
    const textModeBefore = this.inTextMode()
    let beforeRange: Range | undefined
    if (this.inTextMode()) {
      const range = getConcordRange()
      if (range) beforeRange = range.cloneRange()
    }
    if (this.o.state.change) {
      this.root.replaceChildren(...this.o.state.change)
      this.setTextMode(this.o.state.changeTextMode)
      if (this.inTextMode()) {
        this.focusCursor()
        const range = this.o.state.changeRange
        if (range) this.o.editor.restoreSelection(range)
      }
      this.o.state.change = stateBefore
      this.o.state.changeTextMode = textModeBefore
      this.o.state.changeRange = beforeRange
      // Defensive: undo() restores root's children, which -- while hoisted
      // -- are the hoisted headline's own children, not its text. The title
      // row's text isn't reachable through this snapshot today, but refresh
      // anyway so it can never go stale if that ever changes.
      this.o.refreshTitleRow()
      return true
    }
    return false
  }

  // --- expand / collapse ----------------------------------------------------

  collapse(triggerCallbacks = true): void {
    const node = this.getCursor()
    if (!node) return
    if (triggerCallbacks) this.o.fireCallback('opCollapse', this.setCursorContext(node))
    node.classList.add('collapsed')
    node.querySelectorAll('ol').forEach((ol) => {
      if (ol.children.length > 0) ol.parentElement?.classList.add('collapsed')
    })
    this.markChanged()
  }

  expand(triggerCallbacks = true): void {
    const node = this.getCursor()
    if (!node) return
    if (triggerCallbacks) this.o.fireCallback('opExpand', this.setCursorContext(node))
    if (!node.classList.contains('collapsed')) return
    node.classList.remove('collapsed')

    if (scrollEnabled) {
      const rect = node.getBoundingClientRect()
      const cursorPosition = rect.top + window.scrollY
      const cursorHeight = node.offsetHeight
      const windowPosition = window.scrollY
      const windowHeight = window.innerHeight
      const text = textOf(node)
      const lineHeight =
        (text ? parseInt(getComputedStyle(text).lineHeight) || 0 : 0) + 6
      if (cursorHeight > windowHeight) {
        const ctscroll = cursorPosition - pixelsAboveOutlineArea - lineHeight
        if (ctscroll > 0) window.scrollTo({ top: ctscroll })
      } else if (
        cursorPosition < windowPosition ||
        cursorPosition + cursorHeight > windowPosition + windowHeight
      ) {
        if (cursorPosition < windowPosition) {
          window.scrollTo({ top: cursorPosition })
        } else if (cursorHeight + lineHeight < windowHeight) {
          window.scrollTo({ top: cursorPosition - (windowHeight - cursorHeight) + lineHeight })
        } else {
          window.scrollTo({ top: cursorPosition })
        }
      }
    }
    this.markChanged()
  }

  expandAllLevels(): void {
    const node = this.getCursor()
    if (!node) return
    node.classList.remove('collapsed')
    node
      .querySelectorAll('.concord-node')
      .forEach((el) => el.classList.remove('collapsed'))
  }

  fullCollapse(): void {
    this.root.querySelectorAll('.concord-node').forEach((el) => {
      if (childNodes(el).length > 0) el.classList.add('collapsed')
    })
    const cursor = this.getCursor()
    if (cursor) {
      const parents = nodeParents(cursor)
      const top = parents[parents.length - 1]
      if (top) this.o.editor.select(top)
    }
  }

  fullExpand(): void {
    this.root
      .querySelectorAll('.concord-node')
      .forEach((el) => el.classList.remove('collapsed'))
  }

  /**
   * Collapse everything, then re-expand so headlines are visible down
   * through `level`. Levels are 1-based and counted from whatever is
   * currently the top of the view (the real root, or the hoisted node if
   * hoisted): `expandToLevel(1)` shows only the top-level headlines
   * (equivalent to `collapseEverything`), `expandToLevel(2)` additionally
   * reveals their immediate children, and so on. A level deeper than the
   * outline's actual depth is equivalent to `expandEverything`.
   */
  expandToLevel(level: number): void {
    const nodes = Array.from(
      this.root.querySelectorAll('.concord-node'),
    ) as HTMLLIElement[]
    for (const el of nodes) {
      if (childNodes(el).length === 0) continue
      const depth = nodeParents(el).length + 1
      if (depth < level) el.classList.remove('collapsed')
      else el.classList.add('collapsed')
    }
    const cursor = this.getCursor()
    if (cursor) {
      const parents = nodeParents(cursor)
      const top = parents[parents.length - 1]
      if (top) this.o.editor.select(top)
    }
    this.markChanged()
  }

  subsExpanded(): boolean {
    const node = this.getCursor()
    if (!node) return false
    return !node.classList.contains('collapsed') && childNodes(node).length > 0
  }

  countSubs(): number {
    const node = this.getCursor()
    return node ? childNodes(node).length : 0
  }

  level(): number {
    const c = this.getCursor()
    return c ? nodeParents(c).length + 1 : 1
  }

  // --- hoist ------------------------------------------------------------------
  //
  // Hoisting focuses the view on a subtree: `root`'s children are swapped for
  // the hoisted node's children, so the node's subs become the top level.
  // Hoists nest (a stack). Critically, this is done by moving the live DOM
  // nodes aside, not by round-tripping through OPML — that would lose
  // expansion state and cursor position, and (more importantly) any code that
  // serializes while hoisted must still see the *complete* document. See
  // `withFullTree` below, which every OPML/title/header reader is expected to
  // run through.

  /** Move root's current children into a detached fragment and pull `node`'s children up into root. Pure DOM — no cursor/callback side effects. */
  private applyHoist(node: HTMLLIElement): HoistFrame {
    const stash = document.createDocumentFragment()
    while (this.root.firstChild) stash.appendChild(this.root.firstChild)
    const ol = childOl(node, true)!
    while (ol.firstChild) this.root.appendChild(ol.firstChild)
    return { node, stash }
  }

  /** Inverse of `applyHoist`: current root children go back under `frame.node`, and the stashed siblings return to root. Pure DOM — no cursor/callback side effects. */
  private undoHoist(frame: HoistFrame): void {
    const ol = childOl(frame.node, true)!
    ol.replaceChildren()
    while (this.root.firstChild) ol.appendChild(this.root.firstChild)
    this.root.appendChild(frame.stash)
  }

  /**
   * Temporarily restore the real, complete tree (unwinding every hoist level
   * in the stack) so `fn` can read/serialize the full document, then
   * re-apply the same hoists (in the same order, against whatever `fn` may
   * have left behind) before returning. Edits `fn` makes are structural DOM
   * edits against `root`, so they are naturally preserved through the
   * unwind/reapply — nothing is round-tripped through OPML here.
   *
   * This is what guarantees `outlineToXml()` (and anything built on it)
   * returns the complete document no matter how deep the hoist stack is.
   */
  private withFullTree<T>(fn: () => T): T {
    if (this.hoistStack.length === 0) return fn()
    const frames = this.hoistStack
    for (let i = frames.length - 1; i >= 0; i--) this.undoHoist(frames[i])
    try {
      return fn()
    } finally {
      for (let i = 0; i < frames.length; i++) {
        frames[i] = this.applyHoist(frames[i].node)
      }
    }
  }

  /** Hoist to the cursor. False if there is no cursor, or it has no subs. */
  hoist(): boolean {
    const node = this.getCursor()
    if (!node) return false
    if (childNodes(node).length === 0) return false
    this.hoistStack.push(this.applyHoist(node))
    const first = childNodes(this.root)[0]
    if (first) this.setCursor(first)
    this.o.refreshTitleRow()
    return true
  }

  /** Pop one level of hoist. False if not currently hoisted. */
  deHoist(): boolean {
    const frame = this.hoistStack.pop()
    if (!frame) return false
    this.undoHoist(frame)
    if (frame.node.isConnected) this.setCursor(frame.node)
    this.o.refreshTitleRow()
    return true
  }

  /** Pop every level of hoist, back to the real root. False if not hoisted. */
  deHoistAll(): boolean {
    if (this.hoistStack.length === 0) return false
    while (this.hoistStack.length > 0) this.deHoist()
    return true
  }

  isHoisted(): boolean {
    return this.hoistStack.length > 0
  }

  hoistDepth(): number {
    return this.hoistStack.length
  }

  /**
   * The headline currently hoisted into (the innermost frame), or null at
   * the real root. Used by the title row (titleRow.ts): while hoisted, this
   * headline's own text isn't reachable through `root` -- `applyHoist` only
   * pulls its *children* up, the headline itself sits in the outer frame's
   * stash -- so this is the one way back to it.
   */
  hoistedNode(): HTMLLIElement | null {
    const frame = this.hoistStack[this.hoistStack.length - 1]
    return frame ? frame.node : null
  }

  // --- find / find-again ------------------------------------------------------
  //
  // Search order is *document* order, not raw DOM sibling order: from a node,
  // first its own children (regardless of collapsed state — see below), then
  // `_walk_down` to the next sibling-or-ancestor's-sibling. That is the same
  // shape of walk `outlineToXml()` uses to build `expansionState`, except that
  // walk deliberately does *not* descend into a collapsed node's children
  // (it's recording what's visible), while find deliberately *does* — a
  // collapsed subtree can still contain the headline the user is looking for,
  // and refusing to search it would be surprising. When a match is found
  // inside one, its collapsed ancestors are expanded so the cursor is
  // actually visible afterwards (see `_reveal`).
  //
  // Because this walk only ever reaches nodes still attached under `root`,
  // hoisting participates for free: displaced subtrees are detached DOM (see
  // `applyHoist`), so they're simply unreachable from here. Find and
  // find-again therefore search only the current hoisted view, never the
  // stashed-away parts of the document -- consistent with the user having
  // deliberately narrowed focus by hoisting -- and can never land the cursor
  // on a detached node.
  //
  // Dirty-marking: a search that finds nothing must never mark the document
  // changed -- it read-only inspects headline text. A search that *does* find
  // a match, though, may need to expand one or more collapsed ancestors to
  // make the match visible, and expansion state is itself persisted (OPML
  // `<head><expansionState>`), exactly like `expand()`. So `find`/`findAgain`
  // mark the document changed if and only if revealing the match actually
  // expanded something -- never on a failed search, and never when the match
  // was already visible.

  /** Document-order successor of `node`, descending into children (collapsed or not) before moving on. */
  private _searchNext(node: HTMLLIElement): HTMLLIElement | null {
    const kids = childNodes(node)
    if (kids.length > 0) return kids[0]
    return this._walk_down(node)
  }

  /** Expand any collapsed ancestors of `node` and move the cursor there. */
  private _reveal(node: HTMLLIElement): void {
    let expanded = false
    for (const ancestor of nodeParents(node)) {
      if (ancestor.classList.contains('collapsed')) {
        ancestor.classList.remove('collapsed')
        expanded = true
      }
    }
    this.setCursor(node)
    this.focusCursor()
    if (expanded) this.markChanged()
  }

  private _matches(node: HTMLLIElement, needle: string, matchCase: boolean): boolean {
    const text = textOf(node)?.textContent ?? ''
    return (matchCase ? text : text.toLowerCase()).includes(needle)
  }

  private _search(text: string, matchCase: boolean, wrap: boolean): boolean {
    const needle = matchCase ? text : text.toLowerCase()
    const start = this.getCursor()

    let node = start ? this._searchNext(start) : (this.root.querySelector('.concord-node') as HTMLLIElement | null)
    while (node) {
      if (this._matches(node, needle, matchCase)) {
        this._reveal(node)
        return true
      }
      node = this._searchNext(node)
    }

    if (wrap) {
      let wrapped = this.root.querySelector('.concord-node') as HTMLLIElement | null
      while (wrapped && wrapped !== start) {
        if (this._matches(wrapped, needle, matchCase)) {
          this._reveal(wrapped)
          return true
        }
        wrapped = this._searchNext(wrapped)
      }
      // The only match may be the node the search started from -- wrapping
      // all the way back around should still find it.
      if (start && this._matches(start, needle, matchCase)) {
        this._reveal(start)
        return true
      }
    }
    return false
  }

  /**
   * Search headline text starting *after* the current cursor, in document
   * order (see above), and move the cursor to the first match. Matching is
   * case-insensitive unless `matchCase` is set. Wraps around to the top after
   * the last match unless `wrap: false`. Remembers the search (text and
   * options) so `findAgain()` can repeat it. Returns whether a match was found.
   */
  find(text: string, options?: FindOptions): boolean {
    const matchCase = options?.matchCase ?? false
    const wrap = options?.wrap ?? true
    if (!text) return false
    this.lastSearch = { text, matchCase, wrap }
    return this._search(text, matchCase, wrap)
  }

  /** Repeat the last `find()` from the current cursor. False if there's no previous search, or no further match. */
  findAgain(): boolean {
    if (!this.lastSearch) return false
    const { text, matchCase, wrap } = this.lastSearch
    return this._search(text, matchCase, wrap)
  }

  // --- text formatting ------------------------------------------------------

  private execFormat(command: string): void {
    this.saveState()
    if (this.inTextMode()) {
      document.execCommand(command)
    } else {
      this.focusCursor()
      document.execCommand('selectAll')
      document.execCommand(command)
      document.execCommand('unselect')
      this.blurCursor()
      this.o.pasteBinFocus()
    }
    this.markChanged()
  }

  bold(): void {
    this.execFormat('bold')
  }

  italic(): void {
    this.execFormat('italic')
  }

  strikethrough(): void {
    this.execFormat('strikeThrough')
  }

  link(url: string): void {
    if (!this.inTextMode()) return
    if (!this.o.eventsEnabled()) {
      this.o.onResume(() => this.link(url))
      return
    }
    if (!getConcordRange()) this.o.editor.restoreSelection()
    if (getConcordRange()) {
      this.saveState()
      document.execCommand('createLink', false, url)
      this.markChanged()
    }
  }

  // --- text content ---------------------------------------------------------

  getLineText(): string | null {
    const node = this.getCursor()
    if (!node) return null
    let text = textOf(node)?.innerHTML ?? ''
    const m = text.match(/^(.+)<br>\s*$/)
    if (m) text = m[1]
    return this.o.editor.unescape(text)
  }

  setLineText(text: string): boolean {
    this.saveState()
    const node = this.getCursor()
    if (!node) return false
    const t = textOf(node)
    if (t) t.innerHTML = this.o.editor.escape(text)
    return true
  }

  getRenderMode(): boolean {
    const rm = this.o.state.renderMode
    return rm !== undefined ? rm === true : true
  }

  setRenderMode(mode: boolean): boolean {
    this.o.state.renderMode = mode
    this.redraw()
    return true
  }

  setStyle(css: string): boolean {
    this.o.setCustomStyle(css)
    return true
  }

  // --- title & headers ------------------------------------------------------
  //
  // `state.headers` is the single store for OPML `<head>` data -- title
  // included (`title` is just another key in the same map). getTitle()/
  // setTitle() are accessors over it, so there is exactly one place the
  // title lives: setHeaders({ title: ... }) and setTitle(...) can never
  // disagree, because they write the same field.

  getTitle(): string {
    return this.o.state.headers['title'] ?? ''
  }

  setTitle(title: string): boolean {
    this.o.state.headers['title'] = title
    // setTitle() alone does not mark the document changed -- callers that
    // represent a real user edit (titleRow.ts's commit()) call markChanged()
    // themselves; a plain programmatic setTitle() (e.g. from xmlToOutline on
    // load) must not look like an unsaved change.
    this.o.fireHeadChange(this.getHeaders())
    return true
  }

  getHeaders(): OpmlHeaders {
    return { ...this.o.state.headers }
  }

  /**
   * Merge `headers` into the authored `<head>` map (`Object.assign`
   * semantics): every key present overwrites the current value -- setting
   * `title` here works exactly like `setTitle()`, since they share the same
   * store -- and every key *not* present is left untouched. This is
   * deliberate: a caller patching in one custom field (e.g.
   * `{ ownerName: 'x' }`) must not silently wipe out the title or any other
   * field it didn't mention. Pass a full `getHeaders()` snapshot back in
   * (spread with your changes) if you specifically want replace-all
   * semantics.
   *
   * Computed field names (`COMPUTED_HEAD_FIELDS`) are silently ignored --
   * they're regenerated at serialization time (see `outlineToXml`), so
   * accepting one here would let it leak into `getHeaders()` as if the user
   * had authored it.
   */
  setHeaders(headers: OpmlHeaders): boolean {
    for (const name of Object.keys(headers)) {
      if (COMPUTED_HEAD_FIELDS.has(name)) continue
      this.o.state.headers[name] = headers[name]
    }
    this.markChanged()
    this.o.fireHeadChange(this.getHeaders())
    return true
  }

  // --- movement -------------------------------------------------------------

  go(direction: Direction, count = 1, multiple?: boolean, textMode?: boolean): boolean {
    let cursor: HTMLLIElement | null = this.getCursor()
    if (!cursor) return false
    this.setTextMode(textMode ?? false)
    let able = false
    switch (direction) {
      case UP:
        for (let i = 0; i < count; i++) {
          const prev = prevNode(cursor)
          if (prev) {
            cursor = prev
            able = true
          } else break
        }
        this.setCursor(cursor, multiple)
        break
      case DOWN:
        for (let i = 0; i < count; i++) {
          const next = nextNode(cursor)
          if (next) {
            cursor = next
            able = true
          } else break
        }
        this.setCursor(cursor, multiple)
        break
      case LEFT:
        for (let i = 0; i < count; i++) {
          const parent = firstNodeParent(cursor)
          if (parent) {
            cursor = parent
            able = true
          } else break
        }
        this.setCursor(cursor, multiple)
        break
      case RIGHT:
        for (let i = 0; i < count; i++) {
          const kids: HTMLLIElement[] = childNodes(cursor)
          if (kids.length > 0) {
            cursor = kids[0]
            able = true
          } else break
        }
        this.setCursor(cursor, multiple)
        break
      case FLATUP: {
        let nodeCount = 0
        let c: HTMLLIElement | null = cursor
        while (c && nodeCount < count) {
          c = this._walk_up(c)
          if (c && !c.classList.contains('collapsed') && childNodes(c).length > 0) {
            nodeCount++
            able = true
            if (nodeCount === count) {
              this.setCursor(c, multiple)
              break
            }
          }
        }
        break
      }
      case FLATDOWN: {
        let nodeCount = 0
        let c: HTMLLIElement | null = cursor
        while (c && nodeCount < count) {
          let next: HTMLLIElement | null = null
          if (!c.classList.contains('collapsed')) {
            next = childNodes(c)[0] ?? null
          }
          if (!next) next = this._walk_down(c)
          c = next
          if (c && !c.classList.contains('collapsed') && childNodes(c).length > 0) {
            nodeCount++
            able = true
            if (nodeCount === count) this.setCursor(c, multiple)
          }
        }
        break
      }
    }
    this.markChanged()
    return able
  }

  // --- insertion ------------------------------------------------------------

  insert(insertText: string, insertDirection: Direction = DOWN, flInsertRawHtml?: boolean): HTMLLIElement {
    this.saveState()
    const cursor = this.getCursor()!
    let level = nodeParents(cursor).length + 1
    if (insertDirection === RIGHT) level += 1
    else if (insertDirection === LEFT) level -= 1

    const node = this.o.editor.makeNode()
    node.classList.add('concord-level-' + level)
    const text = textOf(node)!
    text.classList.add('concord-level-' + level + '-text')
    if (insertText && insertText !== '') {
      text.innerHTML = flInsertRawHtml ? insertText : this.o.editor.escape(insertText)
    }

    switch (insertDirection) {
      case DOWN:
        cursor.insertAdjacentElement('afterend', node)
        break
      case RIGHT:
        childOl(cursor, true)!.prepend(node)
        this.expand(false)
        break
      case UP:
        cursor.insertAdjacentElement('beforebegin', node)
        break
      case LEFT: {
        const parent = firstNodeParent(cursor)
        if (parent) parent.insertAdjacentElement('afterend', node)
        break
      }
    }
    this.setCursor(node)
    this.markChanged()
    this.o.fireCallback('opInsert', this.setCursorContext(node))
    return node
  }

  insertImage(url: string): void {
    if (this.inTextMode()) {
      document.execCommand('insertImage', false, url)
    } else {
      this.insert('<img src="' + url + '">', DOWN, true)
    }
  }

  insertText(text: string): void {
    const editor = this.o.editor
    const nodesOl = document.createElement('ol')
    let lastLevel = 0
    let startingLine = 0
    const startingLevel = 0
    let lastNode: HTMLLIElement | null = null
    let parent: HTMLLIElement | null = null
    const parents: Record<number, HTMLLIElement> = {}
    const lines = text.split('\n')
    let workflowy = true
    let workflowyParent: HTMLLIElement | null = null

    let firstLineWithContent = 0
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].match(/^\s*$/)) {
        firstLineWithContent = i
        break
      }
    }
    if (lines.length > firstLineWithContent + 2) {
      if (
        lines[firstLineWithContent].match(/^([\t\s]*)-.*$/) == null &&
        lines[firstLineWithContent].match(/^.+$/) &&
        lines[firstLineWithContent + 1] === ''
      ) {
        startingLine = firstLineWithContent + 2
        workflowyParent = editor.makeNode()
        textOf(workflowyParent)!.innerHTML = lines[firstLineWithContent]
      }
    }
    for (let i = startingLine; i < lines.length; i++) {
      const line = lines[i]
      if (line !== '' && !line.match(/^\s+$/) && line.match(/^([\t\s]*)-.*$/) == null) {
        workflowy = false
        break
      }
    }
    if (!workflowy) {
      startingLine = 0
      workflowyParent = null
    }
    for (let i = startingLine; i < lines.length; i++) {
      const line = lines[i]
      if (line !== '' && !line.match(/^\s+$/)) {
        const matches = line.match(/^([\t\s]*)(.+)$/)!
        const node = editor.makeNode()
        let nodeText = editor.escape(matches[2])
        if (workflowy) {
          const wm = nodeText.match(/^([\t\s]*)-\s*(.+)$/)
          if (wm != null) nodeText = wm[2]
        }
        textOf(node)!.innerHTML = nodeText
        let level = startingLevel
        if (matches[1]) {
          level = workflowy
            ? matches[1].length / 2 + startingLevel
            : matches[1].length + startingLevel
          if (level > lastLevel) {
            if (lastNode) parents[lastLevel] = lastNode
            parent = lastNode
          } else if (level > 0 && level < lastLevel) {
            parent = parents[level - 1] ?? null
          }
        }
        if (parent && level > 0) {
          childOl(parent, true)!.appendChild(node)
          parent.classList.add('collapsed')
        } else {
          for (const k of Object.keys(parents)) delete parents[+k]
          nodesOl.appendChild(node)
        }
        lastNode = node
        lastLevel = level
      }
    }
    if (workflowyParent) {
      if (nodesOl.children.length > 0) workflowyParent.classList.add('collapsed')
      const wfOl = childOl(workflowyParent, true)!
      while (nodesOl.firstChild) wfOl.appendChild(nodesOl.firstChild)
      nodesOl.replaceChildren(workflowyParent)
    }
    if (nodesOl.children.length > 0) {
      this.saveState()
      this.setTextMode(false)
      const cursor = this.getCursor()!
      const inserted = Array.from(nodesOl.children) as HTMLLIElement[]
      let anchor: Element = cursor
      for (const n of inserted) {
        anchor.insertAdjacentElement('afterend', n)
        anchor = n
      }
      const next = nextNode(cursor)
      if (next) this.setCursor(next)
      this.o.state.clipboard = null
      this.markChanged()
      editor.recalculateLevels()
    }
  }

  insertXml(opmltext: string | Document, dir: Direction = DOWN): boolean {
    this.saveState()
    const cursor = this.getCursor()!
    let level = nodeParents(cursor).length + 1
    if (dir === RIGHT) level += 1
    else if (dir === LEFT) level -= 1

    const doc =
      typeof opmltext === 'string'
        ? new DOMParser().parseFromString(opmltext, 'application/xml')
        : opmltext
    const body = doc.querySelector('body')
    const nodes: HTMLLIElement[] = []
    if (body) {
      for (const outline of Array.from(body.children)) {
        if (outline.tagName.toLowerCase() === 'outline') {
          nodes.push(this.o.editor.build(outline, true, level))
        }
      }
    }
    const expansionState = doc.querySelector('expansionState')
    if (expansionState && expansionState.textContent) {
      const states = expansionState.textContent.split(',')
      let nodeId = 1
      for (const wrap of nodes) {
        const all = [wrap, ...(wrap.querySelectorAll('.concord-node') as unknown as HTMLLIElement[])]
        for (const n of all) {
          if (states.indexOf('' + nodeId) >= 0) n.classList.remove('collapsed')
          nodeId++
        }
      }
    }
    switch (dir) {
      case DOWN: {
        let anchor: Element = cursor
        for (const n of nodes) {
          anchor.insertAdjacentElement('afterend', n)
          anchor = n
        }
        break
      }
      case RIGHT: {
        const ol = childOl(cursor, true)!
        for (const n of nodes.reverse()) ol.prepend(n)
        this.expand(false)
        break
      }
      case UP:
        for (const n of nodes) cursor.insertAdjacentElement('beforebegin', n)
        break
      case LEFT: {
        const parent = firstNodeParent(cursor)
        if (parent) {
          let anchor: Element = parent
          for (const n of nodes) {
            anchor.insertAdjacentElement('afterend', n)
            anchor = n
          }
        }
        break
      }
    }
    this.markChanged()
    return true
  }

  // --- delete ---------------------------------------------------------------

  deleteLine(): void {
    this.saveState()
    if (this.inTextMode()) {
      const cursor = this.getCursor()!
      let p: HTMLLIElement | null = prevNode(cursor)
      if (!p) p = firstNodeParent(cursor)
      cursor.remove()
      this.restoreAfterDelete(p)
    } else {
      const selected = Array.from(
        this.root.querySelectorAll('.selected'),
      ) as HTMLLIElement[]
      if (selected.length >= 1) {
        const first = selected[0]
        let p: HTMLLIElement | null = prevNode(first)
        if (!p) p = firstNodeParent(first)
        selected.forEach((el) => el.remove())
        this.restoreAfterDelete(p)
      }
    }
    if (this.root.querySelectorAll('.concord-node').length === 0) {
      const node = this.insert('', DOWN)
      this.setCursor(node)
    }
    this.markChanged()
  }

  private restoreAfterDelete(p: HTMLLIElement | null): void {
    if (p) {
      this.setCursor(p)
    } else {
      const first = this.root.querySelector('.concord-node') as HTMLLIElement | null
      if (first) this.setCursor(first)
      else this.wipe()
    }
  }

  deleteSubs(): void {
    const node = this.getCursor()
    if (node && childNodes(node).length > 0) {
      this.saveState()
      childOl(node)?.replaceChildren()
    }
    this.markChanged()
  }

  // --- reorganize -----------------------------------------------------------

  promote(): void {
    const node = this.getCursor()
    if (!node) return
    const kids = childNodes(node)
    if (kids.length > 0) {
      this.saveState()
      for (const child of kids.reverse()) node.insertAdjacentElement('afterend', child)
      const parentOl = node.parentElement
      if (parentOl) {
        this.o.editor.recalculateLevels(
          Array.from(parentOl.querySelectorAll('.concord-node')) as HTMLLIElement[],
        )
      }
      this.markChanged()
    }
  }

  demote(): void {
    const node = this.getCursor()
    if (!node) return
    const following: HTMLLIElement[] = []
    let s = nextNode(node)
    while (s) {
      following.push(s)
      s = nextNode(s)
    }
    if (following.length > 0) {
      this.saveState()
      const ol = childOl(node, true)!
      for (const sib of following) ol.appendChild(sib)
      node.classList.remove('collapsed')
      this.o.editor.recalculateLevels(
        Array.from(node.querySelectorAll('.concord-node')) as HTMLLIElement[],
      )
      this.markChanged()
    }
  }

  reorg(direction: Direction, count = 1): boolean {
    let able = false
    let cursor = this.getCursor()!
    let toMove: HTMLLIElement[] = [cursor]
    const selected = Array.from(
      this.root.querySelectorAll('.selected'),
    ) as HTMLLIElement[]
    if (selected.length > 1) {
      cursor = selected[0]
      toMove = selected
    }
    let iteration = 1

    switch (direction) {
      case UP: {
        let prev = prevNode(cursor)
        if (prev) {
          while (iteration < count) {
            const pp = prevNode(prev)
            if (pp) prev = pp
            else break
            iteration++
          }
          this.saveState()
          for (const n of toMove) prev.insertAdjacentElement('beforebegin', n)
          able = true
        }
        break
      }
      case DOWN: {
        let anchor = cursor
        if (!this.inTextMode() && selected.length > 0) anchor = selected[selected.length - 1]
        let next = nextNode(anchor)
        if (next) {
          while (iteration < count) {
            const nn = nextNode(next)
            if (nn) next = nn
            else break
            iteration++
          }
          this.saveState()
          let insertAfter: Element = next
          for (const n of toMove) {
            insertAfter.insertAdjacentElement('afterend', n)
            insertAfter = n
          }
          able = true
        }
        break
      }
      case LEFT: {
        const outline = cursor.parentElement
        if (outline && !outline.classList.contains('concord-root')) {
          let parent = outline.parentElement as HTMLLIElement
          while (iteration < count) {
            const pp = firstNodeParent(parent)
            if (pp) parent = pp
            else break
            iteration++
          }
          this.saveState()
          let insertAfter: Element = parent
          for (const n of toMove) {
            insertAfter.insertAdjacentElement('afterend', n)
            insertAfter = n
          }
          const following: HTMLLIElement[] = []
          let s = nextNode(parent)
          while (s) {
            following.push(s, ...(Array.from(s.querySelectorAll('.concord-node')) as HTMLLIElement[]))
            s = nextNode(s)
          }
          this.o.editor.recalculateLevels(following)
          able = true
        }
        break
      }
      case RIGHT: {
        let prev = prevNode(cursor)
        if (prev) {
          this.saveState()
          while (iteration < count) {
            const kids = childNodes(prev)
            if (kids.length > 0) prev = kids[kids.length - 1]
            else break
            iteration++
          }
          const prevOl = childOl(prev, true)!
          for (const n of toMove) prevOl.appendChild(n)
          prev.classList.remove('collapsed')
          this.o.editor.recalculateLevels(
            Array.from(prev.querySelectorAll('.concord-node')) as HTMLLIElement[],
          )
          able = true
        }
        break
      }
    }
    if (able) {
      if (this.inTextMode()) {
        const c = this.getCursor()
        if (c) this.setCursor(c)
      }
      this.markChanged()
      const node = this.getCursor()
      if (node) this.o.fireCallback('opReorg', this.setCursorContext(node))
    }
    return able
  }

  // --- clipboard ------------------------------------------------------------

  copy(): void {
    if (!this.inTextMode()) {
      this.o.state.clipboard = Array.from(
        this.root.querySelectorAll('.selected'),
      ).map((n) => n.cloneNode(true) as HTMLLIElement)
    }
  }

  cut(): void {
    if (!this.inTextMode()) {
      this.copy()
      this.deleteLine()
    }
  }

  paste(): void {
    if (this.inTextMode()) return
    const clip = this.o.state.clipboard
    if (clip && clip.length > 0) {
      this.saveState()
      this.root
        .querySelectorAll('.selected')
        .forEach((el) => el.classList.remove('selected'))
      const cursor = this.getCursor()!
      const clones = clip.map((n) => n.cloneNode(true) as HTMLLIElement)
      let anchor: Element = cursor
      for (const n of clones) {
        anchor.insertAdjacentElement('afterend', n)
        anchor = n
      }
      this.setCursor(clones[0], clones.length > 1)
      this.markChanged()
    }
  }

  // --- redraw & misc --------------------------------------------------------

  redraw(): void {
    const visible = Array.from(
      this.root.querySelectorAll('.concord-node'),
    ).filter((n) => (n as HTMLElement).offsetParent !== null || n.isConnected)
    let cursorIndex = 1
    let ct = 1
    for (const n of visible) {
      if (n.classList.contains('concord-cursor')) {
        cursorIndex = ct
        break
      }
      ct++
    }
    const wasChanged = this.changed()
    this.xmlToOutline(this.outlineToXml())
    const visible2 = Array.from(this.root.querySelectorAll('.concord-node'))
    ct = 1
    for (const n of visible2) {
      if (cursorIndex === ct) {
        this.setCursor(n as HTMLLIElement)
        break
      }
      ct++
    }
    if (wasChanged) this.markChanged()
  }

  runSelection(): void {
    // eslint-disable-next-line no-eval
    const value = eval(this.getLineText() ?? '')
    this.deleteSubs()
    this.insert(String(value), RIGHT)
    this.o.script.makeComment()
    this.go(LEFT, 1)
  }

  sort(): void {
    this.saveState()
    const cursor = this.getCursor()!
    const parentOl = cursor.parentElement
    if (!parentOl) return
    const items = Array.from(parentOl.children) as HTMLElement[]
    items.sort((a, b) => {
      const ka = (a.textContent ?? '').toLowerCase()
      const kb = (b.textContent ?? '').toLowerCase()
      if (ka < kb) return -1
      if (ka > kb) return 1
      return 0
    })
    for (const li of items) parentOl.appendChild(li)
    this.markChanged()
  }

  wipe(): void {
    this.hoistStack = []
    if (this.root.querySelectorAll('.concord-node').length > 0) this.saveState()
    this.root.replaceChildren()
    const node = this.o.editor.makeNode()
    this.root.appendChild(node)
    this.setTextMode(false)
    this.setCursor(node)
    this.markChanged()
    // Clearing hoistStack above can switch the title row from "hoisted
    // headline" back to "document title" even though the title text itself
    // is untouched by wipe().
    this.o.refreshTitleRow()
  }

  // --- OPML I/O -------------------------------------------------------------

  cursorToXml(): string {
    return this.o.editor.opml(this.getCursor()!)
  }

  cursorToXmlSubsOnly(): string {
    return this.o.editor.opml(this.getCursor()!, true)
  }

  getNodeOpml(node: HTMLLIElement): string {
    return this.o.editor.opml(node, true)
  }

  outlineToText(): string {
    let text = ''
    for (const n of childNodes(this.root)) text += this.o.editor.textLine(n)
    return text
  }

  saveCursor(): number {
    let cursor = this.getCursor()
    let ct = 0
    while (cursor) {
      const prev = this._walk_up(cursor)
      if (prev) {
        cursor = prev
        ct++
      } else break
    }
    return ct
  }

  outlineToXml(ownerName?: string, ownerEmail?: string, ownerId?: string): string {
    // Serialize against the complete document, not whatever's currently
    // hoisted into view — see `withFullTree`. This is what stops a Save made
    // while hoisted from writing out only the hoisted subtree.
    return this.withFullTree(() => {
      // getHeaders() is always the clean authored map -- 'title' included,
      // computed fields never -- so the three computed fields below are
      // simply appended, never overwriting anything a user actually wrote.
      const head: OpmlHeaders = this.getHeaders()
      if (ownerName) head['ownerName'] = ownerName
      if (ownerEmail) head['ownerEmail'] = ownerEmail
      if (ownerId) head['ownerId'] = ownerId
      head['dateModified'] = new Date().toUTCString()

      const expansionStates: number[] = []
      let nodeId = 1
      let cursor: HTMLLIElement | null = this.root.querySelector('.concord-node')
      while (cursor) {
        if (!cursor.classList.contains('collapsed') && childNodes(cursor).length > 0) {
          expansionStates.push(nodeId)
        }
        nodeId++
        let next: HTMLLIElement | null = null
        if (!cursor.classList.contains('collapsed')) next = childNodes(cursor)[0] ?? null
        if (!next) next = this._walk_down(cursor)
        cursor = next
      }
      head['expansionState'] = expansionStates.join(',')
      head['lastCursor'] = String(this.saveCursor())

      let opml = ''
      let indent = 0
      const add = (s: string) => {
        opml += '\t'.repeat(indent) + s + '\n'
      }
      add('<?xml version="1.0"?>')
      add('<opml version="2.0">')
      indent++
      add('<head>')
      indent++
      for (const name of Object.keys(head)) {
        if (head[name] !== undefined) {
          add('<' + name + '>' + escapeXml(head[name]) + '</' + name + '>')
        }
      }
      indent--
      add('</head>')
      add('<body>')
      indent++
      for (const n of childNodes(this.root)) opml += this.o.editor.opmlLine(n, indent)
      indent--
      add('</body>')
      indent--
      add('</opml>')
      return opml
    })
  }

  xmlToOutline(
    xmlText: string | Document,
    flSetFocus = true,
    flInsertRawHtml?: boolean,
  ): boolean {
    const doc =
      typeof xmlText === 'string'
        ? new DOMParser().parseFromString(xmlText, 'application/xml')
        : xmlText
    // Loading a document replaces the whole tree, which would leave any
    // hoist frames pointing at detached nodes from the old one.
    this.hoistStack = []
    this.root.replaceChildren()

    // 'title' is looked up leniently (a bare <title> outside <head> is also
    // accepted, matching legacy Concord documents) and seeded first, so it's
    // always present -- and always the first key, matching the order every
    // other load/save path produces -- even if <head> is missing or
    // malformed.
    const titleEl = doc.querySelector('head > title, title')
    const headers: OpmlHeaders = { title: titleEl?.textContent ?? '' }
    const head = doc.querySelector('head')
    if (head) {
      for (const child of Array.from(head.children)) {
        const name = child.tagName
        // Computed fields are regenerated at save time (see
        // outlineToXml/COMPUTED_HEAD_FIELDS) -- consumed below for their
        // *effect* (expansion state, cursor restore), never stored as if the
        // user authored them, so getHeaders() doesn't report them after a
        // round trip.
        if (name === 'title' || COMPUTED_HEAD_FIELDS.has(name)) continue
        headers[name] = child.textContent ?? ''
      }
    }
    this.o.state.headers = headers
    // The one notification for "head data changed" on load -- also what
    // switches the title row from a stale previous document's title back to
    // this one's (see Outliner.fireHeadChange).
    this.o.fireHeadChange(this.getHeaders())

    const body = doc.querySelector('body')
    if (body) {
      for (const outline of Array.from(body.children)) {
        if (outline.tagName.toLowerCase() === 'outline') {
          this.root.appendChild(this.o.editor.build(outline, true, undefined, flInsertRawHtml))
        }
      }
    }
    this.o.state.changed = false

    const expansionState = doc.querySelector('expansionState')
    if (expansionState && expansionState.textContent) {
      const states = expansionState.textContent.split(/\s*,\s*/)
      let nodeId = 1
      let cursor: HTMLLIElement | null = this.root.querySelector('.concord-node')
      while (cursor) {
        if (states.indexOf('' + nodeId) >= 0) cursor.classList.remove('collapsed')
        nodeId++
        let next: HTMLLIElement | null = null
        if (!cursor.classList.contains('collapsed')) next = childNodes(cursor)[0] ?? null
        if (!next) next = this._walk_down(cursor)
        cursor = next
      }
    }
    this.setTextMode(false)

    if (flSetFocus) {
      const first = this.root.querySelector('.concord-node') as HTMLLIElement | null
      if (first) this.setCursor(first)
      const lastCursor = doc.querySelector('lastCursor')
      if (lastCursor && lastCursor.textContent) {
        const ix = parseInt(lastCursor.textContent)
        if (!isNaN(ix)) {
          let cursor = this.getCursor()
          let moved: HTMLLIElement | null = null
          for (let i = 1; i <= ix && cursor; i++) {
            let next: HTMLLIElement | null = null
            if (!cursor.classList.contains('collapsed')) next = childNodes(cursor)[0] ?? null
            if (!next) next = this._walk_down(cursor)
            cursor = next
            moved = next
          }
          if (moved) this.setCursor(moved)
        }
      }
    }
    this.o.state.currentChange = this.o.editor.cloneChildren()
    return true
  }

  // --- traversal ------------------------------------------------------------

  visitLevel(cb: (child: NodeRef) => void): boolean {
    const cursor = this.getCursor()
    if (cursor) {
      for (const child of childNodes(cursor)) cb(this.setCursorContext(child))
    }
    return true
  }

  visitToSummit(cb: (node: NodeRef) => boolean): boolean {
    let cursor = this.getCursor()
    while (cursor && cb(this.setCursorContext(cursor))) {
      const parent = firstNodeParent(cursor)
      if (parent) cursor = parent
      else break
    }
    return true
  }

  visitAll(cb: (node: NodeRef) => boolean | void): void {
    const nodes = Array.from(
      this.root.querySelectorAll('.concord-node'),
    ) as HTMLLIElement[]
    for (const n of nodes) {
      const ret = cb(this.setCursorContext(n))
      if (ret === false) break
    }
  }
}
