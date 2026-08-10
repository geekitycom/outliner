// Per-node OPML attribute management. Ported from ConcordOpAttributes.
// Bound to a getter so both the live cursor and a NodeRef can share it.
import type { Outliner } from './outliner'
import type { NodeAttributesApi, OpmlAttributes } from './types'
import { getNodeAttributes, setNodeAttributes, textOf } from './dom'

const CSS_TEXT_CLASS = 'cssTextClass'

export class NodeAttributes implements NodeAttributesApi {
  constructor(
    private o: Outliner,
    private getEl: () => HTMLLIElement | null,
  ) {}

  private el(): HTMLLIElement {
    const el = this.getEl()
    if (!el) throw new Error('outliner: no node for attribute operation')
    return el
  }

  /** Reconcile the text element's non-concord CSS classes with a value. */
  private applyCssTextClass(newValue: string | undefined): void {
    if (newValue === undefined) return
    const text = textOf(this.el())
    if (!text) return
    for (const cls of Array.from(text.classList)) {
      if (!/^concord-/.test(cls)) text.classList.remove(cls)
    }
    for (const cls of newValue.split(/\s+/)) {
      if (cls) text.classList.add(cls)
    }
  }

  /** Update the node icon when type/icon changes, honoring prefs.typeIcons. */
  private updateIcon(name: string, value: string): void {
    const prefs = this.o.prefs()
    let iconName: string | null = null
    if (name === 'type' && prefs.typeIcons && prefs.typeIcons[value]) {
      iconName = prefs.typeIcons[value]
    } else if (name === 'icon') {
      iconName = value
    }
    if (iconName) this.o.editor.setNodeIcon(this.el(), iconName)
  }

  getAll(): OpmlAttributes {
    return getNodeAttributes(this.el())
  }

  getOne(name: string): string | undefined {
    return this.getAll()[name]
  }

  exists(name: string): boolean {
    return this.getOne(name) !== undefined
  }

  setOne(name: string, value: string): boolean {
    if (name === CSS_TEXT_CLASS) this.applyCssTextClass(value)
    const atts = this.getAll()
    atts[name] = value
    setNodeAttributes(this.el(), atts)
    if (name === 'type' || name === 'icon') {
      this.el().setAttribute('opml-' + name, value)
      this.updateIcon(name, value)
    }
    this.o.op.markChanged()
    return true
  }

  addGroup(attributes: OpmlAttributes): OpmlAttributes {
    const el = this.el()
    if (attributes['type']) el.setAttribute('opml-type', attributes['type'])
    else el.removeAttribute('opml-type')
    this.applyCssTextClass(attributes[CSS_TEXT_CLASS])
    const finalAttributes = this.getAll()
    const iconAttribute = attributes['icon'] ? 'icon' : 'type'
    for (const name of Object.keys(attributes)) {
      finalAttributes[name] = attributes[name]
      if (name === iconAttribute) this.updateIcon(name, attributes[name])
    }
    setNodeAttributes(el, finalAttributes)
    this.o.op.markChanged()
    return finalAttributes
  }

  setGroup(attributes: OpmlAttributes): OpmlAttributes {
    const el = this.el()
    this.applyCssTextClass(
      attributes[CSS_TEXT_CLASS] !== undefined ? attributes[CSS_TEXT_CLASS] : '',
    )
    setNodeAttributes(el, attributes)
    // Drop any opml-* DOM attributes no longer present.
    for (const attr of Array.from(el.attributes)) {
      const m = attr.name.match(/^opml-(.+)$/)
      if (m && !attributes[m[1]]) el.removeAttribute(attr.name)
    }
    const iconAttribute = attributes['icon'] ? 'icon' : 'type'
    if (attributes['type']) el.setAttribute('opml-type', attributes['type'])
    for (const name of Object.keys(attributes)) {
      if (name === iconAttribute) this.updateIcon(name, attributes[name])
    }
    this.o.op.markChanged()
    return attributes
  }

  removeOne(name: string): boolean {
    const atts = this.getAll()
    if (atts[name]) {
      if (name === CSS_TEXT_CLASS) this.applyCssTextClass('')
      delete atts[name]
      setNodeAttributes(this.el(), atts)
      if (name === 'type' || name === 'icon')
        this.el().removeAttribute('opml-' + name)
      this.o.op.markChanged()
      return true
    }
    return false
  }

  makeEmpty(): boolean {
    const el = this.el()
    this.applyCssTextClass('')
    const had = Object.keys(this.getAll()).length > 0
    setNodeAttributes(el, {})
    for (const attr of Array.from(el.attributes)) {
      if (/^opml-(.+)$/.test(attr.name)) el.removeAttribute(attr.name)
    }
    if (had) this.o.op.markChanged()
    return had
  }
}
