/**
 * Fetches `AppInfo` from the main process once per session and shares it between tabs.
 */
import { useCallback, useEffect, useState } from 'react'
import type { AppInfo } from '@shared/types'
import { errorMessage, getApi } from '@renderer/utils/api'

let cached: AppInfo | null = null
let inflight: Promise<AppInfo> | null = null

export function fetchAppInfo(force = false): Promise<AppInfo> {
  if (cached && !force) return Promise.resolve(cached)
  if (inflight) return inflight
  const api = getApi()
  if (!api) return Promise.reject(new Error('VibeSync API unavailable'))
  inflight = api.app
    .getInfo()
    .then((info) => {
      cached = info
      return info
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export interface AppInfoState {
  info: AppInfo | null
  loading: boolean
  error: string | null
  reload: () => void
}

export function useAppInfo(): AppInfoState {
  const [info, setInfo] = useState<AppInfo | null>(cached)
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((force: boolean) => {
    let cancelled = false
    setLoading(true)
    fetchAppInfo(force)
      .then((i) => {
        if (cancelled) return
        setInfo(i)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(errorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => load(false), [load])

  const reload = useCallback(() => {
    load(true)
  }, [load])

  return { info, loading, error, reload }
}

export default useAppInfo
