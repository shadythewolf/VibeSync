// WASAPI loopback capture with a short buffer.
//
// NAudio's WasapiLoopbackCapture always uses a 100 ms buffer and, in polling mode, sleeps
// half of it between reads, so audio arrives in ~60 ms chunks: the visualizer then only gets
// new data ~16 times a second and the bars visibly step. WasapiCapture accepts a buffer
// length, and loopback is just its stream flag, so this is WasapiLoopbackCapture with 30 ms
// (reads every ~15 ms). Polling stays on: event-driven loopback is unreliable before Windows 10.
using NAudio.CoreAudioApi;

namespace VibeDeck.Helper
{
    internal sealed class LowLatencyLoopbackCapture : WasapiCapture
    {
        public const int BufferMilliseconds = 30;

        public LowLatencyLoopbackCapture(MMDevice renderDevice)
            : base(renderDevice, false, BufferMilliseconds)
        {
        }

        protected override AudioClientStreamFlags GetAudioClientStreamFlags()
        {
            return AudioClientStreamFlags.Loopback;
        }
    }
}
