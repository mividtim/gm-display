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
- **Hidden Tokens** — A token can be on the board without being on the table. Hidden ones draw only on your screen, faded and dash-ringed, and you can place, drag and duplicate them there as normal. See below.
- **Move From Any Screen** — Drag a token on the projector window, or on the player page opened from this machine, and it commits — no walking back to the laptop mid-round.
- **Split Maps** — A map you have two copies of: yours with the Myths and Holdings drawn on, theirs without. Still one map — same hexes, same notes, same tokens, same fog — so you declare the pairing once and every player-facing surface swaps to their copy. See below.
- **Propose / Approve Moves** — A player drags their token to a new square; it shows as a greyed-out ghost on every screen while the original stays solid, so the table can discuss it. The GM gets ✓/✗ controls (and can nudge the ghost first); approving commits the move for everyone.
- **Remote Players (ngrok / LAN)** — Share the map over the web. Players open a link, type a name, claim a token, and move it. They see the fog-of-war (revealed map art hidden as solid black) but can still see the grid and place/move tokens in the dark. They never see the GM controls.
- **Neon Markers** — A shared "laser pointer": drag to draw a glowing line that everyone sees and that fades after a few seconds. Call out a target, trace a move, mark a grenade toss. GM and every player each pick their own color.
- **Bulletin Board** — A shared corkboard for the whole campaign. Every handout you share, from any module, is pinned to it; players move handouts by their pins, string yarn between them, open them full-screen and leave notes. Everyone shares one board, down to the pan and zoom. See below.
- **Zero Dependencies** — Pure Python server, vanilla HTML/JS/CSS client. No npm, no build step.

## Quick Start

On a Mac, install the ⚔️ menu-bar app once and let it run the server (see
*Running it* below):

```bash
./build_app.sh
```

Without it (or on another OS), run the server directly:

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

   **If ngrok runs on a different machine**, start the server with `--lan`
   first. By default it binds `127.0.0.1`, so nothing else on your network can
   reach it — not even the box running the tunnel:

   ```bash
   python3 server.py --lan /path/to/your/vault
   ```

   It prints the address to point the tunnel at. `--host=<addr>` pins a single
   interface and `--port=<n>` moves the port. Running under launchd? The flag
   has to go in `com.gm-display.server.plist`, or a restart quietly reverts to
   loopback. With `--lan`, anyone on your wifi can reach the *player* view —
   the GM page still redirects them, exactly like a tunnel visitor.

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

## The Bulletin Board (handouts for the whole campaign)

Handouts belong to a module; the board belongs to the **campaign**. Share a
handout from any module and it is pinned to the campaign's one board, so the
players can see everything they have been handed since the first session.

**Sharing is its own click.** Clicking a handout in the Library shows it to you
(and on the sidecar), exactly as before. To put it in front of the players,
click the 📌 on its card, or **📌 Share with players** over the open handout.
It lands on top, in the middle of what the table is looking at. The same button
takes it back off; its notes and yarn are kept in case you share it again.

On the player page the map is now one tool of two — **🗺 Map** and **📌 Board**
in the bottom bar. A red dot on Board means something new was pinned.

Everything on the board is shared, live: where each handout sits, which is on
top, the yarn, the notes, the pan and zoom, and which handout is open
full-screen. One player drags; every screen follows.

| Do this | To |
|---|---|
| Drag a **pin** | move that handout (it comes to the top) |
| Drag anywhere else — even over a handout | pan the board |
| Click a handout (press *and* release) | bring it to the top |
| Double-click a handout, or ⤢ | open it full-screen, for everyone |
| ⤓ on a handout | send it to the bottom of the pile |
| ◢ corner | resize it |
| **🧶 Yarn**, then drag pin → pin | string yarn (click a string to cut it) |
| Wheel / pinch, **Fit** | zoom |

Full-screen has **⧉ Side by side…** for comparing two handouts, and a notes
column on each. A note carries an ⓘ with the session date it was written and
who wrote it — player and character. Players can change or remove their own
notes; you can remove anyone's.

In the sidebar's **Bulletin Board** section: **Open the board** to work it
yourself (your notes are signed **The Handler** — or whatever you type in
*Notes as*), the campaign's single **yarn colour**, and the list of what is
shared.

The board is saved in the vault, one file per campaign:

    Map Notes/Boards/<campaign>.board.json

A handout's image is served to remote players only while it is shared.

Handouts no longer take fog: they are always shown whole. Grid lines on a
handout are off unless you turn them on for that handout, and that choice —
like each map's — is remembered per image.

## Hidden Tokens (the ambush)

The ◉ / ○ on a token's row is per-map, and it means "the table can see this".
Turn it off and the token keeps everything else: it still draws on your canvas,
faded and dash-ringed, still drags, still duplicates, still snaps to cells. What
it stops doing is existing anywhere else.

