import { Fragment, type ReactElement } from 'react'
import { cx } from '@renderer/utils/classNames'
import { shortcutParts } from '@renderer/utils/shortcuts'

export interface KbdProps {
  /** Shortcut combo string such as 'Ctrl+Shift+K'. Rendered as one cap per key. */
  combo?: string
  /** Free-form key caps when no combo is given. */
  keys?: readonly string[]
  size?: 'sm' | 'md'
  accent?: boolean
  className?: string
}

export function Kbd({ combo, keys, size = 'sm', accent, className }: KbdProps): ReactElement {
  const parts = combo ? shortcutParts(combo) : (keys ?? [])
  return (
    <kbd className={cx('kbd', size === 'md' && 'kbd--md', accent && 'kbd--accent', className)} aria-label={parts.join(' + ')}>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? (
            <span className="kbd__plus" aria-hidden="true">
              +
            </span>
          ) : null}
          <span className="kbd__key">{p}</span>
        </Fragment>
      ))}
    </kbd>
  )
}

export default Kbd
