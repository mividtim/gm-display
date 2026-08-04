#!/usr/bin/env python3
"""
Realm API for GM Display — Mythic Bastionland hex notes, player marks and tokens.

Design
------
* One markdown file per hex, in the Obsidian vault:
      <vault>/Mythic Bastionland/Hexes/Hex 05,05.md
  That file is the source of truth for prose. Edit it in Obsidian or in the web
  page; both see the same text, because the server re-reads any file whose mtime
  changed. YAML frontmatter carries the generated facts (terrain, holding, myth,
  landmarks) so Dataview/Bases can query the realm.
* Tokens are transient play state and live in realm_tokens.json beside this file.
* Everything is plain stdlib — the server has no dependencies and keeps none.

Wiring into server.py — four lines:
    import realm_api                                        # near the imports
    ...
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if realm_api.handle_get(self, parsed): return       # first line of do_GET
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if realm_api.handle_post(self, parsed): return      # first line of do_POST
"""

import json
import os
import re
import threading
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
TOKENS_PATH = os.path.join(HERE, 'realm_tokens.json')
DATA_PATH = os.path.join(HERE, 'realm_data.json')      # written by mkweb.py
HEX_SUBDIR = os.path.join('Mythic Bastionland', 'Hexes')
PLAYER_MARK = '<!-- player-notes -->'

_lock = threading.RLock()
_cache = {'stamp': None, 'notes': {}, 'checked': 0.0, 'version': 1}
_tokens = {'version': 1, 'tokens': []}
_vault_root = None      # set by init()
_realm = None           # parsed realm_data.json


# ---------------------------------------------------------------------------
# setup
# ---------------------------------------------------------------------------

def init(vault_root):
    """Called once from server.py's main() with the vault root (IMAGE_ROOTS[0])."""
    global _vault_root, _realm
    _vault_root = vault_root
    if os.path.isfile(DATA_PATH):
        try:
            with open(DATA_PATH, encoding='utf-8') as f:
                _realm = json.load(f)
        except Exception as e:
            print(f"⚠️  realm_api: could not read realm_data.json ({e})")
    _load_tokens()
    n = seed_notes()
    d = hexdir()
    if d:
        print(f"🗺️  Realm notes: {d}" + (f"  (seeded {n} new)" if n else ""))


def hexdir():
    if not _vault_root:
        return None
    return os.path.join(_vault_root, HEX_SUBDIR)


def note_path(row, col):
    d = hexdir()
    return os.path.join(d, f"Hex {int(row):02d},{int(col):02d}.md") if d else None


# ---------------------------------------------------------------------------
# markdown notes
# ---------------------------------------------------------------------------

def _split(text):
    """-> (frontmatter dict, gm body, player body). Unknown YAML keys survive."""
    fm, body = {}, text
    m = re.match(r'^---\n(.*?)\n---\n?(.*)$', text, re.S)
    if m:
        body = m.group(2)
        key = None
        for line in m.group(1).split('\n'):
            if not line.strip():
                continue
            if re.match(r'^\s+-\s', line) and key:
                fm.setdefault(key + '__list', []).append(
                    line.strip()[1:].strip().strip('"\''))
            elif ':' in line:
                key, _, val = line.partition(':')
                key = key.strip()
                fm[key] = val.strip().strip('"\'')
    if PLAYER_MARK in body:
        gm, _, pl = body.partition(PLAYER_MARK)
    else:
        gm, pl = body, ''
    return fm, gm.strip(), pl.strip()


def _yaml(fm):
    out = ['---']
    for k, v in fm.items():
        if k.endswith('__list'):
            out.append(f"{k[:-6]}:")
            for item in v:
                out.append(f'  - "{item}"')
        elif isinstance(v, list):
            out.append(f"{k}:")
            for item in v:
                out.append(f'  - "{item}"')
        else:
            s = str(v)
            out.append(f'{k}: "{s}"' if re.search(r'[:#\[\]{}]', s) else f'{k}: {s}')
    out.append('---')
    return '\n'.join(out)


def _compose(fm, gm_body, player_body):
    parts = [_yaml(fm), '', gm_body.strip(), '']
    parts += [PLAYER_MARK, player_body.strip(), '']
    return '\n'.join(parts)


def _read_note(path):
    try:
        with open(path, encoding='utf-8') as f:
            return _split(f.read())
    except FileNotFoundError:
        return {}, '', ''


def _write_note(path, fm, gm_body, player_body):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(_compose(fm, gm_body, player_body))
    os.replace(tmp, path)


def _stamp():
    """Cheap fingerprint of the notes folder: (name, mtime, size) for each file."""
    d = hexdir()
    if not d or not os.path.isdir(d):
        return ()
    out = []
    try:
        with os.scandir(d) as it:
            for e in it:
                if e.name.endswith('.md'):
                    st = e.stat()
                    out.append((e.name, int(st.st_mtime_ns), st.st_size))
    except OSError:
        return ()
    return tuple(sorted(out))


