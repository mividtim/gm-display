#!/usr/bin/env python3
"""Writes the legend fixture the harness parses.

Every shape a legend line can take is here on purpose — swatch or not, name or
not, gloss or not, a path with spaces in it, an Obsidian embed, and a line that
tries to smuggle markup through. Drop one of these and an entry vanishes from
the panel with no error anywhere.

    python3 make-legend-fixture.py "<vault>/Map Notes"
"""
import os
import sys

BODY = """---
map: "/maps/__parse__.png"
tags:
  - gm-display
  - map-legend
---

# Legend — __parse__.png

Prose before the first heading is not an entry.

## Terrain

- ![](/maps/Map Notes/legend-icons/terrain-bog.png) **Bog** — dark peat
- ![[terrain-lake.png]] **Lake** — deep open water
- **Heath** — open scrub
- **Plains**
- a gloss with no name at all

## Danger

- <img src=x onerror=alert(1)> **Trap** — markup must stay text
"""


def main(notes_dir):
    os.makedirs(notes_dir, exist_ok=True)
    path = os.path.join(notes_dir, '__parse__.png.legend.md')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(BODY)
    print('wrote', path)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'Map Notes')
