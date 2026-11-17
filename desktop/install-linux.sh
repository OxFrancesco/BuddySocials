#!/usr/bin/env bash
# Builds the release binary and installs it for this user on Linux: the binary in ~/.local/bin,
# the phone icon in the icon theme, and a launcher entry so app menus (walker, rofi, GNOME…) list it.
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release

bin=${XDG_BIN_HOME:-$HOME/.local/bin}
data=${XDG_DATA_HOME:-$HOME/.local/share}
mkdir -p "$bin" "$data/applications"
install -m 755 target/release/buddysocials "$bin/buddysocials"

for size in 64 128 256 512; do
  dir=$data/icons/hicolor/${size}x${size}/apps
  mkdir -p "$dir"
  magick ../assets/icon.png -resize ${size}x${size} "$dir/buddysocials.png"
done

cat > "$data/applications/buddysocials.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=BuddySocials
Comment=Your social accounts, posts, inbox and goals
Exec=$bin/buddysocials
Icon=buddysocials
Terminal=false
Categories=Network;
DESKTOP

if command -v update-desktop-database >/dev/null; then update-desktop-database -q "$data/applications"; fi
if command -v gtk-update-icon-cache >/dev/null; then gtk-update-icon-cache -q -t "$data/icons/hicolor" || true; fi
echo "Installed $bin/buddysocials"
