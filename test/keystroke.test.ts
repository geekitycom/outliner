import { describe, it, expect } from 'vitest'
import { getKeystroke } from '../src/util'

/** Build a minimal KeyboardEvent-like object for getKeystroke. */
function ke(partial: Partial<KeyboardEvent>): KeyboardEvent {
  return partial as unknown as KeyboardEvent
}

describe('getKeystroke', () => {
  it('maps special keys', () => {
    expect(getKeystroke(ke({ which: 8 }))).toBe('backspace')
    expect(getKeystroke(ke({ which: 9 }))).toBe('tab')
    expect(getKeystroke(ke({ which: 13 }))).toBe('return')
    expect(getKeystroke(ke({ which: 46 }))).toBe('delete')
  })

  it('maps arrow keys to cursor commands', () => {
    expect(getKeystroke(ke({ which: 38 }))).toBe('cursor-up')
    expect(getKeystroke(ke({ which: 40 }))).toBe('cursor-down')
    expect(getKeystroke(ke({ which: 37 }))).toBe('cursor-left')
    expect(getKeystroke(ke({ which: 39 }))).toBe('cursor-right')
  })

  it('maps meta/ctrl letter shortcuts', () => {
    expect(getKeystroke(ke({ which: 66, metaKey: true }))).toBe('bolden')
    expect(getKeystroke(ke({ which: 73, ctrlKey: true }))).toBe('italicize')
    expect(getKeystroke(ke({ which: 90, metaKey: true }))).toBe('undo')
    expect(getKeystroke(ke({ which: 65, metaKey: true }))).toBe('select-all')
  })

  it('maps bracket / punctuation shortcuts', () => {
    expect(getKeystroke(ke({ which: 219, metaKey: true }))).toBe('promote')
    expect(getKeystroke(ke({ which: 221, metaKey: true }))).toBe('demote')
    expect(getKeystroke(ke({ which: 188, metaKey: true }))).toBe('toggle-expand')
    expect(getKeystroke(ke({ which: 192, metaKey: true }))).toBe('toggle-render')
  })

  it('does not map an unmodified letter to a command (returns the keycode)', () => {
    // Unmodified letters are not command keystrokes — actual text entry is
    // handled by contenteditable + the which-based fallback in the handler.
    expect(getKeystroke(ke({ which: 65 }))).toBe('65')
  })
})
