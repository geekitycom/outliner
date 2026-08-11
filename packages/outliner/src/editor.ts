// DOM construction, OPML serialization, selection and drag mechanics.
// Ported from Concord's ConcordEditor.
import type { Outliner } from './outliner'
import { escapeXml } from './util'
import { iconHtml, setIcon } from './icons'
import { sharedClipboard } from './clipboard'
import {
  childNodes,
  childOl,
  closestNode,
  directChild,
  getNodeAttributes,
  iconOf,
  nodeParents,
  setNodeAttributes,
  textOf,
  wrapperOf,
  applyRange,
  getConcordRange,
} from './dom'

const ALLOWED_RENDER_TAGS = ['b', 'strong', 'i', 'em', 'a', 'img', 'strike', 'del']

/** Escape plain text into HTML, matching jQuery's $("<div/>").text(s).html(). */
function textToHtml(s: string): string {
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

/** Decode HTML into text, matching $("<div/>").html(h).text(). */
function htmlToText(h: string): string {
  const d = document.createElement('div')
  d.innerHTML = h
  return d.textContent ?? ''
}

export class Editor {
  constructor(private o: Outliner) {}

  private get root(): HTMLElement {
    return this.o.root
  }

  makeNode(): HTMLLIElement {
    const node = document.createElement('li')
    node.className = 'concord-node'
    const wrapper = document.createElement('div')
    wrapper.className = 'concord-wrapper type-icon'
    wrapper.insertAdjacentHTML('afterbegin', iconHtml('caret-right'))
    const text = document.createElement('div')
    text.className = 'concord-text'
    text.setAttribute('contenteditable', 'true')
    wrapper.appendChild(text)
    node.appendChild(wrapper)
    node.appendChild(document.createElement('ol'))
    return node
  }

  dragMode(): void {
    this.o.state.draggingChange = this.cloneChildren()
    this.root.classList.add('dragging')
    this.o.state.dragging = true
  }

  dragModeExit(): void {
    if (this.o.state.dragging) {
      this.o.op.markChanged()
      this.o.state.change = this.o.state.draggingChange
      this.o.state.changeTextMode = false
      this.o.state.changeRange = undefined
    }
    this.root
      .querySelectorAll('.draggable, .drop-sibling, .drop-child')
      .forEach((el) =>
        el.classList.remove('draggable', 'drop-sibling', 'drop-child'),
      )
    this.root.classList.remove('dragging')
    this.o.state.dragging = false
    this.o.state.mousedown = false
  }

  /** Deep-clone the root's children (undo/drag snapshot). Attributes ride along
   *  in `data-opml`; events are delegated, so no handler copying is needed. */
  cloneChildren(): HTMLElement[] {
    return Array.from(this.root.children).map(
      (c) => c.cloneNode(true) as HTMLElement,
    )
  }

  edit(node: HTMLLIElement, empty?: boolean): void {
    const text = textOf(node)
    if (!text) return
    if (empty) text.innerHTML = ''
    text.focus()
    if (text.childNodes[0]) {
      const range = document.createRange()
      range.selectNodeContents(text)
      range.collapse(false)
      applyRange(range)
    }
    text.classList.add('editing')
    if (!empty && this.root.querySelector('.concord-node.dirty')) {
      this.o.op.markChanged()
    }
  }

  editable(target: Element | null): boolean {
    if (!target) return false
    let el: Element | null = target
    if (!el.classList.contains('concord-text')) {
      el = el.closest('.concord-text')
    }
    return !!el && el.classList.contains('editing')
  }

  editorMode(): void {
    this.root
      .querySelectorAll('.selected')
      .forEach((el) => el.classList.remove('selected'))
    this.root
      .querySelectorAll('.editing')
      .forEach((el) => el.classList.remove('editing'))
    this.root
      .querySelectorAll('.selection-toolbar')
      .forEach((el) => el.remove())
  }

  // --- OPML serialization ---------------------------------------------------

  opml(rootEl?: Element, flsubsonly = false): string {
    const target = rootEl ?? this.root
    let title = this.o.op.getTitle()
    if (!title) {
      if (target.classList.contains('concord-node')) {
        title = textOf(target)?.textContent ?? ''
      } else {
        title = ''
      }
    }
    let opml = '<?xml version="1.0"?>\n<opml version="2.0">\n<head>\n'
    opml += '<title>' + escapeXml(title) + '</title>\n'
    opml += '</head>\n<body>\n'
    if (target.classList.contains('concord-cursor')) {
      opml += this.opmlLine(target as HTMLLIElement, 0, flsubsonly)
    } else {
      for (const n of childNodes(target)) opml += this.opmlLine(n)
    }
    opml += '</body>\n</opml>\n'
    return opml
  }

  opmlLine(node: HTMLLIElement, indent = 0, flsubsonly = false): string {
    let text = this.unescape(textOf(node)?.innerHTML ?? '')
    const m = text.match(/^(.+)<br>\s*$/)
    if (m) text = m[1]
    let opml = ''
    const tab = () => '\t'.repeat(indent)

    let subheads: HTMLLIElement[]
    if (!flsubsonly) {
      opml += tab() + '<outline text="' + escapeXml(text) + '"'
      const attributes = getNodeAttributes(node)
      for (const name of Object.keys(attributes)) {
        if (name && name !== 'text' && attributes[name] !== undefined) {
          opml += ' ' + name + '="' + escapeXml(attributes[name]) + '"'
        }
      }
      subheads = childNodes(node)
      if (subheads.length === 0) {
        return opml + '/>\n'
      }
      opml += '>\n'
    } else {
      subheads = childNodes(node)
    }

    const childIndent = indent + 1
    for (const sub of subheads) opml += this.opmlLine(sub, childIndent)

    if (!flsubsonly) {
      opml += '\t'.repeat(childIndent) + '</outline>\n'
    }
    return opml
  }

  textLine(node: HTMLLIElement, indent = 0): string {
    let text = '\t'.repeat(indent)
    text += this.unescape(textOf(node)?.innerHTML ?? '')
    text += '\n'
    for (const sub of childNodes(node)) text += this.textLine(sub, indent + 1)
    return text
  }

  // --- selection ------------------------------------------------------------

  select(node: HTMLLIElement, multiple = false, multipleRange = false): void {
    if (!node) return
    this.selectionMode(multiple)
    if (multiple) {
      nodeParents(node).forEach((p) => p.classList.remove('selected'))
      node
        .querySelectorAll('.concord-node.selected')
        .forEach((el) => el.classList.remove('selected'))
    }
    if (multiple && multipleRange) {
      const prevSelected = this.prevAll(node).some((n) =>
        n.classList.contains('selected'),
      )
      if (prevSelected) {
        let stamp = false
        for (const n of this.prevAll(node).reverse()) {
          if (n.classList.contains('selected')) stamp = true
          else if (stamp) n.classList.add('selected')
        }
      } else {
        const nextSelected = this.nextAll(node).some((n) =>
          n.classList.contains('selected'),
        )
        if (nextSelected) {
          let stamp = true
          for (const n of this.nextAll(node)) {
            if (n.classList.contains('selected')) stamp = false
            else if (stamp) n.classList.add('selected')
          }
        }
      }
    }
    const text = textOf(node)
    if (text?.classList.contains('editing')) text.classList.remove('editing')
    node.classList.add('selected')
    this.dragModeExit()
    if (this.root.querySelector('.concord-node.dirty')) this.o.op.markChanged()
  }

  selectionMode(multiple = false): void {
    if (!multiple) {
      this.root
        .querySelectorAll('.selected')
        .forEach((el) => el.classList.remove('selected'))
    }
    this.root
      .querySelectorAll('.selection-toolbar')
      .forEach((el) => el.remove())
  }

  private prevAll(node: Element): HTMLLIElement[] {
    const out: HTMLLIElement[] = []
    let s = node.previousElementSibling
    while (s) {
      if (s.classList.contains('concord-node')) out.push(s as HTMLLIElement)
      s = s.previousElementSibling
    }
    return out // nearest-first, like jQuery prevAll()
  }

  private nextAll(node: Element): HTMLLIElement[] {
    const out: HTMLLIElement[] = []
    let s = node.nextElementSibling
    while (s) {
      if (s.classList.contains('concord-node')) out.push(s as HTMLLIElement)
      s = s.nextElementSibling
    }
    return out
  }

  // --- build (OPML -> DOM) ---------------------------------------------------

  build(
    outline: Element,
    collapsed?: boolean,
    level = 1,
    flInsertRawHtml?: boolean,
  ): HTMLLIElement {
    const node = document.createElement('li')
    node.className = 'concord-node concord-level-' + level

    const attributes: Record<string, string> = {}
    for (const attr of Array.from(outline.attributes)) {
      if (attr.name !== 'text') {
        attributes[attr.name] = attr.value
        if (attr.name === 'type') node.setAttribute('opml-type', attr.value)
      }
    }
    setNodeAttributes(node, attributes)

    const wrapper = document.createElement('div')
    wrapper.className = 'concord-wrapper type-icon'

    const nodeIcon = attributes['icon'] || attributes['type']
    let iconName = 'caret-right'
    const prefs = this.o.prefs()
    if (nodeIcon) {
      if (
        nodeIcon === node.getAttribute('opml-type') &&
        prefs.typeIcons &&
        prefs.typeIcons[nodeIcon]
      ) {
        iconName = prefs.typeIcons[nodeIcon]
      } else if (nodeIcon === attributes['icon']) {
        iconName = nodeIcon
      }
    }
    wrapper.insertAdjacentHTML('afterbegin', iconHtml(iconName))

    if (attributes['isComment'] === 'true') node.classList.add('concord-comment')

    const text = document.createElement('div')
    text.className = 'concord-text concord-level-' + level + '-text'
    text.setAttribute('contenteditable', 'true')
    const rawText = outline.getAttribute('text') ?? ''
    text.innerHTML = flInsertRawHtml ? rawText : this.escape(rawText)

    if (attributes['cssTextClass'] !== undefined) {
      for (const cls of attributes['cssTextClass'].split(/\s+/)) {
        if (cls) text.classList.add(cls)
      }
    }

    const children = document.createElement('ol')
    const childOutlines = Array.from(outline.children).filter(
      (c) => c.tagName.toLowerCase() === 'outline',
    )
    for (const child of childOutlines) {
      children.appendChild(this.build(child, collapsed, level + 1, flInsertRawHtml))
    }
    if (collapsed && childOutlines.length > 0) node.classList.add('collapsed')

    wrapper.appendChild(text)
    node.appendChild(wrapper)
    node.appendChild(children)
    return node
  }

  // --- context menu ---------------------------------------------------------

  hideContextMenu(): void {
    const dd = this.o.state.dropdown
    if (dd) {
      dd.remove()
      this.o.state.dropdown = null
    }
  }

  showContextMenu(x: number, y: number): void {
    const prefs = this.o.prefs()
    if (!prefs.contextMenu) return
    this.hideContextMenu()
    const template = prefs.contextMenu as HTMLElement | string
    const source =
      typeof template === 'string'
        ? (document.querySelector(template) as HTMLElement | null)
        : template
    if (!source) return
    const dd = source.cloneNode(true) as HTMLElement
    this.o.container.appendChild(dd)
    dd.addEventListener('click', (e) => {
      if ((e.target as Element).closest('a')) this.hideContextMenu()
    })
    Object.assign(dd.style, {
      position: 'absolute',
      top: y + 'px',
      left: x + 'px',
      cursor: 'default',
      display: '',
    })
    this.o.state.dropdown = dd
  }

  // --- escaping -------------------------------------------------------------

  escape(s: string): string {
    let h = textToHtml(s).replace(/ /g, ' ')
    if (this.o.op.getRenderMode()) {
      for (const tag of ALLOWED_RENDER_TAGS) {
        if (tag === 'img') {
          h = h.replace(
            new RegExp('&lt;' + tag + '((?!&gt;).+)(/)?&gt;', 'gi'),
            '<' + tag + '$1/>',
          )
        } else if (tag === 'a') {
          h = h.replace(
            new RegExp(
              '&lt;' +
                tag +
                '((?!&gt;).*?)&gt;((?!&lt;/' +
                tag +
                '&gt;).+?)&lt;/' +
                tag +
                '&gt;',
              'gi',
            ),
            '<' + tag + '$1>$2</' + tag + '>',
          )
        } else {
          h = h.replace(
            new RegExp(
              '&lt;' + tag + '&gt;((?!&lt;/' + tag + '&gt;).+?)&lt;/' + tag + '&gt;',
              'gi',
            ),
            '<' + tag + '>$1</' + tag + '>',
          )
        }
      }
    }
    return h
  }

  unescape(s: string): string {
    const h = s.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return htmlToText(h)
  }

  // --- selection persistence ------------------------------------------------

  getSelection(): Range | null {
    return getConcordRange()
  }

  saveSelection(): Range | null {
    const range = this.getSelection()
    if (range) {
      this.o.state.nodeRanges.set(this.o.op.getCursor()!, range.cloneRange())
    }
    return range
  }

  restoreSelection(range?: Range): Range | undefined {
    const cursor = this.o.op.getCursor()
    if (!cursor) return undefined
    const r = range ?? this.o.state.nodeRanges.get(cursor)
    if (r) {
      try {
        applyRange(r.cloneRange())
      } catch (e) {
        console.log(e)
      } finally {
        this.o.state.nodeRanges.delete(cursor)
      }
    }
    return r
  }

  recalculateLevels(context?: HTMLLIElement[]): void {
    const nodes =
      context ??
      (Array.from(
        this.root.querySelectorAll('.concord-node'),
      ) as HTMLLIElement[])
    for (const node of nodes) {
      const text = textOf(node)
      const m = node.className.match(/concord-level-(\d+)/)
      if (m) {
        node.classList.remove('concord-level-' + m[1])
        text?.classList.remove('concord-level-' + m[1] + '-text')
      }
      const level = nodeParents(node).length + 1
      node.classList.add('concord-level-' + level)
      text?.classList.add('concord-level-' + level + '-text')
    }
  }

  // --- paste sanitizing -----------------------------------------------------

  sanitize = (): void => {
    const pasteBin = this.o.pasteBin
    this.root.querySelectorAll('.concord-text.paste').forEach((el) => {
      const concordText = el as HTMLElement
      if (pasteBin.textContent === '...') return
      let h = pasteBin.innerHTML
      h = h.replace(
        new RegExp('<(div|p|blockquote|pre|li|br|dd|dt|code|h\\d)[^>]*(/)?>', 'gi'),
        '\n',
      )
      h = htmlToText(h)

      let clipboardMatch = false
      const clip = sharedClipboard.get()
      if (clip) {
        const trimmedClip = clip.text.replace(/^[\s\r\n]+|[\s\r\n]+$/g, '')
        const trimmedPaste = h.replace(/^[\s\r\n]+|[\s\r\n]+$/g, '')
        if (trimmedClip === trimmedPaste && clip.data) {
          const nodes = clip.data.map((n) => {
            const clone = n.cloneNode(true) as HTMLLIElement
            clone.querySelectorAll('ol').forEach((ol) => {
              if (ol.children.length > 0)
                ol.parentElement?.classList.add('collapsed')
            })
            return clone
          })
          this.o.state.clipboard = nodes
          this.o.op.setTextMode(false)
          this.o.op.paste()
          clipboardMatch = true
        }
      }

      if (!clipboardMatch) {
        sharedClipboard.clear()
        let numberOfLines = 0
        for (const line of h.split('\n')) {
          if (line !== '' && !line.match(/^\s+$/)) numberOfLines++
        }
        if (!this.o.op.inTextMode() || numberOfLines > 1) {
          this.o.op.insertText(h)
        } else {
          this.o.op.saveState()
          concordText.focus()
          const node = concordText.closest('.concord-node') as HTMLLIElement
          const range = this.o.state.nodeRanges.get(node)
          if (range) {
            try {
              applyRange(range)
            } catch (e) {
              console.log(e)
            } finally {
              this.o.state.nodeRanges.delete(node)
            }
          }
          document.execCommand('insertText', false, h)
          this.o.state.clipboard = null
          this.o.op.markChanged()
        }
      }
      concordText.classList.remove('paste')
    })
  }

  /** Swap a node's icon in place (used by attribute changes). */
  setNodeIcon(node: HTMLLIElement, iconName: string): void {
    const icon = iconOf(node)
    if (icon) setIcon(icon, iconName)
  }

  // small re-exports used by other modules
  wrapperOf = wrapperOf
  textOf = textOf
  directChild = directChild
  closestNode = closestNode
  childOl = childOl
}
