// Owns the current file path and dirty state, and the four file operations
// the menu (a later commit) will hang off: New, Open, Save, Save As.
import type { Outliner } from '@andrewshell/outliner'
import { EMPTY_OPML } from '@andrewshell/outliner'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open, save, message } from '@tauri-apps/plugin-dialog'
import { confirmDiscard } from './modal'

const OPML_FILTERS = [{ name: 'OPML', extensions: ['opml', 'xml'] }]

// Assigned once by initDocument(); every other export assumes it has run
// first, same precondition as calling any other method on a torn-down
// Outliner instance.
let outliner: Outliner
let currentPath: string | null = null

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

/** Parses OPML/XML, surfacing malformed markup instead of loading garbage. */
function parseOpml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('not valid XML')
  }
  return doc
}

async function reportError(action: string, path: string, err: unknown): Promise<void> {
  await message(`Could not ${action} "${basename(path)}": ${String(err)}`, {
    title: 'Outliner',
    kind: 'error',
  })
}

function syncTitle(): void {
  const base = currentPath ? basename(currentPath) : 'Untitled — Outliner'
  const title = isDirty() ? `• ${base}` : base
  void getCurrentWindow().setTitle(title)
}

export function isDirty(): boolean {
  return outliner.hasChanged()
}

/**
 * Wires the outliner up to dirty tracking and title sync, then loads a
 * blank document. Call once, right after mounting.
 */
export function initDocument(instance: Outliner): void {
  outliner = instance

  outliner.setCallbacks({
    // Structural ops (promote, reorg, delete, undo, ...) mutate the DOM
    // directly rather than through contenteditable, so they never fire an
    // `input` event below. opKeystroke fires *before* op.ts runs the
    // command it names, so the resync is deferred a tick with
    // queueMicrotask — by the time it runs, the op (and its own
    // markChanged() call, if any) has already happened.
    opKeystroke: () => queueMicrotask(syncTitle),
  })

  // markChanged() is only called by structural operations in op.ts — plain
  // text edits never reach it, so hasChanged() alone misses them. The
  // container's `input` event is the one signal every text edit fires.
  outliner.container.addEventListener('input', () => {
    outliner.markChanged()
    syncTitle()
  })

  currentPath = null
  outliner.loadOpml(EMPTY_OPML)
  outliner.clearChanged()
  syncTitle()
}

/**
 * Runs the unsaved-changes prompt when the document is dirty and reports
 * whether it's safe to proceed — with the Save choice actually saved first,
 * and the whole thing aborted if that save is itself cancelled or fails.
 * Shared by New, Open, and the window's onCloseRequested handler.
 */
export async function confirmClose(): Promise<boolean> {
  if (!isDirty()) return true
  const choice = await confirmDiscard()
  if (choice === 'cancel') return false
  if (choice === 'save') return saveDocument()
  return true // discard
}

export async function newDocument(): Promise<void> {
  if (!(await confirmClose())) return
  currentPath = null
  outliner.loadOpml(EMPTY_OPML)
  outliner.clearChanged()
  syncTitle()
}

export async function openDocument(): Promise<void> {
  if (!(await confirmClose())) return

  const selected = await open({ filters: OPML_FILTERS })
  if (typeof selected !== 'string') return // dialog cancelled

  let contents: string
  try {
    contents = await invoke<string>('read_file', { path: selected })
  } catch (err) {
    await reportError('open', selected, err)
    return
  }

  let doc: Document
  try {
    doc = parseOpml(contents)
  } catch {
    await reportError('open', selected, 'not a valid OPML file')
    return
  }

  outliner.loadOpml(doc)
  outliner.clearChanged()
  currentPath = selected
  syncTitle()
}

export async function saveDocument(): Promise<boolean> {
  if (!currentPath) return saveDocumentAs()

  try {
    await invoke('write_file', { path: currentPath, contents: outliner.toOpml() })
  } catch (err) {
    await reportError('save', currentPath, err)
    return false
  }
  outliner.clearChanged()
  syncTitle()
  return true
}

export async function saveDocumentAs(): Promise<boolean> {
  const selected = await save({ defaultPath: currentPath ?? undefined, filters: OPML_FILTERS })
  if (!selected) return false // dialog cancelled

  // The window title tracks the path, but the OPML <head><title> is part of
  // the saved document itself — keep the two in sync on every Save As.
  outliner.setTitle(basename(selected))

  try {
    await invoke('write_file', { path: selected, contents: outliner.toOpml() })
  } catch (err) {
    await reportError('save', selected, err)
    return false
  }
  currentPath = selected
  outliner.clearChanged()
  syncTitle()
  return true
}
