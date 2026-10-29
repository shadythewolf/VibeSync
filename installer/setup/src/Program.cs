using System;
using System.Windows;

namespace VibeSyncSetup
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Payload payload;
            try
            {
                payload = Payload.Load();
            }
            catch (Exception ex)
            {
                MessageBox.Show("This setup file is damaged. Download it again.\n\n" + ex.Message,
                    "VibeSync setup", MessageBoxButton.OK, MessageBoxImage.Error);
                return 2;
            }

            if (payload.IsUninstaller) return UninstallWindow.Run(payload, args);

            // Scripted installs (/S, /D=...) skip the window and go straight to the NSIS package.
            if (Installer.IsSilent(args)) return Installer.RunSilent(payload, args);

            return ShellWindow.CreateApp().Run(new SetupWindow(payload));
        }
    }
}
