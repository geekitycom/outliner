// Small stateless helpers ported from Concord's ConcordUtil.

const XML_CHAR_MAP: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
}

export function escapeXml(input: unknown): string {
  let s = String(input)
  s = s.replace(/ /g, ' ')
  return s.replace(/[<>&"]/g, (ch) => XML_CHAR_MAP[ch])
}

/** 1-based substring (mirrors the original `stringMid`). */
export function stringMid(s: string, ix: number, len: number): string {
  return s.substr(ix - 1, len)
}

/** Delete `ct` characters starting at 1-based index `ix`. */
export function stringDelete(s: string, ix: number, ct: number): string {
  const start = ix - 1
  const end = ix + ct - 1
  return s.substr(0, start) + s.substr(end)
}

export function beep(): void {
  // The original tried a host-provided speakerBeep(); we just log.
  console.log('beep')
}

const CONCORD_KEYSTROKES: Record<string, string> = {
  backspace: 'backspace',
  tab: 'tab',
  return: 'return',
  delete: 'delete',
  uparrow: 'cursor-up',
  downarrow: 'cursor-down',
  leftarrow: 'cursor-left',
  rightarrow: 'cursor-right',

  'meta-A': 'select-all',
  'meta-B': 'bolden',
  'meta-C': 'copy',
  'meta-D': 'reorg-down',
  'meta-F': 'find',
  'meta-I': 'italicize',
  'meta-L': 'reorg-left',
  'meta-R': 'reorg-right',
  'meta-U': 'reorg-up',
  'meta-V': 'paste',
  'meta-X': 'cut',
  'meta-Z': 'undo',

  'meta-[': 'promote',
  'meta-]': 'demote',

  'meta-\\': 'toggle-comment',
  'meta-/': 'run-selection',
  'meta-`': 'toggle-render',
  'meta-,': 'toggle-expand',
}

function checkSpecials(ch: number): string | number {
  switch (ch) {
    case 8:
      return 'backspace'
    case 9:
      return 'tab'
    case 13:
      return 'return'
    case 33:
      return 'pageup'
    case 34:
      return 'pagedown'
    case 35:
      return 'end'
    case 36:
      return 'home'
    case 37:
      return 'leftarrow'
    case 38:
      return 'uparrow'
    case 39:
      return 'rightarrow'
    case 40:
      return 'downarrow'
    case 46:
      return 'delete'
    case 188:
      return ','
    case 190:
      return '.'
    case 191:
      return '/'
    case 192:
      return '`'
    case 219:
      return '['
    case 220:
      return '\\'
    case 221:
      return ']'
  }
  return ch
}

/** Normalize a keyboard event into a Concord keystroke command string. */
export function getKeystroke(event: KeyboardEvent): string {
  const flmeta = event.metaKey || event.ctrlKey
  const ch = event.which || event.keyCode
  let base: string
  if (ch >= 65 && ch <= 90) {
    base = flmeta ? 'meta-' + String.fromCharCode(ch) : String(checkSpecials(ch))
  } else if (ch >= 48 && ch <= 57 && flmeta) {
    base = 'meta-' + String.fromCharCode(ch)
  } else {
    const s = checkSpecials(ch)
    base = flmeta ? 'meta-' + s : String(s)
  }
  const mapped = CONCORD_KEYSTROKES[base]
  if (mapped !== undefined && mapped.length > 0) {
    return mapped
  }
  return base
}
