import type { ReactElement, ReactNode } from 'react'
import { cx } from '@renderer/utils/classNames'

export interface SegmentedOption<T extends string | number> {
  value: T
  label: ReactNode
  title?: string
  disabled?: boolean
  'data-testid'?: string
}

export interface SegmentedControlProps<T extends string | number> {
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  /** Accessible group name. */
  label: string
  block?: boolean
  /** Highlight the active segment with the accent colour. */
  accent?: boolean
  size?: 'sm' | 'md'
  className?: string
  disabled?: boolean
}

export function SegmentedControl<T extends string | number>({
  value,
  options,
  onChange,
  label,
  block,
  accent,
  className,
  disabled
}: SegmentedControlProps<T>): ReactElement {
  return (
    <div
      className={cx('segmented', block && 'segmented--block', accent && 'segmented--accent', className)}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            className={cx('segmented__btn', active && 'segmented__btn--active')}
            disabled={disabled || o.disabled}
            data-testid={o['data-testid']}
            onClick={() => {
              if (!active) onChange(o.value)
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export default SegmentedControl
