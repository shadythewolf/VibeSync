/**
 * UI state that is not persisted (except `mode`, which is mirrored to settings.general.lastMode
 * by the settings store when changed through `setMode`).
 */
import { create } from 'zustand'
import type { VisualMode } from '@shared/settings'
import type { WindowState } from '@shared/types'
import { useSettingsStore } from './settingsStore'

export type SettingsTab = 'general' | 'audio' | 'visualizer' | 'colors' | 'spotify' | 'shortcuts' | 'about'
export const SETTINGS_TABS: readonly SettingsTab[] = ['general', 'audio', 'visualizer', 'colors', 'spotify', 'shortcuts', 'about']

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'warning' | 'error'
  title: string
  message?: string
  /** ms; 0 = sticky until dismissed */
  timeout: number
}

export interface UiState {
  mode: VisualMode
  setMode: (mode: VisualMode) => void
  settingsOpen: boolean
  settingsTab: SettingsTab
  openSettings: (tab?: SettingsTab) => void
  closeSettings: () => void
  toggleSettings: () => void
  fullscreen: boolean
  windowState: WindowState | null
  _setWindowState: (s: WindowState) => void
  /** Hide overlay chrome (visualizer mode idle / H key). */
  uiHidden: boolean
  setUiHidden: (hidden: boolean) => void
  toasts: Toast[]
  pushToast: (toast: Omit<Toast, 'id'> & { id?: number }) => number
  dismissToast: (id: number) => void
  firstRunOpen: boolean
  setFirstRunOpen: (open: boolean) => void
  /** Renderer-wide fatal error (shown by the error screen). */
  fatalError: string | null
  setFatalError: (msg: string | null) => void
  /** Incremented when canvases must be re-created (GPU process reset / context lost). */
  canvasGeneration: number
  bumpCanvasGeneration: () => void
  /** True when Chromium is rasterising on the CPU (hardware acceleration off). */
  softwareRendering: boolean
  setSoftwareRendering: (v: boolean) => void
}

let toastSeq = 1

export const useUiStore = create<UiState>((set, get) => ({
  mode: 'visualizer',
  setMode: (mode) => {
    if (get().mode === mode) return
    set({ mode })
    useSettingsStore.getState().setMode(mode)
  },
  settingsOpen: false,
  settingsTab: 'general',
  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab ?? get().settingsTab }),
  closeSettings: () => set({ settingsOpen: false }),
  toggleSettings: () => set({ settingsOpen: !get().settingsOpen }),
  fullscreen: false,
  windowState: null,
  _setWindowState: (s) => set({ windowState: s, fullscreen: s.isFullScreen }),
  uiHidden: false,
  setUiHidden: (hidden) => set({ uiHidden: hidden }),
  toasts: [],
  pushToast: (toast) => {
    const id = toast.id ?? toastSeq++
    const t: Toast = { ...toast, id }
    set({ toasts: [...get().toasts.filter((x) => x.id !== id), t].slice(-5) })
    if (t.timeout > 0) {
      setTimeout(() => get().dismissToast(id), t.timeout)
    }
    return id
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  firstRunOpen: false,
  setFirstRunOpen: (open) => set({ firstRunOpen: open }),
  fatalError: null,
  setFatalError: (msg) => set({ fatalError: msg }),
  canvasGeneration: 0,
  bumpCanvasGeneration: () => set({ canvasGeneration: get().canvasGeneration + 1 }),
  softwareRendering: false,
  setSoftwareRendering: (v) => set({ softwareRendering: v })
}))
