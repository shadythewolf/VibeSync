/**
 * Title-bar capture status: micro-label "AUDIO CAPTURE" + coloured dot + state text.
 * Click opens Settings > Audio.
 */
import type { ReactElement } from 'react'
import type { AudioStatus, CaptureEngineKind, CaptureState } from '@shared/types'
import { useAudioStatusStore } from '@renderer/store/audioStatusStore'
import { useUiStore } from '@renderer/store/uiStore'
import { cx } from '@renderer/utils/classNames'

export const STATUS_TEXT: Record<CaptureState, string> = {
  idle: 'Not connected',
  starting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  error: 'Not connected'
}

export function engineLabel(engine: CaptureEngineKind | null): string {
  if (engine === 'helper') return 'Native WASAPI helper'
  if (engine === 'browser') return 'Chromium loopback'
  return 'No engine active'
}

export function describeStatus(status: AudioStatus): string {
  const device = status.deviceName ?? (status.state === 'connected' ? 'Windows default output' : 'No device')
  const parts = [STATUS_TEXT[status.state], device, engineLabel(status.engine)]
  if (status.state === 'error' && status.error) parts.push(status.error.message)
  return parts.join(' · ')
}

export interface StatusDotProps {
  state: CaptureState
  size?: 'sm' | 'lg'
  className?: string
}

export function StatusDot({ state, size = 'sm', className }: StatusDotProps): ReactElement {
  return <span className={cx('status-dot', `status-dot--${state}`, size === 'lg' && 'status-dot--lg', className)} aria-hidden="true" />
}

export function AudioStatusBadge(): ReactElement {
  const status = useAudioStatusStore((s) => s.status)
  const openSettings = useUiStore((s) => s.openSettings)
  const text = STATUS_TEXT[status.state]

  return (
    <button
      type="button"
      className="audio-badge"
      title={describeStatus(status)}
      aria-label={`Audio capture: ${describeStatus(status)}. Open audio settings.`}
      onClick={() => openSettings('audio')}
    >
      <span className="audio-badge__label micro-label" aria-hidden="true">
        Audio capture
      </span>
      <span className="audio-badge__status" data-testid="audio-status" data-state={status.state} data-engine={status.engine ?? ''}>
        <StatusDot state={status.state} />
        <span className="audio-badge__text">{text}</span>
      </span>
    </button>
  )
}

export default AudioStatusBadge
