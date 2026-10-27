# Third-party notices

VibeDeck bundles or depends on the following components. Each remains under its own licence.

| Component | Licence | Used for |
| --- | --- | --- |
| [NAudio](https://github.com/naudio/NAudio) (Mark Heath) | MIT | WASAPI loopback capture in the native helper. `NAudio.Core.dll` and `NAudio.Wasapi.dll` are redistributed in `helper/lib/` and shipped inside the installer. |
| [Electron](https://github.com/electron/electron) | MIT | Application runtime (bundles Chromium, BSD-style, and Node.js, MIT). |
| [React](https://github.com/facebook/react) / React DOM | MIT | User interface. |
| [zustand](https://github.com/pmndrs/zustand) | MIT | State stores. |
| [electron-vite](https://github.com/alex8088/electron-vite), [Vite](https://github.com/vitejs/vite), [TypeScript](https://github.com/microsoft/TypeScript) | MIT / Apache-2.0 | Build tooling (development only). |
| [electron-builder](https://github.com/electron-userland/electron-builder) + NSIS | MIT / zlib | Installer and portable packaging (development only). |
| [Vitest](https://github.com/vitest-dev/vitest), [Playwright](https://github.com/microsoft/playwright), [sharp](https://github.com/lovell/sharp) | MIT / Apache-2.0 | Tests and icon generation (development only). |

The helper is compiled with the C# compiler included in the .NET Framework that ships with
Windows; no Microsoft components are redistributed by this project.
