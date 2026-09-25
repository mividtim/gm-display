#!/usr/bin/env python3
"""
The campaign bulletin board.

One board per CAMPAIGN, not per module: every handout the GM shares, from any
module in the campaign, lands on the same corkboard, so the players can see
everything they have been handed since the first session in one place.

Everything on the board is shared by everyone looking at it — where the
handouts sit, which one is on top, the yarn between them, the notes on them,
and the pan and zoom of the board itself. One player drags, every screen
follows.

Stored in the vault beside the map sidecars, one JSON file per campaign:

    <vault>/Map Notes/Boards/<campaign slug>.board.json

    { "campaign": "delta-green", "name": "Delta Green",
      "yarnColor": "#c0392b", "gmName": "The Handler",
      "view": {"cx": 0, "cy": 0, "z": 1},
      "focus": ["h3f2a..."],                          # the shared full-screen view
      "handouts": [ {"id", "src", "name", "module", "shared",
                     "x", "y", "w", "h", "z", "sharedAt"} ],
      "yarn":  [ {"id", "a", "b"} ],                  # handout id -> handout id
      "notes": { "<handout id>": [ {"id", "by", "character", "gm",
                                    "text", "at", "edited"} ] } }

A handout the GM un-shares keeps its entry (with shared: false) so its notes
and yarn come back if it is shared again. None of it is sent to a player while
it is un-shared, and its image stops being served to them.

Sync is a long poll: GET /api/board?since=<version> waits until the board
changes (or ~20s pass) and then answers with the whole board. It is small —
positions, strings and text — and that keeps every client trivially correct.

Wiring into server.py, beside notes_api:
    if board_api.handle_get(self, parsed): return
    if board_api.handle_post(self, parsed): return
"""

import hashlib
import json
import os
import re
import threading
import time
import urllib.parse

SUBDIR = os.path.join('Map Notes', 'Boards')
DEFAULT_YARN = '#c0392b'
DEFAULT_GM_NAME = 'The Handler'
HANDOUT_W = 320.0               # board units; a new handout's width
LONG_POLL_S = 20.0
SAVE_DELAY_S = 1.2              # coalesce a drag's worth of moves into one write

_vault_root = None
_cond = threading.Condition(threading.RLock())
_boards = {}                    # slug -> doc
_versions = {}                  # slug -> int
_active = {'slug': '', 'name': ''}
_dirty = set()
_save_timer = [None]
# Bumps when the active campaign changes. Starts from the clock so a restarted
# server never hands out a version a client already thinks is old news.
_epoch = [int(time.time())]

_HEX6 = re.compile(r'^#[0-9a-fA-F]{6}$')
_SLUG = re.compile(r'^[a-z0-9][a-z0-9-]{0,80}$')


# ---------------------------------------------------------------------------
# storage
# ---------------------------------------------------------------------------

def init(vault_root):
    global _vault_root
    _vault_root = vault_root
    d = boards_dir()
    if not d:
        return
    os.makedirs(d, exist_ok=True)
    # Remember which campaign the table was on, so a server restart does not
    # leave the players staring at an empty board until the GM page reloads.
    try:
        with open(os.path.join(d, '_active.json'), encoding='utf-8') as f:
            a = json.load(f)
        if _SLUG.match(str(a.get('slug') or '')):
            _active['slug'] = a['slug']
            _active['name'] = str(a.get('name') or '')[:80]
    except Exception:
        pass
    print(f"📌 Bulletin boards: {d}")


def boards_dir():
    return os.path.join(_vault_root, SUBDIR) if _vault_root else None


def board_path(slug):
    d = boards_dir()
    return os.path.join(d, slug + '.board.json') if d else None


def _blank(slug, name=''):
    return {
        'campaign': slug, 'name': name or slug,
        'yarnColor': DEFAULT_YARN, 'gmName': DEFAULT_GM_NAME,
        'view': {'cx': 0.0, 'cy': 0.0, 'z': 1.0},
        'focus': [],
        'handouts': [], 'yarn': [], 'notes': {},
    }


def _board(slug):
    """The live doc for a campaign, loading it from disk the first time.
    Caller holds _cond."""
    if slug in _boards:
        return _boards[slug]
    doc = _blank(slug, _active['name'] if slug == _active['slug'] else '')
    path = board_path(slug)
    if path and os.path.exists(path):
        try:
            with open(path, encoding='utf-8') as f:
                disk = json.load(f)
            if isinstance(disk, dict):
                for k in doc:
                    if k in disk:
                        doc[k] = disk[k]
        except Exception as e:
            print(f"⚠️  Could not read board {path}: {e}")
    doc['focus'] = []            # a full-screen view does not survive a restart
    _boards[slug] = doc
    _versions.setdefault(slug, 1)
    return doc


