// Synchronous await shim for WinRT IAsyncOperation<T> that does not require
// System.Runtime.WindowsRuntime.dll (which would need the Windows SDK union metadata).
using System;
using System.Threading;
using Windows.Foundation;

namespace VibeDeck.Helper
{
    internal static class WinRtAsync
    {
        public static T Await<T>(IAsyncOperation<T> op, int timeoutMs)
        {
            if (op == null) throw new ArgumentNullException("op");
            using (var ev = new ManualResetEventSlim(false))
            {
                op.Completed = delegate(IAsyncOperation<T> o, AsyncStatus status) { ev.Set(); };
                if (!ev.Wait(timeoutMs))
                {
                    try { op.Cancel(); } catch { }
                    throw new TimeoutException("WinRT operation timed out after " + timeoutMs + " ms");
                }
                if (op.Status == AsyncStatus.Completed) return op.GetResults();
                var err = op.ErrorCode;
                if (err != null) throw err;
                throw new InvalidOperationException("WinRT operation ended with status " + op.Status);
            }
        }
    }
}
