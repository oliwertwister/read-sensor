#!/bin/zsh
set -eu

ROOT="${0:A:h}"
RUNTIME="$HOME/.local/lib/read-sensor"
LABEL="io.github.oliwertwister.read-sensor"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/read-sensor"
DOMAIN="gui/$(id -u)"

mkdir -p "$RUNTIME" "${PLIST:h}" "$LOG_DIR"
cp "$ROOT/collector.py" "$ROOT/publish.sh" "$RUNTIME/"
chmod 700 "$RUNTIME/collector.py" "$RUNTIME/publish.sh"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$RUNTIME/publish.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/collector.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/collector-error.log</string>
</dict>
</plist>
PLIST

chmod 600 "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Installed $LABEL (outbound HTTPS every 300 seconds)."
echo "Runtime copy: $RUNTIME"
