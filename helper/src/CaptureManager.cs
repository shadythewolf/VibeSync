// WASAPI loopback capture of a Windows playback (render) endpoint using NAudio.
// Follows the Windows default device when no explicit device is requested and
// survives device removal / default-device changes by restarting automatically.
using System;
using System.Collections.Generic;
using System.Threading;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Wave;

namespace VibeDeck.Helper
{
    internal sealed class CaptureManager : IMMNotificationClient, IDisposable
    {
        private readonly FrameWriter _writer;
        private readonly MMDeviceEnumerator _enumerator;
        private readonly object _lock = new object();

        private LowLatencyLoopbackCapture _capture;
        private MMDevice _device;
        private WaveFormat _format;
        private string _requestedId;      // null => follow default
        private bool _followDefault = true;
        private bool _wantRunning;
        private bool _stoppingIntentionally;
        private int _restartAttempts;
        private Timer _restartTimer;
        private Timer _devicesTimer;

        // Accumulator (interleaved float32), flushed once it holds ~10 ms: in practice every
        // read (~15 ms, see LowLatencyLoopbackCapture) goes out on its own.
        private float[] _acc = new float[0];
        private int _accCount;
        private int _flushThreshold;
        private long _chunksSent;
        private long _lastDataTicks;

        public CaptureManager(FrameWriter writer)
        {
            _writer = writer;
            _enumerator = new MMDeviceEnumerator();
            try
            {
                _enumerator.RegisterEndpointNotificationCallback(this);
            }
            catch (Exception ex)
            {
                _writer.Log("warn", "Could not register for device notifications: " + ex.Message);
            }
        }

        public long ChunksSent { get { return Interlocked.Read(ref _chunksSent); } }

        // ------------------------------------------------------------------
        // Device enumeration
        // ------------------------------------------------------------------

