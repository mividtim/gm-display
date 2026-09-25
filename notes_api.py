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
# server.py points this at resolve_map_key(): the player page only knows the
# map by an opaque key, never by its filename.
RESOLVE_MAP = None


def _map_param(v):
    v = v or ''
    return RESOLVE_MAP(v) if (RESOLVE_MAP and v.startswith('mk-')) else v


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


def party_path(map_src):
    """Notes the players write, kept in a separate file from the GM's so that
    neither can clobber the other and the GM's prep is never handed out."""
    d = notes_dir()
    return os.path.join(d, _safe(map_src) + '.party.md') if d else None


def key_path(map_src):
    """A map can ship its grid calibration beside its notes, so it arrives
    calibrated rather than needing the sliders walked onto it by hand."""
    d = notes_dir()
    return os.path.join(d, _safe(map_src) + '.key.json') if d else None


# ---------------------------------------------------------------------------
# the map key — calibration, and which image the table is shown
# ---------------------------------------------------------------------------
# A map's IDENTITY is the GM image's path: every sidecar above keys off it. A
# split map (a GM realm sheet with the Myths and Holdings drawn on, and a clean
# copy for the players) is still ONE map — same hexes, same notes, same tokens,
# same fog — that happens to be drawn twice. So the player image is recorded as
# a property of the identity rather than being a map in its own right, which is
# what stops the two halves forking into separate note and legend files that
# never meet.
#
#     Map Notes/<gm map>.key.json
#     { "shape": "hex", "cell": 128.5, "ox": 12, "oy": 8,
#       "player": "/maps/Mythic Bastionland/Player/Realm (Player).png" }

def _as_maps_url(p):
    """Accept a '/maps/...' URL or a bare vault-relative path, return a URL.

    The picker in the sidebar writes the first form; a GM editing the JSON in
    Obsidian will reach for the second. Both should work.
    """
    p = (p or '').strip()
    if not p:
        return ''
    if p.startswith('/maps/'):
        return p
    return '/maps/' + urllib.parse.quote(p.lstrip('/'))


def read_key(map_src):
    path = key_path(map_src)
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, encoding='utf-8') as f:
            k = json.load(f)
        return k if isinstance(k, dict) else None
    except Exception:
        return None


def write_key(map_src, patch):
    """Merge `patch` into the map's key file, creating it if needed.

    A key set to '' or None is removed, so the sidebar can un-split a map by
    writing an empty player image rather than needing a second endpoint.
    """
    path = key_path(map_src)
    if not path:
        return None
    k = read_key(map_src) or {}
    for kk, vv in patch.items():
        if vv is None or vv == '':
            k.pop(kk, None)
        else:
            k[kk] = vv
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(k, f, indent=2)
        f.write('\n')
    os.replace(tmp, path)
    return path


def player_variant(map_src):
    """The image the table is shown for this map, or '' when it is not split."""
    return _as_maps_url((read_key(map_src) or {}).get('player'))


def legend_path(map_src):
    """What the symbols on the map mean. Called 'legend' rather than 'key'
    throughout, because in this app a map's key is already its grid
    calibration and one word cannot be both."""
    d = notes_dir()
    return os.path.join(d, _safe(map_src) + '.legend.md') if d else None


# ---------------------------------------------------------------------------
# the encounter — who is standing on this map before anyone opens it
# ---------------------------------------------------------------------------
# The last thing about a map that still had to be built by hand at the table.
# A map could already arrive calibrated, captioned and split; the four things
# waiting in ambush on it had to be typed in, named, given portraits and
# dragged into place while the players watched.
#
# So: one more sidecar, beside the others, keyed on the same map identity.
#
#     Map Notes/<map>.tokens.json
#     { "tokens": [
#         { "base": "K'n-yan", "num": 1, "side": "npc", "color": "#6a4a8a",
#           "img": "/maps/.tools/gm-display/agent-tokens/Knyan 1.png",
#           "tx": 0.31, "ty": 0.44, "onMap": false } ] }
#
# `tx`/`ty` are map-normalized (0..1), the same coordinates a token carries
# everywhere else, so an encounter survives the map being re-exported at a
# different pixel size. `onMap: false` is the useful default for anything that
# is meant to be a surprise — it lands hidden, and stays hidden until revealed.
#
# This is prep, not live state. It seeds a map the first time that browser
# opens it and is never written back to afterwards, so moving a token at the
# table does not rewrite the file the encounter was prepped in.

def encounter_path(map_src):
    d = notes_dir()
    return os.path.join(d, _safe(map_src) + '.tokens.json') if d else None


