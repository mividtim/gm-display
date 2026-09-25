#!/bin/bash
# Double-click to build and (re)install the ⚔️ menu-bar app.
# Output is also saved to build_app.log beside this file.
cd "$(dirname "$0")" || exit 1
./build_app.sh 2>&1 | tee build_app.log
echo
echo "(You can close this window.)"
