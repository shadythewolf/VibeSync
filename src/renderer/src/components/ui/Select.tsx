import type { ReactElement, SelectHTMLAttributes } from 'react'
import { cx } from '@renderer/utils/classNames'
import { IconChevronDown } from '../icons'

export interface SelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

export interface SelectProps<T extends string> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  block?: boolean
  'aria-label'?: string
}

export function Select<T extends string>({ value, options, onChange, block, className, disabled, ...rest }: SelectProps<T>): ReactElement {
  const known = options.some((o) => o.value === value)
  return (
    <div className={cx('select', block && 'select--block', className)}>
      <select
        {...rest}
        className="select__native"
        value={known ? value : ''}
        disabled={disabled}
        onChange={(e) => {
          const v = e.currentTarget.value as T
          if (options.some((o) => o.value === v && !o.disabled)) onChange(v)
        }}
      >
        {!known ? (
          <option value="" disabled>
            {value || '—'}
          </option>
        ) : null}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="select__chevron" aria-hidden="true">
        <IconChevronDown />
      </span>
    </div>
  )
}

export default Select
