# Regression harness

Captures the observable behaviour of GM Display as a JSON snapshot, so a
refactor can be verified by diffing instead of by hoping.

    python3 server.py --no-browser /path/to/vault     # in one shell
    python3 tests/regress.py baseline.json            # capture a baseline
    ...make changes...
    python3 tests/regress.py after.json baseline.json # capture + diff, exits 1 on drift

75 probes covering: map-key geometry (square, both hex orientations, and the
anisotropic case) with a 2000-point fingerprint per shape; fog RLE round-trip
and presets; crop maths including out-of-bounds overlap; token create,
duplicate, snap, propose and approve; localStorage key naming; the exact shapes
of the BroadcastChannel messages and the /api/* payloads; the full list of
sidebar panels and control ids, and that every generated UI binding
found its element. Also asserts the projector, sidecar and remote
pages load with no JS errors.

It expects two fixture maps in the vault under `Maps/`:
  printed-grid.png  1000x700, square grid printed at 53.3px offset (17, 9)
  realm-sheet.png   2560x3400, flat-top hexes at 188.25 x 209.2, origin (271, 256.6)
`tests/make-fixtures.py` regenerates the first; the second is the Mythic
Bastionland realm sheet rendered at 400dpi.

The harness has been mutation-tested: five realistic refactor slips (a hex
axial precision error, a dropped field in a wire payload, an axis mix-up in the
duplicate offset, a lost origin in snapping, and a renamed control id) are each
caught by at least one probe.

## Why the handler probe exists

The ES-module split passed all 46 original probes while leaving 42 of the 60
inline handlers dead: the markup was untouched and every control id still
existed, so the harness saw nothing wrong, but the functions were no longer
global and every button threw `… is not defined` on click. Checking that ids
exist is not the same as checking that controls work. `ui.handlers` closes that.

`baseline.json` is the committed known-good snapshot.

## After the inline-handler conversion

`ui.handlers` (which asserted inline-handler functions resolved) is replaced by
`ui.bindings` and `ui.inline_left`, because there are no inline handlers any
more: gm_display.html carries no `on*=` attributes and every control is wired
from `js/bindings.js`. The probes now assert that all 107 bindings matched an
element, that none are unbound, and that no inline attribute has crept back in.

The app publishes a single `window.GMD` handle and nothing else. The convenience
globals this harness uses are installed by the harness itself (`TEST_SHIM`), so
the application does not carry them.

## Three entry pages

The single page became `gm.html`, `display.html` and `remote.html`, each loading
its own entry module and only its own markup. `gm_display.html` is now a shim
that redirects, so old bookmarks, the menu-bar app and saved projector windows
keep working; the harness covers that path as `legacy-gm`.

`ui.bindings` reads 105 on the GM page rather than 107 because the two remote
controls now live on remote.html, which binds them itself.

## Module layout

    store.js        the shared state object, no imports
    state.js        globals and localStorage persistence
    games.js        game / campaign switcher
    per-map-store.js per-image crop, background, fog, libraries
    geometry.js     map-key geometry: cell size, origin, snapping, grid drawing
    tokens.js       token roster, per-map placement, GM rendering and controls
    projector.js    projector mirror under the keystone warp
    markers.js      shared marker fade/render loop
    remote-page.js  the remote player page
    fog.js fog-presets.js crop.js projection.js navigation.js
    player-view.js sidebar.js keyboard.js init.js bindings.js
    gm.js display.js remote.js    entry points, one per page

## Cell notes

`notes.labels.*` assert that a cell label round-trips through the axial form for
both square and hex keys — get that wrong and a note saved on one hex comes back
attached to a different one. `notes.api` exercises the server: write a note,
read it back, clear it.

Notes live in the vault at `Map Notes/<map name>.md`, one file per map with a
`## row,col` section per cell, so the whole map reads at a glance in Obsidian.
The server re-reads a file whose mtime changed, and the page polls every four
seconds, so an edit made in Obsidian appears on the open map and vice versa.

## Shipped calibrations

A map can ship its grid calibration beside its notes as
`Map Notes/<map>.key.json`, so a prepared map opens already calibrated. It is
only consulted when this browser has never calibrated that map itself, so a
local adjustment always wins.

Watch the ordering there: `setTokenMap` saves the OUTGOING map's calibration,
and `S.lastMapSrc` already points at the incoming one by then. `saveMapKey`
therefore requires an explicit src and has no `|| S.lastMapSrc` fallback — with
one, the first map load wrote the incoming map's entry and masked its shipped
key entirely.

## Party notes

The players' half of the map. They write on their own copy from `remote.html`;
the GM sees what they wrote without being able to edit it.

Two files per map, never one:

    Map Notes/<map>.md         the GM's prep — never served to a player
    Map Notes/<map>.party.md   what the party wrote — readable by everyone

`POST /api/notes` refuses a remote client (`is_remote()` on `X-Forwarded-For`);
`POST /api/partynotes` accepts one, because that endpoint is theirs. Each cell
holds a list of attributed entries, one per author:

    ## 4,6

    - **Sir Tim** — The ford is watched. Two sentries.
    - **Dame Ada** — We left a cache under the flat stone.

Writing again replaces only your own line; writing an empty string removes it,
and removing the last entry removes the cell. `party.api` asserts all three.

On the GM's map a cell with both kinds of note shows two pips side by side —
gold for the GM's, blue for the party's. The party block in the note editor
refreshes on its own (`renderPartyBlock`) so the four-second poll cannot rebuild
the textarea while the GM is typing in it; the player page keeps a draft for the
same reason.

## Why the remote screen probes exist

The module refactor stripped the inline `style="display:none"` from
`#remote-stage` and `#remote-bar`. The page still loaded with zero JS errors —
the old `errors.remote` probe was perfectly happy — but the play stage covered
the join screen, so no player could ever pick a character. `remote.screens` and
`remote.notes.controls` assert what the player actually sees on load, and that
the note canvas only takes taps once Notes mode is on (otherwise it sits over
the tokens and swallows every drag).

Mutation-tested: unhiding `#remote-stage`, dropping the same-author replace in
`notes_api._save_party`, and leaving the note canvas permanently clickable are
each caught.

## The Company

The party as one piece — which is how a realm-scale map wants to move players:
one marker crossing hexes, not five portraits stacked on the same hex. It is a
third `side` alongside `pc` and `npc`:

- **One per campaign.** The button creates it or brings the existing one back
  onto this map; duplicating it is refused.
- **On every map**, like a PC, but starting in the middle rather than the PC row.
- **Owned by nobody**, so any player who has joined may propose its move — the
  GM still approves. `applyPlayerAction` already allowed a propose on an
  unowned token, so this needed no new rule, only a token with no owner.
- **Never claimable.** The remote roster offers `side === 'pc'` only.
- Drawn to fill its cell (`tokenFrac` 1.0 against 0.96) with a gold double ring
  on GM, projector and player views alike.

`company.persists` exists because the roster save used to normalise any
non-`pc` side to `npc`, which would have silently demoted the Company on the
next reload — the map would look right all session and be wrong tomorrow.

Mutation-tested: restoring that normalisation, restricting `propose` to the
owner, and drawing the Company at figure size are each caught.

`company.cellhere` covers the readout in the token list. On a keyed map the
useful fact about a token is its cell, so the list reads "The Company · 5,5".
It is blank when the map has no calibration, because then an address would be
a guess.

## Note pips and clutter

`drawNoteMarkers` draws the GM's own gold pips only while Notes mode is on. The
realm sheet carries prep on all 144 hexes, and 144 gold dots over the artwork
tell the GM nothing during play. Party pips are always drawn: they are news,
and there are never many.

## Legend

What the symbols on a map mean. The realm sheet is a wall of hand-drawn terrain
and glyphs, and nobody at the table can tell a Sanctum from a Monument without
being told.

It lives beside the notes as markdown, so it is written in Obsidian where prep
already happens and read live here:

    <vault>/Map Notes/<map name>.legend.md

    ## Terrain
    - ![](/maps/Map Notes/legend-icons/marsh.png) **Marsh** — wet reedbeds
    - **Heath** — open scrub and heather

`## ` starts a group and each `- ` line is one entry: the bold run is the name,
whatever follows the dash is the gloss, and a leading image is the swatch. Any
of the three may be missing, and `legend.parse` covers every combination —
including a path with spaces in it, which vault paths routinely have and which
a naive `[^)\s]+` truncates at the first space.

Shown in three places from one renderer: the GM sidebar, a corner card on the
projector, and a sheet on players' phones. It is the map's caption rather than
the GM's prep, so nobody is kept from it — and a legend containing a "GM only"
group only reaches players if the GM projects the GM copy of the map, which
shows them far more than the legend anyway.

`legend.escapes` exists because this is the one place the app puts vault
content into `innerHTML`, on all three surfaces at once.

`legend.projector.fit` covers the wall. `fitLegendBox` shrinks the card's own
type until every entry fits, because nobody can scroll a projector: a legend
that overflows is not "mostly shown", the rows past the fold simply never reach
the table, and silently. The first version clipped 7 of the realm's 25 entries
and looked perfectly fine doing it.

Mutation-tested: truncating an icon path at the first space, dropping the HTML
escape, and disabling the fit loop are each caught.

`tests/make-legend-fixture.py` writes the `__parse__.png.legend.md` fixture.

## realm.html is retired

It was a second app living inside the first: one page for one map, with its own
hex geometry, its own note store (`Mythic Bastionland/Hexes/`, one file per hex),
its own token code and its own player build. Every one of those is now general —
any map with a grid calibration has addressable cells, notes, party notes, a
legend and tokens — so keeping it meant maintaining two of everything and fixing
each bug twice.

Removed: `realm.html`, `realm_api.py`, the four `realm_api` hook sites in
`server.py`, and the remote redirect to `realm_player.html`, which had pointed
at a file that no longer existed for some time.

`/realm.html`, `/realm_player.html` and `/realm_data.json` now 301 to `/gm.html`,
because a bookmark, a `gm://` link or a projector window left open from last
session should land on the real thing rather than a 404. `realm.retired` and
`realm.api.gone` assert both halves; dropping the redirect is caught.

No data was migrated because there was none: the vault's `Hexes` folder was
never created and no `realm_tokens.json` was ever written. The realm's prep
lives in `Map Notes/MB Campaign 1 Realm (GM).png.md`, which the general notes
system reads.

Note `status_of()` — the retired API is checked from Python rather than from the
page, because a 404 fetched in the browser writes a console error and
`errors.gm` has to stay a real signal.

## Notes on the map

Editing a cell note used to mean looking away from the map and into the
sidebar, which is the wrong place for a thing that is about a specific hex.

- **Hover** a cell: a tooltip peeks at what is written there — your note and
  the party's — and disappears the moment you press a button, so it never
  interrupts painting fog or dragging a token.
- **Right-click** a cell: the editor opens against that cell, in any mode. The
  moment you want to write something down is rarely the moment you were
  planning to switch modes, and nothing else in the app uses the context menu.
- **Notes mode** still works: a plain left click opens the same editor.
- The sidebar keeps the **index** of every note on the map; clicking a row now
  takes you to that cell with the editor open.

The peek renders the markdown (`mdLite`) because a note that reads `**Plains**`
and `### Castle` in a tooltip is worse than no tooltip. The editor shows the
source, because that is what you are editing. `notes.mdlite` covers both, and
the escaping: this is vault content going into `innerHTML`.

`notes.tip` asserts `pointer-events: none` on the tooltip. A tooltip that
swallows the click it is describing is worse than one that never appears.

Mutation-tested: dropping the escape and letting the tooltip take pointer
events are each caught.

## session.py — the test that should have existed first

`regress.py` is white-box: it calls internals and diffs a snapshot. It was
green for days while the projector showed the players a black rectangle,
because nothing in it ever asked the only question that matters at the table:
**can the players see the map?**

`tests/session.py` drives the app the way a GM does — through the real
controls, in a real second window — and asserts on **pixels in the projector
canvas**. Run it after any change that could touch what reaches the table:

    python3 tests/session.py

It covers loading a map with the projector open, Reveal All / Hide All,
Staged mode not reaching the projector, the staged warning being visible and
clickable, grid lines drawing separately from grid snapping, and a map with no
notes naming itself.

Three real defects it found on its first run, all of which regress.py was
happy with:

1. **Reveal All was inside a collapsed panel.** Fog Tools is the panel a GM
   works in and it was closed by default, so the primary control for putting a
   map on the projector was invisible. Now `open`, and asserted: any control a
   GM needs mid-session must be reachable without expanding something.
2. **Staged mode had no visible signal.** It is sticky across reloads, and its
   only indicators — a button reading "Staged" and a pulsing "Sync Now" — were
   both inside that same collapsed panel. The projector silently stops updating
   and nothing says why. There is now a banner over the map, which cannot be
   collapsed away and syncs when clicked.
3. **Switching to a map with no notes left the previous map's notes on screen.**
   `notesOnMapChanged` cleared `notes` and called `loadNotes(silent)`, which
   only repaints on a diff — and `{}` vs `{}` is not a diff, so the panel kept
   the old map's list. It repaints on the map change now.

A note on thresholds: the first version asserted "more than 60% of the
projector is lit". That passes on a pale fixture and fails on a dark map, which
is a property of the artwork, not a bug. It now compares each map against its
own fogged state, so the assertion is "revealing changed what the table sees".

## Drawing the grid vs using it

These were one flag, `tokenGridEnabled`, so turning off the overlay also killed
snapping, cell addresses and notes. They are now separate:

- `tokenGridEnabled` — this map is calibrated. Drives snapping, cell labels,
  hover notes, the Company's hex readout.
- `tokenGridShow` — draw the lines.

Most maps worth using already have a grid printed on them. Overlaying ours gives
the table two grids, one of which is a blue approximation of the other. Both
realm maps ship `"show": false` in their `.key.json` for exactly that reason:
calibrate to the printed hexes, don't redraw them.

## The tool strip

`S.currentTool` (fog brush), `S.markerMode` and a private `notesMode` used to be
three independent flags, each reaching into the layer stack to switch
`pointer-events` on its own. Nothing stopped two being on at once, and clicking
the map meant different things depending on which panel you had touched last.

There is now one `S.activeTool` and one function, `applyTool()`, that decides
which layer is live. Six tools — None, Reveal, Hide, Tokens, Notes, Marker —
exactly one active, shown in a strip over the map that cannot be collapsed away.
Keys R/H/V/N/M; Escape steps out one level at a time (close an open note, then
drop to None, then leave the map).

`setTool()`, `toggleNotesMode()` and `toggleMarkerMode()` are kept as thin
aliases onto the selector, so the sidebar buttons and saved state still work and
there is still only one piece of truth.

Picking a tool also opens and scrolls to its sidebar section — the brush size
lives with the fog tools, the roster with tokens, the note index with notes.
Opening the section by hand every time is the friction that stops people using
the settings at all.

The session test asserts, for each of the six, that exactly one button is lit
and exactly one layer is interactive. It also drags on the map under Reveal and
checks the projector got brighter, then repeats the identical drag under None
and checks nothing changed — the two halves of "the tool decides what a drag
does".

## Token fill

A token has to mark its cell without hiding what is drawn in it; on a realm hex
the art *is* the information. The fill is now its own layer (`.tok-fill` in the
DOM, a `globalAlpha` pass on the projector) so it can fade while the ring, the
initials and the label stay fully opaque and the token still reads across a
room. `S.tokenOpacity` is campaign-wide with a slider, default 62%; the Company
fades further still (×0.55) because it is the largest piece and sits on the hex
that matters most.

A player's marker line is the colour of the token they are playing, resolved at
draw time rather than at join time — so it stays right if the GM recolours the
token mid-session, and it is always obvious who is drawing.

## An emptied note is a deleted note

Clearing a cell's text removes the note — from the vault file, the note index,
the pip on the map, and the selection. The editor closes rather than sitting
open on a cell that no longer has anything, and the status says "note removed"
rather than "saved to your vault", which was actively misleading. Whitespace
counts as empty.

The hover tooltip now appears only when there is something written. It used to
show "no notes — click to write one" on every blank cell, which meant a box
following the cursor across the whole map telling the GM something they could
already see. The toolbar hint covers what the Notes tool does.

`session.py` step 11 writes a note, empties it, and checks all four places it
should vanish from — then hovers an empty cell and asserts no tooltip, and
hovers a noted one and asserts there is.

### One canvas, one owner

`#gm-grid-canvas` carries both the map grid and the note pips. `drawGMGrid()`
cleared it and drew both; `drawNoteMarkers()` only ever *added* ink. So removing
a note redrew the survivors straight over the stale gold dot, and the pip and
the selection ring stayed on screen until something unrelated happened to redraw
the whole layer. Data gone, UI still showing it.

`drawNoteMarkers()` now owns the layer — clear, grid, pips — and `drawGMGrid()`
delegates to it. Anything that can make a pip disappear goes through one place.

The `GOLD` probe counts gold pixels on that canvas, because this class of bug is
invisible to anything that asks the app what it *thinks* is drawn. Verified
against a faithful reproduction of the original: `1132 → 1721 → 1721` with the
bug, `184 → 755 → 184` with the fix.

A first attempt at this probe passed against a *partial* reproduction and I
nearly believed it. A mutation test is only worth the fidelity of the mutation:
if the reverted code cannot actually ship, it has not proved anything.

### "Have to refresh" is a cache header, not a redraw

Tim reported the pip still needed a page refresh *after* the redraw fix was
deployed — and a refresh fixing it is the signature of stale code, not of a
missing repaint: the old build's `drawGMGrid()` cleared the canvas on load,
which is exactly what a reload triggers.

`server.py` sent **no** `Cache-Control` on `.js`/`.css`, so the browser applied
heuristic freshness and a plain reload could keep running the previous version.
It now sends `no-cache, must-revalidate` for the app's own source and
`no-store` for `/api/*` (map images stay cacheable — they are large and never
edited in place). The override lives in `end_headers`, and skips any response
that already set the header itself, so the `.html` branch and the JSON helpers
are not double-headered. Checked with a real request per content type rather
than by reading the code.

Separately, removal is now optimistic: clearing a note updates the pip, the
ring and the editor *immediately* rather than after the 600ms debounce and a
round-trip, because that is the one edit whose outcome is not in doubt. If the
save then fails, the map is repainted from the vault, so a lost note comes
back rather than staying invisibly gone.

### The party log, and why the timestamp lives in the markdown

Party notes had no times at all — the file recorded *who* and *what*, never
*when* — so "in the order they were entered" was not a sort anyone could do.
The time had to start being recorded before the feature could exist.

It goes in the note line itself rather than a sidecar index:

    - **Sir Tim** (2026-09-16 21:05 · edited 2026-09-17 00:50) — we camped here

because this file is opened in Obsidian and edited by hand, and a separate
index would silently fall out of step the first time that happened. The
parenthesis is optional coming back in, so lines written before this existed —
or typed by a GM who did not bother — still load. They have no time, sort
first (they are older than anything dated, by definition), and the log says
"before times were kept" rather than inventing one.

Rewriting your own line keeps the time it was **entered**, so fixing a typo
does not jump the note to the bottom of the log. A change made later also
records when, because otherwise an entry becomes a different note quietly
wearing an old timestamp. A rewrite inside the same minute is not called an
edit — that is one act of writing, not a revision.

`tests/party-log.py` covers the vault half and then runs `party-log.mjs`,
which drives the real modules in a jsdom document: the order, the escaping of
player-typed text, and that each button actually toggles its panel. It is not
a browser — `session.py` is still the only thing that proves any of this
against a real canvas — but it is enough to catch a broken binding or a
regression in the ordering without one.

### Hide-the-grid was written to one place and read back from another

"Show grid" is stored twice: in the campaign roster (`tokenGridShow`) and in
the per-map key (`show`). A page load restores the roster and then applies the
map key over the top — so the map key wins. The toggle only ever saved the
roster, which meant the map key's stale `show: true` was reapplied on every
refresh and the grid came back. It had never been sticky.

The toggle now writes both. Whether to draw our grid is a property of the MAP
anyway: one map has a grid printed on it and the next does not.

That introduced a second-order trap worth knowing about. `applySavedMapKey`
treats *any* stored key as "this browser has calibrated this map", and skips
the calibration a map can ship in the vault. Once hiding the grid writes a key,
a never-calibrated map would stop adopting its shipped calibration. So the
adopt-from-vault path now keys off whether there is an actual calibration
(`keyCellPx`) rather than whether a key exists, and when it adopts one that
way it leaves the grid's on/off alone — the GM has said that out loud, and the
vault should not talk over them.

`tests/grid-sticky.mjs` drives the real `tokens.js` against a real
localStorage and replays what a page load does, including that second case.

### A hex accumulates notes

Party notes were one-entry-per-player-per-cell: writing again replaced your own
line. Coming back to a hex you have already written about is the normal case
at a table, though — you saw something new — so a second note is now a second
entry, and the log grows rather than being rewritten.

Entries are addressed by `(who, when)`, which is why the stored stamp carries
seconds even though every display rounds to the minute: two notes on one hex in
the same minute have to remain distinguishable. Two *different* players can
share a timestamp and still be distinct, because the author is half the key —
a test asserts exactly that, after an earlier version of it accidentally
proved the opposite.

The API follows from that: a POST without `at` adds; with `at` it changes or
removes that one entry, and only if it is yours. An empty note with no `at` is
nothing to say, and is refused rather than quietly deleting something — which
is what the old "empty means delete" rule would have turned into.
