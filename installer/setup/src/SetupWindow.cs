using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Forms = System.Windows.Forms;

namespace VibeSyncSetup
{
    internal sealed class SetupWindow : ShellWindow
    {
        private readonly Payload payload;
        private readonly ExistingInstall existing;
        private InstallOptions lastOptions;

        public SetupWindow(Payload payload) : base("SetupWindow.xaml", "VibeSync setup", payload)
        {
            this.payload = payload;
            existing = Installer.FindExisting(payload);

            var logo = payload.LoadLogo();
            Find<Image>("Logo").Source = logo;
            Find<Image>("ProgressLogo").Source = logo;
            Find<TextBox>("FolderBox").Text = Installer.DefaultFolder;

            var install = Find<Button>("InstallButton");
            var version = Find<TextBlock>("VersionText");
            if (existing == null)
            {
                version.Text = "Version " + payload.Version;
            }
            else
            {
                // An update reuses the existing folder and shortcuts, so there is nothing to choose.
                bool same = existing.Version == payload.Version;
                version.Text = same ? "Version " + payload.Version + " is already installed"
                    : "Update from " + (existing.Version ?? "an older version") + " to " + payload.Version;
                install.Content = same ? "Reinstall" : "Update";
                Find<Button>("OptionsButton").Visibility = Visibility.Collapsed;
            }

            // NSIS closes running copies without asking, so say so before it happens.
            if (Process.GetProcessesByName(Path.GetFileNameWithoutExtension(payload.ExeName)).Length > 0)
                Find<TextBlock>("RunningNotice").Visibility = Visibility.Visible;

            install.Click += delegate { StartInstall(); };
            Find<Button>("OptionsButton").Click += delegate { ToggleOptions(); };
            Find<Button>("BrowseButton").Click += delegate { Browse(); };
            Find<Button>("LaunchButton").Click += delegate { Launch(); };
            Find<Button>("DoneCloseButton").Click += delegate { Close(); };
            Find<Button>("ErrorCloseButton").Click += delegate { Close(); };
            Find<Button>("RetryButton").Click += delegate { Run(lastOptions); };

            ShowPage("WelcomePage");
        }

        private void ToggleOptions()
        {
            var panel = Find<FrameworkElement>("OptionsPanel");
            bool show = panel.Visibility != Visibility.Visible;
            panel.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
            Find<Button>("OptionsButton").Content = show ? "Hide options" : "Options";
        }

        private void Browse()
        {
            var box = Find<TextBox>("FolderBox");
            using (var dialog = new Forms.FolderBrowserDialog())
            {
                dialog.Description = "Choose where to install VibeSync. A VibeSync folder is created inside it.";
                dialog.ShowNewFolderButton = true;
                string parent = Path.GetDirectoryName(box.Text.TrimEnd('\\'));
                if (Directory.Exists(parent)) dialog.SelectedPath = parent;
                if (dialog.ShowDialog() != Forms.DialogResult.OK) return;

                // The uninstaller deletes the whole folder, so never install straight into e.g. Documents.
                string chosen = dialog.SelectedPath;
                if (!string.Equals(Path.GetFileName(chosen.TrimEnd('\\')), "VibeSync", StringComparison.OrdinalIgnoreCase))
                    chosen = Path.Combine(chosen, "VibeSync");
                box.Text = chosen;
            }
        }

        private void StartInstall()
        {
            var error = Find<TextBlock>("WelcomeError");
            InstallOptions options;
            if (existing != null)
            {
                // Keep the desktop shortcut only if the user didn't delete it.
                options = new InstallOptions
                {
                    Folder = existing.Folder,
                    PerMachine = existing.PerMachine,
                    DesktopShortcut = File.Exists(Installer.DesktopLink(payload, existing.PerMachine))
                };
            }
            else
            {
                string folder = Find<TextBox>("FolderBox").Text.Trim();
                string problem = Installer.CheckFolder(folder);
                if (problem != null)
                {
                    error.Text = problem;
                    error.Visibility = Visibility.Visible;
                    if (Find<FrameworkElement>("OptionsPanel").Visibility != Visibility.Visible) ToggleOptions();
                    return;
                }
                options = new InstallOptions
                {
                    Folder = Path.GetFullPath(folder),
                    DesktopShortcut = Find<CheckBox>("ShortcutBox").IsChecked == true
                };
            }
            error.Visibility = Visibility.Collapsed;
            Run(options);
        }

        private void Run(InstallOptions options)
        {
            lastOptions = options;
            Busy = true;
            var bar = Find<ProgressBar>("Bar");
            var status = Find<TextBlock>("ProgressText");
            bar.BeginAnimation(ProgressBar.ValueProperty, null);
            bar.Value = 0;
            Find<TextBlock>("ProgressTitle").Text = existing == null ? "Installing VibeSync" : "Updating VibeSync";
            status.Text = "Preparing…";
            ShowPage("ProgressPage");
            StartPulse(Find<ScaleTransform>("Pulse"));

            var worker = new Thread(delegate ()
            {
                try
                {
                    Installer.Install(payload, options, delegate (double fraction)
                    {
                        OnUi(delegate
                        {
                            status.Text = "Installing files…";
                            SetProgress(bar, fraction);
                        });
                    });
                    OnUi(delegate { Finish(options); });
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

        private void Finish(InstallOptions options)
        {
            Busy = false;
            Find<TextBlock>("DoneTitle").Text = existing == null ? "VibeSync is installed" : "VibeSync is up to date";
            Find<TextBlock>("DoneText").Text = existing == null && options.DesktopShortcut
                ? "You'll find it in the Start menu and on your desktop."
                : "You'll find it in the Start menu.";
            ShowPage("DonePage");
            Find<Button>("LaunchButton").Focus();
        }

        private void Fail(string message)
        {
            Busy = false;
            Find<TextBlock>("ErrorText").Text = message;
            ShowPage("ErrorPage");
        }

        private void Launch()
        {
            try
            {
                Installer.Launch(payload, lastOptions.Folder);
                Close();
            }
            catch (Exception ex)
            {
                Fail("VibeSync is installed but didn't start: " + ex.Message);
            }
        }
    }
}