# A token definition is copied into the GM's roster, so it is worth being
# strict about the shape here rather than letting a typo in a hand-written file
# turn into an undraggable disc with no name.
_HEX6 = re.compile(r'^#[0-9a-fA-F]{6}$')


def _clean_token(t, i):
    """One entry from an encounter file, or None if it is not usable."""
    if not isinstance(t, dict):
        return None
    base = str(t.get('base') or t.get('name') or '').strip()[:60]
    if not base:
        return None
    side = t.get('side')
    if side not in ('pc', 'npc', 'party'):
        side = 'npc'                      # an encounter is enemies by default
    color = t.get('color') if _HEX6.match(str(t.get('color') or '')) else '#c0392b'

    def frac(v, default):
        try:
            f = float(v)
        except (TypeError, ValueError):
            return default
        return min(1.0, max(0.0, f))

    return {
        # The id has to be stable: it is what stops a second open of the map
        # from seeding a duplicate set. Derived from the map and the entry, not
        # random, and not something the file has to remember to supply.
        'id': t.get('id') or None,
        'base': base,
        'num': int(t.get('num') or 0),
        'side': side,
        'color': color,
        'img': _as_maps_url(t.get('img') or ''),
        'tx': frac(t.get('tx'), 0.5),
        'ty': frac(t.get('ty'), 0.5),
        # Hidden unless the file says otherwise. Getting this backwards would
        # put the ambush on the projector.
        'onMap': bool(t.get('onMap', False)),
    }


def read_encounter(map_src):
    """The encounter prepped for this map: {'tokens': [...]} or None."""
    path = encounter_path(map_src)
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, encoding='utf-8') as f:
            doc = json.load(f)
    except Exception:
        return None
    # Accept both a bare list and the {"tokens": [...]} wrapper, because a GM
    # writing one by hand in Obsidian will reach for either.
    raw = doc.get('tokens') if isinstance(doc, dict) else doc
    if not isinstance(raw, list):
        return None
    out = []
    for i, t in enumerate(raw):
        c = _clean_token(t, i)
        if not c:
            continue
        if not c['id']:
            # Stable, but not the map's name: token ids reach players' browsers.
            import hashlib
            c['id'] = 'enc-%s-%d' % (hashlib.sha1(_safe(map_src).encode('utf-8')).hexdigest()[:10], i)
        out.append(c)
    if not out:
        return None
    name = doc.get('name') if isinstance(doc, dict) else None
    return {'tokens': out, 'name': str(name or '')[:80]}


def write_encounter(map_src, doc):
    """Save an encounter beside the map. Used by the sidebar's 'save' button;
    the file is equally meant to be written by hand."""
    path = encounter_path(map_src)
    if not path:
        return None
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, path)
    return path


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
# party notes — a list of attributed entries per cell
# ---------------------------------------------------------------------------

# An entry carries WHEN it was written, so the party's notes can be read as a
# log of the expedition and not only as an annotated map:
#
#     - **Sir Tim** (2026-09-17 00:44) — We camped here.
#     - **Dame Ada** (2026-09-17 01:02 · edited 2026-09-17 09:15) — The ford is
#
# Local wall-clock time, minute precision: this is a record of a session at a
# table, and "which came first" is the only question anyone asks of it. The
# parenthesis is optional on the way IN — entries written before timestamps
# existed, or typed into Obsidian by hand, still load. They simply have no
# time, and the log puts them first because they are older than anything dated.
_STAMP = r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?'
_ENTRY = re.compile(
    r'^-\s*\*\*(?P<by>.+?)\*\*\s*'
    r'(?:\(\s*(?P<at>' + _STAMP + r')\s*'
    r'(?:·\s*edited\s+(?P<edited>' + _STAMP + r')\s*)?\)\s*)?'
    r'[—-]\s*(?P<text>.*)$')

STAMP_FMT = '%Y-%m-%d %H:%M:%S'


def now_stamp():
    return time.strftime(STAMP_FMT, time.localtime())


def _next_second(stamp):
    try:
        t = time.mktime(time.strptime(stamp, STAMP_FMT)) + 1
        return time.strftime(STAMP_FMT, time.localtime(t))
    except ValueError:
        return stamp + ':01'


def _parse_party(text):
    out = {}
    for cell, body in _parse(text).items():
        entries = []
        for line in body.split('\n'):
            m = _ENTRY.match(line.strip())
            if m:
                e = {'by': m.group('by').strip(), 'text': m.group('text').strip()}
                if m.group('at'):
                    e['at'] = m.group('at')
                if m.group('edited'):
                    e['edited'] = m.group('edited')
                entries.append(e)
            elif line.strip():
                entries.append({'by': '', 'text': line.strip()})
        if entries:
            out[cell] = entries
    return out


