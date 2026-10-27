# VibeSync architecture

Electron owns capture, the local Spotify bridge, lyrics providers, settings and window state. React renders the shell and a single Canvas Visualizer. src/shared defines IPC, settings validation, types and the helper protocol.

## Audio and rendering

Windows uses helper/bin/VibeDeckHelper.exe with NAudio WASAPI loopback and native media metadata. Linux uses linux-helper/vibedeck-linux-helper.cjs with pactl and parec. The Chromium loopback source is the fallback when the selected capture path supports it.

AudioService forwards PCM through the preload API. The singleton AudioEngine analyzes the samples, and FrameScheduler drives VisualizerRenderer through ModeCanvas. React does not update for each audio frame. Beat/tempo analysis remains part of the audio engine even though the BPM text readout is removed.

Artwork palettes come from the current track. VisualizerOverlay renders the current song, progress and Up next. Artist names wrap; wrapped current-song credits reserve space above lyrics. Lyrics uses the same interpolated track position as playback progress.

## Metadata and queue

The Spicetify extension reads the native player state (with Player.data fallback), playback methods and Queue.nextTracks from Spotify Desktop in response to app requests each second. Separate playback and queue packets carry current metadata and the actual next item without Web API polling. MetadataService prefers current bridge playback, then native helper metadata. LyricsService owns the local socket, queue IPC, validated playback and bounded artwork downloads into data URLs.

The renderer retains SpotifyQueueState and its matching-current-track guard. Empty or unavailable queues, disconnects and stale data clear the preview. Queue settings apply even with lyrics disabled. Queue and current artwork share a bounded cache; late downloads cannot overwrite a changed song or queue.

## Lyrics

spicetify/vibesync-bridge.js connects to the loopback WebSocket and sends lyric lines, resolution status and a track ID. LyricsService buffers these results by ID, applies only matching lyrics and uses LRCLIB when needed. WebSocket ping/pong verifies transport health independently of Spotify JavaScript timers. The legacy /vibedeck route is retained for compatible extensions.

## Storage and boundaries

SettingsStore validates and persists settings. Obsolete OAuth settings are dropped during validation; old auth files are not read. Artwork and lyrics caches are optional. Window and GPU state are handled separately from audio processing.

Renderer code accesses main-process services only through window.vibedeck. This API name, VIBEDECK_USER_DATA and the helper filenames are retained for compatibility. They do not indicate a second application or a legacy display mode. The MIT license and upstream attribution remain intact.

Main process: src/main. Renderer: src/renderer/src. API and contracts: src/shared and src/preload. Build configuration: electron.vite.config.ts and electron-builder.yml.

Screen wake protection uses Electron powerSaveBlocker with prevent-display-sleep only while the main window is focused, visible and not minimized. The guard releases on blur, hide, minimize, close and shutdown; the General setting can disable it immediately.

## Bridge protocol (2.0)

A hello packet reports the bridge version and playback/queue/lyrics capabilities. Older extensions are marked for update. Playback and queue each expire after ten seconds without fresh packets; transport ping/pong remains independent of JavaScript timers. Legacy track packets supply only lyrics, while modern playback packets are authoritative. Cover URLs are restricted to Spotify image hosts and converted into renderer-safe data URLs. Local files and episodes have stable playback IDs; a next episode is never skipped to show a later song.

The direct Spotify OAuth service and its IPC methods no longer exist. Spotify data requires the desktop client with the updated extension. Audio capture, visualizer colours and focused screen wake protection remain independent of Spotify.

Bridge 2.0.1 advertises refresh capability. App config enables requestSnapshots and a one-second app-owned timer requests local playback and queue snapshots. The page timer remains a compatibility fallback. Expired playback or an announced session that never delivers playback triggers transport termination and recovery. Configured sessions reconnect directly on close; failed handshakes use a bounded timeout and retry. Focus, online and visibility events recover half-open sessions. Timing getter failures use native state without discarding metadata.
