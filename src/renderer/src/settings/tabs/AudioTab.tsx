import { useEffect, useState, type ReactElement } from 'react'
import { FFT_SIZES, SETTINGS_LIMITS, type CaptureEngine, type FftSize } from '@shared/settings'
import { engineLabel, STATUS_TEXT, StatusDot } from '@renderer/components/AudioStatusBadge'
import { restartAudioCapture } from '@renderer/components/AudioErrorBanner'
import { IconError, IconMicOff, IconRefresh } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/Button'
import { Panel } from '@renderer/components/ui/Panel'
import { SegmentedControl } from '@renderer/components/ui/SegmentedControl'
import { Select, type SelectOption } from '@renderer/components/ui/Select'
import { Slider } from '@renderer/components/ui/Slider'
import { Toggle } from '@renderer/components/ui/Toggle'
import { useAudioStatusStore } from '@renderer/store/audioStatusStore'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { useUiStore } from '@renderer/store/uiStore'
import { errorMessage, getApi } from '@renderer/utils/api'
import { clamp, formatChannels, formatDb, formatInt, formatMultiplier, formatPercent, formatSampleRate } from '@renderer/utils/format'
import { SettingRow, SettingSlot, SettingsGroup } from '../SettingRow'

const DEFAULT_DEVICE = '__default__'

const ENGINE_OPTIONS: SelectOption<CaptureEngine>[] = [
  { value: 'auto', label: 'Auto (recommended)' },
  { value: 'helper', label: 'Native system helper' },
  { value: 'browser', label: 'Chromium loopback (Windows)' }
]

const ENGINE_NOTES: Record<CaptureEngine, string> = {
  auto: 'Uses WASAPI on Windows or PipeWire/PulseAudio on Linux. Windows can fall back to Chromium loopback.',
  helper: 'Native system-audio capture with the lowest latency.',
  browser: "Chromium's system-audio loopback. This fallback is available on Windows only."
}

/** AudioStatus is only broadcast on state changes, so poll while the Audio tab is open. */
const LIVE_STATUS_POLL_MS = 1000

