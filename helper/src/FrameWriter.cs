// Binary frame writer for the helper -> Electron stdout stream.
// Frame: 'VDKP' | type u8 | flags u8 | reserved u16 | length u32 LE | payload
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace VibeDeck.Helper
{
    internal sealed class FrameWriter
    {
        public const byte TypeJson = 1;
        public const byte TypePcm = 2;

        private readonly Stream _out;
        private readonly object _lock = new object();
        private readonly byte[] _header = new byte[12];
        private byte[] _pcmScratch = new byte[0];
        private volatile bool _closed;

        public event Action Closed;

        public FrameWriter(Stream output)
        {
            _out = output;
            _header[0] = (byte)'V';
            _header[1] = (byte)'D';
            _header[2] = (byte)'K';
            _header[3] = (byte)'P';
        }

        public bool IsClosed { get { return _closed; } }

        public void WriteJson(IDictionary<string, object> message)
        {
            var bytes = Encoding.UTF8.GetBytes(Json.Serialize(message));
            Write(TypeJson, bytes, 0, bytes.Length);
        }

        public void Log(string level, string message)
        {
            WriteJson(new Dictionary<string, object>
            {
                { "type", "log" },
                { "level", level },
                { "message", message }
            });
        }

        public void Error(string code, string message, string detail)
        {
            WriteJson(new Dictionary<string, object>
            {
                { "type", "error" },
                { "code", code },
                { "message", message },
                { "detail", detail }
            });
        }

        /// <summary>Write interleaved float32 samples. count = number of floats (frames * channels).</summary>
        public void WritePcm(int sampleRate, int channels, float[] samples, int count)
        {
            if (channels <= 0) return;
            int frames = count / channels;
            if (frames <= 0) return;
            int dataBytes = frames * channels * 4;
            lock (_lock)
            {
                if (_closed) return;
                if (_pcmScratch.Length < 16 + dataBytes) _pcmScratch = new byte[16 + dataBytes];
                var p = _pcmScratch;
                WriteU32(p, 0, (uint)sampleRate);
                WriteU16(p, 4, (ushort)channels);
                WriteU16(p, 6, 1); // format: float32
                WriteU32(p, 8, (uint)frames);
                WriteU32(p, 12, 0);
                Buffer.BlockCopy(samples, 0, p, 16, dataBytes);
                WriteLocked(TypePcm, p, 0, 16 + dataBytes);
            }
        }

        private void Write(byte type, byte[] payload, int offset, int length)
        {
            lock (_lock)
            {
                if (_closed) return;
                WriteLocked(type, payload, offset, length);
            }
        }

        private void WriteLocked(byte type, byte[] payload, int offset, int length)
        {
            try
            {
                _header[4] = type;
                _header[5] = 0;
                _header[6] = 0;
                _header[7] = 0;
                WriteU32(_header, 8, (uint)length);
                _out.Write(_header, 0, 12);
                _out.Write(payload, offset, length);
                _out.Flush();
            }
            catch (IOException)
            {
                MarkClosed();
            }
            catch (ObjectDisposedException)
            {
                MarkClosed();
            }
        }

        private void MarkClosed()
        {
            if (_closed) return;
            _closed = true;
            var h = Closed;
            if (h != null)
            {
                try { h(); } catch { }
            }
        }

        private static void WriteU32(byte[] b, int o, uint v)
        {
            b[o] = (byte)(v & 0xff);
            b[o + 1] = (byte)((v >> 8) & 0xff);
            b[o + 2] = (byte)((v >> 16) & 0xff);
            b[o + 3] = (byte)((v >> 24) & 0xff);
        }

        private static void WriteU16(byte[] b, int o, ushort v)
        {
            b[o] = (byte)(v & 0xff);
            b[o + 1] = (byte)((v >> 8) & 0xff);
        }
    }
}
