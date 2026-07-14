// Mouse / paste / copy / cut wiring. Ported from ConcordEvents, using native
// event delegation on the root element instead of jQuery's `.on(sel, fn)`.
import type { Outliner } from './outliner'
import { IS_MOBILE } from './constants'
import { eventsEnabled } from './runtime'
import { sharedClipboard } from './clipboard'
import { closestNode, textOf } from './dom'

function wrapperFromTarget(target: Element): Element | null {
  let w: Element | null = target
  if (w.classList.contains('node-icon')) w = w.parentElement
  return w
}

export function bindEvents(o: Outliner): void {
  const root = o.root
  const op = o.op
  const editor = o.editor
  const readonly = () => o.prefs().readonly === true

  const toggleExpand = () => {
    if (op.subsExpanded()) op.collapse()
    else op.expand()
  }

  // --- double click ---------------------------------------------------------
  root.addEventListener('dblclick', (e) => {
    if (!eventsEnabled()) return
    if (o.state.dropdown) {
      editor.hideContextMenu()
      return
    }
    const target = e.target as Element

    // readonly text: double-click folds
    if (target.closest('.concord-text') && readonly()) {
      e.preventDefault()
      e.stopPropagation()
      const node = closestNode(target)
      if (node) {
        op.setCursor(node)
        toggleExpand()
      }
      return
    }
    if (editor.editable(target)) return

    const w = wrapperFromTarget(target)
    if (w?.classList.contains('concord-wrapper')) {
      e.stopPropagation()
      op.setTextMode(false)
      toggleExpand()
      return
    }
    if (
      target.classList.contains('concord-node') &&
      target.classList.contains('concord-cursor')
    ) {
      e.stopPropagation()
      op.setTextMode(false)
      op.setCursor(target as HTMLLIElement)
      toggleExpand()
    }
  })

  // --- single click ---------------------------------------------------------
  root.addEventListener('click', (e) => {
    if (!eventsEnabled()) return
    if (o.state.dropdown) {
      e.stopPropagation()
      editor.hideContextMenu()
      return
    }
    const target = e.target as Element

    if (IS_MOBILE) {
      const node = closestNode(target)
      if (node && op.getCursor() === node) {
        // treat as a fold toggle on mobile
        op.setTextMode(false)
        toggleExpand()
        return
      }
    }
    if (e.button !== 0 || editor.editable(target)) return

    const w = wrapperFromTarget(target)
    if (w?.classList.contains('concord-wrapper')) {
      const node = closestNode(w)
      if (!node) return
      if (e.shiftKey && nodeHasSelectedAncestor(node)) return
      op.setTextMode(false)
      op.setCursor(node, e.shiftKey || e.metaKey, e.shiftKey)
      return
    }
    if (target.classList.contains('concord-node')) {
      const node = target as HTMLLIElement
      e.stopPropagation()
      if (e.shiftKey && nodeHasSelectedAncestor(node)) return
      op.setTextMode(false)
      op.setCursor(node, e.shiftKey || e.metaKey, e.shiftKey)
    }
  })

  function nodeHasSelectedAncestor(node: Element): boolean {
    let p = node.parentElement
    while (p) {
      if (p.classList.contains('concord-node') && p.classList.contains('selected'))
        return true
      p = p.parentElement
    }
    return false
  }

  // --- hover ----------------------------------------------------------------
  root.addEventListener('mouseover', (e) => {
    if (!eventsEnabled()) return
    const target = e.target as Element
    const wrapper = target.closest('.concord-wrapper')
    if (wrapper) {
      const node = closestNode(wrapper)
      if (node) o.fireCallback('opHover', op.setCursorContext(node))
    }
    // drag drop indicators
    if (o.state.dragging && !readonly()) {
      e.preventDefault()
      dragOver(target)
    }
  })

  root.addEventListener('mouseout', () => {
    if (!eventsEnabled() || readonly()) return
    if (o.state.dragging) {
      root
        .querySelectorAll('.drop-sibling, .drop-child')
        .forEach((el) => el.classList.remove('drop-sibling', 'drop-child'))
    }
  })

  // --- context menu ---------------------------------------------------------
  const onContextMenu = (e: MouseEvent) => {
    if (!eventsEnabled()) return
    if (!o.prefs().contextMenu) return
    e.preventDefault()
    e.stopPropagation()
    const target = e.target as Element
    if (target.classList.contains('concord-wrapper') || target.classList.contains('node-icon')) {
      op.setTextMode(false)
    }
    const node = closestNode(target)
    if (node) {
      o.fireCallback('opContextMenu', op.setCursorContext(node))
      op.setCursor(node)
      editor.showContextMenu(e.pageX, e.pageY)
    }
  }
  root.addEventListener('contextmenu', onContextMenu)

  // --- blur / focusout ------------------------------------------------------
  root.addEventListener('focusout', (e) => {
    if (!eventsEnabled()) return
    const target = e.target as Element
    if (!target.classList.contains('concord-text')) return
    if (readonly()) return
    if ((target as HTMLElement).innerHTML.match(/^\s*<br>\s*$/)) {
      ;(target as HTMLElement).innerHTML = ''
    }
    const node = closestNode(target)
    if (op.inTextMode()) editor.saveSelection()
    if (op.inTextMode() && node?.classList.contains('dirty')) {
      node.classList.remove('dirty')
    }
  })

  // --- paste into a headline ------------------------------------------------
  root.addEventListener('paste', (e) => {
    if (!eventsEnabled()) return
    const target = e.target as Element
    if (!target.closest('.concord-text')) return
    if (readonly()) return
    target.closest('.concord-text')!.classList.add('paste')
    editor.saveSelection()
    o.pasteBin.innerHTML = ''
    o.pasteBin.focus()
    setTimeout(editor.sanitize, 10)
  })

  // --- pasteBin clipboard ---------------------------------------------------
  o.pasteBin.addEventListener('copy', () => {
    if (!eventsEnabled()) return
    let copyText = ''
    const selected = Array.from(root.querySelectorAll('.selected')) as HTMLLIElement[]
    for (const n of selected) copyText += editor.textLine(n)
    if (copyText !== '' && copyText !== '\n') {
      sharedClipboard.set({
        text: copyText,
        data: selected.map((n) => n.cloneNode(true) as HTMLLIElement),
      })
      const pre = document.createElement('pre')
      pre.textContent = copyText
      o.pasteBin.replaceChildren(pre)
      o.pasteBin.focus()
      document.execCommand('selectAll')
    }
  })

  o.pasteBin.addEventListener('paste', () => {
    if (!eventsEnabled() || readonly()) return
    const cursor = op.getCursor()
    if (cursor) textOf(cursor)?.classList.add('paste')
    o.pasteBin.innerHTML = ''
    setTimeout(editor.sanitize, 10)
  })

  o.pasteBin.addEventListener('cut', () => {
    if (!eventsEnabled() || readonly()) return
    let copyText = ''
    const selected = Array.from(root.querySelectorAll('.selected')) as HTMLLIElement[]
    for (const n of selected) copyText += editor.textLine(n)
    if (copyText !== '' && copyText !== '\n') {
      sharedClipboard.set({
        text: copyText,
        data: selected.map((n) => n.cloneNode(true) as HTMLLIElement),
      })
      const pre = document.createElement('pre')
      pre.textContent = copyText
      o.pasteBin.replaceChildren(pre)
      o.pasteBinFocus()
    }
    op.deleteLine()
    setTimeout(() => o.pasteBinFocus(), 200)
  })

  // --- drag (mousedown / mousemove / mouseup) -------------------------------
  root.addEventListener('mousedown', (e) => {
    if (!eventsEnabled()) return
    const target = e.target as Element
    if (target.matches('a')) {
      const href = target.getAttribute('href')
      if (href) {
        e.preventDefault()
        window.open(href)
      }
      return
    }
    if (readonly()) {
      e.preventDefault()
      const textEl = target.closest('.concord-text')
      if (textEl) {
        const node = closestNode(textEl)
        if (node) op.setCursor(node)
      }
      return
    }
    if (e.button === 0) {
      if (o.state.dropdown) {
        editor.hideContextMenu()
        return
      }
      const textEl = target.closest('.concord-text')
      if (textEl) {
        const node = closestNode(textEl)
        if (node) {
          if (!root.classList.contains('textMode')) {
            root.querySelectorAll('.selected').forEach((el) => el.classList.remove('selected'))
            root.classList.add('textMode')
          }
          if (textOf(node)?.classList.contains('editing')) {
            root.querySelectorAll('.editing').forEach((el) => el.classList.remove('editing'))
            textOf(node)?.classList.add('editing')
          }
          if (!node.classList.contains('concord-cursor')) {
            root.querySelectorAll('.concord-cursor').forEach((el) => el.classList.remove('concord-cursor'))
            node.classList.add('concord-cursor')
            o.fireCallback('opCursorMoved', op.setCursorContext(node))
          }
        }
      } else {
        e.preventDefault()
        o.state.mousedown = true
      }
    }
  })

  root.addEventListener('mousemove', (e) => {
    if (!eventsEnabled() || readonly()) return
    const target = e.target as Element
    if (editor.editable(target)) return
    e.preventDefault()
    if (o.state.mousedown && !o.state.dragging) {
      let t: Element | null = target
      if (t.classList.contains('node-icon')) t = t.parentElement
      if (t?.classList.contains('concord-wrapper') && t.parentElement?.classList.contains('selected')) {
        editor.dragMode()
      }
    }
  })

  root.addEventListener('mouseup', (e) => {
    if (!eventsEnabled() || readonly()) return
    const target = e.target as Element
    if (editor.editable(target)) return
    o.state.mousedown = false
    if (!o.state.dragging) return

    const node = closestNode(target)
    const draggable = Array.from(root.querySelectorAll('.selected')) as HTMLLIElement[]
    if (node && draggable.length >= 1) {
      const isTargetItself = draggable.includes(node)
      if (!isTargetItself) {
        const draggableIsTargetParent = draggable.some((d) => node.closest('.concord-node') && isAncestor(d, node))
        if (!draggableIsTargetParent) {
          const t = wrapperFromTarget(target)
          if (t?.classList.contains('concord-wrapper')) {
            draggable.forEach((d) => node.insertAdjacentElement('afterend', d))
          } else {
            const ol = node.querySelector(':scope > ol') ?? (() => {
              const n = document.createElement('ol')
              node.appendChild(n)
              return n
            })()
            for (const d of draggable) ol.prepend(d)
            node.classList.remove('collapsed')
          }
        }
      } else {
        const prev = node.previousElementSibling as HTMLElement | null
        if (prev?.classList.contains('drop-child')) {
          const ol = prev.querySelector(':scope > ol')
          if (ol) {
            for (const d of draggable) ol.appendChild(d)
            prev.classList.remove('collapsed')
          }
        }
      }
    }
    editor.dragModeExit()
    editor.recalculateLevels()
  })

  function isAncestor(possibleParent: Element, node: Element): boolean {
    let p = node.parentElement
    while (p) {
      if (p === possibleParent) return true
      p = p.parentElement
    }
    return false
  }

  function dragOver(target: Element): void {
    const node = closestNode(target)
    const draggable = Array.from(root.querySelectorAll('.selected')) as HTMLLIElement[]
    if (!node || draggable.length < 1) return
    const isTargetItself = draggable.includes(node)
    if (!isTargetItself) {
      const draggableIsTargetParent = draggable.some((d) => isAncestor(d, node))
      if (!draggableIsTargetParent) {
        node.classList.remove('drop-sibling', 'drop-child')
        const t = wrapperFromTarget(target)
        if (t?.classList.contains('concord-wrapper')) node.classList.add('drop-sibling')
        else node.classList.add('drop-child')
      }
    } else if (draggable.length === 1) {
      const prev = node.previousElementSibling as HTMLElement | null
      if (prev) {
        prev.classList.remove('drop-sibling')
        prev.classList.add('drop-child')
      }
    }
  }
}
