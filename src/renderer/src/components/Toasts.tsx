/**
 * Top-right toast stack driven by uiStore.toasts.
 */
import type { ReactElement } from 'react'
import { useUiStore, type Toast } from '@renderer/store/uiStore'
import { cx } from '@renderer/utils/classNames'
import { IconClose, IconError, IconInfo, IconSuccess, IconWarning } from './icons'
import { IconButton } from './ui/Button'

function ToastIcon({ kind }: { kind: Toast['kind'] }): ReactElement {
  switch (kind) {
    case 'success':
      return <IconSuccess />
    case 'warning':
      return <IconWarning />
    case 'error':
      return <IconError />
    default:
      return <IconInfo />
  }
}

export function Toasts(): ReactElement | null {
  const toasts = useUiStore((s) => s.toasts)
  const dismiss = useUiStore((s) => s.dismissToast)
  if (toasts.length === 0) return null
  return (
    <div className="toasts" data-testid="toasts" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx('toast', `toast--${t.kind}`)}
          role={t.kind === 'error' ? 'alert' : 'status'}
          data-kind={t.kind}
          data-testid="toast"
        >
          <span className="toast__icon" aria-hidden="true">
            <ToastIcon kind={t.kind} />
          </span>
          <div className="toast__body">
            <div className="toast__title">{t.title}</div>
            {t.message ? <div className="toast__message">{t.message}</div> : null}
          </div>
          <IconButton label="Dismiss notification" size="sm" onClick={() => dismiss(t.id)}>
            <IconClose />
          </IconButton>
        </div>
      ))}
    </div>
  )
}

export default Toasts