def _compose_party(map_src, cells):
    name = _safe(map_src)
    out = ['---', f'map: "{map_src}"', 'tags:', '  - gm-display', '  - party-notes',
           '---', '', f'# Party Notes — {name}', '',
           'Written by the players on their own copy of the map.', '']

    def sort_key(c):
        bits = re.findall(r'-?\d+', c)
        return ([int(b) for b in bits], c) if bits else ([9999], c)

    for cell in sorted(cells, key=sort_key):
        out += [f'## {cell}', '']
        for e in cells[cell]:
            who = e.get('by') or 'a player'
            at, ed = e.get('at'), e.get('edited')
            when = ''
            if at:
                when = f' ({at} · edited {ed})' if ed else f' ({at})'
            out.append(f"- **{who}**{when} — {e.get('text', '').strip()}")
        out.append('')
    return '\n'.join(out)


def _load_party(map_src, force=False):
    path = party_path(map_src)
    if not path:
        return {}
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        _cache.pop(('party', path), None)
        return {}
    hit = _cache.get(('party', path))
    if hit and not force and hit['mtime'] == mtime:
        return hit['cells']
    try:
        with open(path, encoding='utf-8') as f:
            cells = _parse_party(f.read())
    except OSError:
        cells = {}
    _cache[('party', path)] = {'mtime': mtime, 'cells': cells}
    return cells


def _save_party(map_src, cells):
    global _version
    path = party_path(map_src)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(_compose_party(map_src, cells))
    os.replace(tmp, path)
    _cache[('party', path)] = {'mtime': os.path.getmtime(path), 'cells': cells}
    _version += 1


# ---------------------------------------------------------------------------
# legend — what the symbols on the map mean
# ---------------------------------------------------------------------------
# A beautiful map is not a readable one. The realm sheet is a wall of hand-drawn
# terrain and glyphs, and nobody at the table knows a Sanctum from a Monument
# without being told. The legend lives beside the notes as markdown, so it is
# written in Obsidian where prep already happens, and read live here:
#
#     <vault>/Map Notes/<map name>.legend.md
#
#     ## Terrain
#     - ![](/maps/Map Notes/legend-icons/marsh.png) **Marsh** — wet reedbeds
#     - **Heath** — open scrub and heather
#
#     ## Landmarks
#     - **Sanctum** — a Seer lives here
#
# '## ' starts a group, '- ' is an entry. The bold run is the name, whatever
# follows a dash is the gloss, and a leading image is the swatch. Any of the
# three may be missing.

_LEGEND_ENTRY = re.compile(
    r'^-\s*'
    # ![](path) — the path may contain spaces, which vault paths routinely do,
    # so take everything up to the closing paren and drop any "title" after it.
    r'(?:!\[[^\]]*\]\(\s*(?P<icon>[^)]+?)\s*(?:"[^"]*")?\s*\)\s*)?'
    r'(?:!\[\[\s*(?P<wiki>[^\]|]+?)\s*(?:\|[^\]]*)?\]\]\s*)?'  # ![[wikilink]]
    r'(?:\*\*(?P<name>.+?)\*\*\s*)?'
    r'(?:[—–-]\s*)?'
    r'(?P<text>.*)$'
)


def _parse_legend(text):
    """-> [{'title': str, 'entries': [{icon,name,text}]}]. Entries written
    before any heading land in an untitled first group."""
    body = text
    m = re.match(r'^---\n.*?\n---\n?(.*)$', text, re.S)
    if m:
        body = m.group(1)
    body = re.sub(r'^#\s+.*$', '', body, count=1, flags=re.M)   # drop the H1
    groups = []
    cur = {'title': '', 'entries': []}
    for line in body.split('\n'):
        s = line.strip()
        if s.startswith('## '):
            if cur['entries'] or cur['title']:
                groups.append(cur)
            cur = {'title': s[3:].strip(), 'entries': []}
            continue
        if not s.startswith('-'):
            continue
        em = _LEGEND_ENTRY.match(s)
        if not em:
            continue
        icon = em.group('icon') or ''
        if not icon and em.group('wiki'):
            # An Obsidian embed names a file, not a path. Serve it from the
            # legend-icons folder, which is where this app puts swatches.
            icon = '/maps/' + SUBDIR + '/legend-icons/' + em.group('wiki').strip()
        name = (em.group('name') or '').strip()
        gloss = (em.group('text') or '').strip().lstrip('—–-').strip()
        if not (name or gloss or icon):
            continue
        cur['entries'].append({'icon': icon, 'name': name, 'text': gloss})
    if cur['entries'] or cur['title']:
        groups.append(cur)
    return [g for g in groups if g['entries']]