def _refresh(force=False):
    """Re-read notes if anything changed on disk (including edits made in Obsidian)."""
    now = time.time()
    if not force and now - _cache['checked'] < 0.8:
        return
    _cache['checked'] = now
    stamp = _stamp()
    if stamp == _cache['stamp']:
        return
    d = hexdir()
    notes = {}
    if d and os.path.isdir(d):
        for name, _, _ in stamp:
            m = re.match(r'^Hex (\d+),(\d+)\.md$', name)
            if not m:
                continue
            row, col = int(m.group(1)), int(m.group(2))
            fm, gm_body, pl_body = _read_note(os.path.join(d, name))
            marks = fm.get('player_marks__list', [])
            notes[f"{row},{col}"] = {
                'gm': gm_body, 'player': pl_body,
                'holdingName': fm.get('holding_name', ''),
                'marks': [_parse_mark(s) for s in marks],
            }
    _cache['stamp'] = stamp
    _cache['notes'] = notes
    _cache['version'] += 1


def _parse_mark(s):
    parts = [p.strip() for p in str(s).split('|')]
    while len(parts) < 3:
        parts.append('')
    return {'kind': parts[0], 'label': parts[1], 'by': parts[2]}


def _fmt_mark(m):
    return f"{m.get('kind','Note')} | {m.get('label','')} | {m.get('by','')}"


# ---------------------------------------------------------------------------
# seeding from realm_data.json
# ---------------------------------------------------------------------------

def seed_notes():
    """Create any missing hex note with generated frontmatter and a starter body."""
    if not _realm or not hexdir():
        return 0
    made = 0
    for h in _realm.get('hexes', []):
        row, col = h['row'], h['col']
        path = note_path(row, col)
        if os.path.exists(path):
            continue
        fm = {
            'hex': f"{row:02d},{col:02d}", 'row': row, 'col': col,
            'terrain': h['terrain'],
            'tags__list': ['mythic-bastionland', 'realm-hex'],
        }
        body = [f"# Hex {row},{col} — {h['terrain']}", '']
        if h.get('river'):
            body += ['A navigable river runs through this hex.', '']
        if h.get('holding'):
            fm['holding'] = h['holding']['type']
            fm['holding_name'] = h['holding']['name']
            body += [f"## {h['holding']['type']} — {h['holding']['name']}", '',
                     h['holding']['notes'], '']
        if h.get('myth'):
            m = h['myth']
            fm['myth'] = f"{m['n']} - {m['name']}"
            fm['myth_page'] = m['page']
            fm['omens'] = m['omens']
            body += [f"## Myth {m['n']} — {m['name']} (p{m['page']})", '',
                     f"Omens revealed so far: {m['omens']}.", '']
        if h.get('landmarks'):
            fm['landmarks__list'] = h['landmarks']
            for k in h['landmarks']:
                body += [f"## {k}", '', _realm.get('landmarkText', {}).get(k, ''), '']
        if h.get('barriers'):
            fm['barriers__list'] = [f"{b[0]},{b[1]}" for b in h['barriers']]
        _write_note(path, fm, '\n'.join(body).strip(), '')
        made += 1
    if made:
        _write_index()
        _refresh(force=True)
    return made