def _schedule_save(slug):
    _dirty.add(slug)
    t = _save_timer[0]
    if t:
        t.cancel()
    t = threading.Timer(SAVE_DELAY_S, flush)
    t.daemon = True
    _save_timer[0] = t
    t.start()


def flush():
    with _cond:
        slugs = list(_dirty)
        _dirty.clear()
        docs = {s: json.loads(json.dumps(_boards[s])) for s in slugs if s in _boards}
    for slug, doc in docs.items():
        path = board_path(slug)
        if not path:
            continue
        doc.pop('focus', None)
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(doc, f, indent=2, ensure_ascii=False)
                f.write('\n')
            os.replace(tmp, path)
        except Exception as e:
            print(f"⚠️  Could not save board {path}: {e}")


def _changed(slug):
    """Caller holds _cond."""
    _versions[slug] = _versions.get(slug, 1) + 1
    _schedule_save(slug)
    _cond.notify_all()


# ---------------------------------------------------------------------------
# what a player is allowed to see
# ---------------------------------------------------------------------------

def canon_src(src):
    """One spelling per image: '/maps/' + the vault path, quoted once. The same
    handout reached from two modules (or quoted two ways) is one handout."""
    s = str(src or '').split('?')[0]
    if '://' in s:
        s = urllib.parse.urlparse(s).path
    if not s.startswith('/maps/'):
        return ''
    return '/maps/' + urllib.parse.quote(urllib.parse.unquote(s[6:]))


def handout_id(src):
    return 'h' + hashlib.sha1(canon_src(src).encode('utf-8')).hexdigest()[:12]


# server.py points this at its opaque-address function (/a/<token>) at start.
PUBLIC_URL = None

# What of a handout a player's browser is handed. Deliberately NOT its name or
# its path: a filename is information ("Barbas.png" pinned up as Agent
# Exeter's photo gives away a reveal the story has not made yet). A player sees
# only the title the GM chose to give it, if any.
_PUBLIC_KEYS = ('id', 'x', 'y', 'w', 'h', 'z', 'shared', 'cutout', 'title')


def public_view(doc):
    """The board as a player's browser receives it: shared handouts only,
    nothing that hangs off an un-shared one, and no filenames anywhere."""
    shared = [h for h in doc.get('handouts', []) if h.get('shared')]
    ids = {h['id'] for h in shared}
    out = dict(doc)
    hs = []
    for h in shared:
        p = {k: h[k] for k in _PUBLIC_KEYS if k in h}
        p['src'] = PUBLIC_URL(h.get('src') or '') if PUBLIC_URL else ''
        hs.append(p)
    out['handouts'] = hs
    out['yarn'] = [y for y in doc.get('yarn', []) if y.get('a') in ids and y.get('b') in ids]
    out['notes'] = {k: v for k, v in (doc.get('notes') or {}).items() if k in ids}
    out['focus'] = [i for i in (doc.get('focus') or []) if i in ids]
    return out


def published_assets():
    """Vault-relative paths of every handout currently on the active board.
    server.may_serve_remote() adds these to what a remote player may fetch."""
    with _cond:
        slug = _active['slug']
        if not slug:
            return set()
        doc = _board(slug)
        srcs = [h.get('src') or '' for h in doc.get('handouts', []) if h.get('shared')]
    out = set()
    for s in srcs:
        u = s.split('?')[0]
        if u.startswith('/maps/'):
            out.add(urllib.parse.unquote(u[6:]).replace('\\', '/').strip('/'))
    return out


# ---------------------------------------------------------------------------
# operations
# ---------------------------------------------------------------------------

def _num(v, default=0.0, lo=-1e7, hi=1e7):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f:                   # NaN
        return default
    return max(lo, min(hi, f))


def _find(doc, hid):
    return next((h for h in doc['handouts'] if h['id'] == hid), None)


def _stamp():
    return time.strftime('%Y-%m-%d %H:%M:%S')


def _new_id(prefix):
    return prefix + hashlib.sha1(f'{time.time()}-{os.urandom(4).hex()}'.encode()).hexdigest()[:10]


