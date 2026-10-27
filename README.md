# VibeSync

Shady's Visualizer fork of [VibeDeck](https://github.com/dhanush-the-versatile/VibeDeck) by Amara Dhanush Kumar. The original MIT license is preserved in LICENSE. The version is defined in package.json.

VibeSync visualizes system audio on Windows and Linux. It includes album artwork colors, synchronized lyrics and an optional Up next preview. Long artist lists wrap without hiding names. The Visualizer is the only display mode.

Spotify Desktop with Spicetify and bridge 2.0.1 is the single Spotify integration. The bridge supplies title, every available artist, album, cover, playback time, duration, pause and the next song from the local queue. Playback and Up next work with lyrics disabled and update locally about once per second. There is no Developer Client ID, OAuth flow or Spotify Web API song/queue polling. Spotify lyrics and LRCLIB remain the synchronized lyric sources. Cover images and lyrics still use network requests. Native helper metadata remains a fallback for other media players.

## Start and development

End-user instructions: [Installation](docs/INSTALLATION-DE.txt), [Lyrics](docs/LYRICS-DE.txt), [Updates](docs/UPDATE-DE.txt).

```sh
npm ci
npm run typecheck
npm run test:unit
npm run build
npm run dev
```

Use a Node.js version supported by the locked dependencies, such as Node 22.12+ within the 22 release line or Node 24. The installed Vitest package defines the supported versions in its engines field.

Build a Linux AppImage with npm run dist:linux. Build Windows installers on Windows with npm run dist. The native Windows helper requires .NET Framework 4.8; Linux capture uses pactl and parec.

[Architecture](docs/ARCHITECTURE.md), [Development](docs/DEVELOPMENT.md) and [Testing](docs/TESTING.md) describe the current fork. Upstream's documentation is available in the linked original repository.

## Versioning

Version 2.0.0 removes the previous OAuth integration and requires bridge 2.0.0 in Spotify Desktop. This is an intentional breaking change and increments Major. Existing visualizer, colour, lyrics and queue preferences are preserved. Versions use Major.Minor.Patch: fixes increment Patch, compatible features increment Minor, and breaking changes increment Major.

Version 2.0.2 uses a neutral near-black background (#020203) with background glow off by default. Older profiles migrate the previous 55% default once; other chosen intensities and all other preferences are preserved. Bridge 2.0.0 is unchanged.

Version 2.0.3 uses app-driven local snapshots, immediate reconnection after an established session drops, bounded handshake recovery, and focus/online recovery. Install both app 2.0.3 and bridge 2.0.1. Playback timing helpers can temporarily fail without dropping the rest of the metadata. No Spotify Web API polling is added.

Version 2.0.4 verhindert die Verstärkung minimaler RGB-Unterschiede bei nahezu schwarzen Coverfarben. Eindeutig farbige Schatten bleiben erhalten. Bridge 2.0.1 ist unverändert.

Version 2.0.5 keeps black-floor artwork casts such as RGB 2,0,3 subdued and smoothly introduces chromatic amplification as dark colours become distinguishable. Existing cover-area and dark-hue handling remain; bridge 2.0.1 is unchanged.

Version 2.0.6 lowers the neutral artwork visibility floor from RGB 56 to 16 and limits white peak highlights on dark neutral regions. Existing visible greys and chromatic peak behaviour remain. Bridge 2.0.1 is unchanged.

Version 2.1.0 berücksichtigt die gemeinsame Fläche ähnlicher kleiner Farbakzente und hält äußere Balken auch beim maximalen Bass-Zoom im Fenster. Fünf Farben und gemessene Coveranteile bleiben erhalten; Bridge 2.0.1 ist unverändert.

Die Cover-Farbfolge läuft von hell nach dunkel. Die vorhandene Spiegelung ergibt daraus automatisch hell in der Mitte und dunkel außen.
