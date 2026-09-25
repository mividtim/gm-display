#!/bin/bash
# Build and install the GM Display menu-bar app (⚔️).
#
#   ./build_app.sh
#
# The app is the ONE thing that runs the server. It runs server.py straight out
# of this folder (never a copy inside the app), as its own child process, and
# owns port 7680. This script:
#
#   1. retires the old launchd daemon (com.gm-display.server), which ran python
#      without Documents access and fought the app for the port;
#   2. stops anything else holding the port;
#   3. compiles gm_menubar.swift into ~/Applications/GM Display.app;
#   4. registers the gm:// URL scheme and adds the app to Login Items;
#   5. launches it and waits for the server to answer.
#
# Re-run it only when gm_menubar.swift changes. Changes to the server and the
# pages do not need it: the server restarts itself when its code changes, and
# open pages offer a reload.
set -u

APP_NAME="GM Display"
APP_DIR="$HOME/Applications/${APP_NAME}.app"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_ID="com.gm-display.app"
PORT=7680
UID_NUM="$(id -u)"

say() { printf '%s\n' "$*"; }

say "GM Display — building the menu-bar app"
say "  server.py: ${SCRIPT_DIR}/server.py"
say ""

# --- 0. Swift ---------------------------------------------------------------
if ! command -v swiftc >/dev/null 2>&1; then
    say "✗ swiftc not found. Install the Xcode command-line tools:"
    say "    xcode-select --install"
    exit 1
fi

# --- 1. retire the old launchd daemon ----------------------------------------
say "Retiring the old launchd daemon (if any)…"
for plist in "$HOME/Library/LaunchAgents"/com.gm-display*.plist; do
    [ -e "$plist" ] || continue
    label="$(basename "$plist" .plist)"
    launchctl bootout "gui/${UID_NUM}/${label}" 2>/dev/null
    mkdir -p "$HOME/.Trash"
    mv -f "$plist" "$HOME/.Trash/${label}.plist.$(date +%s)"
    say "  removed ${label} (moved to the Trash)"
done
launchctl bootout "gui/${UID_NUM}/com.gm-display.server" 2>/dev/null

# --- 2. stop the running app and anything on the port ------------------------
say "Stopping the running app and anything on port ${PORT}…"
osascript -e "tell application id \"${BUNDLE_ID}\" to quit" 2>/dev/null
sleep 1
pkill -x gm-display 2>/dev/null
PIDS="$(lsof -nP -ti tcp:${PORT} -sTCP:LISTEN 2>/dev/null)"
if [ -n "$PIDS" ]; then
    kill $PIDS 2>/dev/null
    sleep 1.5
    PIDS="$(lsof -nP -ti tcp:${PORT} -sTCP:LISTEN 2>/dev/null)"
    [ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null
fi

# --- 3. compile ----------------------------------------------------------------
say "Compiling gm_menubar.swift…"
BINARY="$(mktemp -t gm-display)"
if ! swiftc -O -o "${BINARY}" "${SCRIPT_DIR}/gm_menubar.swift" -framework Cocoa 2>/tmp/gm-display-swiftc.log; then
    say "✗ Swift compilation failed:"
    head -30 /tmp/gm-display-swiftc.log
    exit 1
fi
say "  compiled ✓"

rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources"
mv "${BINARY}" "${APP_DIR}/Contents/MacOS/gm-display"
chmod +x "${APP_DIR}/Contents/MacOS/gm-display"

# GMDToolsDir tells the app where server.py lives. No server files are copied
# into the bundle — a copy is exactly how the old app ended up running
# last month's server.
TOOLS_XML="$(printf '%s' "${SCRIPT_DIR}" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
cat > "${APP_DIR}/Contents/Info.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>         <string>${BUNDLE_ID}</string>
    <key>CFBundleName</key>               <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>        <string>${APP_NAME}</string>
    <key>CFBundleExecutable</key>         <string>gm-display</string>
    <key>CFBundleVersion</key>            <string>5.0</string>
    <key>CFBundleShortVersionString</key> <string>5.0</string>
    <key>CFBundlePackageType</key>        <string>APPL</string>
    <key>LSUIElement</key>                <true/>
    <key>LSMinimumSystemVersion</key>     <string>11.0</string>
    <key>GMDToolsDir</key>                <string>${TOOLS_XML}</string>
    <key>NSDocumentsFolderUsageDescription</key>
    <string>GM Display serves your maps, handouts and notes from your Obsidian vault in Documents.</string>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>    <string>GM Display Protocol</string>
            <key>CFBundleURLSchemes</key> <array><string>gm</string></array>
        </dict>
    </array>
</dict>
</plist>
EOF
plutil -lint "${APP_DIR}/Contents/Info.plist" >/dev/null || { say "✗ Info.plist is invalid"; exit 1; }

# Ad-hoc signature, so macOS can tell it is the same app from run to run.
codesign --force --sign - "${APP_DIR}" 2>/dev/null && say "  signed (ad-hoc) ✓"

# --- 4. gm:// and Login Items -------------------------------------------------
say "Registering gm:// …"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "${APP_DIR}" 2>/dev/null

say "Adding to Login Items…"
osascript -e 'tell application "System Events"
  try
    delete every login item whose name is "GM Display"
  end try
  make login item at end with properties {path:"'"${APP_DIR}"'", hidden:true, name:"GM Display"}
end tell' >/dev/null 2>&1

# --- 5. launch -------------------------------------------------------------------
say "Launching…"
open -a "${APP_DIR}"

say "Waiting for the server (macOS may ask whether GM Display can access Documents — say Allow)…"
for i in $(seq 1 60); do
    H="$(curl -s --max-time 1 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null)"
    if printf '%s' "$H" | grep -q '"supervisor": "tray"'; then
        say "  server: running under the menu-bar app ✓"
        printf '%s\n' "$H" | python3 -c 'import json,sys; h=json.load(sys.stdin); print("  pid %s · python %s · %s" % (h.get("pid"), h.get("python"), h.get("script","")))' 2>/dev/null
        break
    fi
    if [ "$i" -eq 60 ]; then
        say "  ✗ the server did not come up. Last lines of the log:"
        tail -15 "$HOME/Library/Logs/gm-display.log" 2>/dev/null
    fi
    sleep 0.5
done

say ""
say "Done: ${APP_DIR}"
say "  ⚔️ is in the menu bar. Restart Server there always runs the code in:"
say "     ${SCRIPT_DIR}"
say "  Settings: ${SCRIPT_DIR}/gm-display.conf"
say "  Log:      ~/Library/Logs/gm-display.log"
