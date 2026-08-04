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
- **Tokens** — Create player/NPC tokens (colored disc + name, or a vault image). Duplicate a token to auto-number it (`Goblin` → `Goblin 1`, `Goblin 2`, …). Tokens snap to a square grid and appear on the projector and on players' web view. The ✎ on any token's row renames it, recolours it, gives it a portrait or changes its side — after the fact, and for the Company too.
- **Split Maps** — A map you have two copies of: yours with the Myths and Holdings drawn on, theirs without. Still one map — same hexes, same notes, same tokens, same fog — so you declare the pairing once and every player-facing surface swaps to their copy. See below.
- **Propose / Approve Moves** — A player drags their token to a new square; it shows as a greyed-out ghost on every screen while the original stays solid, so the table can discuss it. The GM gets ✓/✗ controls (and can nudge the ghost first); approving commits the move for everyone.
- **Remote Players (ngrok / LAN)** — Share the map over the web. Players open a link, type a name, claim a token, and move it. They see the fog-of-war (revealed map art hidden as solid black) but can still see the grid and place/move tokens in the dark. They never see the GM controls.
- **Neon Markers** — A shared "laser pointer": drag to draw a glowing line that everyone sees and that fades after a few seconds. Call out a target, trace a move, mark a grenade toss. GM and every player each pick their own color.
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

## Remote Players (Tokens over the Web)

Tokens, fog, the grid, and markers sync to remote players through the server, so
players on other machines can take part — not just the local projector/sidecar
windows (which still sync instantly via `BroadcastChannel`).

1. Start the server as usual, open a map, and enter **Fog of War** mode.
2. Add tokens from the sidebar **Tokens** panel. Give players' tokens the **Player (PC)** side.
3. Expose the server with your ngrok tunnel:

   ```bash
   ngrok http 7680
   ```

4. Send players the ngrok URL. They land on the **player page** automatically
   (the GM control page is only served to localhost). They type a name, tap a
   token to claim it, and drag it to propose a move.
5. You'll see proposed moves as greyed ghosts with ✓/✗ buttons. Approve to commit.

### Players who let themselves in

A player with no token of their own can introduce themselves: a name, a
character, a colour, and optionally a portrait. That is a **request**, not a
character. It lands in **Asking to join** in your Tokens panel — ✓ makes them a
PC token on the current map, already owned by them; ✗ discards it.

Nothing they send exists until you tick it, and that is enforced rather than
hidden. A pending portrait is held in the server's memory: it is never written
to disk, never given a `/maps/` URL, and never sent to the projector or to
another player's browser. The queue in your sidebar is the only place it can be
rendered, and that request is refused to anyone but this machine. Tick it and it
becomes a normal vault image under `uploads/`; cross it and the bytes go with it.

Portraits are sniffed by content, not by what the sender called them, capped at
2MB, and the queue is capped at a dozen so nobody can bury you in requests.

Security model is intentionally light (no passwords, as requested): anyone with
the link can join and control an unclaimed token. Remote visitors can only *submit*
moves/claims/markers — they can never push authoritative state or reach the GM page.
Works the same over a LAN if you bind to your machine's IP instead of using ngrok.

Light is not the same as open. A remote visitor cannot read your cell notes, cannot
list your vault, and cannot fetch a vault image you are not currently showing them —
only the map on the table, the portraits on tokens they can already see, and legend
swatches. Fog hid unrevealed *areas* of the map you chose to show; it never had
anything to say about the rest of the vault.

## Split Maps (a GM copy and a player copy)

For a map you have twice — a realm sheet with the Myths and Holdings marked, and a
clean one for the table.

1. Open your copy as usual.
2. In **Grid Calibration** → **Players' copy of this map**, pick the players' image.
3. That's it. The projector and every remote player swap to their copy; your canvas
   keeps yours, and a ⚑ badge in Fog Tools reminds you the table is seeing something
   different.

Both copies must be the same pixel size — they share one grid, one set of cell
addresses and one fog mask, all measured in map pixels, so the hexes have to line up.
GM Display refuses a mismatched pair rather than letting every note drift silently
off the thing it describes.

The pairing is stored beside the map's other sidecar files, so you can also write it
in Obsidian:

```json
// Map Notes/<your map>.key.json
{ "shape": "hex", "cell": 188.25, "ox": 271, "oy": 256.6,
  "player": "/maps/Mythic Bastionland/Player/Realm (Player).png" }
```

The map's **identity** stays your copy: notes, party notes, the legend and the
calibration are all keyed on it. That is what keeps the two halves together — what
players write on their copy lands in the same `.party.md` you read, and shows up as
blue pips on your image.

A legend group whose title ends in `(GM)` — `## Myth sites (GM)` — is yours alone.
Players get the rest of the legend, because a player who can't read the map isn't in
suspense, just confused.

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
