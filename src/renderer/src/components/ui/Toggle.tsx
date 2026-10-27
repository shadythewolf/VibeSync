import { useId, type InputHTMLAttributes, type ReactElement, type ReactNode } from 'react'
import { cx } from '@renderer/utils/classNames'

export interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked' | 'value'> {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  /** `data-testid` is forwarded to the underlying checkbox input. */
  'data-testid'?: string
}

/**
 * Switch built on a real checkbox (role="switch") so it works with keyboard, assistive
 * tech and test automation (`check()` / `click()` both work on the input).
 */
export function Toggle({ checked, onChange, label, className, disabled, id, 'data-testid': testId, ...rest }: ToggleProps): ReactElement {
  const autoId = useId()
  const inputId = id ?? autoId
  return (
    <label className={cx('toggle', disabled && 'toggle--disabled', className)} htmlFor={inputId}>
      <input
        {...rest}
        id={inputId}
        type="checkbox"
        role="switch"
        className="toggle__input"
        checked={checked}
        disabled={disabled}
        aria-checked={checked}
        data-testid={testId}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span className="toggle__track" aria-hidden="true">
        <span className="toggle__thumb" />
      </span>
      {label ? <span className="toggle__label">{label}</span> : null}
    </label>
  )
}

export default Toggle
