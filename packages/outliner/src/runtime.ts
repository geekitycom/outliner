// Global, document-level runtime state. In the original this lived on the
// `concord` singleton: which root has focus, whether events are being handled,
// and the map from a root element back to its instance.
import type { Outliner } from './outliner'

const registry = new WeakMap<Element, Outliner>()
const roots = new Set<HTMLElement>()

export function register(root: HTMLElement, outliner: Outliner): void {
  registry.set(root, outliner)
  roots.add(root)
}

export function unregister(root: HTMLElement): void {
  registry.delete(root)
  roots.delete(root)
}

export function outlinerForRoot(root: Element | null): Outliner | undefined {
  return root ? registry.get(root) : undefined
}

function isVisible(el: HTMLElement): boolean {
  return el.isConnected && el.offsetParent !== null
}

function visibleRoots(): HTMLElement[] {
  return Array.from(roots).filter(isVisible)
}

let focusRoot: HTMLElement | null = null
let handleEvents = true
const resumeCallbacks: Array<() => void> = []

export function eventsEnabled(): boolean {
  return handleEvents
}

export function getFocusRoot(): HTMLElement | null {
  const vis = visibleRoots()
  if (vis.length === 1) return setFocusRoot(vis[0])
  if (focusRoot === null) {
    return vis.length > 0 ? setFocusRoot(vis[0]) : null
  }
  if (!isVisible(focusRoot)) {
    return vis.length > 0 ? setFocusRoot(vis[0]) : null
  }
  return focusRoot
}

export function setFocusRoot(root: HTMLElement): HTMLElement {
  const prev = focusRoot
  const next = outlinerForRoot(root)
  if (prev !== null && prev !== root) {
    const prevOutliner = outlinerForRoot(prev)
    if (prevOutliner) {
      prevOutliner.editor.hideContextMenu()
      prevOutliner.editor.dragModeExit()
    }
  }
  if (next) {
    if (next.op.inTextMode()) next.op.focusCursor()
    else next.pasteBinFocus()
  }
  focusRoot = root
  return focusRoot
}

export function updateFocusRootFromEvent(event: Event): void {
  const target = event.target as Element | null
  const root = target?.closest('.concord-root') as HTMLElement | null
  if (root) setFocusRoot(root)
}

export function onResume(cb: () => void): void {
  resumeCallbacks.push(cb)
}

export function stopListening(): void {
  if (!handleEvents) return
  handleEvents = false
  const root = getFocusRoot()
  const o = outlinerForRoot(root)
  if (o && o.op.inTextMode()) o.editor.saveSelection()
}

export function resumeListening(): void {
  if (handleEvents) return
  handleEvents = true
  const root = getFocusRoot()
  const o = outlinerForRoot(root)
  // No title-row guard needed here: both focusCursor() and pasteBinFocus()
  // refuse to steal focus from it themselves (see op.ts / outliner.ts), which
  // covers every caller rather than this one.
  if (o) {
    if (o.op.inTextMode()) {
      o.op.focusCursor()
      o.editor.restoreSelection()
    } else {
      o.pasteBinFocus()
    }
  }
  const pending = resumeCallbacks.splice(0)
  for (const cb of pending) cb()
}
