import { Slider } from '@renderer/components/ui/Slider'
import { Toggle } from '@renderer/components/ui/Toggle'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { useLyricsStore } from '@renderer/components/Lyrics'
import { SettingRow, SettingSlot, SettingsGroup } from './SettingRow'

export function LyricsSettings(): JSX.Element {
  const lyrics = useSettingsStore(s => s.settings.lyrics)
  const update = useSettingsStore(s => s.update)
  const state = useLyricsStore(s => s.state)
  return <SettingsGroup title="Synchronized lyrics" description="The bridge supplies Spotify lyrics and playback timing. LRCLIB is the fallback for missing synchronized lyrics.">
    <SettingRow label="Show lyrics" description="Centered below the visualizer. Lyrics remain visible when the controls hide.">
      <Toggle label="Enable lyrics" checked={lyrics.enabled} onChange={enabled => update({ lyrics: { enabled } })} data-testid="lyrics-enabled" />
    </SettingRow>
    <SettingRow label="VibeSync bridge" description={state.bridgeNeedsUpdate ? 'Replace the installed bridge with version 2.0.1 from the bundle and run spicetify apply.' : state.error || 'Install the updated Spicetify/vibesync-bridge.js (2.0.1) from the bundle. Connection stays on 127.0.0.1:43821.'}>
      <span data-testid="lyrics-bridge-status">{state.bridgeConnected ? state.bridgeNeedsUpdate ? 'Connected / Update bridge' : 'Connected' : 'Waiting for Spotify'}{state.source ? ` / ${state.source === 'spotify' ? 'Spotify' : 'LRCLIB'}` : ''}{state.status === 'unavailable' ? ' / No synchronized lyrics' : ''}</span>
    </SettingRow>
    <SettingSlot><Slider label="Sync offset" value={lyrics.offsetMs} min={-10000} max={10000} step={50} format={v => `${v > 0 ? '+' : ''}${v} ms`} description="Positive values show lyrics earlier; negative values show them later. Pause and seeks follow the progress bar." onChange={offsetMs => update({ lyrics: { offsetMs } })} /></SettingSlot>
    <SettingSlot><Slider label="Lyrics size" value={lyrics.fontSize} min={16} max={56} format={v => `${v} px`} onChange={fontSize => update({ lyrics: { fontSize } })} /></SettingSlot>
    <SettingSlot><Slider label="Line spacing" value={lyrics.lineGap} min={0} max={24} format={v => `${v} px`} onChange={lineGap => update({ lyrics: { lineGap } })} /></SettingSlot>
    <SettingSlot><Slider label="Lyrics opacity" value={lyrics.opacity} min={0.15} max={1} step={0.05} format={v => `${Math.round(v * 100)}%`} onChange={opacity => update({ lyrics: { opacity } })} /></SettingSlot>
    <SettingRow label="Previous and next line"><Toggle label="Show surrounding lines" checked={lyrics.showContext} onChange={showContext => update({ lyrics: { showContext } })} /></SettingRow>
  </SettingsGroup>
}
