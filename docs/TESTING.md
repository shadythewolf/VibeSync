# Testing

## Automated checks

`npm run typecheck`, `npm run test:unit` and `npm run build`.

Unit tests (`tests/unit`) cover the audio algorithms, the capture protocol, settings validation and migration, artwork palettes, bridge metadata and the queue, lyrics fallback and cache, bridge transport and reconnection, and the Spicetify bridge installer. Migration tests use setting names from the original app to verify that older profiles are normalized safely.

`bridgeRecoveryTransport.test.ts` runs the real bridge extension and services over a local WebSocket while never executing Spotify page timers. It simulates six minutes of snapshots, pause/resume, song and queue changes, then a forced abnormal disconnect and immediate reconnect. Other unit checks cover stale snapshots despite healthy pongs, failing player getters, handshake timeouts and focus recovery.

Artwork color regressions use real cover histograms from `tests/fixtures`: near-black covers (all RGB channel permutations and a smooth ramp out of the black floor), small accent colors that must be kept without inflating their coverage, the light-to-dark color order, and outer bars staying inside the window at maximum bass zoom.

`npm run test:e2e` runs Playwright Electron tests against `out`: startup, the visualizer, fullscreen, settings, persistence, audio status and renderer errors. Each test uses `VIBEDECK_USER_DATA` with an isolated profile; results go to `test-results`. Setting `VIBESYNC_BRIDGE_TEST_PORT=0` together with `VIBEDECK_USER_DATA` binds the bridge server to an ephemeral port so a real Spotify extension cannot interfere. Normal launches always use 43821.

## Hardware and platform checks

`npm run test:integration` runs the native Windows loopback test; it needs a playback device and a built helper. `npm run qa:fps` measures the visualizer at 1920x1080 with audio playing. `npm run qa:smoothness` profiles what averages hide: frame-time percentiles, long tasks and how evenly audio chunks arrive (choppy bars with a steady frame rate usually mean sparse or bunched chunks).

`scripts/verify-install.ps1` and `scripts/verify-uninstall.ps1` check an installed Windows build.

Tests with fixtures do not prove a live Spotify session, real lyrics availability or a native launch on each platform. Check those manually before a release:

- Play system audio and confirm the visualizer reacts.
- With Spotify: install the bridge from Settings › Spotify, then verify title, all artists, cover, pause and seek, queue changes, a song without synchronized lyrics and a long artist list.
- Quit and relaunch to confirm settings are saved.

On Linux, test both the .deb and `install-linux.sh` on a current Ubuntu.

## UI test IDs

`app-root` has `data-mode=visualizer`. `settings-button` and `settings-close` control the settings panel. `lyrics-enabled`, `spotify-show-next` and `bridge-install` are in the Spotify tab. `spotify-next-track`, `viz-track`, `viz-progress` and `lyrics` identify the visible readouts.
