#!/usr/bin/env sh
# VibeSync AppImage installer for Linux (x86_64), for distros where the .deb does not fit.
# Installs for the current user only: no sudo needed except for the optional package step.
#
#   sh install-linux.sh [path/to/VibeSync-Linux-<version>.AppImage]
#   sh install-linux.sh --uninstall
set -eu

BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/vibesync"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"
APPIMAGE="$APP_DIR/VibeSync.AppImage"

say() { printf '%s\n' "$*"; }

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$APPIMAGE" "$BIN_DIR/vibesync" "$DESKTOP_DIR/vibesync.desktop" "$ICON_DIR/vibesync.png"
  rmdir "$APP_DIR" 2>/dev/null || true
  say "VibeSync removed. Your settings in ~/.config/VibeSync were kept."
  exit 0
fi

# Find the AppImage: argument, else next to this script.
SOURCE="${1:-}"
if [ -z "$SOURCE" ]; then
  SOURCE=$(ls "$(dirname "$0")"/VibeSync-Linux-*.AppImage 2>/dev/null | sort -V | tail -n 1 || true)
fi
if [ -z "$SOURCE" ] || [ ! -f "$SOURCE" ]; then
  say "VibeSync AppImage not found. Usage: sh install-linux.sh path/to/VibeSync-Linux-<version>.AppImage"
  exit 1
fi

mkdir -p "$APP_DIR" "$BIN_DIR" "$DESKTOP_DIR" "$ICON_DIR"
cp "$SOURCE" "$APPIMAGE"
chmod +x "$APPIMAGE"

# AppImages need FUSE 2; without it, extract-and-run works everywhere. The environment
# variable (not the flag) also reaches the new version that the updater restarts.
EXTRACT_ENV=""
if ! ls /usr/lib*/libfuse.so.2 /usr/lib/*/libfuse.so.2 /lib/*/libfuse.so.2 >/dev/null 2>&1; then
  EXTRACT_ENV="export APPIMAGE_EXTRACT_AND_RUN=1 VIBESYNC_EXTRACT_AND_RUN=1"
  say "Note: FUSE 2 (libfuse2) not found, VibeSync will start in extract-and-run mode."
fi

# The in-app updater needs the AppImage path. Extract-and-run strips APPIMAGE* variables
# before starting the app, so it is passed under VibeSync's own names as well.
cat > "$BIN_DIR/vibesync" <<EOF
#!/usr/bin/env sh
export APPIMAGE="$APPIMAGE" VIBESYNC_APPIMAGE="$APPIMAGE"
$EXTRACT_ENV
exec "$APPIMAGE" "\$@"
EOF
chmod +x "$BIN_DIR/vibesync"

# Icon from the AppImage itself; a missing icon only affects the menu entry.
( cd "$APP_DIR" && "$APPIMAGE" --appimage-extract 'usr/share/icons/*' >/dev/null 2>&1 \
  && cp "$(find squashfs-root/usr/share/icons -name '*.png' | sort | tail -n 1)" "$ICON_DIR/vibesync.png"; rm -rf squashfs-root ) || true

cat > "$DESKTOP_DIR/vibesync.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=VibeSync
Comment=Music visualizer with Spotify and synchronized lyrics
Exec=$BIN_DIR/vibesync %U
Icon=vibesync
StartupWMClass=vibesync
Terminal=false
Categories=AudioVideo;Audio;
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true

say "VibeSync installed. Start it from your app menu or with: vibesync"

# System audio capture needs pactl and parec (PulseAudio or PipeWire's pulse layer).
if ! command -v pactl >/dev/null 2>&1 || ! command -v parec >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then PKG="sudo apt-get install -y pulseaudio-utils"
  elif command -v dnf >/dev/null 2>&1; then PKG="sudo dnf install -y pulseaudio-utils"
  elif command -v pacman >/dev/null 2>&1; then PKG="sudo pacman -S --needed libpulse"
  elif command -v zypper >/dev/null 2>&1; then PKG="sudo zypper install -y pulseaudio-utils"
  else PKG=""
  fi
  say ""
  say "pactl/parec are missing; VibeSync needs them to capture system audio."
  if [ -n "$PKG" ] && [ -t 0 ]; then
    printf 'Install them now with "%s"? [Y/n] ' "$PKG"
    read -r answer
    case "$answer" in [nN]*) say "Skipped. Run later: $PKG" ;; *) $PKG ;; esac
  elif [ -n "$PKG" ]; then
    say "Install them with: $PKG"
  else
    say "Install your distribution's PulseAudio utilities package."
  fi
fi

case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "Tip: add $BIN_DIR to your PATH to start VibeSync with 'vibesync'." ;; esac