That last part is enforced rather than styled. A hidden NPC is stripped out of
the token document before it reaches a remote browser, and its portrait drops
out of the set of vault images the server will serve. There is nothing to find
in devtools, because nothing was sent. (Hidden *player* tokens are still sent —
a PC is not a secret from the table, and the join screen is built from that
list, so stripping one would strand the player who owns it.)

The shape of a normal ambush:

1. **Hide all NPCs** in the Tokens panel — one click, the whole room.
2. Place them and walk them around. The table watches an empty map.
3. As each player passes their roll, hit ◉ on that one row. Just that one
   appears, exactly where it has been standing.
4. It goes invisible again with the same button, from the same square.

## Shipped Encounters (a map that arrives with people on it)

A map could already arrive calibrated, captioned and split. The last thing that
still had to be built by hand at the table was the four things waiting in ambush
on it. Now that ships too, as one more sidecar beside the others:

```json
// Map Notes/<your map>.tokens.json
{ "name": "Devil's Chair",
  "tokens": [
    { "base": "K'n-yan", "num": 1, "side": "npc", "color": "#6a4a8a",
      "img": ".tools/gm-display/agent-tokens/Knyan 1.png",
      "tx": 0.40, "ty": 0.50, "onMap": false }
  ] }
```

`tx`/`ty` are fractions of the map (0–1) — the same coordinates a token carries
everywhere else — so an encounter survives the image being re-exported at a
different size. `onMap: false` is the default and the useful one: the token
lands hidden and stays hidden until you reveal it.

It seeds **once per map per browser**, so reopening a map mid-fight never walks
everyone back to their starting hexes or deals in a second set. In the Tokens
panel, **Save encounter** writes the current arrangement back to the vault, and
**Reload** re-seeds from the file — after editing the JSON, or to reset a fight
to its opening positions.

Prep is prep: this file is served to this machine only, and refused to anyone
holding the tunnel link. Half of a good encounter is things the players are not
supposed to know are there.

## Moving Tokens From the Projector or a Tablet

Tokens are draggable on the **projector window** as well as the GM page. The
grab is hit-tested through the keystone warp, so it stays accurate on an angled
projector rather than drifting toward the corners. That window is a mirror and
holds no roster: it moves the token on its own canvas so the drag looks live,
tells the GM page, and the GM page commits, persists and fans the move back out.

Only revealed tokens can be dragged there — the projector never draws the hidden
ones, which is the point of them.

The **player page opened from this machine** works the same way, which makes a
tablet or phone on the GM's own network into a second pair of hands. It offers
an **Open as GM** card on the character screen: no name, no claim, no proposal
queue. Drags commit instead of asking, hidden tokens are drawn (faded) so they
can be placed, and a double-tap on any token hides or reveals it — the reveal
beat, without reaching for the laptop.

Whether a page gets any of this is decided by the server, from the socket the
request arrived on, and stamped onto the request. It is not a field the sender
fills in, so a remote player posting the GM's own message kind gets nowhere.

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

## Running it: the ⚔️ menu-bar app

The menu-bar app is the one thing that runs the server. Build and install it
once (it needs the Xcode command-line tools):

```bash
./build_app.sh
```

That compiles `gm_menubar.swift` into `~/Applications/GM Display.app`, registers
`gm://` links, adds it to Login Items, retires the old launchd daemon, and starts
it. The first time, macOS asks whether GM Display may access your Documents
folder — say **Allow**; that is where the vault is.

What it guarantees:

- **It runs the code in this folder.** `server.py` is run straight from here,
  never from a copy inside the app, so there is no old version to fall back to.
- **New code goes live by itself.** When `server.py`, `notes_api.py` or
  `board_api.py` change, the server restarts itself in place (after checking
  the new code compiles). When the pages change, open GM and player pages show
  a small *GM Display was updated — Reload* bar.
- **It owns port 7680.** Starting or restarting takes the port from whatever
  holds it. Running `python3 server.py` in a Terminal while the app is up just
  asks the app to restart its server; add `--force` to really run it from the
  Terminal (the app then leaves it alone until you pick *Take Over Server*).
- **Restart Server** in the menu really restarts: it stops the server (the
  server now honours SIGTERM) and starts `server.py` fresh from disk.

The menu also opens the GM page, the projector, the sidecar and a **player
preview**, shows the log (`~/Library/Logs/gm-display.log`), and edits
`gm-display.conf` — the server's arguments (`--lan`), which browser *profile*
pages open in, and which python to use. Re-run `build_app.sh` only when
`gm_menubar.swift` itself changes.

## Previewing the player view

**👁 Preview player view** in the Displays section (or *Preview Player View* in
the ⚔️ menu, or the card on the player page's join screen) opens the player page
as a player would see it, without making a token. The server treats that page
exactly like a visitor on the tunnel: hidden NPCs, `(GM)` legend groups and
un-shared handouts are simply not sent to it.

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
