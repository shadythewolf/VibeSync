import type { ButtonHTMLAttributes, ReactElement, ReactNode, RefAttributes } from 'react'
import { cx } from '@renderer/utils/classNames'

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'accent'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, RefAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  /** Shows a spinner and disables the button. */
  loading?: boolean
  block?: boolean
}

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  loading = false,
  block = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): ReactElement {
  return (
    <button
      type={type}
      className={cx(
        'btn',
        variant !== 'default' && `btn--${variant}`,
        size !== 'md' && `btn--${size}`,
        block && 'btn--block',
        loading && 'btn--loading',
        className
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {icon ? <span className="btn__icon">{icon}</span> : null}
      {children}
      {loading ? (
        <span className="btn__spinner" aria-hidden="true">
          <span className="spinner" />
        </span>
      ) : null}
    </button>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, RefAttributes<HTMLButtonElement> {
  /** Accessible name (also used as the tooltip). */
  label: string
  active?: boolean
  size?: 'sm' | 'md'
}

export function IconButton({ label, active, size = 'md', className, children, type = 'button', title, ...rest }: IconButtonProps): ReactElement {
  return (
    <button
      type={type}
      className={cx('icon-btn', size === 'sm' && 'icon-btn--sm', active && 'icon-btn--active', className)}
      aria-label={label}
      title={title ?? label}
      {...rest}
    >
      {children}
    </button>
  )
}

export default Button
