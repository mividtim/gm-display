#!/bin/bash
# Build the GM Display macOS app
#
# Tries to compile a native Swift menu bar app (⚔️ in menu bar).
# Falls back to AppleScript if Swift compilation fails.

APP_NAME="GM Display"
APP_DIR="$HOME/Applications/${APP_NAME}.app"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_ID="com.gm-display.app"

echo "Building ${APP_NAME}.app..."
echo ""

# --- Stop any running instance ---
echo "Stopping any running GM Display..."
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/com.gm-display.server.plist"
launchctl bootout gui/$(id -u) "${LAUNCHD_PLIST}" 2>/dev/null
rm -f "${LAUNCHD_PLIST}" 2>/dev/null
lsof -ti :7680 2>/dev/null | xargs kill 2>/dev/null
pkill -f "gm-display" 2>/dev/null
sleep 0.5

rm -rf "${APP_DIR}"
mkdir -p "$HOME/Applications"

# --- Try Swift compilation ---
SWIFT_SRC="${SCRIPT_DIR}/gm_menubar.swift"
BINARY="/tmp/gm-display-binary"
USE_SWIFT=false

echo "Attempting Swift compilation..."
if command -v swiftc &>/dev/null; then
    # Try compiling without target flag (works on any arch)
    if swiftc -O -o "${BINARY}" "${SWIFT_SRC}" -framework Cocoa 2>/tmp/swiftc_err.log; then
        USE_SWIFT=true
        echo "  Swift: compiled ✓ (native menu bar app)"
    else
        echo "  Swift compilation failed:"
        cat /tmp/swiftc_err.log | head -5
        echo "  Falling back to AppleScript..."
    fi
else
    echo "  swiftc not found. Install Xcode CLT: xcode-select --install"
    echo "  Falling back to AppleScript..."
fi

if $USE_SWIFT; then
    # === SWIFT APP BUNDLE ===
    mkdir -p "${APP_DIR}/Contents/MacOS"
    mkdir -p "${APP_DIR}/Contents/Resources"

    cp "${BINARY}" "${APP_DIR}/Contents/MacOS/gm-display"
    chmod +x "${APP_DIR}/Contents/MacOS/gm-display"
    rm -f "${BINARY}"

    cat > "${APP_DIR}/Contents/Info.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleExecutable</key>
    <string>gm-display</string>
    <key>CFBundleVersion</key>
    <string>4.0</string>
    <key>CFBundleShortVersionString</key>
    <string>4.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>GM Display Protocol</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>gm</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
EOF

    # Copy server files to Resources
    cp "${SCRIPT_DIR}/gm_display.html" "${APP_DIR}/Contents/Resources/"
    cp "${SCRIPT_DIR}/server.py" "${APP_DIR}/Contents/Resources/"

else
    # === APPLESCRIPT FALLBACK ===
    cat > /tmp/gm_display_handler.applescript << 'APPLESCRIPT'
-- GM Display URL handler
-- Sends gm:// URLs to the running server via curl POST.
-- Only starts the server if it's not already running. NEVER kills existing servers.

property serverScript : "$HOME/Documents/Pathfinder/.tools/gm-display/server.py"

on run
    if not isServerRunning() then
        startServer()
    end if
    do shell script "open 'http://localhost:7680'"
end run

on open location theURL
    if not isServerRunning() then
        startServer()
        delay 2
    end if

    -- POST the command directly via curl — never spawn a second server.py
    set jsonPayload to "{\"url\": " & quoted form of theURL & "}"
    -- Escape for shell: use a temp file to avoid quoting nightmares
    try
        do shell script "curl -s -X POST http://localhost:7680/api/command -H 'Content-Type: application/json' -d '{\"url\": \"" & theURL & "\"}' --max-time 2"
    on error errMsg
        -- Server might have died between check and POST — try starting it
        if not isServerRunning() then
            startServer()
            delay 2
            try
                do shell script "curl -s -X POST http://localhost:7680/api/command -H 'Content-Type: application/json' -d '{\"url\": \"" & theURL & "\"}' --max-time 2"
            end try
        end if
    end try
end open location

on isServerRunning()
    try
        do shell script "curl -s -o /dev/null -w '%{http_code}' --max-time 1 http://localhost:7680/api/health 2>/dev/null | grep -q 200"
        return true
    on error
        return false
    end try
end isServerRunning

on startServer()
    set supportPath to POSIX path of (path to application support from user domain) & "GM Display/"
    do shell script "mkdir -p " & quoted form of supportPath
    set logFile to supportPath & "gm-display.log"
    -- Use the vault copy of server.py (always up to date), find python3 via PATH
    set pyPath to do shell script "which python3 2>/dev/null || echo /usr/bin/python3"
    set srvPath to do shell script "echo " & serverScript
    set cmd to quoted form of pyPath & " " & quoted form of srvPath & " --no-browser >> " & quoted form of logFile & " 2>&1 & echo $!"
    set newPid to do shell script cmd
    do shell script "echo " & newPid & " > " & quoted form of (supportPath & "gm-display.pid")
    repeat 15 times
        if isServerRunning() then exit repeat
        delay 0.3
    end repeat
end startServer
APPLESCRIPT

    osacompile -o "${APP_DIR}" /tmp/gm_display_handler.applescript
    if [ $? -ne 0 ]; then
        echo "ERROR: osacompile failed"
        exit 1
    fi

    # Add URL scheme
    PLIST="${APP_DIR}/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string ${BUNDLE_ID}" "${PLIST}" 2>/dev/null
    /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "${PLIST}" 2>/dev/null
    /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "${PLIST}"
    /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLName string 'GM Display Protocol'" "${PLIST}"
    /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "${PLIST}"
    /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string gm" "${PLIST}"

    # Copy server files
    cp "${SCRIPT_DIR}/gm_display.html" "${APP_DIR}/Contents/Resources/"
    cp "${SCRIPT_DIR}/server.py" "${APP_DIR}/Contents/Resources/"

    rm -f /tmp/gm_display_handler.applescript
    echo "  AppleScript: compiled ✓ (no menu bar icon, but gm:// links work)"
fi

# --- Register URL scheme ---
echo ""
echo "Registering gm:// protocol..."
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -R "${APP_DIR}" 2>/dev/null

# --- Add to Login Items ---
osascript -e 'tell application "System Events"
  try
    delete every login item whose name is "GM Display"
  end try
  make login item at end with properties {path:"'"${APP_DIR}"'", hidden:true, name:"GM Display"}
end tell' 2>/dev/null

# --- Launch ---
echo "Launching..."
open -a "${APP_DIR}"

echo ""
echo "Waiting for server..."
for i in $(seq 1 30); do
    if curl -s --max-time 1 http://localhost:7680/api/command > /dev/null 2>&1; then
        echo "Server: running ✓"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "Server didn't start. Check log: cat ~/Library/Application\ Support/GM\ Display/gm-display.log"
    fi
    sleep 0.5
done

echo ""
echo "Done! Built: ${APP_DIR}"
if $USE_SWIFT; then
    echo "  ⚔️ should be in your menu bar (top right, near the clock)"
fi
echo ""
echo "=== Quick Guide ==="
echo "  gm://map/path  -> fog-of-war on projector"
echo "  gm://show/path -> image on sidecar"
echo "  P key in fog mode -> keystone + grid controls"
echo ""
