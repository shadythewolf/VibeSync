/**
 * Connects the preload API (window.vibedeck) to the stores and the audio engine.
 * Call `initializeApp()` once from main.tsx before rendering.
 */
import { validateSettings, type Settings } from '@shared/settings'
import type { AudioStatus, WindowState } from '@shared/types'
import { audioEngine, frameScheduler, startBrowserCapture, stopBrowserCapture } from '../audio'
import { useAudioStatusStore } from './audioStatusStore'
import { useSettingsStore } from './settingsStore'
import { useLyricsStore } from '../components/Lyrics'
import { useSpotifyQueueStore } from './spotifyQueueStore'
import { useTrackStore } from './trackStore'
import { useUiStore } from './uiStore'

let initialized = false
let browserCaptureActive = false

function applyEngineSettings(s: Settings): void {
  audioEngine.applySettings({ audio: s.audio, visualizer: s.visualizer })
  frameScheduler.setFpsLimit(s.visualizer.fpsLimit)
}

function handleAudioStatus(status: AudioStatus): void {
  const prev = useAudioStatusStore.getState().status
  useAudioStatusStore.getState()._setStatus(status)

  // Browser loopback fallback is owned by the renderer: main asks for it by publishing
  // engine === 'browser' with state 'starting'.
  if (status.engine === 'browser' && status.state === 'starting' && !browserCaptureActive) {
    browserCaptureActive = true
    startBrowserCapture().catch(() => {
      browserCaptureActive = false
    })
  } else if (status.engine !== 'browser' && browserCaptureActive) {
    browserCaptureActive = false
    stopBrowserCapture()
  }

  const ui = useUiStore.getState()
  if (status.state === 'reconnecting' && prev.state !== 'reconnecting') {
    ui.pushToast({ kind: 'warning', title: 'Audio device changed', message: 'Reconnecting system audio capture…', timeout: 4000 })
  }
  if (status.state === 'connected' && prev.state !== 'connected' && prev.state !== 'idle') {
    ui.pushToast({
      kind: 'success',
      title: 'Audio capture connected',
      message: status.deviceName ?? undefined,
      timeout: 3000
    })
  }
  if (status.state === 'error' && status.error && prev.error?.message !== status.error.message) {
    ui.pushToast({ kind: 'error', title: status.error.message, message: status.error.hint, timeout: 0, id: 9001 })
  }
  if (status.state === 'connected') ui.dismissToast(9001)
}

export async function initializeApp(): Promise<void> {
  if (initialized) return
  initialized = true
  const api = window.vibedeck
  if (!api) {
    useUiStore.getState().setFatalError('The VibeSync preload API is missing. Please reinstall VibeSync.')
    return
  }

  // Settings
  useSettingsStore.subscribe((state, prev) => {
    if (state.settings !== prev.settings) applyEngineSettings(state.settings)
  })
  api.settings.onChange((raw) => {
    const s = validateSettings(raw)
    useSettingsStore.getState()._replace(s)
    // The tray menu switches modes by writing general.lastMode; mirror it into the UI store.
    if (useUiStore.getState().mode !== s.general.lastMode) {
      useUiStore.setState({ mode: s.general.lastMode })
    }
  })
  try {
    const s = validateSettings(await api.settings.get())
    useSettingsStore.getState()._replace(s)
    useUiStore.setState({ mode: s.general.lastMode, firstRunOpen: !s.general.firstRunCompleted })
    applyEngineSettings(s)
  } catch (err) {
    api.app.log('error', 'Failed to load settings', String(err))
    applyEngineSettings(useSettingsStore.getState().settings)
  }

  // Audio
  api.audio.onPcm((chunk) => audioEngine.pushPcm(chunk))
  api.audio.onStatus(handleAudioStatus)
  api.audio.onDevices((devices) => useAudioStatusStore.getState()._setDevices(devices))
  try {
    handleAudioStatus(await api.audio.getStatus())
    useAudioStatusStore.getState()._setDevices(await api.audio.listDevices())
  } catch (err) {
    api.app.log('error', 'Failed to query audio status', String(err))
  }

  // Track metadata
  api.track.onChange((t) => useTrackStore.getState()._setTrack(t))
  try {
    useTrackStore.getState()._setTrack(await api.track.get())
  } catch {
    /* metadata is optional */
  }

  api.spotify.onQueue(state => useSpotifyQueueStore.setState({ state }))
  try { useSpotifyQueueStore.setState({ state: await api.spotify.getQueue() }) } catch { /* optional */ }

  // Subscribe before fetching so startup and reconnect updates are not lost.
  api.lyrics.onChange(state => useLyricsStore.setState({ state }))
  try { useLyricsStore.setState({ state: await api.lyrics.get() }) } catch { /* optional */ }

  // Window state. Pause rendering entirely while the window is not on screen.
  const applyWindowState = (s: WindowState): void => {
    useUiStore.getState()._setWindowState(s)
    frameScheduler.setPaused(s.isVisible === false)
  }
  api.window.onStateChange(applyWindowState)
  try {
    applyWindowState(await api.window.getState())
  } catch {
    /* ignore */
  }

  // Explain an automatic software-rendering fallback once, on the launch that applied it.
  try {
    const info = await api.app.getInfo()
    useUiStore.getState().setSoftwareRendering(!info.hardwareAcceleration)
    if (info.gpuFallbackApplied) {
      useUiStore.getState().pushToast({
        kind: 'warning',
        title: 'Switched to software rendering',
        message: 'The graphics driver kept crashing, so VibeSync restarted without hardware acceleration. You can turn it back on in Settings > General.',
        timeout: 15000
      })
    }
  } catch {
    /* diagnostics only */
  }

  // GPU process crash -> every ModeCanvas re-creates its canvas + renderer.
  api.app.onGpuReset(() => {
    api.app.log('warn', 'GPU process was reset; re-creating canvases')
    useUiStore.getState().bumpCanvasGeneration()
  })

  frameScheduler.start()
}
