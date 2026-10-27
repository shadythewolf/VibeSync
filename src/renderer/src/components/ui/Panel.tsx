import type { HTMLAttributes, ReactElement, ReactNode } from 'react'
import { cx } from '@renderer/utils/classNames'

export interface PanelProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Panel heading (rendered in the header, not as a native tooltip). */
  title?: ReactNode
  /** Right-aligned content in the header. */
  actions?: ReactNode
  footer?: ReactNode
  variant?: 'default' | 'glass' | 'accent'
  tight?: boolean
}

export function Panel({ title, actions, footer, variant = 'default', tight, className, children, ...rest }: PanelProps): ReactElement {
  return (
    <div className={cx('panel', variant !== 'default' && `panel--${variant}`, className)} {...rest}>
      {title || actions ? (
        <div className="panel__head">
          {title ? <div className="panel__title">{title}</div> : <span />}
          {actions}
        </div>
      ) : null}
      <div className={cx('panel__body', tight && 'panel__body--tight')}>{children}</div>
      {footer ? <div className="panel__foot">{footer}</div> : null}
    </div>
  )
}

export const Card = Panel

export default Panel
