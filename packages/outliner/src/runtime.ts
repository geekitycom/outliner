// The one thing that is document-level rather than per-instance and is not
// about the caret: the map from a root element back to its Outliner.
//
// In the original this lived on the `concord` singleton, alongside a
// hand-rolled focus state machine and the no-arg `stopListening()` /
// `resumeListening()` / `getFocusRoot()` / `setFocusRoot()` API. All of that is
// gone: caret.ts owns the caret (docs/adr/0001) and hands out a disposable
// rather than toggling a global (docs/adr/0002). What is left is the registry,
// which is the only reason this file still exists -- caret.ts deliberately
// knows nothing about `Outliner`, so the lookup cannot live there without
// making the caret module depend on the class it exists to serve.
import type { Outliner } from './outliner'
import { unregisterOutline } from './caret'

const registry = new WeakMap<Element, Outliner>()

export function register(root: HTMLElement, outliner: Outliner): void {
  registry.set(root, outliner)
}

export function unregister(root: HTMLElement): void {
  registry.delete(root)
  // The instance registers itself with caret.ts as well (see
  // `Outliner.caretOwner()`); a root that is no longer an outliner must stop
  // being a possible caret owner too, or a detached root keeps answering
  // ownership questions forever.
  unregisterOutline(root)
}

export function outlinerForRoot(root: Element | null): Outliner | undefined {
  return root ? registry.get(root) : undefined
}
