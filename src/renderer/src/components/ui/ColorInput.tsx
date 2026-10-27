import { useEffect, useId, useState, type ReactElement } from 'react'
import { normalizeHexColor } from '@shared/settings'
import { cx } from '@renderer/utils/classNames'

export interface ColorInputProps {
  value: string
  onChange: (hex: string) => void
  label?: string
  disabled?: boolean
  className?: string
  id?: string
}

const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/**
 * Native colour picker + editable hex field. Only valid, normalised `#RRGGBB` values are
 * emitted; the text field keeps the user's partial input until it becomes valid.
 */
export function ColorInput({ value, onChange, label, disabled, className, id }: ColorInputProps): ReactElement {
  const autoId = useId()
  const inputId = id ?? autoId
  const normalized = normalizeHexColor(value, '#FFFFFF')
  const [text, setText] = useState(normalized)
  const [invalid, setInvalid] = useState(false)

  // Keep the text field in sync when the value changes from outside (palette, reset).
  useEffect(() => {
    setText(normalized)
    setInvalid(false)
  }, [normalized])

  const commit = (raw: string): void => {
    const s = raw.trim()
    if (!HEX_RE.test(s)) {
      setInvalid(true)
      return
    }
    const hex = normalizeHexColor(s.startsWith('#') ? s : '#' + s, normalized)
    setInvalid(false)
    setText(hex)
    if (hex !== normalized) onChange(hex)
  }

  return (
    <div className={cx('color-input', disabled && 'color-input--disabled', invalid && 'color-input--invalid', className)}>
      <span className="color-input__swatch" style={{ background: normalized }}>
        <input
          id={inputId}
          type="color"
          className="color-input__native"
          value={normalized}
          disabled={disabled}
          aria-label={label ?? 'Colour'}
          onChange={(e) => {
            const hex = normalizeHexColor(e.currentTarget.value, normalized)
            setText(hex)
            setInvalid(false)
            if (hex !== normalized) onChange(hex)
          }}
        />
      </span>
      <input
        type="text"
        className="color-input__hex"
        value={text}
        disabled={disabled}
        spellCheck={false}
        maxLength={7}
        placeholder="#RRGGBB"
        aria-label={label ? `${label} hex value` : 'Hex colour value'}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          const raw = e.currentTarget.value
          setText(raw)
          const digits = raw.trim().replace('#', '')
          // Commit as soon as a complete 6-digit colour is typed; shorter input is "in progress".
          if (digits.length === 6) commit(raw)
          else setInvalid(false)
        }}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value)
          if (e.key === 'Escape') {
            setText(normalized)
            setInvalid(false)
          }
        }}
      />
    </div>
  )
}

export default ColorInput