def apply_op(op, local):
    """Apply one operation to the active board. Returns (ok, error, extra)."""
    kind = str(op.get('op') or '')
    slug = _active['slug']
    if not slug:
        return False, 'no campaign is active — the GM page is not open', None
    doc = _board(slug)
    handouts = doc['handouts']

    def visible(h):
        # A player can only touch what they can see.
        return h is not None and (h.get('shared') or local)

    if kind == 'move':
        h = _find(doc, op.get('id'))
        if not visible(h):
            return False, 'no such handout', None
        h['x'] = _num(op.get('x'), h.get('x', 0))
        h['y'] = _num(op.get('y'), h.get('y', 0))
        if op.get('w') is not None:
            w = _num(op.get('w'), h.get('w', HANDOUT_W), 40, 4000)
            ratio = (h.get('h') or w) / (h.get('w') or w)
            h['w'] = w
            h['h'] = w * ratio
    elif kind in ('raise', 'lower'):
        h = _find(doc, op.get('id'))
        if not visible(h):
            return False, 'no such handout', None
        zs = [x.get('z', 0) for x in handouts] or [0]
        if kind == 'raise':
            if h.get('z', 0) == max(zs) and zs.count(max(zs)) == 1:
                return True, None, None          # already on top: not a change
            h['z'] = max(zs) + 1
        else:
            h['z'] = min(zs) - 1
        # Keep the numbers small; only their order means anything.
        for i, x in enumerate(sorted(handouts, key=lambda x: x.get('z', 0))):
            x['z'] = i
    elif kind == 'style':
        # Background cut-out on or off for one handout — shared, like the rest.
        h = _find(doc, op.get('id'))
        if not visible(h):
            return False, 'no such handout', None
        if op.get('cutout') is None:
            h.pop('cutout', None)
        else:
            h['cutout'] = bool(op.get('cutout'))
    elif kind == 'view':
        doc['view'] = {'cx': _num(op.get('cx')), 'cy': _num(op.get('cy')),
                       'z': _num(op.get('z'), 1.0, 0.05, 8.0)}
    elif kind == 'focus':
        ids = [i for i in (op.get('ids') or []) if visible(_find(doc, i))][:2]
        doc['focus'] = ids
    elif kind == 'yarn_add':
        a, b = op.get('a'), op.get('b')
        if a == b or not visible(_find(doc, a)) or not visible(_find(doc, b)):
            return False, 'yarn needs two different pins', None
        if any({y['a'], y['b']} == {a, b} for y in doc['yarn']):
            return True, None, None
        doc['yarn'].append({'id': _new_id('y'), 'a': a, 'b': b})
    elif kind == 'yarn_del':
        before = len(doc['yarn'])
        doc['yarn'] = [y for y in doc['yarn'] if y['id'] != op.get('id')]
        if len(doc['yarn']) == before:
            return True, None, None
    elif kind == 'note_add':
        hid = op.get('hid')
        if not visible(_find(doc, hid)):
            return False, 'no such handout', None
        text = str(op.get('text') or '').strip()[:4000]
        if not text:
            return False, 'nothing to add', None
        note = {
            'id': _new_id('n'),
            'by': (doc.get('gmName') or DEFAULT_GM_NAME) if local and op.get('gm')
                  else str(op.get('by') or 'a player').strip()[:40],
            'character': '' if (local and op.get('gm')) else str(op.get('character') or '').strip()[:60],
            'gm': bool(local and op.get('gm')),
            'text': text,
            'at': _stamp(),
        }
        doc['notes'].setdefault(hid, []).append(note)
        _changed(slug)
        return True, None, {'note': note}
    elif kind in ('note_edit', 'note_del'):
        hid = op.get('hid')
        lst = doc['notes'].get(hid) or []
        n = next((x for x in lst if x['id'] == op.get('nid')), None)
        if not n or not visible(_find(doc, hid)):
            return False, 'no such note', None
        # Yours to change, nobody else's. The GM may tidy anything.
        mine = (n.get('gm') and local) or (not n.get('gm') and n.get('by') == str(op.get('by') or ''))
        if not (mine or (local and op.get('gm'))):
            return False, 'that note is not yours', None
        if kind == 'note_del':
            lst.remove(n)
            if not lst:
                doc['notes'].pop(hid, None)
        else:
            text = str(op.get('text') or '').strip()[:4000]
            if not text:
                return False, 'nothing to save', None
            if text != n['text']:
                n['text'] = text
                n['edited'] = _stamp()
    # --- the GM's alone ------------------------------------------------------
    elif kind in ('share', 'unshare', 'settings', 'remove', 'retitle'):
        if not local:
            return False, 'forbidden', None
        if kind == 'share':
            src = canon_src(op.get('src'))
            if not src:
                return False, 'only vault images can be shared', None
            hid = handout_id(src)
            h = _find(doc, hid)
            aw = _num(op.get('aw'), 1, 1, 100000)
            ah = _num(op.get('ah'), 1, 1, 100000)
            if not h:
                h = {'id': hid, 'src': src, 'w': HANDOUT_W, 'h': HANDOUT_W * ah / aw}
                handouts.append(h)
            h['name'] = str(op.get('name') or h.get('name') or src.rsplit('/', 1)[-1])[:120]
            h['module'] = str(op.get('module') or h.get('module') or '')[:120]
            h['shared'] = True
            h['sharedAt'] = _stamp()
            # On top, and in the middle of what everyone is looking at.
            v = doc.get('view') or {}
            h['x'] = _num(v.get('cx')) - h['w'] / 2
            h['y'] = _num(v.get('cy')) - h['h'] / 2
            h['z'] = max([x.get('z', 0) for x in handouts] or [0]) + 1
        elif kind == 'unshare':
            h = _find(doc, handout_id(str(op.get('src') or '')))
            if not h or not h.get('shared'):
                return True, None, None
            h['shared'] = False
            doc['focus'] = [i for i in doc.get('focus', []) if i != h['id']]
        elif kind == 'retitle':
            # The only name players ever see: one the GM gives it on purpose.
            h = _find(doc, op.get('id'))
            if not h:
                return False, 'no such handout', None
            t = str(op.get('title') or '').strip()[:80]
            if t:
                h['title'] = t
            else:
                h.pop('title', None)
        elif kind == 'remove':
            # Gone for good: the handout, its strings and its notes.
            hid = op.get('id')
            doc['handouts'] = [h for h in handouts if h['id'] != hid]
            doc['yarn'] = [y for y in doc['yarn'] if hid not in (y['a'], y['b'])]
            doc['notes'].pop(hid, None)
            doc['focus'] = [i for i in doc.get('focus', []) if i != hid]
        else:
            c = str(op.get('yarnColor') or '')
            if _HEX6.match(c):
                doc['yarnColor'] = c
            if op.get('gmName') is not None:
                doc['gmName'] = str(op.get('gmName') or '').strip()[:40] or DEFAULT_GM_NAME
    else:
        return False, 'unknown op', None
    _changed(slug)
    return True, None, None


