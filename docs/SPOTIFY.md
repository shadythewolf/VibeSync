# Spotify bridge

VibeSync gets Spotify data through a small [Spicetify](https://spicetify.app) extension, the bridge (`spicetify/vibesync-bridge.js`). It runs inside Spotify Desktop and sends the current song, all artists, album, cover, playback position, pause state, the next song in your queue and Spotify's synchronized lyrics to VibeSync.

The connection stays on your computer (`ws://127.0.0.1:43821/vibesync`). There is no Spotify developer app, Client ID or separate sign-in, and your Spotify credentials never reach VibeSync. The bridge reads the queue locally and makes no Spotify Web API requests for songs or the queue.

## Requirements

- Spotify Desktop, signed in. On Linux, use Spotify's own package (`spotify-client` from repository.spotify.com); Spicetify does not support the Snap or Flatpak.
- [Spicetify](https://spicetify.app/docs/getting-started) installed.

## Install or update

Open **Settings › Spotify** in VibeSync and click **Install bridge** or **Update bridge**. VibeSync copies the bundled bridge into Spicetify, enables it and applies it. Spotify restarts once and connects automatically.

### Manual install

If the button reports an error, the same steps by hand:

1. Quit Spotify.
2. Find Spicetify's user data folder:
   ```sh
   spicetify path userdata
   ```
3. Copy `vibesync-bridge.js` into the `Extensions` folder inside it. On Windows it is in `resources\spicetify` of the VibeSync install folder; on Linux in `/opt/VibeSync/resources/spicetify`, or in this repository under `spicetify/`.
4. Enable and apply it:
   ```sh
   spicetify config extensions vibesync-bridge.js
   spicetify apply
   ```
5. Start Spotify and VibeSync.

## Troubleshooting

**"Spotify version and backup version are mismatched"**: Spotify updated itself. Run `spicetify backup apply`. The Install/Update bridge button does this automatically.

**"Preprocessed data is outdated"**: run `spicetify restore backup apply`.

**Settings shows "Waiting for Spotify"**: Spotify Desktop must be open with the bridge applied. After a Spotify update, Spicetify's changes are removed; click **Update bridge** or run `spicetify backup apply`.

**No lyrics for a song**: not every song has synchronized lyrics. VibeSync tries Spotify first, then LRCLIB.

**Lyrics slightly early or late**: adjust **Sync offset** under Settings › Spotify. Positive values show lyrics earlier.

When the bridge disconnects or sends no playback data for ten seconds, VibeSync clears the old song and reconnects on its own. Other media players still show song details through the system's media controls on Windows.

## Remove

```sh
spicetify config extensions vibesync-bridge.js-
spicetify apply
```

Then delete `vibesync-bridge.js` from Spicetify's `Extensions` folder.