def _write_index():
    d = hexdir()
    if not d or not _realm:
        return
    rows = ["---", "tags:", "  - mythic-bastionland", "---", "",
            "# The Realm — hex index", "",
            "Open the interactive map: [Realm map](http://localhost:7680/realm.html)", "",
            "| Hex | Terrain | Of note |", "|---|---|---|"]
    for h in _realm.get('hexes', []):
        bits = []
        if h.get('holding'):
            bits.append(f"{h['holding']['type']} — {h['holding']['name']}")
        if h.get('myth'):
            bits.append(f"Myth {h['myth']['n']} · {h['myth']['name']}")
        bits += h.get('landmarks', [])
        if h.get('river'):
            bits.append('river')
        if not bits:
            continue
        link = f"[[Hex {h['row']:02d},{h['col']:02d}]]"
        rows.append(f"| {link} | {h['terrain']} | {', '.join(bits)} |")
    with open(os.path.join(d, 'Realm Hexes.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(rows) + '\n')


# ---------------------------------------------------------------------------
# tokens
# ---------------------------------------------------------------------------

def _load_tokens():
    global _tokens
    try:
        with open(TOKENS_PATH, encoding='utf-8') as f:
            _tokens = json.load(f)
    except Exception:
        _tokens = {'version': 1, 'tokens': [
            {'id': 'company', 'name': 'The Company', 'kind': 'company',
             'row': 5, 'col': 5, 'color': '#c8a02a'}]}
        _save_tokens()


def _save_tokens():
    tmp = TOKENS_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(_tokens, f, indent=1)
    os.replace(tmp, TOKENS_PATH)


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


def _body(h):
    try:
        n = int(h.headers.get('Content-Length', 0))
        return json.loads(h.rfile.read(n).decode()) if n else {}
    except Exception:
        return None


def _state(include_gm):
    _refresh()
    notes = {}
    for k, v in _cache['notes'].items():
        entry = {'player': v['player'], 'marks': v['marks'],
                 'holdingName': v['holdingName']}
        if include_gm:
            entry['gm'] = v['gm']
        notes[k] = entry
    return {'version': _cache['version'] + _tokens['version'],
            'notes': notes, 'tokens': _tokens['tokens']}


def handle_get(h, parsed=None):
    parsed = parsed or urllib.parse.urlparse(h.path)
    if parsed.path != '/api/realm/state':
        return False
    with _lock:
        _send(h, _state(include_gm=not h.is_remote()))
    return True


def handle_post(h, parsed=None):
    parsed = parsed or urllib.parse.urlparse(h.path)
    if not parsed.path.startswith('/api/realm/'):
        return False
    action = parsed.path[len('/api/realm/'):]
    body = _body(h)
    if body is None:
        _send(h, {'error': 'bad body'}, 400)
        return True
    remote = h.is_remote()

    with _lock:
        if action == 'note':
            row, col = int(body.get('row', 0)), int(body.get('col', 0))
            path = note_path(row, col)
            if not path:
                _send(h, {'error': 'no vault'}, 503)
                return True
            fm, gm_body, pl_body = _read_note(path)
            fm.setdefault('hex', f"{row:02d},{col:02d}")
            fm.setdefault('row', row); fm.setdefault('col', col)
            section = body.get('section', 'player' if remote else 'gm')
            if section == 'gm' and remote:            # players never touch GM prose
                _send(h, {'error': 'forbidden'}, 403)
                return True
            if section == 'gm':
                gm_body = body.get('text', '')
            else:
                pl_body = body.get('text', '')
            if 'holdingName' in body and not remote:
                fm['holding_name'] = body['holdingName']
            _write_note(path, fm, gm_body, pl_body)
            _refresh(force=True)
            _send(h, {'ok': True, 'version': _cache['version'] + _tokens['version']})
            return True

        if action == 'mark':                          # player-placed landmark
            row, col = int(body.get('row', 0)), int(body.get('col', 0))
            path = note_path(row, col)
            if not path:
                _send(h, {'error': 'no vault'}, 503)
                return True
            fm, gm_body, pl_body = _read_note(path)
            fm.setdefault('hex', f"{row:02d},{col:02d}")
            fm.setdefault('row', row); fm.setdefault('col', col)
            marks = [_parse_mark(s) for s in fm.get('player_marks__list', [])]
            if body.get('remove') is not None:
                i = int(body['remove'])
                if 0 <= i < len(marks):
                    marks.pop(i)
            else:
                marks.append({'kind': body.get('kind', 'Note')[:40],
                              'label': body.get('label', '')[:200],
                              'by': body.get('by', 'a player')[:40]})
            if marks:
                fm['player_marks__list'] = [_fmt_mark(m) for m in marks]
            else:
                fm.pop('player_marks__list', None)
            _write_note(path, fm, gm_body, pl_body)
            _refresh(force=True)
            _send(h, {'ok': True, 'version': _cache['version'] + _tokens['version']})
            return True

        if action == 'token':
            toks = _tokens['tokens']
            tid = body.get('id')
            if body.get('remove'):
                if remote:
                    _send(h, {'error': 'forbidden'}, 403)
                    return True
                _tokens['tokens'] = [t for t in toks if t.get('id') != tid]
            else:
                t = next((t for t in toks if t.get('id') == tid), None)
                if t is None:
                    if remote:                        # players move, GM creates
                        _send(h, {'error': 'forbidden'}, 403)
                        return True
                    t = {'id': tid or f"t{int(time.time()*1000)}",
                         'name': 'Token', 'kind': 'marker',
                         'row': 1, 'col': 1, 'color': '#7a1f1f'}
                    toks.append(t)
                for k in ('row', 'col'):
                    if k in body:
                        t[k] = max(1, min(12, int(body[k])))
                if not remote:
                    for k in ('name', 'color', 'kind', 'note'):
                        if k in body:
                            t[k] = str(body[k])[:60]
            _tokens['version'] += 1
            _save_tokens()
            _send(h, {'ok': True, 'version': _cache['version'] + _tokens['version']})
            return True

    _send(h, {'error': 'unknown action'}, 404)
    return True
