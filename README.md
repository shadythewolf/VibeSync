# VibeSync

VibeSync is a music visualizer for Windows and Linux. It listens to whatever your computer is playing and turns it into a live spectrum, without plugins and without ever opening the microphone.

Connect Spotify Desktop and it also shows the current song, colors the visualizer from the album artwork, previews the next song and displays synchronized lyrics.

VibeSync is a fork of [VibeDeck](https://github.com/dhanush-the-versatile/VibeDeck) by Amara Dhanush Kumar.

## Features

- Reacts to any audio app: Spotify, browsers, games, video players
- Album artwork colors for the visualizer
- Current song with all artists, playback progress and an Up next preview
- Synchronized lyrics from Spotify, with [LRCLIB](https://lrclib.net) as fallback
- Fullscreen, always on top, tray mode and keeping the screen awake while it has focus

## Install

Download the files for your system from the [latest release](https://github.com/shadythewolf/VibeSync/releases/latest).

### Windows 10/11

1. Download `VibeSync-Setup-<version>.exe` and run it.
2. Windows SmartScreen may say "Windows protected your PC", because the app is not code-signed. Click **More info**, then **Run anyway**.
3. Click **Install**. **Options** lets you pick the folder and skip the desktop shortcut. When it finishes, click **Launch VibeSync**.

No installation wanted? `VibeSync-Portable.exe` runs without installing. The release also lists `VibeSync-Package-<version>.exe`: that's what the built-in updater downloads, so you don't need it.

To uninstall, go to **Settings › Apps › Installed apps**, open the menu next to VibeSync and click **Uninstall**. Choose **Keep my settings** if you might come back, or **Remove everything** to also delete your settings, caches, logs and the Spotify bridge.

For scripted installs, `VibeSync-Setup-<version>.exe /S` installs silently (add `/D=<folder>` as the last argument to choose the folder).

### Linux (x86_64)

**Ubuntu, Debian, Linux Mint, Pop!_OS:** download `VibeSync-Linux-<version>.deb` and install it by double-clicking, or in a terminal:

```sh
sudo apt install ./VibeSync-Linux-<version>.deb
```

This adds VibeSync to your app menu and installs the audio tools it needs (`pactl`, `parec`).

**Other distributions:** download `VibeSync-Linux-<version>.AppImage` and `install-linux.sh` into the same folder, then run:

```sh
sh install-linux.sh
```

It installs VibeSync for your user (no root needed), adds a menu entry and a `vibesync` command, handles missing FUSE, and offers to install missing audio tools. Remove it again with `sh install-linux.sh --uninstall`.

System audio capture needs PulseAudio or PipeWire, which almost every desktop distribution uses.

### Connect Spotify (optional)

VibeSync visualizes any audio without this. Connecting Spotify adds song details, album artwork colors, Up next and synchronized lyrics.

1. Install [Spotify Desktop](https://www.spotify.com/download/) and sign in once. On Linux, use Spotify's own package, not the Snap or Flatpak.
2. Install [Spicetify](https://spicetify.app/docs/getting-started).
3. In VibeSync, open **Settings › Spotify** and click **Install bridge** (also offered on first launch). Spotify restarts once and connects automatically.

How the bridge works, manual setup and troubleshooting: [docs/SPOTIFY.md](docs/SPOTIFY.md).

### Updating

From version 2.2.0, VibeSync checks GitHub for new releases at startup and every few hours. When one is available, a banner offers **Download and install**; once downloaded, **Restart to update** installs it and keeps your settings. Nothing is downloaded or installed without your click, and the check can be turned off under **Settings › General**. On Linux, updating the .deb asks for your password.

The portable version cannot replace itself: its banner opens the download page instead. Versions before 2.2.0 have no update check, so install 2.2.0 manually once.

If **Settings › Spotify** shows **Update bridge** after an update, click it.

## Privacy

- Audio is captured and analyzed locally. Nothing is recorded or uploaded, and the microphone is never used.
- The Spotify bridge talks to VibeSync only on your own computer (`127.0.0.1`). Your Spotify login never reaches VibeSync.
- Network requests: album covers from Spotify's image servers, lyrics from Spotify and LRCLIB, and the update check against this repository's GitHub releases. There is no telemetry.

## Development

Building from source needs Git and Node.js 22.12+ or 24:

```sh
git clone https://github.com/shadythewolf/VibeSync.git
cd VibeSync
npm ci
npm run dev
```

On Windows, if PowerShell blocks `npm`, use `npm.cmd` instead.

| Command | Does |
|---|---|
| `npm run typecheck` | TypeScript checks |
| `npm run test:unit` | Unit tests |
| `npm run dist` | Windows installer and portable build (needs .NET Framework 4.8 for the audio helper) |
| `npm run dist:linux` | Linux AppImage and .deb (run on Linux) |

More in [Development](docs/DEVELOPMENT.md), [Architecture](docs/ARCHITECTURE.md) and [Testing](docs/TESTING.md).

## License

MIT, see [LICENSE](LICENSE). Third-party notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
