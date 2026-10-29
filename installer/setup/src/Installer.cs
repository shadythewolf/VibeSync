using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using Microsoft.Win32;

namespace VibeSyncSetup
{
    internal sealed class ExistingInstall
    {
        public string Folder;
        public string Version;
        public bool PerMachine;
    }

    internal sealed class InstallOptions
    {
        public string Folder;
        public bool DesktopShortcut;
        public bool PerMachine;
    }

    internal sealed class InstallException : Exception
    {
        public InstallException(string message) : base(message) { }
    }

    /// <summary>
    /// Runs the embedded electron-builder NSIS package silently. NSIS keeps doing the real work
    /// (files, shortcuts, uninstaller, registry), so updates through electron-updater behave
    /// exactly as before; this class only feeds it the user's choices and watches its progress.
    /// </summary>
    internal static class Installer
    {
        private const int ErrorCancelled = 1223;

        public static string DefaultFolder
        {
            get
            {
                string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                return Path.Combine(Path.Combine(local, "Programs"), "VibeSync");
            }
        }

        public static bool IsSilent(string[] args)
        {
            foreach (var arg in args)
            {
                if (string.Equals(arg, "/S", StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        /// <summary>Passes the command line through to the NSIS package and returns its exit code.</summary>
        public static int RunSilent(Payload payload, string[] args)
        {
            string package = payload.ExtractPackage();
            try
            {
                var psi = new ProcessStartInfo(package, string.Join(" ", args)) { UseShellExecute = false };
                using (var process = Process.Start(psi))
                {
                    process.WaitForExit();
                    return process.ExitCode;
                }
            }
            finally
            {
                DeleteQuietly(Path.GetDirectoryName(package));
            }
        }

        /// <summary>Finds an install made by any earlier VibeSync setup (per-user first, then per-machine).</summary>
        public static ExistingInstall FindExisting(Payload payload)
        {
            foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
            {
                foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
                {
                    using (var root = RegistryKey.OpenBaseKey(hive, view))
                    {
                        string folder = ReadValue(root, @"Software\" + payload.AppGuid, "InstallLocation");
                        if (string.IsNullOrEmpty(folder) || !File.Exists(Path.Combine(folder, payload.ExeName))) continue;
                        return new ExistingInstall
                        {
                            Folder = folder,
                            Version = ReadValue(root, @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + payload.AppGuid, "DisplayVersion"),
                            PerMachine = hive == RegistryHive.LocalMachine
                        };
                    }
                }
            }
            return null;
        }

        /// <summary>Returns null when the folder can be written to, otherwise a message for the user.</summary>
        public static string CheckFolder(string folder)
        {
            if (string.IsNullOrWhiteSpace(folder) || !Path.IsPathRooted(folder)) return "Choose a full folder path, like " + DefaultFolder + ".";
            try
            {
                Directory.CreateDirectory(folder);
                string probe = Path.Combine(folder, ".vibesync-setup-probe");
                File.WriteAllText(probe, "");
                File.Delete(probe);
                return null;
            }
            catch (UnauthorizedAccessException)
            {
                return "Setup can't write to that folder. Choose one inside your user folder.";
            }
            catch (Exception ex)
            {
                return "That folder can't be used: " + ex.Message;
            }
        }

        /// <summary>Installs and reports progress from 0 to 1. Throws InstallException on failure.</summary>
        public static void Install(Payload payload, InstallOptions options, Action<double> progress)
        {
            string package = payload.ExtractPackage();
            try
            {
                var args = new List<string> { "/S", options.PerMachine ? "/allusers" : "/currentuser" };
                if (!options.DesktopShortcut) args.Add("--no-desktop-shortcut");
                // NSIS wants /D last and unquoted, even when the path has spaces.
                args.Add("/D=" + options.Folder);

                // Shell execute so a per-machine update can show the UAC prompt.
                var psi = new ProcessStartInfo(package, string.Join(" ", args)) { UseShellExecute = true };
                Process process;
                try
                {
                    process = Process.Start(psi);
                }
                catch (Win32Exception ex)
                {
                    if (ex.NativeErrorCode == ErrorCancelled)
                        throw new InstallException("VibeSync is installed for all users, so updating it needs administrator rights.");
                    throw;
                }

                using (process)
                {
                    Watch(process, options.Folder, payload.UnpackedSize, progress);
                    if (process.ExitCode != 0)
                        throw new InstallException("Setup couldn't finish (code " + process.ExitCode + "). Close VibeSync if it's running, then try again.");
                }
            }
            finally
            {
                DeleteQuietly(Path.GetDirectoryName(package));
            }

            if (!File.Exists(Path.Combine(options.Folder, payload.ExeName)))
                throw new InstallException("Setup finished, but VibeSync wasn't found in " + options.Folder + ".");

            // Older packages ignore --no-desktop-shortcut; remove the link ourselves to be sure.
            if (!options.DesktopShortcut)
            {
                try { File.Delete(DesktopLink(payload, options.PerMachine)); } catch (Exception) { }
            }
            progress(1);
        }

        public static string DesktopLink(Payload payload, bool perMachine)
        {
            var desktop = perMachine ? Environment.SpecialFolder.CommonDesktopDirectory : Environment.SpecialFolder.DesktopDirectory;
            return Path.Combine(Environment.GetFolderPath(desktop), Path.GetFileNameWithoutExtension(payload.ExeName) + ".lnk");
        }

        public static void Launch(Payload payload, string folder)
        {
            Process.Start(new ProcessStartInfo(Path.Combine(folder, payload.ExeName))
            {
                UseShellExecute = true,
                WorkingDirectory = folder
            });
        }

        /// <summary>
        /// NSIS reports nothing in silent mode. A fresh install is measured by the folder's size
        /// against the unpacked app size; an update extracts over files of the same size, so a
        /// time-based curve (EstimatedProgress) keeps the bar moving there.
        /// </summary>
        private static void Watch(Process process, string folder, long expected, Action<double> progress)
        {
            long initial = FolderSize(folder);
            var clock = Stopwatch.StartNew();
            double shown = 0;
            while (!process.WaitForExit(250))
            {
                double bySize = initial < expected / 10 ? FolderSize(folder) / (double)expected : 0;
                double fraction = Math.Min(0.97, Math.Max(bySize, EstimatedProgress(clock.Elapsed)));
                if (fraction > shown)
                {
                    shown = fraction;
                    progress(fraction);
                }
            }
        }

        /// <summary>Eases toward 95% (about 70% after 7 s, 90% after 14 s, a typical install).</summary>
        internal static double EstimatedProgress(TimeSpan elapsed)
        {
            return 0.95 * (1 - Math.Exp(-elapsed.TotalSeconds / 6));
        }

        internal static long FolderSize(string folder)
        {
            long total = 0;
            try
            {
                if (!Directory.Exists(folder)) return 0;
                foreach (var file in Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories))
                {
                    try { total += new FileInfo(file).Length; } catch (IOException) { }
                }
            }
            catch (Exception) { }
            return total;
        }

        private static string ReadValue(RegistryKey root, string path, string name)
        {
            using (var key = root.OpenSubKey(path))
            {
                return key == null ? null : key.GetValue(name) as string;
            }
        }

        private static void DeleteQuietly(string dir)
        {
            try { Directory.Delete(dir, true); } catch (Exception) { }
        }
    }
}
