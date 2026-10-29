using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Threading;
using Microsoft.Win32;

namespace VibeSyncSetup
{
    /// <summary>
    /// Runs the NSIS uninstaller silently (it removes files, shortcuts and registry entries, and
    /// with --delete-app-data also %APPDATA%\VibeSync) and, for a full removal, cleans up what
    /// it doesn't know about: the update cache and the Spotify bridge.
    /// </summary>
    internal static class Uninstaller
    {
        private const int ErrorCancelled = 1223;
        // electron-updater's download cache: %LOCALAPPDATA%\<package name>-updater.
        private const string UpdaterCache = "vibesync-updater";
        // Same names as src/main/bridgeInstaller.ts.
        private static readonly string[] BridgeFiles = { "vibesync-bridge.js", "vibedeck-bridge.js" };

        public static void Uninstall(Payload payload, ExistingInstall install, bool everything, Action<string, double> progress)
        {
            if (everything)
            {
                progress("Removing the Spotify bridge…", 0);
                RemoveBridge();
            }

            progress("Closing VibeSync…", 0);
            string uninstaller = FindUninstaller(payload, install);
            if (uninstaller == null || !File.Exists(uninstaller))
                throw new InstallException("The VibeSync uninstaller is missing from " + install.Folder + ".");

            // Run a copy with _?= so it works in place and waits; the original can then be deleted too.
            string temp = Path.Combine(Path.GetTempPath(), "VibeSync-Uninstall-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temp);
            try
            {
                string copy = Path.Combine(temp, Path.GetFileName(uninstaller));
                File.Copy(uninstaller, copy);
                string args = "/S " + (install.PerMachine ? "/allusers" : "/currentuser")
                    + (everything ? " --delete-app-data" : "")
                    + " _?=" + install.Folder;

                Process process;
                try
                {
                    process = Process.Start(new ProcessStartInfo(copy, args) { UseShellExecute = true });
                }
                catch (Win32Exception ex)
                {
                    if (ex.NativeErrorCode == ErrorCancelled)
                        throw new InstallException("VibeSync is installed for all users, so removing it needs administrator rights.");
                    throw;
                }

                using (process)
                {
                    long start = Math.Max(1, Installer.FolderSize(install.Folder));
                    var clock = Stopwatch.StartNew();
                    double shown = 0;
                    while (!process.WaitForExit(250))
                    {
                        double removed = 1 - Installer.FolderSize(install.Folder) / (double)start;
                        double fraction = Math.Min(0.97, Math.Max(removed, Installer.EstimatedProgress(clock.Elapsed)));
                        if (fraction > shown)
                        {
                            shown = fraction;
                            progress("Removing files…", fraction);
                        }
                    }
                    if (process.ExitCode != 0)
                        throw new InstallException("The uninstaller stopped (code " + process.ExitCode + "). Close VibeSync if it's running, then try again.");
                }
            }
            finally
            {
                try { Directory.Delete(temp, true); } catch (Exception) { }
            }

            // _?= leaves the (now empty) folder behind, and Windows can hold it for a moment after.
            for (int attempt = 0; attempt < 10 && Directory.Exists(install.Folder); attempt++)
            {
                try { Directory.Delete(install.Folder, true); } catch (Exception) { Thread.Sleep(300); }
            }

            if (everything)
            {
                string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                string name = Path.GetFileNameWithoutExtension(payload.ExeName);
                DeleteQuietly(Path.Combine(local, UpdaterCache));
                DeleteQuietly(Path.Combine(roaming, name));
                DeleteQuietly(Path.Combine(roaming, name.ToLowerInvariant()));
            }
            progress("Done", 1);
        }

        private static string FindUninstaller(Payload payload, ExistingInstall install)
        {
            var hive = install.PerMachine ? RegistryHive.LocalMachine : RegistryHive.CurrentUser;
            foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                using (var root = RegistryKey.OpenBaseKey(hive, view))
                using (var key = root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + payload.AppGuid))
                {
                    string command = key == null ? null : key.GetValue("UninstallString") as string;
                    if (string.IsNullOrEmpty(command)) continue;
                    // UninstallString is '"C:\...\Uninstall VibeSync.exe" /currentuser'.
                    if (command.StartsWith("\""))
                    {
                        int end = command.IndexOf('"', 1);
                        if (end > 1) return command.Substring(1, end - 1);
                    }
                }
            }
            string fallback = Path.Combine(install.Folder, "Uninstall " + Path.GetFileNameWithoutExtension(payload.ExeName) + ".exe");
            return File.Exists(fallback) ? fallback : null;
        }

        /// <summary>
        /// Undoes Settings › Spotify › Install bridge. Spotify is only touched (spicetify apply)
        /// when a bridge file was actually installed. Failures are ignored: it's a cleanup step.
        /// </summary>
        private static void RemoveBridge()
        {
            string spicetify = FindSpicetify();
            if (spicetify == null) return;

            bool removed = false;
            foreach (var dir in new[] { Spicetify(spicetify, "path userdata"), Spicetify(spicetify, "path -e root") })
            {
                if (string.IsNullOrEmpty(dir)) continue;
                string extensions = Path.GetFileName(dir).Equals("Extensions", StringComparison.OrdinalIgnoreCase) ? dir : Path.Combine(dir, "Extensions");
                foreach (var file in BridgeFiles)
                {
                    string path = Path.Combine(extensions, file);
                    if (!File.Exists(path)) continue;
                    try { File.Delete(path); removed = true; } catch (Exception) { }
                }
            }
            if (!removed) return;

            foreach (var file in BridgeFiles) Spicetify(spicetify, "config extensions " + file + "-");
            Spicetify(spicetify, "apply");
        }

        private static string FindSpicetify()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string installed = Path.Combine(Path.Combine(local, "spicetify"), "spicetify.exe");
            if (File.Exists(installed)) return installed;
            return Spicetify("spicetify.exe", "-v") != null ? "spicetify.exe" : null;
        }

        /// <summary>Runs spicetify and returns the first output line, or null if it failed.</summary>
        private static string Spicetify(string exe, string args)
        {
            try
            {
                var psi = new ProcessStartInfo(exe, args)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true
                };
                using (var process = Process.Start(psi))
                {
                    string output = process.StandardOutput.ReadToEnd();
                    if (!process.WaitForExit(60000)) { process.Kill(); return null; }
                    if (process.ExitCode != 0) return null;
                    string first = output.Trim().Split('\n')[0].Trim();
                    return first;
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static void DeleteQuietly(string dir)
        {
            try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch (Exception) { }
        }
    }
}
