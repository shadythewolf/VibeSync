// Windows Media Session (GSMTC - Global System Media Transport Controls) watcher.
// Reads title / artist / album / playback state / timeline / artwork of the
// currently playing media app (Apple Music, Spotify, browsers, ...).
// Everything here is best effort: if the API is unavailable the visualizer still works.
using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Threading;
using Windows.Media;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace VibeDeck.Helper
{
    internal sealed class MediaWatcher : IDisposable
    {
        private const int MaxArtworkBytes = 6 * 1024 * 1024;

        private readonly FrameWriter _writer;
        private readonly object _lock = new object();
        private GlobalSystemMediaTransportControlsSessionManager _manager;
        private GlobalSystemMediaTransportControlsSession _session;
        private string _sessionKey;
        private Timer _pollTimer;
        private Timer _debounceTimer;
        private bool _disposed;
        private int _managerRetryCountdown;

        // last emitted state
        private string _lastStable;
        private long _lastPositionMs = -1;
        private long _lastPositionAt;
        private bool _lastPlaying;
        private string _lastPropsKey;
        private string _artworkKey;
        private byte[] _artworkBytes;
        private string _artworkType;
        private long _lastArtworkAttemptTicks;
        private bool _announcedUnavailable;

        public MediaWatcher(FrameWriter writer)
        {
            _writer = writer;
        }

        public void Start()
        {
            TryCreateManager();
            _pollTimer = new Timer(delegate { Refresh(false); }, null, 200, 1000);
        }

        private void TryCreateManager()
        {
            try
            {
                var mgr = WinRtAsync.Await(GlobalSystemMediaTransportControlsSessionManager.RequestAsync(), 5000);
                mgr.CurrentSessionChanged += delegate { ScheduleRefresh(); };
                mgr.SessionsChanged += delegate { ScheduleRefresh(); };
                _manager = mgr;
                _writer.Log("info", "Media session manager connected");
            }
            catch (Exception ex)
            {
                _manager = null;
                _managerRetryCountdown = 10;
                _writer.Log("warn", "Windows media session API unavailable: " + ex.Message);
            }
        }

        private void ScheduleRefresh()
        {
            lock (_lock)
            {
                if (_disposed) return;
                if (_debounceTimer != null) return;
                _debounceTimer = new Timer(delegate
                {
                    lock (_lock)
                    {
                        if (_debounceTimer != null) { _debounceTimer.Dispose(); _debounceTimer = null; }
                    }
                    Refresh(true);
                }, null, 120, Timeout.Infinite);
            }
        }

        public void ResendTrack()
        {
            lock (_lock) { _lastStable = null; }
            Refresh(true);
        }

        public void ResendArtwork(string key)
        {
            lock (_lock)
            {
                if (_artworkBytes != null && (key == null || key == _artworkKey))
                {
                    EmitArtwork();
                }
            }
        }

        private void Refresh(bool force)
        {
            if (_disposed) return;
            if (!Monitor.TryEnter(_lock, 50)) return;
            try
            {
                if (_manager == null)
                {
                    if (--_managerRetryCountdown <= 0) TryCreateManager();
                    if (_manager == null)
                    {
                        EmitUnavailable();
                        return;
                    }
                }

                var session = PickSession();
                if (session == null)
                {
                    DetachSession();
                    EmitUnavailable();
                    return;
                }

                string key = SafeSourceId(session);
                if (!ReferenceEquals(session, _session) || key != _sessionKey)
                {
                    DetachSession();
                    _session = session;
                    _sessionKey = key;
                    try
                    {
                        session.MediaPropertiesChanged += delegate { ScheduleRefresh(); };
                        session.PlaybackInfoChanged += delegate { ScheduleRefresh(); };
                        session.TimelinePropertiesChanged += delegate { ScheduleRefresh(); };
                    }
                    catch (Exception ex)
                    {
                        _writer.Log("debug", "Could not subscribe to session events: " + ex.Message);
                    }
                    _lastPropsKey = null;
                    force = true;
                }

                ReadAndEmit(session, force);
            }
            catch (Exception ex)
            {
                _writer.Log("debug", "Media refresh failed: " + ex.Message);
            }
            finally
            {
                Monitor.Exit(_lock);
            }
        }

        private GlobalSystemMediaTransportControlsSession PickSession()
        {
            GlobalSystemMediaTransportControlsSession current = null;
            try { current = _manager.GetCurrentSession(); } catch { }
            IReadOnlyList<GlobalSystemMediaTransportControlsSession> all = null;
            try { all = _manager.GetSessions(); } catch { }

            if (current != null && IsPlaying(current)) return current;
            if (all != null)
            {
                foreach (var s in all)
                {
                    if (IsPlaying(s)) return s;
                }
            }
            if (current != null) return current;
            if (all != null && all.Count > 0) return all[0];
            return null;
        }

        private static bool IsPlaying(GlobalSystemMediaTransportControlsSession s)
        {
            try
            {
                var info = s.GetPlaybackInfo();
                return info != null && info.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
            }
            catch { return false; }
        }

        private static string SafeSourceId(GlobalSystemMediaTransportControlsSession s)
        {
            try { return s.SourceAppUserModelId ?? ""; } catch { return ""; }
        }

        private void DetachSession()
        {
            // WinRT event handlers registered with anonymous delegates cannot be removed individually;
            // dropping the reference lets the session (and its handlers) be collected.
            _session = null;
            _sessionKey = null;
        }

        private void ReadAndEmit(GlobalSystemMediaTransportControlsSession session, bool force)
        {
            GlobalSystemMediaTransportControlsSessionMediaProperties props = null;
            try { props = WinRtAsync.Await(session.TryGetMediaPropertiesAsync(), 3000); }
            catch (Exception ex) { _writer.Log("debug", "TryGetMediaPropertiesAsync failed: " + ex.Message); }

            GlobalSystemMediaTransportControlsSessionPlaybackInfo playback = null;
            try { playback = session.GetPlaybackInfo(); } catch { }
            GlobalSystemMediaTransportControlsSessionTimelineProperties timeline = null;
            try { timeline = session.GetTimelineProperties(); } catch { }

            string title = props != null ? (props.Title ?? "") : "";
            string artist = props != null ? (props.Artist ?? "") : "";
            string album = props != null ? (props.AlbumTitle ?? "") : "";
            if (string.IsNullOrEmpty(artist) && props != null && !string.IsNullOrEmpty(props.AlbumArtist)) artist = props.AlbumArtist;

            string status = "unknown";
            if (playback != null)
            {
                switch (playback.PlaybackStatus)
                {
                    case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing: status = "playing"; break;
                    case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused: status = "paused"; break;
                    case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Stopped: status = "stopped"; break;
                    case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Changing: status = "changing"; break;
                    case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Opened: status = "opening"; break;
                    case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Closed: status = "closed"; break;
                }
            }
            bool playing = status == "playing";

            long positionMs = 0, durationMs = 0, positionAt = NowMs();
            if (timeline != null)
            {
                try
                {
                    positionMs = (long)timeline.Position.TotalMilliseconds;
                    durationMs = (long)(timeline.EndTime - timeline.StartTime).TotalMilliseconds;
                    if (timeline.LastUpdatedTime.Year > 2000)
                        positionAt = timeline.LastUpdatedTime.ToUnixTimeMilliseconds();
                }
                catch { }
            }
            if (positionMs < 0) positionMs = 0;
            if (durationMs < 0) durationMs = 0;

            // Artwork: re-read when track changed, or periodically while we have none (apps set it late).
            string propsKey = title + "" + artist + "" + album;
            long nowTicks = DateTime.UtcNow.Ticks;
            bool wantArtwork = props != null && props.Thumbnail != null &&
                               (propsKey != _lastPropsKey || (_artworkKey == null && nowTicks - _lastArtworkAttemptTicks > TimeSpan.TicksPerSecond * 3));
            if (propsKey != _lastPropsKey && props != null && props.Thumbnail == null)
            {
                // New track without artwork
                _artworkKey = null;
                _artworkBytes = null;
            }
            if (wantArtwork)
            {
                _lastArtworkAttemptTicks = nowTicks;
                ReadArtwork(props);
            }
            _lastPropsKey = propsKey;

            string sourceApp = SafeSourceId(session);
            string stable = string.Join("", new[] { "1", title, artist, album, sourceApp, status, durationMs.ToString(), _artworkKey ?? "" });

            bool positionJump = false;
            if (_lastPositionMs >= 0)
            {
                long expected = _lastPlaying ? _lastPositionMs + (NowMs() - _lastPositionAt) : _lastPositionMs;
                long reportedNow = playing ? positionMs + (NowMs() - positionAt) : positionMs;
                positionJump = Math.Abs(reportedNow - expected) > 1500;
            }

            if (force || stable != _lastStable || positionJump || _lastPositionMs < 0)
            {
                _writer.WriteJson(new Dictionary<string, object>
                {
                    { "type", "track" },
                    { "available", true },
                    { "title", title },
                    { "artist", artist },
                    { "album", album },
                    { "sourceApp", sourceApp },
                    { "status", status },
                    { "positionMs", positionMs },
                    { "durationMs", durationMs },
                    { "positionUpdatedAt", positionAt },
                    { "artworkKey", _artworkKey }
                });
                _lastStable = stable;
                _lastPositionMs = positionMs;
                _lastPositionAt = positionAt;
                _lastPlaying = playing;
                _announcedUnavailable = false;
            }
        }

        private void ReadArtwork(GlobalSystemMediaTransportControlsSessionMediaProperties props)
        {
            try
            {
                var stream = WinRtAsync.Await(props.Thumbnail.OpenReadAsync(), 4000);
                ulong size = stream.Size;
                if (size == 0 || size > (ulong)MaxArtworkBytes)
                {
                    _writer.Log("debug", "Artwork skipped, size=" + size);
                    return;
                }
                var reader = new DataReader(stream.GetInputStreamAt(0));
                uint loaded = WinRtAsync.Await(reader.LoadAsync((uint)size), 4000);
                var bytes = new byte[loaded];
                reader.ReadBytes(bytes);
                string contentType = "image/jpeg";
                try { if (!string.IsNullOrEmpty(stream.ContentType)) contentType = stream.ContentType; } catch { }
                contentType = SniffContentType(bytes, contentType);

                string key;
                using (var sha = SHA1.Create())
                {
                    key = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
                }
                if (key == _artworkKey) return;
                _artworkKey = key;
                _artworkBytes = bytes;
                _artworkType = contentType;
                EmitArtwork();
            }
            catch (Exception ex)
            {
                _writer.Log("debug", "Artwork read failed: " + ex.Message);
            }
        }

        private static string SniffContentType(byte[] b, string fallback)
        {
            if (b.Length >= 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return "image/png";
            if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";
            if (b.Length >= 6 && b[0] == 'G' && b[1] == 'I' && b[2] == 'F') return "image/gif";
            if (b.Length >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "image/webp";
            if (b.Length >= 2 && b[0] == 'B' && b[1] == 'M') return "image/bmp";
            return fallback;
        }

        private void EmitArtwork()
        {
            if (_artworkBytes == null) return;
            _writer.WriteJson(new Dictionary<string, object>
            {
                { "type", "artwork" },
                { "key", _artworkKey },
                { "contentType", _artworkType },
                { "base64", Convert.ToBase64String(_artworkBytes) }
            });
        }

        private void EmitUnavailable()
        {
            if (_announcedUnavailable) return;
            _announcedUnavailable = true;
            _lastStable = null;
            _lastPositionMs = -1;
            _lastPropsKey = null;
            _artworkKey = null;
            _artworkBytes = null;
            _writer.WriteJson(new Dictionary<string, object>
            {
                { "type", "track" },
                { "available", false },
                { "title", "" },
                { "artist", "" },
                { "album", "" },
                { "sourceApp", "" },
                { "status", "unknown" },
                { "positionMs", 0 },
                { "durationMs", 0 },
                { "positionUpdatedAt", NowMs() },
                { "artworkKey", null }
            });
        }

        private static long NowMs()
        {
            return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }

        public void Dispose()
        {
            lock (_lock)
            {
                _disposed = true;
                if (_pollTimer != null) { _pollTimer.Dispose(); _pollTimer = null; }
                if (_debounceTimer != null) { _debounceTimer.Dispose(); _debounceTimer = null; }
                _session = null;
                _manager = null;
            }
        }
    }
}
