// Shared types for the Outliner.

/** A movement / reorganize direction. */
export type Direction = 'up' | 'down' | 'left' | 'right' | 'flatup' | 'flatdown' | 'nodirection'

/** OPML attributes attached to a headline (everything except the `text`). */
export type OpmlAttributes = Record<string, string>

/** OPML `<head>` values, serialized as string children. */
export type OpmlHeaders = Record<string, string>

/** Icon name -> icon name, used to map an OPML `type` to a rendered icon. */
export type TypeIcons = Record<string, string>

/** User-visible preferences for an outliner instance. */
export interface OutlinerPrefs {
  readonly?: boolean
  renderMode?: boolean
  outlineFont?: string
  outlineFontSize?: number
  outlineLineHeight?: number
  /** Map an OPML `type` attribute to an icon name. */
  typeIcons?: TypeIcons
  /** Extra CSS injected for this instance. */
  css?: string
  /** Allow arbitrary extra prefs. */
  [key: string]: unknown
}

/**
 * A read-only view of a single headline, handed to callbacks. Mirrors the
 * "cursor context" the original Concord passed around (an `op` bound to one node).
 */
export interface NodeRef {
  /** The underlying `<li class="concord-node">`. */
  readonly element: HTMLLIElement
  getLineText(): string
  level(): number
  countSubs(): number
  subsExpanded(): boolean
  attributes: NodeAttributesApi
  isComment(): boolean
  /** OPML for this node's subs only. */
  toOpml(): string
  /** Visit the immediate children of this node. */
  visitLevel(cb: (child: NodeRef) => void): void
  deleteSubs(): void
  clearChanged(): boolean
  insertXml(opml: string, dir?: Direction): boolean
}

/** Per-node OPML attribute operations (classic Concord names). */
export interface NodeAttributesApi {
  getAll(): OpmlAttributes
  getOne(name: string): string | undefined
  exists(name: string): boolean
  setOne(name: string, value: string): boolean
  /** Replace the whole attribute set. */
  setGroup(attributes: OpmlAttributes): OpmlAttributes
  /** Merge into the existing attribute set. */
  addGroup(attributes: OpmlAttributes): OpmlAttributes
  removeOne(name: string): boolean
  makeEmpty(): boolean
}

/** The keystroke event passed to the `keystroke` callback. */
export interface KeystrokeEvent {
  /** The normalized keystroke string, e.g. "meta-B" or "cursor-up". */
  keystroke: string
  /** Set true inside the callback to swallow the key. */
  captured: boolean
  /** The original DOM event. */
  domEvent: KeyboardEvent
}

/** Lifecycle callbacks. All are optional. */
export interface OutlinerCallbacks {
  insert?: (node: NodeRef) => void
  cursorMoved?: (node: NodeRef) => void
  expand?: (node: NodeRef) => void
  collapse?: (node: NodeRef) => void
  reorg?: (node: NodeRef) => void
  hover?: (node: NodeRef) => void
  contextMenu?: (node: NodeRef) => void
  keystroke?: (event: KeystrokeEvent) => void
}

/** Options accepted by the `Outliner` constructor. */
export interface OutlinerOptions {
  prefs?: OutlinerPrefs
  callbacks?: OutlinerCallbacks
}