def set_active(slug, name):
    with _cond:
        changed = slug != _active['slug']
        _active['slug'] = slug
        _active['name'] = name
        doc = _board(slug)
        if name and doc.get('name') != name:
            doc['name'] = name
            _schedule_save(slug)
        if changed:
            _epoch[0] += 1
            _cond.notify_all()
    d = boards_dir()
    if d:
        try:
            with open(os.path.join(d, '_active.json'), 'w', encoding='utf-8') as f:
                json.dump({'slug': slug, 'name': name}, f)
        except Exception:
            pass


def snapshot(remote):
    """(token, payload). Caller holds _cond. The token changes whenever the
    answer would, which is what the long poll waits on."""
    slug = _active['slug']
    if not slug:
        return f'{_epoch[0]}:0', {'campaign': '', 'board': None}
    doc = _board(slug)
    ver = _versions.get(slug, 1)
    token = f'{_epoch[0]}:{ver}'
    board = public_view(doc) if remote else doc
    return token, {'campaign': slug, 'board': json.loads(json.dumps(board))}


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


def handle_get(h, parsed=None):
    parsed = parsed or urllib.parse.urlparse(h.path)
    if parsed.path != '/api/board':
        return False
    q = urllib.parse.parse_qs(parsed.query)
    since = (q.get('since') or [''])[0]
    remote = h.is_remote()
    deadline = time.time() + LONG_POLL_S
    with _cond:
        token, payload = snapshot(remote)
        while since and token == since:
            left = deadline - time.time()
            if left <= 0:
                break
            _cond.wait(left)
            token, payload = snapshot(remote)
    payload['version'] = token
    payload['local'] = not remote
    _send(h, payload)
    return True


def handle_post(h, parsed=None):
    parsed = parsed or urllib.parse.urlparse(h.path)

    # The GM page says which campaign the table is in. GM only.
    if parsed.path == '/api/board/campaign':
        if h.is_remote():
            _send(h, {'error': 'forbidden'}, 403)
            return True
        body = _body(h) or {}
        slug = str(body.get('slug') or '')
        if not _SLUG.match(slug):
            _send(h, {'error': 'bad campaign'}, 400)
            return True
        set_active(slug, str(body.get('name') or '')[:80])
        _send(h, {'ok': True})
        return True

    if parsed.path != '/api/board/op':
        return False
    body = _body(h)
    if body is None:
        _send(h, {'error': 'bad body'}, 400)
        return True
    ops = body.get('ops') if isinstance(body.get('ops'), list) else [body]
    local = not h.is_remote()
    results = []
    with _cond:
        for op in ops[:50]:
            if not isinstance(op, dict):
                continue
            ok, err, extra = apply_op(op, local)
            r = {'ok': ok}
            if err:
                r['error'] = err
            if extra:
                r.update(extra)
            results.append(r)
        token, _ = snapshot(not local)
    status = 200 if all(r['ok'] for r in results) else (403 if any(
        r.get('error') == 'forbidden' for r in results) else 400)
    _send(h, {'ok': status == 200, 'results': results, 'version': token}, status)
    return True
