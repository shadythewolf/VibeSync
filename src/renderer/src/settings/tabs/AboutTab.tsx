import { useState, type ReactElement } from 'react'
import type { UpdateCheckResult } from '@shared/types'
import { engineLabel } from '@renderer/components/AudioStatusBadge'
import { IconDownload, IconFolder, IconRefresh, IconTrash } from '@renderer/components/icons'
import { Logo } from '@renderer/components/Logo'
import { Button } from '@renderer/components/ui/Button'
import { Chip } from '@renderer/components/ui/Chip'
import { useAudioStatusStore } from '@renderer/store/audioStatusStore'
import { useTrackStore } from '@renderer/store/trackStore'
import { useUiStore } from '@renderer/store/uiStore'
import { useUpdateStore } from '@renderer/store/updateStore'
import { errorMessage, getApi } from '@renderer/utils/api'
import { cx } from '@renderer/utils/classNames'
import { clearArtworkCache } from '@renderer/visualizer/artwork'
import { SettingsGroup } from '../SettingRow'
import { useAppInfo } from '../useAppInfo'

const CREDITS: { name: string; license: string }[] = [
  { name: 'NAudio', license: 'MIT' },
  { name: 'Electron', license: 'MIT' },
  { name: 'React', license: 'MIT' },
  { name: 'zustand', license: 'MIT' }
]

function describeUpdate(r: UpdateCheckResult): string {
  switch (r.status) {
    case 'not-configured':
      return r.message ?? 'This build has no update feed configured.'
    case 'up-to-date':
      return `You are on the latest version${r.version ? ` (${r.version})` : ''}.`
    case 'available':
      return r.message?.startsWith('Download failed') ? r.message : `Version ${r.version ?? ''} is available.`
    case 'downloading':
      return `Downloading version ${r.version ?? ''}… ${r.percent ?? 0}%`
    case 'downloaded':
      return `Version ${r.version ?? ''} is ready. VibeSync restarts once to install it.`
    case 'checking':
      return 'Checking for updates…'
    case 'error':
      return r.message ?? 'The update check failed.'
    default:
      return ''
  }
}

