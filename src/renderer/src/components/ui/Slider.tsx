import { useId, type ReactElement, type ReactNode } from 'react'
import { cx } from '@renderer/utils/classNames'
import { clamp } from '@renderer/utils/format'
import type { CssVarStyle } from '@renderer/utils/theme'

export interface SliderProps {
  label: ReactNode
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  /** Formats the value readout; default shows the raw number. */
  format?: (value: number) => string
  description?: ReactNode
  disabled?: boolean
  className?: string
  /** Forwarded to the range input. */
  'data-testid'?: string
  id?: string
}

function defaultFormat(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '')
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format = defaultFormat,
  description,
  disabled,
  className,
  'data-testid': testId,
  id
}: SliderProps): ReactElement {
  const autoId = useId()
  const inputId = id ?? autoId
  const safe = clamp(Number.isFinite(value) ? value : min, min, max)
  const pct = max > min ? ((safe - min) / (max - min)) * 100 : 0
  const style: CssVarStyle = { '--fill': `${pct.toFixed(2)}%` }
  return (
    <div className={cx('slider', className)}>
      <div className="slider__head">
        <label className="slider__label" htmlFor={inputId}>
          {label}
        </label>
        <output className="slider__value" htmlFor={inputId} aria-live="off">
          {format(safe)}
        </output>
      </div>
      <input
        id={inputId}
        type="range"
        className="slider__input"
        style={style}
        min={min}
        max={max}
        step={step}
        value={safe}
        disabled={disabled}
        data-testid={testId}
        aria-valuetext={format(safe)}
        onChange={(e) => {
          const n = Number(e.currentTarget.value)
          if (Number.isFinite(n)) onChange(clamp(n, min, max))
        }}
      />
      {description ? <div className="slider__desc">{description}</div> : null}
    </div>
  )
}

export default Slider
