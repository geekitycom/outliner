// Global keydown command dispatch. Ported from the document keydown handler in
// the original concord.js IIFE.
import { getKeystroke, beep, stringMid, stringDelete } from './util'
import { UP, DOWN, LEFT, RIGHT, IS_MOBILE } from './constants'
import { outlinerForRoot } from './runtime'
import { owner } from './caret'
import { iconHtml } from './icons'
import { textOf } from './dom'
import type { KeystrokeEvent } from './types'

function caretPosition(node: Element): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return 0
  const range = sel.getRangeAt(0)
  const pre = range.cloneRange()
  pre.selectNodeContents(node)
  pre.setEnd(range.endContainer, range.endOffset)
  const tmp = document.createElement('div')
  tmp.appendChild(pre.cloneContents())
  return tmp.innerHTML.length
}

export function handleKeydown(event: KeyboardEvent): void {
  // The whole gate, in one question: keystrokes are outline commands only while
  // an outline owns the caret. There is no separate "are events enabled" flag
  // any more -- a field that suspends the outline does it by taking the caret,
  // so the suspension and the ownership are the same fact, and this can no
  // longer dispatch to an outline that has been suspended but still looks
  // focused (or refuse to dispatch to one that is focused but whose suspension
  // somebody else released -- the bug docs/adr/0002 exists for).
  //
  // No `input`/`textarea` check here either. That was the same rule as the
  // title row's three other guards, discovered a third way -- and discovering
  // it by tag name is exactly why the title row was missed, since a
  // contenteditable div is neither. Ownership covers inputs, textareas,
  // dialogs, the title row and anything an app puts on the page, without
  // naming any of them.
  const current = owner()
  if (current.kind !== 'outline') return
  const o = outlinerForRoot(current.root)
  if (!o) return
  const op = o.op

  let readonly = o.prefs().readonly === true
  const which = event.which || event.keyCode
  if (readonly) {
    if (which >= 37 && which <= 40) readonly = false
    else if ((event.metaKey || event.ctrlKey) && which === 188) readonly = false
  }
  if (readonly) return

  const keystrokeString = getKeystroke(event)
  const kev: KeystrokeEvent = { keystroke: keystrokeString, captured: false, domEvent: event }
  o.fireKeystroke(kev)
  let keyCaptured = kev.captured
  const commandKey = event.metaKey || event.ctrlKey

  switch (keystrokeString) {
    case 'backspace':
      if (IS_MOBILE) {
        const lt = op.getLineText()
        if (lt === '' || lt === '<br>') {
          event.preventDefault()
          op.deleteLine()
        }
      } else if (op.inTextMode()) {
        const cursor = op.getCursor()
        if (cursor && !cursor.classList.contains('dirty')) {
          op.saveState()
          cursor.classList.add('dirty')
        }
      } else {
        keyCaptured = true
        event.preventDefault()
        op.deleteLine()
      }
      break

    case 'meta-backspace': {
      const cmdBackspace = (): boolean => {
        const rightString = op.getLineText() ?? ''
        if (op.countSubs() > 0) return false
        if (!op.go(UP, 1)) return false
        if (op.countSubs() > 0) {
          op.go(DOWN, 1)
          return false
        }
        op.setLineText((op.getLineText() ?? '') + rightString)
        op.go(DOWN, 1)
        op.deleteLine()
        return true
      }
      if (!cmdBackspace()) beep()
      break
    }

    case 'tab':
      keyCaptured = true
      event.preventDefault()
      event.stopPropagation()
      op.reorg(event.shiftKey ? LEFT : RIGHT)
      break

    case 'select-all': {
      keyCaptured = true
      event.preventDefault()
      const cursor = op.getCursor()
      if (op.inTextMode()) {
        op.focusCursor()
        document.execCommand('selectAll', false)
      } else if (cursor) {
        o.editor.selectionMode()
        const parentOl = cursor.parentElement
        parentOl?.querySelectorAll(':scope > .concord-node').forEach((el) => el.classList.add('selected'))
      }
      break
    }

    case 'reorg-up':
      keyCaptured = true
      event.preventDefault()
      op.reorg(UP)
      break
    case 'reorg-down':
      keyCaptured = true
      event.preventDefault()
      op.reorg(DOWN)
      break
    case 'reorg-left':
      keyCaptured = true
      event.preventDefault()
      op.reorg(LEFT)
      break
    case 'reorg-right':
      keyCaptured = true
      event.preventDefault()
      op.reorg(RIGHT)
      break

    case 'promote':
      keyCaptured = true
      event.preventDefault()
      op.promote()
      break
    case 'demote':
      keyCaptured = true
      event.preventDefault()
      op.demote()
      break

    case 'return':
      if (IS_MOBILE) {
        event.preventDefault()
        keyCaptured = true
        const cursor = op.getCursor()
        if (cursor) {
          const cloned = cursor.cloneNode(true) as HTMLLIElement
          cloned.classList.remove('concord-cursor', 'selected', 'dirty', 'collapsed')
          op.setLineText('')
          const icon = cursor.querySelector('.node-icon')
          if (icon) icon.outerHTML = iconHtml('caret-right')
          cursor.insertAdjacentElement('beforebegin', cloned)
          op.attributes.makeEmpty()
          op.deleteSubs()
          op.focusCursor()
          o.fireCallback('opInsert', op.setCursorContext(cursor))
        }
      } else {
        event.preventDefault()
        keyCaptured = true
        if (event.location && event.location !== 0) {
          op.setTextMode(!op.inTextMode())
        } else {
          const direction = op.subsExpanded() ? RIGHT : DOWN
          op.insert('', direction)
          op.setTextMode(true)
          op.focusCursor()
        }
      }
      break

    case 'meta-return':
      if (op.inTextMode()) {
        if (op.countSubs() === 0) {
          const cursor = op.getCursor()
          const text = cursor ? textOf(cursor) : null
          if (text) {
            const ixcaret = caretPosition(text)
            const linetext = op.getLineText() ?? ''
            const leftString = stringMid(linetext, 1, ixcaret)
            const rightString = stringDelete(linetext, 1, ixcaret)
            op.setLineText(leftString)
            op.insert(rightString, DOWN)
          }
        } else {
          console.log("Can't split this headline because it has subs.")
          beep()
        }
      } else {
        console.log("Can't split this headline because you're not in text mode.")
        beep()
      }
      break

    case 'cursor-left': {
      let active = false
      const cursor = op.getCursor()
      if (cursor?.classList.contains('selected')) active = true
      if (active && cursor) {
        keyCaptured = true
        event.preventDefault()
        const prev = op._walk_up(cursor)
        if (prev) op.setCursor(prev)
      }
      break
    }

    case 'cursor-up': {
      keyCaptured = true
      event.preventDefault()
      const cursor = op.getCursor()
      if (op.inTextMode() && cursor) {
        const prev = op._walk_up(cursor)
        if (prev) op.setCursor(prev)
      } else {
        op.go(UP, 1, event.shiftKey, op.inTextMode())
      }
      break
    }

    case 'cursor-right': {
      const cursor = op.getCursor()
      if (cursor?.classList.contains('selected')) {
        keyCaptured = true
        event.preventDefault()
        let next: HTMLLIElement | null = null
        if (!cursor.classList.contains('collapsed')) {
          next = (cursor.querySelector(':scope > ol > .concord-node') as HTMLLIElement) ?? null
        }
        if (!next) next = op._walk_down(cursor)
        if (next) op.setCursor(next)
      }
      break
    }

    case 'cursor-down': {
      keyCaptured = true
      event.preventDefault()
      const cursor = op.getCursor()
      if (op.inTextMode() && cursor) {
        let next: HTMLLIElement | null = null
        if (!cursor.classList.contains('collapsed')) {
          next = (cursor.querySelector(':scope > ol > .concord-node') as HTMLLIElement) ?? null
        }
        if (!next) next = op._walk_down(cursor)
        if (next) op.setCursor(next)
      } else {
        op.go(DOWN, 1, event.shiftKey, op.inTextMode())
      }
      break
    }

    case 'delete':
      if (op.inTextMode()) {
        const cursor = op.getCursor()
        if (cursor && !cursor.classList.contains('dirty')) {
          op.saveState()
          cursor.classList.add('dirty')
        }
      } else {
        keyCaptured = true
        event.preventDefault()
        op.deleteLine()
      }
      break

    case 'undo':
      keyCaptured = true
      event.preventDefault()
      op.undo()
      break

    case 'cut':
      if (op.inTextMode()) {
        if (op.getLineText() === '') {
          keyCaptured = true
          event.preventDefault()
          op.deleteLine()
        } else {
          op.saveState()
        }
      }
      break

    case 'copy':
    case 'paste':
    case 'find':
      break

    case 'toggle-comment':
      if (o.script.isComment()) o.script.unComment()
      else o.script.makeComment()
      break

    case 'italicize':
      keyCaptured = true
      event.preventDefault()
      op.italic()
      break

    case 'bolden':
      keyCaptured = true
      event.preventDefault()
      op.bold()
      break

    case 'toggle-render':
      keyCaptured = true
      event.preventDefault()
      op.setRenderMode(!op.getRenderMode())
      break

    case 'toggle-expand':
      keyCaptured = true
      event.preventDefault()
      if (op.subsExpanded()) op.collapse()
      else op.expand()
      break

    case 'run-selection':
      if (!keyCaptured) {
        keyCaptured = true
        event.preventDefault()
        op.runSelection()
      }
      break

    default:
      keyCaptured = false
  }

  if (!keyCaptured) {
    if (which >= 32 && (which < 112 || which > 123) && which < 1000 && !commandKey) {
      const node = op.getCursor()
      if (!node) return
      if (op.inTextMode()) {
        if (!node.classList.contains('dirty')) op.saveState()
        node.classList.add('dirty')
      } else {
        op.setTextMode(true)
        op.saveState()
        o.editor.edit(node, true)
        node.classList.add('dirty')
      }
      op.markChanged()
    }
  }
}
