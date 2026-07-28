# Regression harness

Captures the observable behaviour of GM Display as a JSON snapshot, so a
refactor can be verified by diffing instead of by hoping.

    python3 server.py --no-browser /path/to/vault     # in one shell
    python3 tests/regress.py baseline.json            # capture a baseline
    ...make changes...
    python3 tests/regress.py after.json baseline.json # capture + diff, exits 1 on drift

46 probes covering: map-key geometry (square, both hex orientations, and the
anisotropic case) with a 2000-point fingerprint per shape; fog RLE round-trip
and presets; crop maths including out-of-bounds overlap; token create,
duplicate, snap, propose and approve; localStorage key naming; the exact shapes
of the BroadcastChannel messages and the /api/* payloads; and the full list of
sidebar panels and control ids. Also asserts the projector, sidecar and remote
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
