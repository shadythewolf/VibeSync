using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace VibeSyncSetup
{
    /// <summary>
    /// The uninstall window. Started by the NSIS uninstaller's un.onInit (installer.nsh) with
    /// "--folder=<install dir>" whenever someone uninstalls interactively; silent uninstalls
    /// (updates, scripts) never reach it.
    /// </summary>
    internal sealed class UninstallWindow : ShellWindow
    {
        private const string FolderArg = "--folder=";
        private const string RelaunchedArg = "--relaunched";

        private readonly Payload payload;
        private readonly ExistingInstall install;

        public static int Run(Payload payload, string[] args)
        {
            string folder = null;
            bool relaunched = false;
            foreach (var arg in args)
            {
                if (arg.StartsWith(FolderArg, StringComparison.OrdinalIgnoreCase)) folder = arg.Substring(FolderArg.Length).TrimEnd('\\');
                else if (arg == RelaunchedArg) relaunched = true;
            }

            var found = Installer.FindExisting(payload);
            if (folder == null && found != null) folder = found.Folder;
            if (folder == null || !Directory.Exists(folder))
            {
                MessageBox.Show("VibeSync isn't installed.", "Uninstall VibeSync", MessageBoxButton.OK, MessageBoxImage.Information);
                return 1;
            }

            // This exe lives in the install folder; run a temp copy so the folder can be deleted.
            string self = Assembly.GetExecutingAssembly().Location;
            if (!relaunched)
            {
                string temp = Path.Combine(Path.GetTempPath(), "VibeSync-Uninstall-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(temp);
                string copy = Path.Combine(temp, Path.GetFileName(self));
                File.Copy(self, copy);
                Process.Start(new ProcessStartInfo(copy, "\"" + FolderArg + folder + "\" " + RelaunchedArg) { UseShellExecute = false });
                return 0;
            }

            var install = found != null && string.Equals(found.Folder.TrimEnd('\\'), folder, StringComparison.OrdinalIgnoreCase)
                ? found
                : new ExistingInstall { Folder = folder };
            int code = ShellWindow.CreateApp().Run(new UninstallWindow(payload, install));
            DeleteSelfLater(Path.GetDirectoryName(self));
            return code;
        }

        private UninstallWindow(Payload payload, ExistingInstall install) : base("UninstallWindow.xaml", "Uninstall VibeSync", payload)
        {
            this.payload = payload;
            this.install = install;

            var logo = payload.LoadLogo();
            Find<Image>("Logo").Source = logo;
            Find<Image>("ProgressLogo").Source = logo;
            Find<TextBlock>("InfoText").Text = (install.Version != null ? "Version " + install.Version + " in " : "Installed in ") + install.Folder;

            Find<Button>("UninstallButton").Click += delegate { Start(); };
            Find<Button>("CancelButton").Click += delegate { Close(); };
            Find<Button>("DoneCloseButton").Click += delegate { Close(); };
            Find<Button>("ErrorCloseButton").Click += delegate { Close(); };
            Find<Button>("RetryButton").Click += delegate { ShowPage("ChoosePage"); };

            ShowPage("ChoosePage");
        }

        private void Start()
        {
            bool everything = Find<RadioButton>("EverythingChoice").IsChecked == true;
            Busy = true;
            var bar = Find<ProgressBar>("Bar");
            var status = Find<TextBlock>("ProgressText");
            bar.BeginAnimation(ProgressBar.ValueProperty, null);
            bar.Value = 0;
            ShowPage("ProgressPage");
            StartPulse(Find<ScaleTransform>("Pulse"));

            var worker = new Thread(delegate ()
            {
                try
                {
                    Uninstaller.Uninstall(payload, install, everything, delegate (string text, double fraction)
                    {
                        OnUi(delegate
                        {
                            status.Text = text;
                            SetProgress(bar, fraction);
                        });
                    });
                    OnUi(delegate { Finish(everything); });
                }
                catch (Exception ex)
                {
                    string message = ex is InstallException ? ex.Message : "Something went wrong: " + ex.Message;
                    OnUi(delegate { Fail(message); });
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }

        private void Finish(bool everything)
        {
            Busy = false;
            Find<TextBlock>("DoneText").Text = everything
                ? "All VibeSync files, settings and data were removed."
                : "Your settings were kept for next time.";
            ShowPage("DonePage");
            Find<Button>("DoneCloseButton").Focus();
        }

        private void Fail(string message)
        {
            Busy = false;
            Find<TextBlock>("ErrorText").Text = message;
            ShowPage("ErrorPage");
        }

        /// <summary>A running exe can't delete itself; a hidden cmd removes the temp copy once we've exited.</summary>
        private static void DeleteSelfLater(string dir)
        {
            if (!dir.StartsWith(Path.GetTempPath(), StringComparison.OrdinalIgnoreCase)) return;
            try
            {
                Process.Start(new ProcessStartInfo("cmd.exe", "/c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"" + dir + "\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                });
            }
            catch (Exception) { }
        }
    }
}
