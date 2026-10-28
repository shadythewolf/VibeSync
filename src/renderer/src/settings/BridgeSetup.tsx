/**
 * One-click Spicetify bridge setup, shared by Settings › Spotify and the first-run dialog.
 * The main process finds Spicetify, copies the bundled bridge and runs spicetify apply.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { BridgeSetupStatus } from '@shared/types'
import { Button } from '@renderer/components/ui/Button'
import { useLyricsStore } from '@renderer/components/Lyrics'
import { useUiStore } from '@renderer/store/uiStore'
import { errorMessage, getApi } from '@renderer/utils/api'

const SPICETIFY_URL = 'https://spicetify.app/docs/getting-started'

export interface BridgeSetup {
  status: BridgeSetupStatus | null
  installing: boolean
  /** Bridge is missing, older than the bundled one, or the live bridge lacks capabilities. */
  needsInstall: boolean
  description: string
  refresh(): void
  install(): void
}

export function useBridgeSetup(): BridgeSetup {
  const api = getApi()
  const liveNeedsUpdate = useLyricsStore((s) => !!s.state.bridgeNeedsUpdate)
  const [status, setStatus] = useState<BridgeSetupStatus | null>(null)
  const [installing, setInstalling] = useState(false)

  const refresh = useCallback((): void => {
    api?.spotify.getBridgeStatus().then(setStatus).catch(() => setStatus(null))
  }, [api])
  useEffect(refresh, [refresh])

  const install = (): void => {
    if (!api) return
    setInstalling(true)
    api.spotify
      .installBridge()
      .then((r) => useUiStore.getState().pushToast(r.ok
        ? { kind: 'success', title: 'Spotify bridge installed', message: r.message, timeout: 5000 }
        : { kind: 'error', title: 'Bridge install failed', message: r.message, timeout: 8000 }))
      .catch((err: unknown) => useUiStore.getState().pushToast({ kind: 'error', title: 'Bridge install failed', message: errorMessage(err), timeout: 8000 }))
      .finally(() => { setInstalling(false); refresh() })
  }

  const outdated = !!status?.installedVersion && !!status.bundledVersion && status.installedVersion !== status.bundledVersion
  const needsInstall = !!status?.spicetifyFound && (!status.installedVersion || outdated || liveNeedsUpdate)
  const description = !status
    ? 'Checking for Spicetify…'
    : !status.spicetifyFound
      ? 'Spicetify connects VibeSync to Spotify Desktop. Install it, then come back and click Install bridge.'
      : !status.installedVersion
        ? `Installs bridge ${status.bundledVersion ?? ''} into Spicetify. Spotify restarts once.`
        : needsInstall
          ? `Bridge ${status.installedVersion} is installed; ${status.bundledVersion ?? 'a newer version'} is included. Spotify restarts once.`
          : `Bridge ${status.installedVersion} is installed.`
  return { status, installing, needsInstall, description, refresh, install }
}

/** Buttons for the current setup state. */
export function BridgeSetupControl({ setup }: { setup: BridgeSetup }): ReactElement | null {
  const api = getApi()
  const { status, installing, needsInstall } = setup
  if (!status) return null
  if (!status.spicetifyFound) {
    return <>
      <Button size="sm" variant="primary" onClick={() => void api?.app.openExternal(SPICETIFY_URL)}>Get Spicetify</Button>
      <Button size="sm" variant="ghost" onClick={setup.refresh}>Check again</Button>
    </>
  }
  return <Button size="sm" variant={needsInstall ? 'primary' : 'ghost'} loading={installing} onClick={setup.install} data-testid="bridge-install">
    {!status.installedVersion ? 'Install bridge' : needsInstall ? 'Update bridge' : 'Reinstall'}
  </Button>
}
