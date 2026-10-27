/**
 * Layout helpers shared by the settings tabs: a titled group of rows and a single
 * label / description / control row.
 */
import type { ReactElement, ReactNode } from 'react'
import { SectionLabel } from '@renderer/components/ui/SectionLabel'
import { cx } from '@renderer/utils/classNames'

export interface SettingsGroupProps {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  /** Render children without the bordered row container (for grids, cards). */
  bare?: boolean
  className?: string
}

export function SettingsGroup({ title, description, children, bare, className }: SettingsGroupProps): ReactElement {
  return (
    <section className={cx('settings-group', className)}>
      <SectionLabel>{title}</SectionLabel>
      {description ? <p className="note">{description}</p> : null}
      {bare ? children : <div className="settings-group__rows">{children}</div>}
    </section>
  )
}

export interface SettingRowProps {
  label: ReactNode
  description?: ReactNode
  children?: ReactNode
  /** Stack the control under the label (sliders, wide selects). */
  stack?: boolean
  disabled?: boolean
  className?: string
  htmlFor?: string
  'data-testid'?: string
}

export function SettingRow({ label, description, children, stack, disabled, className, htmlFor, 'data-testid': testId }: SettingRowProps): ReactElement {
  return (
    <div className={cx('srow', stack && 'srow--stack', disabled && 'srow--disabled', className)} data-testid={testId}>
      <div className="srow__text">
        {htmlFor ? (
          <label className="srow__label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <div className="srow__label">{label}</div>
        )}
        {description ? <div className="srow__desc">{description}</div> : null}
      </div>
      {children ? <div className="srow__control">{children}</div> : null}
    </div>
  )
}

/** Full-width row that just hosts a slider or other self-labelled control. */
export function SettingSlot({ children, className }: { children: ReactNode; className?: string }): ReactElement {
  return <div className={cx('srow', 'srow--stack', className)}>{children}</div>
}

export default SettingRow
