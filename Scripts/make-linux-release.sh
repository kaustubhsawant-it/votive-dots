#!/usr/bin/env bash
# Builds the downloadable Linux release: dist/Votive-Dots-<version>-linux.tar.gz (the tray program, the shared scripts, an installer that needs only
# Node.js 18 or later) and dist/SHA256SUMS-linux.txt. Run it from a checkout, on any machine with tar. Nothing is compiled.
#
#   ./Scripts/make-linux-release.sh
#   VOTIVE_RELEASE_OUT=/some/folder ./Scripts/make-linux-release.sh   # write somewhere other than ./dist
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION=$(sed -n 's/.*MARKETING_VERSION: "\(.*\)"/\1/p' project.yml)
[ -n "$VERSION" ] || { echo "Could not read the version from project.yml"; exit 1; }
[ -d linux ] || { echo "There is no linux/ folder here."; exit 1; }
OUT="${VOTIVE_RELEASE_OUT:-$ROOT/dist}"
NAME="Votive-Dots-$VERSION-linux"
WORK="$(mktemp -d)"
STAGE="$WORK/$NAME"

echo "==> Staging ${NAME}…"
mkdir -p "$STAGE/mcp-server" "$STAGE/docs"
cp -R linux "$STAGE/linux"
echo "$VERSION" > "$STAGE/linux/VERSION"   # the window shows it on Agents & tools
cp -R Scripts "$STAGE/Scripts"
cp mcp-server/index.js mcp-server/package.json mcp-server/package-lock.json "$STAGE/mcp-server/"
cp README.md LICENSE PRIVACY.md SECURITY.md "$STAGE/"
[ -f docs/INSTALLATION.md ] && cp docs/INSTALLATION.md "$STAGE/docs/"
# The Mac-only pieces do not belong in the Linux download.
rm -f "$STAGE/Scripts/install.sh" "$STAGE/Scripts/uninstall.sh" "$STAGE/Scripts/make-release.sh" "$STAGE/Scripts/build.sh" "$STAGE/Scripts/test-linux.sh"
find "$STAGE" -name .DS_Store -delete
cat > "$STAGE/INSTALL.txt" <<EOT
Votive Dots $VERSION for Linux (tray program)

What you need
  - Ubuntu 24.04 (GNOME, X11 or Wayland) is what it has been tried on. Other desktops that show tray icons (KDE, XFCE, Cinnamon, MATE) should work but are not tested.
  - On GNOME the AppIndicator extension must be on (Ubuntu ships it switched on).
  - Node.js 18 or later:  sudo apt install nodejs
  - Optional, each switches one feature on:
      wmctrl or xdotool    "Go to terminal" (X11 only; Wayland does not let one app raise another's window)
      xclip or wl-clipboard   Copy, and Prompt snippets (Add from clipboard)
      zenity               the confirmation window for Stop / Pause on the Ports list
      python3-gi gir1.2-gtk-3.0   the Votive Dots window and quick view (Ubuntu's desktop already has them)
      xdg-utils            Open (folders, transcripts, files)
      pulseaudio-utils or pipewire-bin   sounds

Install (no root needed)
  1. tar xzf $NAME.tar.gz && cd $NAME
  2. ./linux/install.sh
  3. node Scripts/doctor.js          checks the install, the service and the tray host
  Remove it later with:  ./linux/install.sh --remove

It runs as a systemd user service that may only open unix sockets. It reads files under ~/.votive and talks to your own D-Bus session.
It opens no network connection. See linux/README.md for what it does and what has been checked.
EOT
chmod +x "$STAGE"/linux/install.sh "$STAGE"/Scripts/*.sh 2>/dev/null || true

mkdir -p "$OUT"
TARBALL="$OUT/$NAME.tar.gz"
# Written in the work folder and moved into place, so a half-written file is never left behind. No extended attributes, no ownership.
( cd "$WORK" && COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -czf "$WORK/$NAME.tar.gz" "$NAME" 2>/dev/null || COPYFILE_DISABLE=1 tar -czf "$WORK/$NAME.tar.gz" "$NAME" )
mv -f "$WORK/$NAME.tar.gz" "$TARBALL"
if command -v sha256sum >/dev/null; then ( cd "$OUT" && sha256sum "$NAME.tar.gz" > SHA256SUMS-linux.txt ); else ( cd "$OUT" && shasum -a 256 "$NAME.tar.gz" > SHA256SUMS-linux.txt ); fi
echo "==> Wrote $TARBALL ($(du -h "$TARBALL" | cut -f1))"
cat "$OUT/SHA256SUMS-linux.txt"