export function AboutTab(): ReactElement {
  const { info, loading, error, reload } = useAppInfo()
  const engine = useAudioStatusStore((s) => s.status.engine)
  const update = useUpdateStore((s) => s.state)
  const checking = update.status === 'checking'
  const [clearing, setClearing] = useState(false)
  const api = getApi()

  const run = (label: string, fn: () => Promise<void>, setBusy?: (b: boolean) => void): void => {
    setBusy?.(true)
    fn()
      .catch((err: unknown) => useUiStore.getState().pushToast({ kind: 'error', title: `${label} failed`, message: errorMessage(err), timeout: 5000 }))
      .finally(() => setBusy?.(false))
  }

  // Results arrive through the shared update store, which also drives the update banner.
  const checkUpdates = (): void => {
    if (api) run('Check for updates', async () => { await api.app.checkForUpdates() })
  }

  const clearCache = (): void => {
    if (!api) return
    run(
      'Clear artwork cache',
      async () => {
        await api.app.clearArtworkCache()
        clearArtworkCache()
        useTrackStore.setState({ artwork: null, artworkKey: null, artworkPalette: null })
        useUiStore.getState().pushToast({ kind: 'success', title: 'Artwork cache cleared', timeout: 2500 })
      },
      setClearing
    )
  }

  const rows: { k: string; v: string; mono?: boolean }[] = info
    ? [
        { k: 'Electron', v: info.electron },
        { k: 'Chromium', v: info.chrome },
        { k: 'Node', v: info.node },
        { k: 'OS', v: `${info.osVersion} (${info.arch})` },
        { k: 'Install', v: info.isPortable ? 'Portable' : info.isPackaged ? 'Installed' : 'Development' },
        { k: 'Helper', v: info.helperFound ? `Found · ${info.helperPath}` : `Not found · expected at ${info.helperPath}`, mono: true },
        { k: 'Engine in use', v: engineLabel(engine) },
        { k: 'User data', v: info.userDataPath, mono: true },
        { k: 'Log file', v: info.logPath, mono: true }
      ]
    : []

  return (
    <>
      <div className="about-hero">
        <Logo size={56} />
        <div>
          <div className="about-hero__name">
            Vibe<span className="gradient-text">Sync</span>
          </div>
          <div className="about-hero__version">
            <Chip accent>v{info?.version ?? '…'}</Chip>
            <span className="note">Spotify, synchronized lyrics and album artwork colors</span>
          </div>
        </div>
      </div>

      <SettingsGroup title="VibeDeck fork" bare>
        <p className="about-text">VibeSync is a fork of VibeDeck by Amara Dhanush Kumar, customized by Shady.
          This edition focuses on the visualizer with Spotify integration, synchronized lyrics and album artwork colors.</p>
        <Button variant="ghost" size="sm" onClick={() => void api?.app.openExternal('https://github.com/dhanush-the-versatile/VibeDeck')}>
          Original VibeDeck project
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void api?.app.openExternal('https://github.com/shadythewolf/VibeSync')}>
          VibeSync on GitHub
        </Button>
      </SettingsGroup>

      <SettingsGroup title="System" bare>
        {error ? (
          <div className="inline-error" role="alert">
            Could not load app info: {error}
            <Button size="sm" variant="ghost" onClick={reload}>
              Retry
            </Button>
          </div>
        ) : loading && !info ? (
          <p className="note">Loading…</p>
        ) : (
          <div className="info-rows" data-testid="app-info">
            {rows.map((r) => (
              <RowPair key={r.k} k={r.k} v={r.v} mono={r.mono} />
            ))}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="Maintenance" bare>
        <div className="about-actions">
          <Button size="sm" icon={<IconFolder />} onClick={() => api && run('Open log folder', () => api.app.openLogs())} disabled={!api}>
            Open log folder
          </Button>
          <Button size="sm" icon={<IconFolder />} onClick={() => api && run('Open data folder', () => api.app.openUserData())} disabled={!api}>
            Open data folder
          </Button>
          <Button size="sm" icon={<IconDownload />} loading={checking} onClick={checkUpdates} disabled={!api} data-testid="check-updates">
            Check for updates
          </Button>
          <Button size="sm" icon={<IconTrash />} loading={clearing} onClick={clearCache} disabled={!api}>
            Clear artwork cache
          </Button>
        </div>
        {update.status !== 'idle' ? (
          <div
            className={cx(
              'update-result',
              update.status === 'up-to-date' && 'update-result--ok',
              (update.status === 'available' || update.status === 'downloading' || update.status === 'downloaded') && 'update-result--available',
              update.status === 'error' && 'update-result--error'
            )}
            role="status"
            data-testid="update-result"
          >
            {update.status === 'checking' ? <IconRefresh className="spinner-icon" /> : null}
            {describeUpdate(update)}
            {update.status === 'available' || update.status === 'downloading' ? (
              <Button size="sm" variant="primary" loading={update.status === 'downloading'} onClick={() => api && run('Download update', () => api.app.downloadUpdate())}>
                {update.canInstall ? 'Download and install' : 'Download'}
              </Button>
            ) : null}
            {update.status === 'downloaded' ? (
              <Button size="sm" variant="primary" onClick={() => api && run('Install update', () => api.app.installUpdate())}>
                Restart to update
              </Button>
            ) : null}
          </div>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="How it works" bare>
        <p className="about-text">
          System audio is captured locally using WASAPI on Windows or PulseAudio/PipeWire on Linux and drawn as a live spectrum.
          The Spotify bridge supplies track information, playback timing, Up Next and synchronized lyrics.
          Lyrics can also be retrieved from LRCLIB. Album artwork can drive the visualizer colors.
        </p>
      </SettingsGroup>

      <SettingsGroup title="Third-party" bare>
        <div className="credits">
          {CREDITS.map((c) => (
            <Chip key={c.name} title={`${c.name} - ${c.license} license`}>
              {c.name} · {c.license}
            </Chip>
          ))}
        </div>
      </SettingsGroup>
    </>
  )
}

function RowPair({ k, v, mono }: { k: string; v: string; mono?: boolean }): ReactElement {
  return (
    <>
      <div className="info-rows__k">{k}</div>
      <div className={cx('info-rows__v', mono && 'info-rows__v--mono')} title={v}>
        {v}
      </div>
    </>
  )
}

export default AboutTab
