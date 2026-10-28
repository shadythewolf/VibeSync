# VibeSync

Shady's Visualizer fork of [VibeDeck](https://github.com/dhanush-the-versatile/VibeDeck) by Amara Dhanush Kumar. The original MIT license is preserved in LICENSE. The version is defined in package.json.

VibeSync visualizes system audio on Windows and Linux. It includes album artwork colors, synchronized lyrics and an optional Up next preview. Long artist lists wrap without hiding names. The Visualizer is the only display mode.

Spotify Desktop with Spicetify and bridge 2.0.1 is the single Spotify integration. The bridge supplies title, every available artist, album, cover, playback time, duration, pause and the next song from the local queue. Playback and Up next work with lyrics disabled and update locally about once per second. There is no Developer Client ID, OAuth flow or Spotify Web API song/queue polling. Spotify lyrics and LRCLIB remain the synchronized lyric sources. Cover images and lyrics still use network requests. Native helper metadata remains a fallback for other media players.

## Install

Download the files for your system from the [latest release](https://github.com/shadythewolf/VibeSync/releases/latest).

### Windows 10/11

1. Download `VibeSync-Setup-<version>.exe` and run it.
2. Windows SmartScreen may say "Windows protected your PC", because the app is not code-signed. Click **More info**, then **Run anyway**.
3. Follow the installer. VibeSync opens when it finishes.

No installation wanted? `VibeSync-Portable.exe` runs without installing.

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

After a Spotify or VibeSync update, the same row shows **Update bridge** when needed.

More details: [Installation](docs/INSTALLATION.txt), [Lyrics and Spotify](docs/LYRICS.txt), [Updating](docs/UPDATE.txt).

## Development

Building from source needs Node.js (see below) and Git:

```sh
git clone https://github.com/shadythewolf/VibeSync.git
cd VibeSync
npm ci
npm run typecheck
npm run test:unit
npm run build
npm run dev
```

Use a Node.js version supported by the locked dependencies, such as Node 22.12+ within the 22 release line or Node 24. The installed Vitest package defines the supported versions in its engines field. On Windows, if PowerShell blocks `npm`, use `npm.cmd` instead.

Build a Linux AppImage and .deb with npm run dist:linux; scripts/install-linux.sh installs the AppImage on other distributions. Build Windows installers on Windows with npm run dist. The native Windows helper requires .NET Framework 4.8; Linux capture uses pactl and parec.

[Architecture](docs/ARCHITECTURE.md), [Development](docs/DEVELOPMENT.md) and [Testing](docs/TESTING.md) describe the current fork. Upstream's documentation is available in the linked original repository.

## Versioning

Version 2.0.0 removes the previous OAuth integration and requires bridge 2.0.0 in Spotify Desktop. This is an intentional breaking change and increments Major. Existing visualizer, colour, lyrics and queue preferences are preserved. Versions use Major.Minor.Patch: fixes increment Patch, compatible features increment Minor, and breaking changes increment Major.

Version 2.0.2 uses a neutral near-black background (#020203) with background glow off by default. Older profiles migrate the previous 55% default once; other chosen intensities and all other preferences are preserved. Bridge 2.0.0 is unchanged.

Version 2.0.3 uses app-driven local snapshots, immediate reconnection after an established session drops, bounded handshake recovery, and focus/online recovery. Install both app 2.0.3 and bridge 2.0.1. Playback timing helpers can temporarily fail without dropping the rest of the metadata. No Spotify Web API polling is added.

Version 2.0.4 prevents amplifying tiny RGB differences in near-black cover colors. Clearly colored shadows are preserved. Bridge 2.0.1 is unchanged.

Version 2.0.5 keeps black-floor artwork casts such as RGB 2,0,3 subdued and smoothly introduces chromatic amplification as dark colours become distinguishable. Existing cover-area and dark-hue handling remain; bridge 2.0.1 is unchanged.

Version 2.0.6 lowers the neutral artwork visibility floor from RGB 56 to 16 and limits white peak highlights on dark neutral regions. Existing visible greys and chromatic peak behaviour remain. Bridge 2.0.1 is unchanged.

Version 2.1.0 takes the combined area of similar small color accents into account and keeps the outer bars inside the window even at maximum bass zoom. Five colors and the measured cover shares are preserved; bridge 2.0.1 is unchanged.

The cover color order runs from light to dark. The existing mirroring turns this into light in the middle and dark at the edges.
