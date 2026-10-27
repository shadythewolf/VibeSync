/**
 * Persistent banner shown while `AudioStatus.state === 'error'`: message + hint from the
 * main process, Retry (restart capture) and a shortcut to Settings > Audio.
 */
import { useState, type ReactElement } from 'react'
import { useAudioStatusStore } from '@renderer/store/audioStatusStore'
import { useUiStore } from '@renderer/store/uiStore'
import { errorMessage, getApi } from '@renderer/utils/api'
import { IconClose, IconRefresh, IconWarning } from './icons'
import { Button, IconButton } from './ui/Button'

export function restartAudioCapture(setBusy?: (b: boolean) => void): void {
  const api = getApi()
  if (!api) return
  setBusy?.(true)
  api.audio
    .restart()
    .catch((err: unknown) => {
      useUiStore.getState().pushToast({ kind: 'error', title: 'Restart failed', message: errorMessage(err), timeout: 5000 })
    })
    .finally(() => setBusy?.(false))
}

export function AudioErrorBanner(): ReactElement | null {
  const status = useAudioStatusStore((s) => s.status)
  const openSettings = useUiStore((s) => s.openSettings)
  const [busy, setBusy] = useState(false)
  // Dismiss hides the banner for this particular error only; a new error re-shows it.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)

  if (status.state !== 'error') return null
  const err = status.error
  const key = `${err?.code ?? 'UNKNOWN'}|${err?.message ?? ''}|${status.updatedAt}`
  if (dismissedKey === key) return null

  const message = err?.message ?? 'System audio capture is not running.'
  const hint = err?.hint ?? 'Open Settings › Audio to pick another device or capture engine.'

  return (
    <div className="audio-banner" role="alert" data-testid="audio-error-banner" data-code={err?.code ?? 'UNKNOWN'}>
      <span className="audio-banner__icon" aria-hidden="true">
        <IconWarning />
      </span>
      <div className="audio-banner__text">
        <div className="audio-banner__title">
          {message}
          {err?.code ? <span className="audio-banner__code">{err.code}</span> : null}
        </div>
        <div className="audio-banner__hint">{hint}</div>
      </div>
      <div className="audio-banner__actions">
        <Button size="sm" variant="ghost" onClick={() => openSettings('audio')}>
          Open Audio settings
        </Button>
        <Button size="sm" variant="primary" icon={<IconRefresh />} loading={busy} onClick={() => restartAudioCapture(setBusy)}>
          Retry
        </Button>
        <IconButton label="Dismiss" size="sm" onClick={() => setDismissedKey(key)}>
          <IconClose />
        </IconButton>
      </div>
    </div>
  )
}

export default AudioErrorBanner