function useLiveAudioStatus(): void {
  useEffect(() => {
    const api = getApi()
    if (!api) return
    let cancelled = false
    const tick = (): void => {
      api.audio
        .getStatus()
        .then((s) => {
          if (!cancelled) useAudioStatusStore.getState()._setStatus(s)
        })
        .catch(() => {
          /* the panel simply keeps the last known status */
        })
    }
    tick()
    const timer = setInterval(tick, LIVE_STATUS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])
}

function StatusCard(): ReactElement {
  const status = useAudioStatusStore((s) => s.status)
  const setDevices = useAudioStatusStore((s) => s._setDevices)
  useLiveAudioStatus()
  const [restarting, setRestarting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const refreshDevices = (): void => {
    const api = getApi()
    if (!api) return
    setRefreshing(true)
    api.audio
      .listDevices()
      .then((d) => setDevices(d))
      .catch((err: unknown) => useUiStore.getState().pushToast({ kind: 'error', title: 'Could not list devices', message: errorMessage(err), timeout: 5000 }))
      .finally(() => setRefreshing(false))
  }

  const deviceName = status.deviceName ?? (status.state === 'connected' ? 'System default output' : '—')

  return (
    <Panel variant={status.state === 'connected' ? 'accent' : 'default'} data-testid="audio-status-card">
      <div className="status-card">
        <div className="status-card__head">
          <div>
            <div className="micro-label">Audio capture</div>
            <div className="status-card__state" data-state={status.state}>
              <StatusDot state={status.state} size="lg" />
              {STATUS_TEXT[status.state]}
            </div>
          </div>
          <span className="chip">{status.helperAvailable ? 'Helper found' : 'Helper missing'}</span>
        </div>

        <div className="status-card__grid">
          <div className="kv">
            <span className="kv__key micro-label">Engine</span>
            <span className="kv__value">{engineLabel(status.engine)}</span>
          </div>
          <div className="kv">
            <span className="kv__key micro-label">Device</span>
            <span className="kv__value" title={deviceName}>
              {deviceName}
            </span>
          </div>
          <div className="kv">
            <span className="kv__key micro-label">Format</span>
            <span className="kv__value">
              {status.sampleRate > 0 ? `${formatSampleRate(status.sampleRate)} · ${formatChannels(status.channels)}` : '—'}
            </span>
          </div>
          <div className="kv">
            <span className="kv__key micro-label">Chunks received</span>
            <span className="kv__value kv__value--mono">{formatInt(status.chunksReceived)}</span>
          </div>
        </div>

        {status.error ? (
          <div className="status-card__error" role="alert">
            <IconError />
            <div>
              <div className="status-card__error-title">
                {status.error.message} <span className="audio-banner__code">{status.error.code}</span>
              </div>
              {status.error.hint ? <div className="status-card__error-hint">{status.error.hint}</div> : null}
            </div>
          </div>
        ) : null}

        <div className="status-card__actions">
          <Button size="sm" variant="accent" icon={<IconRefresh />} loading={restarting} onClick={() => restartAudioCapture(setRestarting)} data-testid="audio-restart">
            Restart capture
          </Button>
          <Button size="sm" variant="ghost" loading={refreshing} onClick={refreshDevices} data-testid="audio-refresh-devices">
            Refresh devices
          </Button>
        </div>

        <p className="note" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <IconMicOff size={14} style={{ flex: 'none', marginTop: 2 }} />
          <span>
            VibeSync captures the sound sent to your speakers or headphones. The microphone is never used and nothing is recorded.
          </span>
        </p>
      </div>
    </Panel>
  )
}

export function AudioTab(): ReactElement {
  const audio = useSettingsStore((s) => s.settings.audio)
  const update = useSettingsStore((s) => s.update)
  const devices = useAudioStatusStore((s) => s.devices)
  const L = SETTINGS_LIMITS

  const deviceOptions: SelectOption<string>[] = [
    { value: DEFAULT_DEVICE, label: 'System Default Output' },
    ...devices.map((d) => ({ value: d.id, label: d.isDefault ? `${d.name} (default)` : d.name }))
  ]
  const selectedDevice = audio.deviceId ?? DEFAULT_DEVICE
  if (audio.deviceId && !devices.some((d) => d.id === audio.deviceId)) {
    deviceOptions.push({ value: audio.deviceId, label: 'Saved device (currently unavailable)' })
  }

  const setEngine = (engine: CaptureEngine): void => {
    update({ audio: { engine } })
    const api = getApi()
    api?.audio.setEngine(engine).catch((err: unknown) => {
      useUiStore.getState().pushToast({ kind: 'error', title: 'Could not switch capture engine', message: errorMessage(err), timeout: 5000 })
    })
  }

  const setDevice = (value: string): void => {
    const id = value === DEFAULT_DEVICE ? null : value
    update({ audio: { deviceId: id } })
    const api = getApi()
    api?.audio.selectDevice(id).catch((err: unknown) => {
      useUiStore.getState().pushToast({ kind: 'error', title: 'Could not select device', message: errorMessage(err), timeout: 5000 })
    })
  }

  const setMinDb = (v: number): void => {
    const minDb = Math.round(v)
    const maxDb = audio.maxDb <= minDb + 6 ? clamp(minDb + 6, L.maxDb.min, L.maxDb.max) : audio.maxDb
    update({ audio: { minDb, maxDb } })
  }

  const setMaxDb = (v: number): void => {
    const maxDb = Math.round(v)
    const minDb = audio.minDb >= maxDb - 6 ? clamp(maxDb - 6, L.minDb.min, L.minDb.max) : audio.minDb
    update({ audio: { minDb, maxDb } })
  }

  return (
    <>
      <SettingsGroup title="Capture" bare>
        <StatusCard />
      </SettingsGroup>

      <SettingsGroup title="Source">
        <SettingRow label="Engine" description={ENGINE_NOTES[audio.engine]} stack>
          <Select aria-label="Capture engine" value={audio.engine} options={ENGINE_OPTIONS} onChange={setEngine} block data-testid="setting-engine" />
        </SettingRow>
        <SettingRow
          label="Audio source"
          description={devices.length === 0 ? 'No playback devices reported yet. The system default output is used.' : 'Which playback device to visualise.'}
          stack
        >
          <Select aria-label="Audio source" value={selectedDevice} options={deviceOptions} onChange={setDevice} block data-testid="setting-device" />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Analysis">
        <SettingSlot>
          <Slider
            label="Sensitivity"
            value={audio.sensitivity}
            min={L.sensitivity.min}
            max={L.sensitivity.max}
            step={L.sensitivity.step}
            format={formatMultiplier}
            onChange={(v) => update({ audio: { sensitivity: v } })}
            description="Gain applied before analysis. Raise it for quiet sources, lower it if everything is pinned at the top."
            data-testid="setting-sensitivity"
          />
        </SettingSlot>
        <SettingRow label="FFT size" description="Larger = finer bass detail, slower response." stack>
          <SegmentedControl<FftSize>
            label="FFT size"
            value={audio.fftSize}
            options={FFT_SIZES.map((n) => ({ value: n, label: String(n) }))}
            onChange={(v) => update({ audio: { fftSize: v } })}
            block
            accent
          />
        </SettingRow>
        <SettingSlot>
          <Slider
            label="Smoothing"
            value={audio.smoothing}
            min={L.smoothing.min}
            max={L.smoothing.max}
            step={L.smoothing.step}
            format={formatPercent}
            onChange={(v) => update({ audio: { smoothing: v } })}
            description="Temporal averaging of the spectrum. Higher is calmer, lower is snappier."
            data-testid="setting-smoothing"
          />
        </SettingSlot>
        <SettingSlot>
          <Slider
            label="Decay"
            value={audio.decay}
            min={L.decay.min}
            max={L.decay.max}
            step={L.decay.step}
            format={formatPercent}
            onChange={(v) => update({ audio: { decay: v } })}
            description="How quickly bars fall when the signal drops."
            data-testid="setting-decay"
          />
        </SettingSlot>
      </SettingsGroup>

      <SettingsGroup title="Peaks & range">
        <SettingRow label="Peak hold" description="Show a marker at each bar's recent maximum." htmlFor="audio-peakHold">
          <Toggle id="audio-peakHold" checked={audio.peakHold} onChange={(v) => update({ audio: { peakHold: v } })} data-testid="setting-peakHold" />
        </SettingRow>
        <SettingSlot>
          <Slider
            label="Peak hold time"
            value={audio.peakHoldMs}
            min={L.peakHoldMs.min}
            max={L.peakHoldMs.max}
            step={L.peakHoldMs.step}
            format={(v) => `${Math.round(v)} ms`}
            disabled={!audio.peakHold}
            onChange={(v) => update({ audio: { peakHoldMs: Math.round(v) } })}
            data-testid="setting-peakHoldMs"
          />
        </SettingSlot>
        <SettingSlot>
          <div className="slider-pair">
            <Slider
              label="Floor (min dB)"
              value={audio.minDb}
              min={L.minDb.min}
              max={L.minDb.max}
              step={L.minDb.step}
              format={formatDb}
              onChange={setMinDb}
              data-testid="setting-minDb"
            />
            <Slider
              label="Ceiling (max dB)"
              value={audio.maxDb}
              min={L.maxDb.min}
              max={L.maxDb.max}
              step={L.maxDb.step}
              format={formatDb}
              onChange={setMaxDb}
              data-testid="setting-maxDb"
            />
          </div>
          <p className="note">The dB window mapped onto bar height. Narrow it for more contrast; widen it to see quiet detail.</p>
        </SettingSlot>
      </SettingsGroup>
    </>
  )
}

export default AudioTab
