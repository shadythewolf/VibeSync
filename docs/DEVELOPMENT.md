# Development

Run commands from Source. Use npm ci with a Node.js version supported by the locked dependencies. Vitest currently accepts Node 22.12+ in the 22 line, Node 24, or Node 26 and later. No global Electron or TypeScript installation is needed: the postinstall script downloads the Electron binary (Electron 44 no longer does this itself), and package.json allowScripts approves esbuild's install script. After an esbuild upgrade, run `npm install-scripts approve esbuild` again.

On Windows, if PowerShell refuses `npm` because running scripts is disabled, use `npm.cmd` (for example `npm.cmd run dev`); no execution policy change is needed.

```sh
npm run typecheck
npm run test:unit
npm run build
npm run dev
```

## Platform builds

Linux: npm run dist:linux builds the AppImage and a .deb (which depends on pulseaudio-utils) in dist. Ship scripts/install-linux.sh next to the AppImage for non-Debian distributions. Set ELECTRON_BUILDER_CACHE to a writable directory if the default cache is unavailable. Runtime audio capture needs pactl and parec.

Windows: npm run dist builds the native helper, regenerates icons and produces NSIS/portable targets. helper/build.ps1 uses the C# 5 compiler shipped with .NET Framework 4.8, Windows WinMD metadata and the included NAudio libraries. Native helper filenames stay VibeDeckHelper.exe for compatibility.

npm run icons regenerates the icon and tray assets. npm run build writes main, preload and renderer bundles to out. Release files belong in dist; dependencies, generated build output and test profiles are excluded from source archives where appropriate.

The Windows installer checks in scripts/verify-install.ps1 and scripts/verify-uninstall.ps1 use VibeSync as the product name. The expected install version defaults to package.json and can be overridden with -Version.

## Runtime conventions

TypeScript uses strict checking. Audio capture and frame scheduling are singletons. Canvas draw paths reuse buffers and gradients; UI readouts update at a lower frequency. IPC names and shared settings/types are centralized in src/shared.

spicetify/vibesync-bridge.js is bundled as an extra resource. src/main/bridgeInstaller.ts finds the Spicetify CLI (default install folder, then PATH), copies the bridge into Spicetify's user data Extensions folder, enables it and runs spicetify apply; the version shown in the UI comes from the bridge's header comment, so keep "VibeSync x.y.z" in its first line.

contextIsolation and the renderer sandbox stay enabled. Native metadata is the fallback; Spotify playback, queue and lyrics arrive through the local bridge. Preserve the legacy preload API name and environment variables when changing the implementation.

VIBEDECK_USER_DATA selects an isolated profile for tests. VIBEDECK_LOG_CONSOLE=1 mirrors main-process logs. The log file is logs/vibedeck.log within the VibeSync profile. Settings > About opens that folder.

The shipped configuration has no update feed. An HTTPS VIBEDECK_UPDATE_URL or the configured UPDATE_FEED_URL can enable update checks; downloads and installation remain manual. Do not point this fork at upstream's releases without providing compatible artifacts.

See TESTING.md for checks and INSTALLATION-DE.txt for user instructions. The workspace release pipeline is documented in the top-level README.md.
