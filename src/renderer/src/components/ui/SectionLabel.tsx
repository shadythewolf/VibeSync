import type { HTMLAttributes, ReactElement } from 'react'
import { cx } from '@renderer/utils/classNames'

export interface SectionLabelProps extends HTMLAttributes<HTMLHeadingElement> {
  /** Without the trailing rule line. */
  plain?: boolean
  as?: 'h2' | 'h3' | 'h4' | 'div'
}

/** Uppercase, letter-spaced micro heading used for every settings / overlay section. */
export function SectionLabel({ plain, as = 'h3', className, children, ...rest }: SectionLabelProps): ReactElement {
  const Tag = as
  return (
    <Tag className={cx('section-label', 'micro-label', plain && 'section-label--plain', className)} {...rest}>
      {children}
    </Tag>
  )
}

export default SectionLabel
