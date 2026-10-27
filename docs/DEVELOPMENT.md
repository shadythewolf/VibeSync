# Development

Run commands from Source. Use npm ci with a Node.js version supported by the locked dependencies. Vitest currently accepts Node 22.12+ in the 22 line, Node 24, or Node 26 and later. No global Electron or TypeScript installation is needed.

```sh
npm run typecheck
npm run test:unit
npm run build
npm run dev
```

## Platform builds

Linux: npm run dist:linux builds the AppImage in dist. Set ELECTRON_BUILDER_CACHE to a writable directory if the default cache is unavailable. Runtime audio capture needs pactl and parec.

Windows: npm run dist builds the native helper, regenerates icons and produces NSIS/portable targets. helper/build.ps1 uses the C# 5 compiler shipped with .NET Framework 4.8, Windows WinMD metadata and the included NAudio libraries. Native helper filenames stay VibeDeckHelper.exe for compatibility.

npm run icons regenerates the icon and tray assets. npm run build writes main, preload and renderer bundles to out. Release files belong in dist; dependencies, generated build output and test profiles are excluded from source archives where appropriate.

The Windows installer checks in scripts/verify-install.ps1 and scripts/verify-uninstall.ps1 use VibeSync as the product name. The expected install version defaults to package.json and can be overridden with -Version.

## Runtime conventions

TypeScript uses strict checking. Audio capture and frame scheduling are singletons. Canvas draw paths reuse buffers and gradients; UI readouts update at a lower frequency. IPC names and shared settings/types are centralized in src/shared.

contextIsolation and the renderer sandbox stay enabled. Native metadata is the fallback; Spotify playback, queue and lyrics arrive through the local bridge. Preserve the legacy preload API name and environment variables when changing the implementation.

VIBEDECK_USER_DATA selects an isolated profile for tests. VIBEDECK_LOG_CONSOLE=1 mirrors main-process logs. The log file is logs/vibedeck.log within the VibeSync profile. Settings > About opens that folder.

The shipped configuration has no update feed. An HTTPS VIBEDECK_UPDATE_URL or the configured UPDATE_FEED_URL can enable update checks; downloads and installation remain manual. Do not point this fork at upstream's releases without providing compatible artifacts.

See TESTING.md for checks and INSTALLATION-DE.txt for user instructions. The workspace release pipeline is documented in the top-level README.md.