_GM_GROUP = re.compile(r'\(\s*gm\s*\)\s*$', re.I)


def _public_legend(groups):
    """The legend minus any group marked "(GM)" — see /api/legend below."""
    return [g for g in groups if not _GM_GROUP.search(g.get('title') or '')]


def _load_legend(map_src, force=False):
    path = legend_path(map_src)
    if not path:
        return []
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        _cache.pop(('legend', path), None)
        return []
    hit = _cache.get(('legend', path))
    if hit and not force and hit['mtime'] == mtime:
        return hit['groups']
    try:
        with open(path, encoding='utf-8') as f:
            groups = _parse_legend(f.read())
    except OSError:
        groups = []
    _cache[('legend', path)] = {'mtime': mtime, 'groups': groups}
    return groups


_LEGEND_STARTER = """---
map: "{map_src}"
tags:
  - gm-display
  - map-legend
---

# Legend — {name}

Write what the symbols on this map mean. `## ` starts a group and each `- `
line is one entry: **bold** is the name, the rest is the gloss, and a leading
image becomes the swatch. It shows up in GM Display as you save.

## Terrain

- **Example** — replace this with the real thing

## Symbols

- **Example** — and this
"""


def _start_legend(map_src):
    """Create the file so the GM has something to open in Obsidian rather than
    a blank panel and no idea where the content is supposed to come from."""
    path = legend_path(map_src)
    if not path or os.path.exists(path):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(_LEGEND_STARTER.format(map_src=map_src, name=_safe(map_src)))
    return path


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

    if parsed.path == '/api/mapkey':
        q = urllib.parse.parse_qs(parsed.query)
        map_src = (q.get('map') or [''])[0]
        with _lock:
            key = read_key(map_src)
        _send(h, {'map': map_src, 'key': key,
                  'player': player_variant(map_src),
                  'file': key_path(map_src) or ''})
        return True

    # Who is waiting on this map. This is prep — half of it is things the
    # players are not supposed to know are there — so it is answered to this
    # machine and nowhere else, on the same reasoning as /api/notes below.
    if parsed.path == '/api/encounter':
        if h.is_remote():
            _send(h, {'error': 'forbidden'}, 403)
            return True
        q = urllib.parse.parse_qs(parsed.query)
        map_src = (q.get('map') or [''])[0]
        path = encounter_path(map_src)
        with _lock:
            enc = read_encounter(map_src)
        _send(h, {'map': map_src, 'encounter': enc,
                  'file': path if (path and os.path.exists(path)) else ''})
        return True

    if parsed.path == '/api/partynotes':
        q = urllib.parse.parse_qs(parsed.query)
        asked = (q.get('map') or [''])[0]
        map_src = _map_param(asked)
        if not map_src:                     # an opaque key for a map no longer up
            _send(h, {'map': asked, 'cells': {}, 'version': _version})
            return True
        with _lock:
            # Echo back what was asked, never the resolved filename.
            _send(h, {'map': asked, 'cells': _load_party(map_src), 'version': _version})
        return True

    # The legend is read by everyone — it is the map's own caption, and a
    # player who cannot read the map is not being kept in suspense, just
    # confused. One exception: a group whose title ends in "(GM)" is prep that
    # happens to be shaped like a caption ("Myth sites (GM)"), so it is dropped
    # on the way out to the table.
    if parsed.path == '/api/legend':
        q = urllib.parse.parse_qs(parsed.query)
        asked = (q.get('map') or [''])[0]
        map_src = _map_param(asked)
        path = legend_path(map_src) if map_src else None
        with _lock:
            groups = _load_legend(map_src) if map_src else []
        remote = h.is_remote()
        if remote:
            groups = _public_legend(groups)
        _send(h, {'map': asked, 'groups': groups,
                  # The legend file is named after the map: the GM's to know.
                  'file': '' if remote else (path if (path and os.path.exists(path)) else ''),
                  'count': sum(len(g['entries']) for g in groups)})
        return True

    if parsed.path != '/api/notes':
        return False
    # The GM's prep, and only the GM's. POST was guarded from the start; GET
    # never was, which made every hex of a realm's prep — where the Myths are,
    # where the Holdings are — one unauthenticated request away for anyone
    # holding the tunnel link. Fog hid the ART. This handed over the TEXT.
    if h.is_remote():
        _send(h, {'error': 'forbidden'}, 403)
        return True
    q = urllib.parse.parse_qs(parsed.query)
    map_src = (q.get('map') or [''])[0]
    with _lock:
        cells = _load(map_src)
        _send(h, {'map': map_src, 'cells': cells, 'version': _version,
                  'file': note_path(map_src), 'count': len(cells)})
    return True


