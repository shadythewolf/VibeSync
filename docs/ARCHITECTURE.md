# Architecture

Electron's main process owns audio capture, the local Spotify bridge, lyrics providers, settings and window state. React renders the shell and a single canvas visualizer. `src/shared` defines IPC, settings validation, types and the helper protocol.

Main process: `src/main`. Renderer: `src/renderer/src`. API and contracts: `src/shared` and `src/preload`. Build configuration: `electron.vite.config.ts` and `electron-builder.yml`.

## Audio and rendering

Windows uses `helper/bin/VibeDeckHelper.exe` with NAudio WASAPI loopback and native media metadata. Linux uses `linux-helper/vibedeck-linux-helper.cjs` with `pactl` and `parec`. Chromium loopback capture is the fallback when the helper is unavailable.

AudioService forwards PCM through the preload API. The singleton AudioEngine analyzes the samples (spectrum, beat and tempo), and FrameScheduler drives VisualizerRenderer through ModeCanvas, so React does not re-render for each audio frame.

Artwork palettes come from the current track. VisualizerOverlay renders the current song, progress and Up next. Long artist lists wrap; wrapped credits reserve space above the lyrics. Lyrics use the same interpolated track position as the progress bar.

## Spotify bridge

`spicetify/vibesync-bridge.js` runs inside Spotify Desktop and connects to a WebSocket server on `127.0.0.1:43821` owned by LyricsService. On connect it sends a hello packet with its version and capabilities (playback, queue, lyrics, refresh); bridges missing a capability are shown as needing an update.

The app requests playback and queue snapshots once per second. The bridge reads the native player state (with `Player.data` as fallback) and `Queue.nextTracks`, so no Spotify Web API polling is involved. Playback and queue data each expire after ten seconds without fresh packets. WebSocket ping/pong checks transport health independently of Spotify's page timers, which Spotify throttles in the background. Dropped sessions reconnect immediately; failed handshakes retry with a bounded timeout, and focus, online and visibility events recover half-open connections.

MetadataService prefers bridge playback and falls back to native helper metadata. Cover URLs are restricted to Spotify image hosts and downloaded into renderer-safe data URLs with a bounded cache; a late download cannot overwrite a newer song. Local files and podcast episodes get stable playback IDs, and a next episode is shown as such instead of being skipped.

The bridge also sends synchronized lyric lines per track ID. LyricsService applies only lyrics that match the current track and falls back to LRCLIB, caching results on disk. The `/vibedeck` WebSocket path is still accepted for VibeDeck-era extensions.

`src/main/bridgeInstaller.ts` installs the bridge through the Spicetify CLI (see DEVELOPMENT.md).

## Storage and boundaries

SettingsStore validates and persists settings; unknown or obsolete fields are dropped during validation. Artwork and lyrics caches are optional. Window and GPU state are handled separately from audio processing.

Renderer code reaches main-process services only through `window.vibedeck`. The MIT license and upstream attribution remain intact.

Screen wake protection uses Electron's `powerSaveBlocker` (prevent-display-sleep) only while the main window is focused, visible and not minimized. It releases on blur, hide, minimize, close and shutdown, and the General setting can turn it off.
