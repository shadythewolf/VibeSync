/* VibeSync 2.0.1 local Spotify playback, queue and lyrics bridge. No Spotify credentials leave this client. */
(async function vibeSyncBridge() {
  if (globalThis.__vibeSyncBridge || globalThis.__vibeDeckBridge) return;
  globalThis.__vibeSyncBridge = true;
  // Shared guard keeps the legacy extension from starting a second socket in this page.
  globalThis.__vibeDeckBridge = true;
  while (!globalThis.Spicetify?.Player?.addEventListener || !Spicetify.Platform) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const ADDRESS = 'ws://127.0.0.1:43821/vibesync';
  const HOST = 'https://spclient.wg.spotify.com/color-lyrics/v2';
  let socket = null, enabled = false, uri = '', generation = 0;
  let reconnectTimer = null;
  let connectedAt = 0, lastControlAt = 0, requestSnapshots = false;
  const cache = new Map();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const send = packet => {
    const active = socket;
    if (active?.readyState === WebSocket.OPEN) {
      try { active.send(JSON.stringify(packet)); } catch { active.close(); }
    }
  };
  const timed = promise => Promise.race([promise, sleep(4000).then(() => { throw new Error('Lyrics timeout'); })]);
  function parse(body) {
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return null; } }
    const lyrics = body?.lyrics;
    if (!['LINE_SYNCED', 'SYLLABLE_SYNCED'].includes(lyrics?.syncType) || !Array.isArray(lyrics.lines)) return null;
    const lines = lyrics.lines.map(line => ({ timeMs: Number(line.startTimeMs), text: String(line.words || '') }))
      .filter(line => Number.isFinite(line.timeMs) && line.timeMs >= 0);
    return lines.some(line => line.text.trim()) ? lines : null;
  }
  async function spotifyLyrics(id) {
    // New Spotify clients use RequestBuilder; older clients can use CosmosAsync.
    try {
      const result = await timed(Spicetify.Platform.RequestBuilder.build()
        .withHost(HOST).withPath(`/track/${id}`)
        .withQueryParameters({ format: 'json', vocalRemoval: false, market: 'from_token' })
        .withEndpointIdentifier('/track/{trackId}').send());
      const lines = parse(result?.body);
      if (lines) return lines;
    } catch { /* next compatible transport */ }
    try {
      const token = Spicetify.Platform.AuthorizationAPI.getState().token.accessToken;
      const response = await fetch(`${HOST}/track/${id}?format=json&vocalRemoval=false&market=from_token`, {
        signal: AbortSignal.timeout(4000),
        headers: { Authorization: `Bearer ${token}`, 'App-Platform': Spicetify.Platform.PlatformData?.app_platform || 'Win32_x86_64', 'Spotify-App-Version': Spicetify.Platform.version || '' }
      });
      if (response.ok) { const lines = parse(await response.json()); if (lines) return lines; }
    } catch { /* older Spotify transport */ }
    try { return parse(await timed(Spicetify.CosmosAsync.get(`${HOST}/track/${id}?format=json&market=from_token`))); }
    catch { return null; }
  }
  function playerState() {
    // The public snapshot may temporarily disappear or lag behind the native player.
    try {
      const state = Spicetify.Player.origin?._state;
      if (state?.item) return state;
    } catch { /* public snapshot remains available during native player replacement */ }
    return Spicetify.Player.data;
  }
  function trackId() {
    return playerState()?.item?.uri?.match(/^spotify:track:([a-zA-Z0-9]{22})$/)?.[1] || '';
  }
  function localTrack(raw) {
    const item = raw?.contextTrack || raw;
    if (!item?.uri) return null;
    const id = item.uri.match(/^spotify:track:([a-zA-Z0-9]{22})$/)?.[1] || '';
    if (!id && !/^(spotify:episode:[a-zA-Z0-9]{22}|spotify:local:)/.test(item.uri)) return null;
    const metadata = item.metadata || {};
    const names = (Array.isArray(item.artists) ? item.artists.map(artist => artist.name) : []).filter(Boolean);
    for (const key of Object.keys(metadata).filter(key => /^artist_name(?::?\d+)?$/.test(key))
      .sort((a, b) => Number(a.replace('artist_name', '').replace(':', '') || 0) - Number(b.replace('artist_name', '').replace(':', '') || 0))) {
      if (metadata[key] && !names.includes(metadata[key])) names.push(metadata[key]);
    }
    let artwork = metadata.image_xlarge_url || metadata.image_large_url || metadata.image_url || item.album?.images?.[0]?.url || '';
    if (artwork.startsWith('spotify:image:')) artwork = 'https://i.scdn.co/image/' + artwork.slice(14);
    const title = metadata.title || item.name || '';
    if (!title) return null;
    return { trackId: id, uri: item.uri, title, artists: names,
      album: metadata.album_title || item.album?.name || '', artworkUrl: artwork };
  }
  function playback() {
    // Read the already loaded client state, without Spotify Web API polling.
    try {
      const player = Spicetify.Player, state = playerState(), item = state?.item;
      if (!item) { send({ type: 'playback', available: false }); return; }
      const track = localTrack(item);
      if (!track) return;
      const readNumber = (read, fallback) => {
        try { const value = Number(read()); if (Number.isFinite(value) && value >= 0) return value; } catch { /* native state below */ }
        const value = Number(fallback); return Number.isFinite(value) && value >= 0 ? value : 0;
      };
      let paused = state.isPaused !== false;
      try { paused = !player.isPlaying(); } catch { /* native state remains authoritative */ }
      const position = Number(state.positionAsOfTimestamp || 0) + (!paused && Number.isFinite(state.timestamp) ? Math.max(0, Date.now() - state.timestamp) : 0);
      send({ type: 'playback', available: true, ...track,
        durationMs: readNumber(() => player.getDuration(), state.duration || item.metadata?.duration),
        positionMs: readNumber(() => player.getProgress(), position), paused });
    } catch { /* Keep transport heartbeat independent of incomplete player state. */ }
  }
  function queue() {
    try {
      const current = localTrack(playerState()?.item);
      const state = Spicetify.Queue;
      const queuedCurrent = state?.track?.contextTrack || state?.track;
      if (!current || !Array.isArray(state?.nextTracks) || queuedCurrent?.uri && queuedCurrent.uri !== current.uri) {
        send({ type: 'queue', available: false }); return;
      }
      // Preserve actual order. Never skip a next episode to show a later song.
      const first = state.nextTracks[0];
      const firstUri = (first?.contextTrack || first)?.uri || '';
      const next = firstUri.startsWith('spotify:episode:') ? null : localTrack(first);
      if (first && !next && !firstUri.startsWith('spotify:episode:')) {
        send({ type: 'queue', available: false }); return;
      }
      send({ type: 'queue', available: true, trackId: current.trackId, uri: current.uri, nextTrack: next });
    } catch { /* Temporary queue navigation state expires locally. */ }
  }
  async function update(force = false) {
    const id = trackId();
    if (!id) { uri = ''; generation++; return; }
    if (!force && uri === id) return;
    uri = id;
    const gen = ++generation;
    send({ type: 'lyrics', trackId: id, lyricsStatus: enabled ? 'loading' : 'disabled', lines: [] });
    if (!enabled) return;
    let entry = cache.get(id);
    if (!entry || Date.now() - entry.at > (entry.lines ? 86400000 : 60000)) {
      const lines = await spotifyLyrics(id);
      entry = { at: Date.now(), lines };
      cache.set(id, entry);
      if (cache.size > 200) cache.delete(cache.keys().next().value);
    }
    if (gen !== generation || !enabled || trackId() !== id) return;
    send({ type: 'lyrics', trackId: id, lyricsStatus: 'resolved', lines: entry.lines || [] });
  }
  function scheduleReconnect() {
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
  }
  const refresh = (force = false) => {
    // Spotify's player API can briefly be unavailable during navigation or a track change.
    void update(force).catch(() => {});
  };
  function resume() {
    const now = Date.now();
    if (socket?.readyState === WebSocket.CONNECTING && now - connectedAt < 8000) return;
    if (socket?.readyState === WebSocket.OPEN && (!requestSnapshots || now - lastControlAt < 10000)) {
      playback(); queue(); refresh(); return;
    }
    const old = socket; socket = null;
    try { old?.close(); } catch { /* retire a half-open connection */ }
    if (reconnectTimer !== null) globalThis.clearTimeout?.(reconnectTimer);
    reconnectTimer = null;
    connect();
  }
  function connect() {
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
    let active;
    try { active = new WebSocket(ADDRESS); } catch { scheduleReconnect(); return; }
    socket = active; connectedAt = Date.now(); requestSnapshots = false;
    let configured = false;
    const handshakeTimeout = setTimeout(() => {
      if (socket === active && !configured) active.close();
    }, 8000);
    active.onmessage = event => {
      if (socket !== active) return;
      try {
        const packet = JSON.parse(event.data);
        if (packet.type === 'config' && typeof packet.enabled === 'boolean') {
          configured = true; globalThis.clearTimeout?.(handshakeTimeout);
          enabled = packet.enabled; requestSnapshots = packet.requestSnapshots === true; lastControlAt = Date.now();
          send({ type: 'hello', version: '2.0.1', capabilities: ['playback', 'queue', 'lyrics', 'refresh'] });
          playback(); queue(); refresh(true);
        } else if (packet.type === 'refresh') {
          requestSnapshots = true; lastControlAt = Date.now();
          playback(); queue(); refresh();
        }
      } catch { /* ignore unknown protocol */ }
    };
    active.onclose = () => {
      if (socket !== active) return;
      globalThis.clearTimeout?.(handshakeTimeout);
      socket = null; enabled = false; generation++;
      // A close event is not a chained page timer: recover an established session
      // immediately. Failed connection attempts retain a bounded retry delay.
      if (configured) connect(); else scheduleReconnect();
    };
    active.onerror = () => { if (socket === active) active.close(); };
  }
  Spicetify.Player.addEventListener('songchange', () => { playback(); queue(); refresh(); });
  Spicetify.Player.addEventListener('onplaypause', () => { playback(); });
  // Timers are a compatibility fallback; current VibeSync requests snapshots itself.
  setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      if (requestSnapshots && Date.now() - lastControlAt >= 10000) resume();
      else if (!requestSnapshots || Date.now() - lastControlAt >= 2500) { playback(); queue(); refresh(); }
    } else if (socket?.readyState === WebSocket.CONNECTING && Date.now() - connectedAt >= 8000) resume();
    else if (!socket && reconnectTimer === null) connect();
  }, 1000);
  globalThis.addEventListener?.('online', resume);
  globalThis.addEventListener?.('focus', resume);
  globalThis.addEventListener?.('pageshow', resume);
  globalThis.document?.addEventListener?.('visibilitychange', () => { if (!document.hidden) resume(); });
  connect();
})();
