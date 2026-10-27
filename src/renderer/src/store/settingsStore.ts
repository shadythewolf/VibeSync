/**
 * Settings store. Local state updates immediately (so sliders feel instant), the patch is
 * sent to the main process (debounced) which persists it and broadcasts the validated
 * result back to every window.
 */
import { create } from 'zustand'
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type DeepPartial,
  type Settings,
  type VisualMode
} from '@shared/settings'

export interface SettingsState {
  settings: Settings
  loaded: boolean
  /** Apply a partial patch (any depth). */
  update: (patch: DeepPartial<Settings>) => void
  reset: () => Promise<void>
  /** Convenience: persist the last used mode. */
  setMode: (mode: VisualMode) => void
  /** Internal: replace settings from the main process. */
  _replace: (settings: Settings, loaded?: boolean) => void
}

let pending: DeepPartial<Settings> | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null

function mergePatch(a: DeepPartial<Settings>, b: DeepPartial<Settings>): DeepPartial<Settings> {
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) }
  for (const key of Object.keys(b) as (keyof Settings)[]) {
    const bv = (b as Record<string, unknown>)[key]
    const av = out[key]
    if (bv && typeof bv === 'object' && av && typeof av === 'object') {
      out[key] = { ...(av as Record<string, unknown>), ...(bv as Record<string, unknown>) }
    } else {
      out[key] = bv
    }
  }
  return out as DeepPartial<Settings>
}

/** Patch sent to main but not yet acknowledged. Re-applied on top of stale broadcasts. */
let inflight: DeepPartial<Settings> | null = null

function flush(): void {
  flushTimer = null
  const patch = pending
  pending = null
  if (!patch) return
  const api = window.vibedeck
  if (!api) return
  inflight = inflight ? mergePatch(inflight, patch) : patch
  const sent = inflight
  api.settings
    .set(patch)
    .catch((err: unknown) => {
      api.app.log('error', 'settings.set failed', String(err))
    })
    .finally(() => {
      if (inflight === sent) inflight = null
    })
}

/**
 * Settings pushed by the main process may predate patches we have not flushed (or that
 * main has not acknowledged) yet; re-apply those so optimistic UI state never flickers back.
 */
function withLocalPatches(base: Settings): Settings {
  let out = base
  if (inflight) out = mergeSettings(out, inflight)
  if (pending) out = mergeSettings(out, pending)
  return out
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  update: (patch) => {
    const next = mergeSettings(get().settings, patch)
    set({ settings: next })
    pending = pending ? mergePatch(pending, patch) : patch
    if (flushTimer === null) flushTimer = setTimeout(flush, 80)
  },
  reset: async () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    pending = null
    inflight = null
    const api = window.vibedeck
    if (!api) {
      set({ settings: DEFAULT_SETTINGS })
      return
    }
    const s = await api.settings.reset()
    set({ settings: s, loaded: true })
  },
  setMode: (mode) => {
    get().update({ general: { lastMode: mode } })
  },
  _replace: (settings, loaded = true) => set({ settings: withLocalPatches(settings), loaded })
}))

/** Non-hook accessor for render loops. */
export const getSettings = (): Settings => useSettingsStore.getState().settings
