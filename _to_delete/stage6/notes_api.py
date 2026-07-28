#!/usr/bin/env python3
"""
Cell notes for keyed maps.

Any map with a grid calibration has addressable cells, so any map can carry
notes. They are stored as ONE markdown file per map in the Obsidian vault, with
a section per cell:

    <vault>/Map Notes/<map name>.md

    ---
    map: /maps/Darkmoon Vale/Maps/Dragonfall.jpg
    tags: [gm-display, map-notes]
    ---
    # Map Notes — Dragonfall.jpg

    ## 5,5
    The ford is guarded. Two sentries, bored.

    ## 7,2
    Collapsed bridge — the detour costs a Phase.

One file rather than one per cell keeps the vault tidy and the whole map
readable at a glance in Obsidian. The server re-reads a file whose mtime has
changed, so notes edited in Obsidian appear in the map without a reload, and
vice versa.

Wiring into server.py is two lines, next to the realm hooks:
    if notes_api.handle_get(self, parsed): return
    if notes_api.handle_post(self, parsed): return
"""

import json
import os
import re
import threading
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
SUBDIR = 'Map Notes'

_lock = threading.RLock()
_vault_root = None
_cache = {}       # path -> {'mtime': float, 'cells': {...}, 'title': str}
_version = 1


def init(vault_root):
    global _vault_root
    _vault_root = vault_root
    d = notes_dir()
    if d:
        os.makedirs(d, exist_ok=True)
        print(f"🗒️  Map notes: {d}")


def notes_dir():
    return os.path.join(_vault_root, SUBDIR) if _vault_root else None


def _safe(name):
    """A filename that survives Obsidian and the filesystem."""
    name = urllib.parse.unquote(name or '')
    name = os.path.basename(name.rstrip('/')) or 'map'
    name = re.sub(r'[\\/:*?"<>|#^\[\]]', '-', name)
    return name[:120]


def note_path(map_src):
    d = notes_dir()
    return os.path.join(d, _safe(map_src) + '.md') if d else None


# ---------------------------------------------------------------------------
# markdown <-> dict
# ---------------------------------------------------------------------------

def _parse(text):
    """-> {cell: body}. Anything before the first '## ' heading is preamble."""
    cells = {}
    body = text
    m = re.match(r'^---\n.*?\n---\n?(.*)$', text, re.S)
    if m:
        body = m.group(1)
    parts = re.split(r'^##\s+(.+?)\s*$', body, flags=re.M)
    # parts = [preamble, cell, text, cell, text, ...]
    for i in range(1, len(parts) - 1, 2):
        cell = parts[i].strip()
        note = parts[i + 1].strip()
        if note:
            cells[cell] = note
    return cells


def _compose(map_src, cells):
    name = _safe(map_src)
    out = ['---',
           f'map: "{map_src}"',
           'tags:',
           '  - gm-display',
           '  - map-notes',
           '---',
           '',
           f'# Map Notes — {name}',
           '']

    def sort_key(c):
        bits = re.findall(r'-?\d+', c)
        return ([int(b) for b in bits], c) if bits else ([9999], c)

    for cell in sorted(cells, key=sort_key):
        out += [f'## {cell}', '', cells[cell].strip(), '']
    return '\n'.join(out)


def _load(map_src, force=False):
    """Read from disk if the file changed under us (an Obsidian edit)."""
    path = note_path(map_src)
    if not path:
        return {}
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        _cache.pop(path, None)
        return {}
    hit = _cache.get(path)
    if hit and not force and hit['mtime'] == mtime:
        return hit['cells']
    try:
        with open(path, encoding='utf-8') as f:
            cells = _parse(f.read())
    except OSError:
        cells = {}
    _cache[path] = {'mtime': mtime, 'cells': cells}
    return cells


def _save(map_src, cells):
    global _version
    path = note_path(map_src)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(_compose(map_src, cells))
    os.replace(tmp, path)
    _cache[path] = {'mtime': os.path.getmtime(path), 'cells': cells}
    _version += 1


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def _send(h, obj, status=200):
    body = json.dumps(obj).encode()
    h.send_response(status)
    h.send_header('Content-Type', 'application/json')
    h.send_header('Content-Length', len(body))
    h.send_header('Cache-Control', 'no-store')
    h.send_header('Access-Control-Allow-Origin', '*')
    h.end_headers()
    h.wfile.write(body)


def handle_get(h, parsed=None):
    parsed = parsed or urllib.parse.urlparse(h.path)
    if parsed.path != '/api/notes':
        return False
    q = urllib.parse.parse_qs(parsed.query)
    map_src = (q.get('map') or [''])[0]
    with _lock:
        cells = _load(map_src)
        _send(h, {'map': map_src, 'cells': cells, 'version': _version,
                  'file': note_path(map_src), 'count': len(cells)})
    return True


def handle_post(h, parsed=None):
    parsed = parsed or urllib.parse.urlparse(h.path)
    if parsed.path != '/api/notes':
        return False
    if h.is_remote():                      # notes are the GM's
        _send(h, {'error': 'forbidden'}, 403)
        return True
    try:
        n = int(h.headers.get('Content-Length', 0))
        body = json.loads(h.rfile.read(n).decode()) if n else {}
    except Exception:
        _send(h, {'error': 'bad body'}, 400)
        return True
    map_src = body.get('map') or ''
    cell = str(body.get('cell') or '').strip()
    text = body.get('text', '')
    if not map_src or not cell:
        _send(h, {'error': 'map and cell required'}, 400)
        return True
    if not notes_dir():
        _send(h, {'error': 'no vault'}, 503)
        return True
    with _lock:
        cells = dict(_load(map_src, force=True))
        if text.strip():
            cells[cell] = text
        else:
            cells.pop(cell, None)
        _save(map_src, cells)
        _send(h, {'ok': True, 'version': _version, 'count': len(cells)})
    return True
