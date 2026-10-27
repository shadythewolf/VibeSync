# Testing

## Automated checks

Run npm run typecheck, npm run test:unit and npm run build from Source. Unit tests cover audio algorithms, capture protocol, settings migration, artwork palettes, local bridge metadata, the local queue, lyrics fallback/cache and bridge transport/reconnection. Old-mode names in migration tests verify that saved settings from the original app are safely normalized.

npm run test:e2e runs Playwright Electron tests against out. The suite checks startup, the single Visualizer, fullscreen, settings, persistence, audio status and renderer errors. Each test uses VIBEDECK_USER_DATA with an isolated profile. Test results and failure diagnostics are stored in test-results.

The workspace additionally runs work/check-app.cjs against the packaged Linux AppImage. It checks Spotify-only lyrics controls, complete artists, queue matching/empty states, the queue toggle, bottom-right placement and wrapping of long artist lists in two window sizes. Its current screenshots are stored under work/qa-results. Metadata and lyrics in those checks are fixtures, not a live Spotify account.

## Hardware and platform checks

npm run test:integration runs the native Windows loopback test. It needs a Windows playback endpoint and a built helper. npm run qa:fps measures the Visualizer at 1920x1080 with audio playing; it no longer looks for removed DJ mode buttons.

Windows installer checks: scripts/verify-install.ps1 and scripts/verify-uninstall.ps1. These concern installed NSIS builds, not the unpacked Windows runtime in the combined ZIP.

A successful build or fixture test does not prove a live Spotify desktop session, real lyrics availability or a native Windows launch. Report those checks separately. A local test-only --no-sandbox argument may be needed in restricted Linux environments; it is not the normal user launch command.

## Current UI contracts

app-root has data-mode=visualizer. settings-button and settings-close control the settings panel. The settings tabs include Spotify. lyrics-enabled occurs only in that tab. spotify-show-next controls the preview. spotify-next-track, viz-track, viz-progress and lyrics identify the visible readouts. There are no mode-selector buttons or BPM readout.

Manual release check: play system audio, verify current title/all artists/cover, pause and seek, change the queue, test a track without synchronized lyrics, change a long artist list, then quit and relaunch to verify saved settings.

Bridge tests cover complete artists, queue reordering, wrapped ProvidedTracks, empty and unavailable queues, episode ordering, lyrics disabled, shared artwork caching, stale data, native metadata fallback and actual WebSocket playback/queue packets. Release validation asserts that api.spotify.com, accounts.spotify.com and Client ID controls are absent from the built package.

The packaged QA profile sets VIBESYNC_BRIDGE_TEST_PORT=0 with VIBEDECK_USER_DATA to bind an ephemeral loopback port. This keeps the real Spotify extension from replacing IPC fixtures. Normal launches always use 43821.

bridgeRecoveryTransport.test.ts runs the actual extension and services over a real local WebSocket while deliberately never executing Spotify page timers. It covers six simulated minutes of snapshots, pause/resume, song and queue changes, then forced abnormal disconnection and immediate reconnection. This is a controlled transport regression, not a long live Spotify session. Unit checks also cover stale snapshots despite healthy pongs, failed public/native getters, handshake timeout and focus recovery.

The Re_Jaded histogram regression checks the real RGB 2,0,3 majority, neutral coverage and retained green accent. Near-black tests cover all channel permutations and a smooth gain ramp out of the black floor, while existing navy, red, green and cover-area regressions remain. Packaged renderer QA saves qa-re-jaded-rendered.png and checks actual bar pixels.

Dark-neutral visibility tests enforce the RGB 16 floor and bound Re_Jaded majority-region brightness both at normal height and at peaks. Renderer QA samples actual near-black bars at high amplitude; existing chromatic and mid-grey peak checks remain.

Never Say Die Vol. 7 regression checks retain its small blue-violet family without enlarging its measured coverage. Adjacent sub-percent shades are tested alongside isolated noise. Renderer QA checks outer bars at maximum bass zoom with/without mirroring at 320 and 1280 pixels wide, using real painted pixels and viewport bounds.

Brightness-order checks verify a single descending artwork gradient with unchanged coverage. Actual canvas checks verify bright-left/dark-right without mirroring, and bright-centre/dark-edges through the existing mirrored renderer. The QA fixture waits for native capture startup before injecting song and lyric readouts.
