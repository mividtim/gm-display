# Regression harness

Captures the observable behaviour of GM Display as a JSON snapshot, so a
refactor can be verified by diffing instead of by hoping.

    python3 server.py --no-browser /path/to/vault     # in one shell
    python3 tests/regress.py baseline.json            # capture a baseline
    ...make changes...
    python3 tests/regress.py after.json baseline.json # capture + diff, exits 1 on drift

65 probes covering: map-key geometry (square, both hex orientations, and the
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
