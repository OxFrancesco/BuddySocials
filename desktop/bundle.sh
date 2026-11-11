#!/bin/zsh
# Builds BuddySocials.app from the release binary and, with --install, copies it to /Applications.
set -e
cd "${0:A:h}"
cargo build --release
out=target/bundle
app=$out/BuddySocials.app
rm -rf $out && mkdir -p $app/Contents/MacOS $app/Contents/Resources $out/icon.iconset
cp target/release/buddysocials $app/Contents/MacOS/BuddySocials

# macOS icons sit on a rounded square inset from the canvas; the phone icon fills its square.
magick -size 824x824 xc:none -fill white -draw "roundrectangle 0,0,823,823,185,185" $out/mask.png
magick ../assets/icon.png -resize 824x824 -alpha off $out/mask.png -alpha off -compose CopyOpacity -composite \
  -compose Over -background none -gravity center -extent 1024x1024 $out/icon.png
for size in 16 32 128 256 512; do
  sips -z $size $size $out/icon.png --out $out/icon.iconset/icon_${size}x${size}.png >/dev/null
  sips -z $((size * 2)) $((size * 2)) $out/icon.png --out $out/icon.iconset/icon_${size}x${size}@2x.png >/dev/null
done
iconutil -c icns $out/icon.iconset -o $app/Contents/Resources/AppIcon.icns

version=$(grep -m1 '^version' Cargo.toml | cut -d'"' -f2)
cat > $app/Contents/Info.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>BuddySocials</string>
  <key>CFBundleDisplayName</key><string>BuddySocials</string>
  <key>CFBundleIdentifier</key><string>com.francescooddo.buddysocials.desktop</string>
  <key>CFBundleExecutable</key><string>BuddySocials</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.social-networking</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
# Signed for this Mac only, so the keychain remembers the app between builds of the same binary.
codesign --force --deep --sign - $app
echo "Built $app"
if [[ $1 == --install ]]; then
  rm -rf /Applications/BuddySocials.app
  cp -R $app /Applications/BuddySocials.app
  echo "Installed /Applications/BuddySocials.app"
fi
