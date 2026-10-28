import type { ReactElement } from 'react'
import { Toggle } from '@renderer/components/ui/Toggle'
import { useSpotifyQueueStore } from '@renderer/store/spotifyQueueStore'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { LyricsSettings } from '../LyricsSettings'
import { SettingRow, SettingsGroup } from '../SettingRow'

export function SpotifyTab(): ReactElement {
  const showNextTrack = useSettingsStore(s => s.settings.spotify.showNextTrack)
  const queueError = useSpotifyQueueStore(s => s.state.error)
  const update = useSettingsStore(s => s.update)
  return <>
    <SettingsGroup bare children={null} title="Spotify playback" description="The VibeSync bridge supplies song details, all available artists, album artwork, playback time and Up Next from Spotify Desktop. Use Spotify bridge setup below to install it with Spicetify; it connects automatically." />
    <LyricsSettings />
    <SettingsGroup title="Up next" description="Shows the next song from Spotify's local queue, with its artists and cover. Updates about once per second, including queue reordering.">
      <SettingRow label="Show next song" description={queueError || 'Appears in the lower right when Spotify has a next song. The bridge also supplies it with lyrics disabled.'}>
        <Toggle label="Enable next song" checked={showNextTrack} onChange={showNextTrack => update({ spotify: { showNextTrack } })} data-testid="spotify-show-next" />
      </SettingRow>
    </SettingsGroup>
  </>
}

export default SpotifyTab
