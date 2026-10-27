// VibeDeck native helper entry point.
//
// Spawned by the Electron main process with piped stdio:
//   stdin  <- JSON commands, one per line     (see src/shared/protocol.ts)
//   stdout -> binary frames: JSON messages + PCM float32 audio
//
// Run `VibeDeckHelper.exe --selftest` for a standalone diagnostic.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;

[assembly: AssemblyTitle("VibeDeck Audio Helper")]
[assembly: AssemblyDescription("WASAPI loopback capture and Windows media session bridge for VibeDeck")]
[assembly: AssemblyProduct("VibeDeck")]
[assembly: AssemblyCompany("VibeDeck")]
[assembly: AssemblyCopyright("Copyright (c) 2026 VibeDeck")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace VibeDeck.Helper
{
    internal static class Program
    {
        public const string HelperVersion = "1.0.0";
        public const int ProtocolVersion = 1;

        private static int Main(string[] args)
        {
            if (args.Length > 0)
            {
                switch (args[0])
                {
                    case "--version":
                        Console.WriteLine(HelperVersion);
                        return 0;
                    case "--selftest":
                        return SelfTest.Run(args);
                    case "--help":
                    case "-h":
                    case "/?":
                        Console.WriteLine("VibeDeckHelper [--version | --selftest [deviceId] | --help]");
                        Console.WriteLine("Without arguments the helper speaks the VibeDeck binary protocol on stdin/stdout.");
                        return 0;
                }
            }

            var stdout = Console.OpenStandardOutput();
            var writer = new FrameWriter(stdout);
            var exit = new ManualResetEventSlim(false);
            writer.Closed += delegate { exit.Set(); };

            AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e)
            {
                try
                {
                    var ex = e.ExceptionObject as Exception;
                    writer.Error("HELPER_CRASHED", "The audio helper hit an unexpected error.", ex != null ? ex.ToString() : "unknown");
                }
                catch { }
            };

            writer.WriteJson(new Dictionary<string, object>
            {
                { "type", "hello" },
                { "version", ProtocolVersion },
                { "pid", System.Diagnostics.Process.GetCurrentProcess().Id },
                { "helperVersion", HelperVersion },
                { "dotnet", Environment.Version.ToString() }
            });

            CaptureManager capture = null;
            MediaWatcher media = null;
            try
            {
                capture = new CaptureManager(writer);
                capture.SendDevices();
            }
            catch (Exception ex)
            {
                writer.Error("CAPTURE_INIT_FAILED", "Could not initialise Windows Core Audio (WASAPI).", ex.ToString());
            }
            try
            {
                media = new MediaWatcher(writer);
                media.Start();
            }
            catch (Exception ex)
            {
                writer.Log("warn", "Media watcher failed to start: " + ex.Message);
            }

            // stdin command loop on a background thread so we can also exit when stdout closes.
            var stdinThread = new Thread(delegate()
            {
                try
                {
                    var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        line = line.Trim();
                        if (line.Length == 0) continue;
                        Dictionary<string, object> cmd = null;
                        try { cmd = Json.ParseObject(line); }
                        catch (Exception ex) { writer.Error("HELPER_PROTOCOL", "Bad command JSON", ex.Message); continue; }
                        if (cmd == null) continue;
                        string name = Json.GetString(cmd, "cmd") ?? "";
                        try
                        {
                            switch (name)
                            {
                                case "listDevices":
                                    if (capture != null) capture.SendDevices();
                                    break;
                                case "start":
                                    if (capture != null) capture.Start(Json.GetString(cmd, "deviceId"));
                                    else writer.Error("CAPTURE_INIT_FAILED", "Audio subsystem unavailable", null);
                                    break;
                                case "stop":
                                    if (capture != null) capture.Stop();
                                    break;
                                case "ping":
                                    writer.WriteJson(new Dictionary<string, object>
                                    {
                                        { "type", "pong" },
                                        { "time", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() },
                                        { "chunks", capture != null ? capture.ChunksSent : 0L }
                                    });
                                    break;
                                case "getTrack":
                                    if (media != null) media.ResendTrack();
                                    break;
                                case "requestArtwork":
                                    if (media != null) media.ResendArtwork(Json.GetString(cmd, "key"));
                                    break;
                                case "quit":
                                    exit.Set();
                                    return;
                                default:
                                    writer.Error("HELPER_PROTOCOL", "Unknown command: " + name, null);
                                    break;
                            }
                        }
                        catch (Exception ex)
                        {
                            writer.Error("UNKNOWN", "Command '" + name + "' failed", ex.ToString());
                        }
                    }
                }
                catch (Exception) { }
                // stdin closed => parent process is gone
                exit.Set();
            });
            stdinThread.IsBackground = true;
            stdinThread.Start();

            exit.Wait();

            try { if (capture != null) capture.Dispose(); } catch { }
            try { if (media != null) media.Dispose(); } catch { }
            return 0;
        }
    }

    /// <summary>Standalone diagnostics: enumerate devices, capture for a few seconds, dump media sessions.</summary>
    internal static class SelfTest
    {
        public static int Run(string[] args)
        {
            string deviceId = args.Length > 1 ? args[1] : null;
            Console.WriteLine("VibeDeck helper self test v" + Program.HelperVersion);
            Console.WriteLine(".NET " + Environment.Version + " on " + Environment.OSVersion);
            int rc = 0;
            try
            {
                var en = new NAudio.CoreAudioApi.MMDeviceEnumerator();
                string defId = null;
                try { defId = en.GetDefaultAudioEndpoint(NAudio.CoreAudioApi.DataFlow.Render, NAudio.CoreAudioApi.Role.Multimedia).ID; } catch { }
                Console.WriteLine("Playback devices:");
                foreach (var d in en.EnumerateAudioEndPoints(NAudio.CoreAudioApi.DataFlow.Render, NAudio.CoreAudioApi.DeviceState.Active))
                {
                    Console.WriteLine("  " + (d.ID == defId ? "* " : "  ") + d.FriendlyName + "  [" + d.ID + "]  " + d.AudioClient.MixFormat);
                }
                var dev = deviceId != null ? en.GetDevice(deviceId) : en.GetDefaultAudioEndpoint(NAudio.CoreAudioApi.DataFlow.Render, NAudio.CoreAudioApi.Role.Multimedia);
                Console.WriteLine("Capturing 3 seconds of loopback from: " + dev.FriendlyName);
                var cap = new NAudio.Wave.WasapiLoopbackCapture(dev);
                Console.WriteLine("Format: " + cap.WaveFormat);
                long bytes = 0; double sumsq = 0; long n = 0; int events = 0; float peak = 0;
                cap.DataAvailable += delegate(object s, NAudio.Wave.WaveInEventArgs e)
                {
                    events++;
                    bytes += e.BytesRecorded;
                    for (int i = 0; i + 4 <= e.BytesRecorded; i += 4)
                    {
                        float f = BitConverter.ToSingle(e.Buffer, i);
                        sumsq += f * f; n++;
                        float a = Math.Abs(f); if (a > peak) peak = a;
                    }
                };
                cap.StartRecording();
                Thread.Sleep(3000);
                cap.StopRecording();
                cap.Dispose();
                double rms = Math.Sqrt(sumsq / Math.Max(1, n));
                Console.WriteLine("Buffers: " + events + "  bytes: " + bytes + "  RMS: " + rms.ToString("F4") + "  peak: " + peak.ToString("F4"));
                Console.WriteLine(events > 0 ? "Loopback capture: OK" : "Loopback capture: NO DATA (is anything playing?)");
                if (events == 0) rc = 2;
            }
            catch (Exception ex)
            {
                Console.WriteLine("Loopback capture FAILED: " + ex);
                rc = 1;
            }

            try
            {
                var mgr = WinRtAsync.Await(Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager.RequestAsync(), 5000);
                var sessions = mgr.GetSessions();
                Console.WriteLine("Media sessions: " + sessions.Count);
                foreach (var s in sessions)
                {
                    var p = WinRtAsync.Await(s.TryGetMediaPropertiesAsync(), 3000);
                    var pb = s.GetPlaybackInfo();
                    var tl = s.GetTimelineProperties();
                    Console.WriteLine("  " + s.SourceAppUserModelId + " | " + p.Title + " | " + p.Artist + " | " + p.AlbumTitle + " | " + pb.PlaybackStatus + " | " + tl.Position + " / " + tl.EndTime + " | artwork=" + (p.Thumbnail != null));
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("Media session API unavailable: " + ex.Message);
            }
            return rc;
        }
    }
}