        public List<Dictionary<string, object>> ListDevices(out string defaultId)
        {
            defaultId = null;
            var list = new List<Dictionary<string, object>>();
            try
            {
                var def = _enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
                defaultId = def.ID;
            }
            catch { }
            foreach (var d in _enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
            {
                int rate = 0, ch = 0;
                try
                {
                    var mf = d.AudioClient.MixFormat;
                    rate = mf.SampleRate;
                    ch = mf.Channels;
                }
                catch { }
                string name = "Unknown device";
                try { name = d.FriendlyName; } catch { }
                list.Add(new Dictionary<string, object>
                {
                    { "id", d.ID },
                    { "name", name },
                    { "isDefault", d.ID == defaultId },
                    { "sampleRate", rate },
                    { "channels", ch }
                });
            }
            return list;
        }

        public void SendDevices()
        {
            try
            {
                string defId;
                var list = ListDevices(out defId);
                _writer.WriteJson(new Dictionary<string, object>
                {
                    { "type", "devices" },
                    { "devices", list },
                    { "defaultId", defId }
                });
            }
            catch (Exception ex)
            {
                _writer.Error("DEVICE_ENUM_FAILED", "Could not enumerate Windows playback devices.", ex.ToString());
            }
        }

        private void ScheduleSendDevices()
        {
            lock (_lock)
            {
                if (_devicesTimer != null) _devicesTimer.Dispose();
                _devicesTimer = new Timer(delegate { SendDevices(); }, null, 300, Timeout.Infinite);
            }
        }

        // ------------------------------------------------------------------
        // Start / stop
        //
        // NAudio raises RecordingStopped on its capture thread and Dispose() joins that
        // thread, so a capture must never be stopped/disposed while holding _lock (the
        // RecordingStopped handler takes _lock -> deadlock). Pattern: detach under the
        // lock, dispose outside it, then (re)start under the lock.
        // ------------------------------------------------------------------

        public void Start(string deviceId)
        {
            LowLatencyLoopbackCapture oldCap; MMDevice oldDev;
            lock (_lock)
            {
                _requestedId = string.IsNullOrEmpty(deviceId) ? null : deviceId;
                _followDefault = _requestedId == null;
                _wantRunning = true;
                _restartAttempts = 0;
                CancelRestart();
                DetachLocked(out oldCap, out oldDev);
            }
            DisposeCapture(oldCap, oldDev);
            lock (_lock)
            {
                if (_wantRunning && _capture == null) StartLocked();
            }
        }

        public void Stop()
        {
            LowLatencyLoopbackCapture oldCap; MMDevice oldDev;
            lock (_lock)
            {
                _wantRunning = false;
                CancelRestart();
                DetachLocked(out oldCap, out oldDev);
            }
            DisposeCapture(oldCap, oldDev);
            lock (_lock)
            {
                EmitCapture("stopped", null);
            }
        }

        private void RestartNow()
        {
            LowLatencyLoopbackCapture oldCap; MMDevice oldDev;
            lock (_lock)
            {
                _restartTimer = null;
                if (!_wantRunning) return;
                DetachLocked(out oldCap, out oldDev);
            }
            DisposeCapture(oldCap, oldDev);
            lock (_lock)
            {
                if (_wantRunning && _capture == null) StartLocked();
            }
        }

        /// <summary>Must be called under _lock. Removes the current capture from the manager without stopping it.</summary>
        private void DetachLocked(out LowLatencyLoopbackCapture cap, out MMDevice dev)
        {
            cap = _capture;
            dev = _device;
            _capture = null;
            _device = null;
            if (cap != null)
            {
                _stoppingIntentionally = true;
                try { cap.DataAvailable -= OnDataAvailable; } catch { }
                try { cap.RecordingStopped -= OnRecordingStopped; } catch { }
            }
        }

        /// <summary>Must be called WITHOUT holding _lock.</summary>
        private static void DisposeCapture(LowLatencyLoopbackCapture cap, MMDevice dev)
        {
            if (cap != null)
            {
                try { cap.StopRecording(); } catch { }
                try { cap.Dispose(); } catch { }
            }
            if (dev != null)
            {
                try { dev.Dispose(); } catch { }
            }
        }

        private void StartLocked()
        {
            MMDevice dev = null;
            if (!_followDefault)
            {
                try
                {
                    dev = _enumerator.GetDevice(_requestedId);
                    if (dev.State != DeviceState.Active) dev = null;
                }
                catch { dev = null; }
                if (dev == null)
                {
                    EmitCaptureError("DEVICE_NOT_FOUND",
                        "The selected playback device is not available. Falling back to the Windows default output.",
                        _requestedId, "restarting");
                    _followDefault = true;
                }
            }
            if (dev == null)
            {
                try
                {
                    dev = _enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
                }
                catch (Exception ex)
                {
                    EmitCaptureError("NO_AUDIO_DEVICE",
                        "No active Windows playback device was found. Connect or enable a speaker/headphone device in Windows Sound settings.",
                        ex.Message, "error");
                    ScheduleRestart(3000);
                    return;
                }
            }

            string friendly = "Playback device";
            try { friendly = dev.FriendlyName; } catch { }

            try
            {
                var cap = new LowLatencyLoopbackCapture(dev);
                var fmt = cap.WaveFormat;
                if (!IsSupported(fmt))
                {
                    cap.Dispose();
                    EmitCaptureError("CAPTURE_INIT_FAILED",
                        "The device mix format (" + fmt + ") is not supported.",
                        fmt.ToString(), "error");
                    return;
                }
                cap.DataAvailable += OnDataAvailable;
                cap.RecordingStopped += OnRecordingStopped;
                _capture = cap;
                _device = dev;
                _format = fmt;
                _accCount = 0;
                int capacity = fmt.SampleRate * fmt.Channels; // one second
                if (_acc.Length < capacity) _acc = new float[capacity];
                _flushThreshold = Math.Max(fmt.Channels * 64, (fmt.SampleRate / 100) * fmt.Channels); // ~10 ms
                _stoppingIntentionally = false;
                cap.StartRecording();
                _lastDataTicks = DateTime.UtcNow.Ticks;
                EmitCapture("started", null);
            }
            catch (Exception ex)
            {
                _capture = null;
                _device = null;
                EmitCaptureError("CAPTURE_INIT_FAILED",
                    "Could not start WASAPI loopback capture on \"" + friendly + "\".",
                    ex.ToString(), "error");
                ScheduleRestart(2000);
            }
        }

        private static bool IsSupported(WaveFormat fmt)
        {
            if (fmt.Channels < 1 || fmt.Channels > 8) return false;
            if (fmt.Encoding == WaveFormatEncoding.IeeeFloat && fmt.BitsPerSample == 32) return true;
            if (fmt.Encoding == WaveFormatEncoding.Pcm && (fmt.BitsPerSample == 16 || fmt.BitsPerSample == 24 || fmt.BitsPerSample == 32)) return true;
            if (fmt.Encoding == WaveFormatEncoding.Extensible)
            {
                // Extensible formats that NAudio could not standardise; treat 32-bit as float, others as PCM.
                return fmt.BitsPerSample == 32 || fmt.BitsPerSample == 16 || fmt.BitsPerSample == 24;
            }
            return false;
        }

        private void ScheduleRestart(int delayMs)
        {
            if (!_wantRunning) return;
            _restartAttempts++;
            if (_restartAttempts > 30)
            {
                EmitCaptureError("CAPTURE_INIT_FAILED",
                    "Audio capture keeps failing. Check your Windows playback device and restart VibeDeck.",
                    "attempts=" + _restartAttempts, "error");
                _wantRunning = false;
                return;
            }
            CancelRestart();
            int delay = Math.Min(10000, delayMs * Math.Max(1, Math.Min(_restartAttempts, 5)));
            _restartTimer = new Timer(delegate { RestartNow(); }, null, delay, Timeout.Infinite);
        }

        private void CancelRestart()
        {
            if (_restartTimer != null)
            {
                _restartTimer.Dispose();
                _restartTimer = null;
            }
        }

        // ------------------------------------------------------------------
        // Data
        // ------------------------------------------------------------------

        private void OnDataAvailable(object sender, WaveInEventArgs e)
        {
            var fmt = _format;
            if (fmt == null || e.BytesRecorded <= 0) return;
            int bytesPerSample = fmt.BitsPerSample / 8;
            int count = e.BytesRecorded / bytesPerSample;
            if (count <= 0) return;

            lock (_lock)
            {
                if (_capture == null || !ReferenceEquals(sender, _capture)) return;
                if (_accCount + count > _acc.Length)
                {
                    // Flush what we have, then grow if a single buffer is larger than capacity.
                    if (_accCount > 0)
                    {
                        _writer.WritePcm(fmt.SampleRate, fmt.Channels, _acc, _accCount);
                        Interlocked.Increment(ref _chunksSent);
                        _accCount = 0;
                    }
                    if (count > _acc.Length) _acc = new float[count * 2];
                }
                Convert(e.Buffer, e.BytesRecorded, fmt, _acc, _accCount);
                _accCount += count;
                _lastDataTicks = DateTime.UtcNow.Ticks;
                if (_accCount >= _flushThreshold)
                {
                    _writer.WritePcm(fmt.SampleRate, fmt.Channels, _acc, _accCount);
                    Interlocked.Increment(ref _chunksSent);
                    _accCount = 0;
                }
            }
        }

        private static void Convert(byte[] src, int bytes, WaveFormat fmt, float[] dst, int dstOffset)
        {
            int bps = fmt.BitsPerSample;
            bool isFloat = fmt.Encoding == WaveFormatEncoding.IeeeFloat || (fmt.Encoding == WaveFormatEncoding.Extensible && bps == 32);
            if (isFloat && bps == 32)
            {
                Buffer.BlockCopy(src, 0, dst, dstOffset * 4, bytes - (bytes % 4));
                return;
            }
            if (bps == 16)
            {
                int n = bytes / 2;
                for (int i = 0; i < n; i++)
                {
                    short s = (short)(src[i * 2] | (src[i * 2 + 1] << 8));
                    dst[dstOffset + i] = s / 32768f;
                }
                return;
            }
            if (bps == 24)
            {
                int n = bytes / 3;
                for (int i = 0; i < n; i++)
                {
                    int v = (src[i * 3] << 8) | (src[i * 3 + 1] << 16) | (src[i * 3 + 2] << 24);
                    dst[dstOffset + i] = (v >> 8) / 8388608f;
                }
                return;
            }
            if (bps == 32)
            {
                int n = bytes / 4;
                for (int i = 0; i < n; i++)
                {
                    int v = src[i * 4] | (src[i * 4 + 1] << 8) | (src[i * 4 + 2] << 16) | (src[i * 4 + 3] << 24);
                    dst[dstOffset + i] = v / 2147483648f;
                }
            }
        }

        private void OnRecordingStopped(object sender, StoppedEventArgs e)
        {
            lock (_lock)
            {
                if (_stoppingIntentionally || !ReferenceEquals(sender, _capture)) return;
                if (e.Exception != null)
                {
                    EmitCaptureError("DEVICE_DISCONNECTED",
                        "Audio capture stopped unexpectedly (" + e.Exception.Message + "). Reconnecting...",
                        e.Exception.ToString(), "restarting");
                    // Common cause: device removed or format changed. Fall back to default and retry.
                    ScheduleRestart(800);
                }
            }
        }

        // ------------------------------------------------------------------
        // Status messages
        // ------------------------------------------------------------------

        private void EmitCapture(string state, Dictionary<string, object> error)
        {
            string devId = null, devName = null;
            int rate = 0, ch = 0;
            if (_device != null)
            {
                try { devId = _device.ID; } catch { }
                try { devName = _device.FriendlyName; } catch { }
            }
            if (_format != null)
            {
                rate = _format.SampleRate;
                ch = _format.Channels;
            }
            var msg = new Dictionary<string, object>
            {
                { "type", "capture" },
                { "state", state },
                { "deviceId", devId },
                { "deviceName", devName },
                { "sampleRate", rate },
                { "channels", ch },
                { "followingDefault", _followDefault }
            };
            if (error != null) msg["error"] = error;
            _writer.WriteJson(msg);
        }

        private void EmitCaptureError(string code, string message, string detail, string state)
        {
            EmitCapture(state, new Dictionary<string, object>
            {
                { "code", code },
                { "message", message },
                { "detail", detail }
            });
        }

        // ------------------------------------------------------------------
        // IMMNotificationClient
        // ------------------------------------------------------------------

        public void OnDeviceStateChanged(string deviceId, DeviceState newState)
        {
            Notify("stateChanged", deviceId);
            lock (_lock)
            {
                if (_device != null && _wantRunning)
                {
                    string curId = null;
                    try { curId = _device.ID; } catch { }
                    if (curId == deviceId && newState != DeviceState.Active)
                    {
                        EmitCaptureError("DEVICE_DISCONNECTED",
                            "The playback device being captured was disabled or disconnected. Switching to the Windows default output.",
                            deviceId, "restarting");
                        _followDefault = true;
                        ScheduleRestart(600);
                    }
                }
            }
            ScheduleSendDevices();
        }

        public void OnDeviceAdded(string pwstrDeviceId)
        {
            Notify("added", pwstrDeviceId);
            ScheduleSendDevices();
        }

        public void OnDeviceRemoved(string deviceId)
        {
            Notify("removed", deviceId);
            lock (_lock)
            {
                if (_device != null && _wantRunning)
                {
                    string curId = null;
                    try { curId = _device.ID; } catch { }
                    if (curId == deviceId)
                    {
                        EmitCaptureError("DEVICE_DISCONNECTED",
                            "The playback device being captured was removed. Switching to the Windows default output.",
                            deviceId, "restarting");
                        _followDefault = true;
                        ScheduleRestart(600);
                    }
                }
            }
            ScheduleSendDevices();
        }

        public void OnDefaultDeviceChanged(DataFlow flow, Role role, string defaultDeviceId)
        {
            if (flow != DataFlow.Render || role != Role.Multimedia) return;
            Notify("defaultChanged", defaultDeviceId);
            lock (_lock)
            {
                if (_followDefault && _wantRunning)
                {
                    string curId = null;
                    if (_device != null) { try { curId = _device.ID; } catch { } }
                    if (curId != defaultDeviceId)
                    {
                        EmitCapture("restarting", null);
                        _restartAttempts = 0;
                        ScheduleRestart(400);
                    }
                }
            }
            ScheduleSendDevices();
        }

        public void OnPropertyValueChanged(string pwstrDeviceId, PropertyKey key)
        {
            // Frequent and noisy; ignored.
        }

        private void Notify(string kind, string deviceId)
        {
            _writer.WriteJson(new Dictionary<string, object>
            {
                { "type", "deviceChange" },
                { "kind", kind },
                { "deviceId", deviceId }
            });
        }

        public void Dispose()
        {
            LowLatencyLoopbackCapture oldCap; MMDevice oldDev;
            lock (_lock)
            {
                _wantRunning = false;
                CancelRestart();
                if (_devicesTimer != null) { _devicesTimer.Dispose(); _devicesTimer = null; }
                DetachLocked(out oldCap, out oldDev);
            }
            DisposeCapture(oldCap, oldDev);
            try { _enumerator.UnregisterEndpointNotificationCallback(this); } catch { }
            try { _enumerator.Dispose(); } catch { }
        }
    }
}
