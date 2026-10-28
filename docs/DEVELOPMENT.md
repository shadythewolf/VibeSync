# Development

Use Node.js 22.12+ (22 line) or 24 and run `npm ci`. No global Electron or TypeScript installation is needed: the `postinstall` script downloads the Electron binary, and `allowScripts` in package.json approves esbuild's install script. After an esbuild upgrade, run `npm install-scripts approve esbuild` again.

On Windows, if PowerShell refuses `npm` because running scripts is disabled, use `npm.cmd` (for example `npm.cmd run dev`); no execution policy change is needed.

```sh
npm run typecheck
npm run test:unit
npm run build
npm run dev
```

In development on Windows, audio falls back to Chromium loopback capture until the native helper is built with `npm run helper:build`.

## Platform builds

Windows: `npm run dist` builds the native helper, regenerates icons and produces the NSIS installer and portable executable in `dist`. `helper/build.ps1` uses the C# compiler shipped with .NET Framework 4.8, Windows WinMD metadata and the included NAudio libraries.

Linux: `npm run dist:linux` builds the AppImage and a .deb (which depends on `pulseaudio-utils`) in `dist`. Set `ELECTRON_BUILDER_CACHE` to a writable directory if the default cache is unavailable. Ship `scripts/install-linux.sh` next to the AppImage for non-Debian distributions.

`npm run icons` regenerates the icon and tray assets. `npm run build` writes the main, preload and renderer bundles to `out`.

`scripts/verify-install.ps1` and `scripts/verify-uninstall.ps1` check an installed Windows build. The expected version defaults to package.json and can be overridden with `-Version`.

## Releases

Bump `version` in package.json, build on Windows (`npm run dist`) and on Linux (`npm run dist:linux`), then attach `VibeSync-Setup-<version>.exe`, `VibeSync-Portable.exe`, `VibeSync-Linux-<version>.deb`, `VibeSync-Linux-<version>.AppImage`, `scripts/install-linux.sh` and a `SHA256SUMS.txt` to a GitHub release tagged `v<version>`. Versions follow semantic versioning: fixes increment Patch, compatible features Minor, breaking changes Major.

## Runtime conventions

TypeScript uses strict checking. Audio capture and frame scheduling are singletons. Canvas draw paths reuse buffers and gradients; UI readouts update at a lower frequency. IPC names and shared settings/types are centralized in `src/shared`.

`contextIsolation` and the renderer sandbox stay enabled. Native metadata is the fallback; Spotify playback, queue and lyrics arrive through the local bridge.

`spicetify/vibesync-bridge.js` is bundled as an extra resource. `src/main/bridgeInstaller.ts` finds the Spicetify CLI (default install folder, then PATH), copies the bridge into Spicetify's user data Extensions folder, enables it and runs `spicetify apply` (falling back to `backup apply` and `restore backup apply`). The version shown in the UI comes from the bridge's header comment, so keep "VibeSync x.y.z" in its first line.

Some internal names come from VibeDeck and are kept so existing profiles keep working: the renderer API `window.vibedeck`, the helper file names (`VibeDeckHelper.exe`, `vibedeck-linux-helper.cjs`) and the environment variables below.

`VIBEDECK_USER_DATA` selects an isolated profile for tests. `VIBEDECK_LOG_CONSOLE=1` mirrors main-process logs. The log file is `logs/vibedeck.log` in the VibeSync profile; Settings › About opens that folder.

The app ships without an update feed. An HTTPS `VIBEDECK_UPDATE_URL` or the configured `UPDATE_FEED_URL` can enable update checks; downloads and installation remain manual.

See [TESTING.md](TESTING.md) for checks and [ARCHITECTURE.md](ARCHITECTURE.md) for how the parts fit together.
