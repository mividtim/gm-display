# GM Display

A lightweight browser-based display tool for tabletop RPG game masters. Run maps on a projector with fog-of-war painting, and show art/handouts on a sidecar display — all controlled from a single GM page.

Designed for use with [Obsidian](https://obsidian.md) vaults via `gm://` URL protocol links, but works standalone too.

## Features

- **Fog of War** — Paint to reveal/hide areas on a map projected for players. Brush size, reveal all, hide all.
- **Dual Display** — Separate projector (maps) and sidecar (art/handouts) windows, each on their own screen.
- **Crop & Zoom** — Pan and zoom into map sub-regions. Fit (show all) and Fill (no black bars) presets. Position sliders with snap-to-edge. Viewport can extend past map edges to center any area on screen.
- **4-Corner Keystone** — Projective warp correction for angled projectors. Nudge each corner independently.
- **Grid Overlay** — Adjustable spacing, opacity, and color. Rendered on the projector over the map.
- **Text Overlay** — Display read-aloud text on the projector with a parchment-style overlay.
- **Obsidian Integration** — `gm://map/...` and `gm://show/...` links in your notes send commands directly to the running server.
- **macOS Menu Bar App** — Optional native Swift app (with AppleScript fallback) that registers the `gm://` URL scheme and lives in your menu bar.
- **Zero Dependencies** — Pure Python server, vanilla HTML/JS/CSS client. No npm, no build step.

## Quick Start

```bash
# Start the server (opens GM page in your default browser)
python3 server.py

# Or start without opening a browser
python3 server.py --no-browser

# Point it at your image vault
python3 server.py /path/to/your/vault
```

Then:
1. Click **Open Map Display** and **Open Image Display** to open the player-facing windows.
2. Drag each window to its target screen (projector, sidecar monitor).
3. Press **F11** for fullscreen on each.
4. Click `gm://` links in Obsidian, or drag images onto the GM page.

## Obsidian Links

In your Obsidian notes, use these link formats:

```markdown
[Show Battle Map](gm://map/Darkmoon%20Vale/Maps/Battle%20Map.jpg)
[Show NPC Portrait](gm://show/NPCs/Portrait.png)
```

- `gm://map/...` sends to the **projector** with fog-of-war controls
- `gm://show/...` sends to the **sidecar** as a simple image display

Paths are relative to your vault root.

## macOS App (Optional)

Build the menu bar app to register the `gm://` URL scheme system-wide:

```bash
./build_app.sh
```

This compiles a native Swift menu bar app (falls back to AppleScript if `swiftc` isn't available), registers the `gm://` protocol, and adds the app to Login Items. After building, clicking `gm://` links anywhere on your Mac routes them to the running server.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **R** | Reveal tool |
| **H** | Hide tool |
| **[** / **]** | Decrease / increase brush size |
| **C** | Toggle crop panel |
| **1** | Crop: Fit (show all) |
| **2** | Crop: Fill (no black bars) |
| **P** | Toggle projection (keystone + grid) panel |
| **G** | Toggle grid overlay |
| **T** | Toggle text overlay panel |
| **Esc** | Return to home screen |

## Architecture

```
Obsidian  ──gm://──▶  macOS App  ──curl POST──▶  server.py (:7680)
                                                      │
                                          ┌───────────┼───────────┐
                                          ▼           ▼           ▼
                                      GM Page    Projector    Sidecar
                                     (control)   (BroadcastChannel)
```

- **server.py** — Python HTTP server on `localhost:7680`. Serves the HTML app, handles `gm://` commands via POST, serves images from vault directories.
- **gm_display.html** — Single-file web app. GM page polls for commands; player windows sync via `BroadcastChannel` API.
- **build_app.sh** — Builds a macOS `.app` bundle that registers the `gm://` URL scheme.

## File Index

The server builds a file index at startup by walking your vault directory. This enables fuzzy path resolution — if a `gm://` link uses a partial path like `Maps/file.jpg`, the server can still find it even if the full vault path is `Campaign/Maps/file.jpg`.

## License

MIT
