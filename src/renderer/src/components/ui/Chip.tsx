import type { HTMLAttributes, ReactElement } from 'react'
import { cx } from '@renderer/utils/classNames'

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  accent?: boolean
}

export function Chip({ accent, className, children, ...rest }: ChipProps): ReactElement {
  return (
    <span className={cx('chip', accent && 'chip--accent', className)} {...rest}>
      {children}
    </span>
  )
}

export default Chip
