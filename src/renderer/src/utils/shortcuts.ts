/**
 * Keyboard shortcut helpers. Combo strings follow the shared settings format
 * ("Ctrl+Shift+Alt+Key", see SHORTCUT_RE in src/shared/settings.ts): modifiers in the
 * order Ctrl, Shift, Alt followed by a key name (F1..F24, Escape, Space, Enter, Tab,
 * Backspace, Delete, Home, End, PageUp, PageDown, Arrow*, or one printable character).
 */
import { isValidShortcut } from '@shared/settings'

const MODIFIER_KEYS = new Set([
  'Control',
  'Shift',
  'Alt',
  'Meta',
  'OS',
  'AltGraph',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Fn',
  'Hyper',
  'Super'
])

const NAMED_KEYS = new Set([
  'Escape',
  'Space',
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight'
])

/** Physical key codes -> combo key names (layout independent, shift independent). */
const CODE_MAP: Record<string, string> = {
  Space: 'Space',
  Escape: 'Escape',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  NumpadSubtract: '-',
  NumpadDecimal: '.',
  NumpadDivide: '/'
}
for (let i = 0; i < 26; i++) {
  const letter = String.fromCharCode(65 + i)
  CODE_MAP['Key' + letter] = letter
}
for (let i = 0; i <= 9; i++) {
  CODE_MAP['Digit' + i] = String(i)
  CODE_MAP['Numpad' + i] = String(i)
}
for (let i = 1; i <= 24; i++) CODE_MAP['F' + i] = 'F' + i

const F_KEY_RE = /^F(?:[1-9]|1[0-9]|2[0-4])$/
const PRINTABLE_RE = /^[A-Za-z0-9`\-=[\];',./\\]$/

export interface ParsedShortcut {
  ctrl: boolean
  shift: boolean
  alt: boolean
  key: string
}

/** Split a combo string into modifiers + key. Returns null for malformed input. */
export function parseShortcut(combo: string): ParsedShortcut | null {
  if (typeof combo !== 'string' || combo.length === 0) return null
  const parts = combo.split('+')
  const key = parts.pop()
  if (!key) return null
  const out: ParsedShortcut = {
    ctrl: false,
    shift: false,
    alt: false,
    key: key.length === 1 ? key.toUpperCase() : key
  }
  for (const p of parts) {
    if (p === 'Ctrl' || p === 'Control') out.ctrl = true
    else if (p === 'Shift') out.shift = true
    else if (p === 'Alt') out.alt = true
    else return null
  }
  return out
}

/** Canonical form: modifier order Ctrl, Shift, Alt; single letters upper-case. */
export function normalizeShortcut(combo: string): string {
  const p = parseShortcut(combo)
  if (!p) return combo
  const out: string[] = []
  if (p.ctrl) out.push('Ctrl')
  if (p.shift) out.push('Shift')
  if (p.alt) out.push('Alt')
  out.push(p.key)
  return out.join('+')
}

export function shortcutsEqual(a: string, b: string): boolean {
  return normalizeShortcut(a) === normalizeShortcut(b)
}

/**
 * Key name of a keyboard event in combo format, or null for pure modifier presses and
 * keys we do not support. Letters and digits are taken from `event.key` (layout aware);
 * shifted symbols fall back to the physical `event.code` so "Ctrl+Shift+1" works.
 */
export function keyFromEvent(e: KeyboardEvent): string | null {
  const k = e.key
  if (!k || MODIFIER_KEYS.has(k) || k === 'Dead' || k === 'Unidentified' || k === 'Process') {
    return null
  }
  if (k === ' ' || k === 'Spacebar') return 'Space'
  if (k === 'Esc') return 'Escape'
  if (k === 'Del') return 'Delete'
  if (NAMED_KEYS.has(k) || F_KEY_RE.test(k)) return k
  if (k.length === 1) {
    if (/[A-Za-z]/.test(k)) return k.toUpperCase()
    if (/[0-9]/.test(k)) return k
  }
  const fromCode = CODE_MAP[e.code]
  if (fromCode) return fromCode
  if (k.length === 1 && PRINTABLE_RE.test(k)) return k
  return null
}

/** Build the combo string for a keydown event ("Ctrl+Shift+K"), or null when not representable. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const key = keyFromEvent(e)
  if (!key) return null
  const out: string[] = []
  if (e.ctrlKey) out.push('Ctrl')
  if (e.shiftKey) out.push('Shift')
  if (e.altKey) out.push('Alt')
  out.push(key)
  return out.join('+')
}

/** True when the keydown event matches the combo (modifiers must match exactly; Win/Meta must be up). */
export function matchShortcut(e: KeyboardEvent, combo: string): boolean {
  const p = parseShortcut(combo)
  if (!p) return false
  if (e.metaKey) return false
  if (e.ctrlKey !== p.ctrl || e.shiftKey !== p.shift || e.altKey !== p.alt) return false
  const key = keyFromEvent(e)
  if (!key) return false
  return key === p.key
}

/** F-keys and Escape work everywhere, even while typing in an input. */
export function isAlwaysActiveShortcut(combo: string): boolean {
  const p = parseShortcut(combo)
  if (!p) return false
  return p.key === 'Escape' || F_KEY_RE.test(p.key)
}

/** Shortcuts with Ctrl or Alt do not interfere with typing. */
export function hasCommandModifier(combo: string): boolean {
  const p = parseShortcut(combo)
  return !!p && (p.ctrl || p.alt)
}

/** True when the event target is a text-entry element. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file'].includes(type)
  }
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}

/**
 * Should the combo fire for this event? Single-key shortcuts are ignored while the user is
 * typing; F-keys, Escape and Ctrl/Alt combos always work.
 */
export function shouldHandleShortcut(e: KeyboardEvent, combo: string): boolean {
  if (!matchShortcut(e, combo)) return false
  if (!isEditableTarget(e.target)) return true
  return isAlwaysActiveShortcut(combo) || hasCommandModifier(combo)
}

const DISPLAY_NAMES: Record<string, string> = {
  Escape: 'Esc',
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Del',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→'
}

/** Human readable key caps for a combo: 'Ctrl+,' -> ['Ctrl', ','] ; 'Escape' -> ['Esc']. */
export function shortcutParts(combo: string): string[] {
  const p = parseShortcut(combo)
  if (!p) return [combo]
  const out: string[] = []
  if (p.ctrl) out.push('Ctrl')
  if (p.shift) out.push('Shift')
  if (p.alt) out.push('Alt')
  out.push(DISPLAY_NAMES[p.key] ?? p.key)
  return out
}

export function formatShortcut(combo: string): string {
  return shortcutParts(combo).join(' + ')
}

export { isValidShortcut }

// ---------------------------------------------------------------------------
// Capture mode: while the Shortcuts tab is recording a new key the global shortcut
// handler must stay quiet. Module-level flag, read by App.tsx.
// ---------------------------------------------------------------------------
let captureDepth = 0

export function beginShortcutCapture(): () => void {
  captureDepth++
  let released = false
  return () => {
    if (released) return
    released = true
    captureDepth = Math.max(0, captureDepth - 1)
  }
}

export function isCapturingShortcut(): boolean {
  return captureDepth > 0
}
