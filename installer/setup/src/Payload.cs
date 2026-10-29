using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Windows.Media.Imaging;

namespace VibeSyncSetup
{
    /// <summary>
    /// Everything build.ps1 embeds: the logo, a small properties file (mode, version, app GUID,
    /// unpacked size) and, for the setup only, the electron-builder NSIS package.
    /// </summary>
    internal sealed class Payload
    {
        private const string PackageResource = "package.exe";
        private const string LogoResource = "logo.png";
        private const string PropertiesResource = "setup.properties";

        public bool IsUninstaller { get; private set; }
        public string Version { get; private set; }
        public string AppGuid { get; private set; }
        public string ExeName { get; private set; }
        public long UnpackedSize { get; private set; }

        public static Payload Load()
        {
            var props = new Dictionary<string, string>();
            using (var stream = Open(PropertiesResource))
            using (var reader = new StreamReader(stream))
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    int eq = line.IndexOf('=');
                    if (eq > 0) props[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
                }
            }
            bool uninstaller = props["mode"] == "uninstall";
            if (!uninstaller) using (Open(PackageResource)) { }

            return new Payload
            {
                IsUninstaller = uninstaller,
                Version = props["version"],
                AppGuid = props["guid"],
                ExeName = props["exe"],
                UnpackedSize = long.Parse(props["size"])
            };
        }

        public BitmapImage LoadLogo()
        {
            var image = new BitmapImage();
            image.BeginInit();
            image.StreamSource = Open(LogoResource);
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.EndInit();
            image.Freeze();
            return image;
        }

        /// <summary>Writes the NSIS package to a fresh temp folder and returns its path.</summary>
        public string ExtractPackage()
        {
            string dir = Path.Combine(Path.GetTempPath(), "VibeSync-Setup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            string path = Path.Combine(dir, "VibeSync-Package-" + Version + ".exe");
            using (var source = Open(PackageResource))
            using (var target = File.Create(path))
            {
                source.CopyTo(target, 1 << 20);
            }
            return path;
        }

        internal static Stream Open(string name)
        {
            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
            if (stream == null) throw new InvalidDataException("Missing embedded resource " + name);
            return stream;
        }
    }
}
