/**
 * Banner offered when a newer release exists: Download and install -> progress ->
 * Restart to update. Installs that cannot replace themselves (portable .exe) get a
 * Download button that opens the release page instead.
 */
import { useState, type ReactElement } from 'react'
import { useAudioStatusStore } from '@renderer/store/audioStatusStore'
import { useUiStore } from '@renderer/store/uiStore'
import { useUpdateStore } from '@renderer/store/updateStore'
import { errorMessage, getApi } from '@renderer/utils/api'
import { IconClose, IconDownload, IconRefresh } from './icons'
import { Button, IconButton } from './ui/Button'

export function UpdateBanner(): ReactElement | null {
  const update = useUpdateStore((s) => s.state)
  // The audio error banner occupies the same spot and matters more.
  const audioError = useAudioStatusStore((s) => s.status.state === 'error')
  const [dismissed, setDismissed] = useState<string | null>(null)
  const api = getApi()

  if (!api || audioError) return null
  if (update.status !== 'available' && update.status !== 'downloading' && update.status !== 'downloaded') return null
  // Dismissing hides this version until the next launch; a ready download stays visible.
  if (dismissed === update.version && update.status !== 'downloaded') return null

  const fail = (title: string) => (err: unknown): void => {
    useUiStore.getState().pushToast({ kind: 'error', title, message: errorMessage(err), timeout: 6000 })
  }

  const title = update.status === 'downloaded'
    ? `VibeSync ${update.version ?? ''} is ready to install`
    : `VibeSync ${update.version ?? ''} is available`
  const hint = update.status === 'downloading'
    ? `Downloading… ${update.percent ?? 0}%`
    : update.status === 'downloaded'
      ? 'VibeSync restarts once; your settings are kept.'
      : update.canInstall
        ? update.message?.startsWith('Download failed') ? update.message : 'Download it now and restart when it suits you.'
        : 'Download the new version from the release page.'

  return (
    <div className="update-banner ui-overlay" role="status" data-testid="update-banner" data-status={update.status}>
      <span className="update-banner__icon" aria-hidden="true">
        <IconDownload />
      </span>
      <div className="update-banner__text">
        <div className="update-banner__title">{title}</div>
        <div className="update-banner__hint">{hint}</div>
        {update.status === 'downloading' ? (
          <div className="update-banner__progress" aria-hidden="true">
            <span style={{ width: `${update.percent ?? 0}%` }} />
          </div>
        ) : null}
      </div>
      <div className="update-banner__actions">
        {update.status === 'downloaded' ? (
          <Button size="sm" variant="primary" icon={<IconRefresh />} onClick={() => api.app.installUpdate().catch(fail('Update failed'))} data-testid="update-install">
            Restart to update
          </Button>
        ) : (
          <Button size="sm" variant="primary" loading={update.status === 'downloading'} onClick={() => api.app.downloadUpdate().catch(fail('Download failed'))} data-testid="update-download">
            {update.canInstall ? 'Download and install' : 'Download'}
          </Button>
        )}
        <IconButton label="Later" size="sm" onClick={() => setDismissed(update.version ?? '')}>
          <IconClose />
        </IconButton>
      </div>
    </div>
  )
}

export default UpdateBanner