def handle_post(h, parsed=None):
    parsed = parsed or urllib.parse.urlparse(h.path)

    # Players may write here — this is their half of the map, and it is a
    # separate file from the GM's notes.
    if parsed.path == '/api/partynotes':
        try:
            n = int(h.headers.get('Content-Length', 0))
            body = json.loads(h.rfile.read(n).decode()) if n else {}
        except Exception:
            _send(h, {'error': 'bad body'}, 400)
            return True
        map_src = _map_param(body.get('map') or '')
        cell = str(body.get('cell') or '').strip()
        who = (str(body.get('by') or 'a player').strip())[:40]
        text = str(body.get('text') or '').strip()[:2000]
        # Which existing entry this is about. Absent means "a new one" — a hex
        # visited twice is two observations, and the second must not silently
        # erase the first.
        at = str(body.get('at') or '').strip()
        if not map_src or not cell:
            _send(h, {'error': 'map and cell required'}, 400)
            return True
        if not notes_dir():
            _send(h, {'error': 'no vault'}, 503)
            return True
        with _lock:
            cells = {k: list(v) for k, v in _load_party(map_src, force=True).items()}
            entries = list(cells.get(cell, []))
            stamp = now_stamp()

            if at:
                # Addressing an entry that already exists: yours to change or
                # to take back, and nobody else's.
                idx = next((i for i, e in enumerate(entries)
                            if e.get('by') == who and e.get('at') == at), None)
                if idx is None:
                    _send(h, {'error': 'no such entry'}, 404)
                    return True
                if not text:
                    entries.pop(idx)
                else:
                    was = entries[idx]
                    e = {'by': who, 'text': text, 'at': was.get('at') or stamp}
                    if was.get('text') != text:
                        e['edited'] = stamp
                    elif was.get('edited'):
                        e['edited'] = was['edited']
                    entries[idx] = e
            elif text:
                # A new observation. Two notes on one hex in the same second
                # would be indistinguishable afterwards, so nudge the later
                # one along rather than let them collide.
                while any(e.get('by') == who and e.get('at') == stamp for e in entries):
                    stamp = _next_second(stamp)
                entries.append({'by': who, 'text': text, 'at': stamp})
            else:
                _send(h, {'error': 'nothing to add'}, 400)
                return True

            if entries:
                cells[cell] = entries
            else:
                cells.pop(cell, None)
            _save_party(map_src, cells)
            _send(h, {'ok': True, 'version': _version, 'at': stamp})
        return True

    # Save the tokens now on this map back to the vault as its encounter, so a
    # setup built by dragging can be kept and re-run — the same file a GM would
    # write by hand. Prep, so the GM only.
    if parsed.path == '/api/encounter':
        if h.is_remote():
            _send(h, {'error': 'forbidden'}, 403)
            return True
        try:
            n = int(h.headers.get('Content-Length', 0))
            body = json.loads(h.rfile.read(n).decode()) if n else {}
        except Exception:
            _send(h, {'error': 'bad body'}, 400)
            return True
        map_src = body.get('map') or ''
        if not map_src:
            _send(h, {'error': 'map required'}, 400)
            return True
        if not notes_dir():
            _send(h, {'error': 'no vault'}, 503)
            return True
        toks = [t for t in (_clean_token(t, i) or {}
                            for i, t in enumerate(body.get('tokens') or []))
                if t]
        with _lock:
            path = write_encounter(map_src, {
                'name': str(body.get('name') or '')[:80],
                'tokens': toks,
            })
        _send(h, {'ok': True, 'file': path or '', 'count': len(toks)})
        return True

    # Starting a legend writes a template into the vault for the GM to fill in
    # in Obsidian. Prep, so the GM only.
    if parsed.path == '/api/legend/start':
        if h.is_remote():
            _send(h, {'error': 'forbidden'}, 403)
            return True
        try:
            n = int(h.headers.get('Content-Length', 0))
            body = json.loads(h.rfile.read(n).decode()) if n else {}
        except Exception:
            _send(h, {'error': 'bad body'}, 400)
            return True
        map_src = body.get('map') or ''
        if not map_src:
            _send(h, {'error': 'map required'}, 400)
            return True
        if not notes_dir():
            _send(h, {'error': 'no vault'}, 503)
            return True
        with _lock:
            path = _start_legend(map_src)
        _send(h, {'ok': True, 'file': path or ''})
        return True

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
