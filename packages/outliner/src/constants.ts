import type { Direction } from './types'

export const UP: Direction = 'up'
export const DOWN: Direction = 'down'
export const LEFT: Direction = 'left'
export const RIGHT: Direction = 'right'
export const FLATUP: Direction = 'flatup'
export const FLATDOWN: Direction = 'flatdown'
export const NODIRECTION: Direction = 'nodirection'

/** True when running on a touch/mobile browser. */
export const IS_MOBILE = /Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(
  typeof navigator !== 'undefined' ? navigator.userAgent : '',
)

/**
 * This package's version. Kept in sync with package.json by release-please via
 * the trailing annotation — do not edit the annotation comment.
 */
export const VERSION = '0.1.0' // x-release-please-version

/**
 * A minimal, valid OPML document with a single empty headline — the starting
 * point for a blank outline. Equivalent to `initialOpmltext` in the original
 * concordutils.js (updated to UTF-8). Pass it to `outliner.loadOpml(...)`.
 */
export const EMPTY_OPML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<opml version="2.0"><head><title>Untitled</title></head>' +
  '<body><outline text=""/></body></opml>'
