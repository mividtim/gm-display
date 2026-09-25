#!/usr/bin/env python3
"""
GM Display Server
Serves the GM Display web app and handles gm:// protocol requests.

Architecture:
  - Server runs on localhost:7680, serves the GM Display HTML app
  - GM page stays open in one browser tab, polls /api/command for new commands
  - Player window stays open on projector, syncs via BroadcastChannel
  - gm:// clicks → macOS app → curl POST /api/command → GM page picks it up
  - No new tabs ever spawned after initial open
"""

import base64
import http.server
import os
import re
import sys
import json
import urllib.parse
import webbrowser
import threading
import shlex
import signal
import subprocess
import time

import notes_api  # per-cell notes for any keyed map
import board_api  # the campaign's shared bulletin board

PORT = 7680
# Loopback by default: the GM's own machine is the whole audience, and a server
# that quietly listens on the network is not something you should have to opt
# OUT of. --lan opts in, for the case where the thing that needs to reach this
# is on another box (an ngrok host, say) rather than on this one.
BIND_HOST = '127.0.0.1'
# How to open the GM page, when the default browser's guess is not good enough.
# Set by --browser-cmd= or $GM_DISPLAY_BROWSER; see open_gm_page().
BROWSER_CMD = ''
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))

# Directories where maps/images are stored (searched in order)
IMAGE_ROOTS = []

# Index: maps filename/partial-path → absolute path (built at startup)
# Enables instant fallback when gm:// links use partial paths
FILE_INDEX = {}  # "Dragonfall Maps/Map - The Bone Field.jpg" → "/full/path/..."

# ---------------------------------------------------------------------------
# Who runs this, and which code it is running
# ---------------------------------------------------------------------------
# The menu-bar app (gm_menubar.swift) is the one thing meant to run the server:
# it starts server.py straight out of the vault as its own child and marks it
# with GMD_SUPERVISOR=tray. Everything else — a Terminal, a stale launchd job —
# is a second claimant on the port, and the port has one owner.
SUPERVISOR = os.environ.get('GMD_SUPERVISOR', '')
STARTED_AT = time.time()

# The server's own code. When any of it changes on disk the server restarts
# itself in place (os.execv, same PID, same arguments), so a new version is
# live as soon as it is saved — no hunting for which process to kill.
PY_SOURCES = ('server.py', 'notes_api.py', 'board_api.py')

# What the pages are made of. Pages poll /api/build and offer a reload when
# this changes, so an open GM page or player tab does not keep running last
# version's JavaScript against this version's server.
_build_cache = {'t': 0.0, 'v': ''}


def _web_files():
    out = []
    for sub, exts in (('', ('.html',)), ('js', ('.js',)), ('css', ('.css',))):
        d = os.path.join(STATIC_DIR, sub)
        try:
            for f in sorted(os.listdir(d)):
                if f.endswith(exts):
                    out.append(os.path.join(d, f))
        except OSError:
            pass
    return out


def _stamp_of(paths):
    import hashlib
    h = hashlib.sha1()
    for p in paths:
        try:
            st = os.stat(p)
            h.update(f'{p}:{st.st_mtime_ns}:{st.st_size};'.encode())
        except OSError:
            h.update(f'{p}:missing;'.encode())
    return h.hexdigest()[:12]


def web_build():
    now = time.time()
    if now - _build_cache['t'] > 1.0:
        _build_cache['v'] = _stamp_of(_web_files())
        _build_cache['t'] = now
    return _build_cache['v']


# ---------------------------------------------------------------------------
# The GM code: GM powers on the player page from any device
# ---------------------------------------------------------------------------
# On this machine the player page already knows it is the GM. From a tablet
# over the LAN, or through the tunnel, it cannot — so the GM types a short
# code, shown in the GM page's Displays panel, and gets a cookie. The code and
# the key the cookie is signed with live in .gm-secret.json beside this file;
# making a new code makes a new key, which logs every GM browser out.
GM_COOKIE = 'gmd_gm'
GM_SECRET_FILE = os.path.join(STATIC_DIR, '.gm-secret.json')
_gm_secret = {}
_login_tries = {}             # client -> [timestamps]
_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'   # no 0/O, 1/I/L


def _load_gm_secret(regenerate=False):
    import secrets
    if not regenerate and not _gm_secret:
        try:
            with open(GM_SECRET_FILE, encoding='utf-8') as f:
                d = json.load(f)
            if d.get('code') and d.get('key'):
                _gm_secret.update(d)
        except Exception:
            pass
    if regenerate or not _gm_secret:
        code = ''.join(secrets.choice(_CODE_ALPHABET) for _ in range(8))
        _gm_secret.clear()
        _gm_secret.update({'code': code[:4] + '-' + code[4:], 'key': secrets.token_hex(32)})
        try:
            with open(GM_SECRET_FILE, 'w', encoding='utf-8') as f:
                json.dump(_gm_secret, f)
            os.chmod(GM_SECRET_FILE, 0o600)
        except Exception as e:
            print(f"⚠️  Could not save the GM code: {e}")
    return _gm_secret


def gm_code():
    return _load_gm_secret()['code']


def gm_token():
    import hmac as _h, hashlib
    return _h.new(_load_gm_secret()['key'].encode(), b'gm', hashlib.sha256).hexdigest()


def hmac_eq(a, b):
    import hmac as _h
    return _h.compare_digest(str(a), str(b))


def _norm_code(c):
    return ''.join(ch for ch in str(c or '').upper() if ch.isalnum())


# Pending command for the GM page to pick up
pending_command = None
command_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Live tabletop state (tokens, fog frame, ephemeral markers, player actions)
# ---------------------------------------------------------------------------
# The GM page is the single source of truth. It pushes authoritative state here;
# remote player browsers (reached over ngrok / LAN) read it and submit only
# constrained "actions" (claim a token, propose a move) which the GM drains and
# applies. Markers (ephemeral neon strokes) are low-stakes and may be written by
# anyone. All access is guarded by state_lock.
state_lock = threading.Lock()

# Heavy payload: map image ref + RLE fog + crop + projection. Pushed by GM only.
player_state = {'version': 0, 'payload': None}

# Authoritative token doc: {tokens:[...], grid:{...}, mapW, mapH}. Pushed by GM.
tokens_state = {'version': 0, 'payload': {'tokens': [], 'grid': None, 'mapW': 0, 'mapH': 0}}

# Inbox of player-submitted actions awaiting GM processing.
player_actions = []  # list of dicts

# Ephemeral marker strokes. Each: {id, by, color, points:[[tx,ty],...], t}
# Pruned by age on every access (MARKER_TTL seconds).
markers = {}  # id -> stroke
MARKER_TTL = 6.0  # seconds a stroke lives before it is dropped server-side


# ---------------------------------------------------------------------------
# Players letting themselves in
# ---------------------------------------------------------------------------
# A player used to need the GM to make them a token before they could do
# anything, which meant the first ten minutes of a session were the GM typing
# names. Now they introduce themselves and wait to be let in.
#
# Nothing a player submits is real until the GM says so, and that is enforced
# HERE rather than by hiding a button: a pending portrait never touches the
# disk, never gets a /maps/ URL, and is never handed to any surface the table
# can see. It exists in this process, visible to the GM's own page, until it is
# approved (written into the vault like any other upload) or dropped.
pending_players = []          # [{id, name, character, color, img, t}] — img is a data URL
join_results = {}             # join id -> 'approved' | 'rejected'
PENDING_CAP = 12              # a queue, not an inbox; refuse the 13th
JOIN_IMG_CAP = 2 * 1024 * 1024
_join_seq = [0]


def _new_join_id():
    _join_seq[0] += 1
    return 'j%d' % _join_seq[0]


def decode_image(data_url, cap=JOIN_IMG_CAP):
    """(raw bytes, extension) for a data: URL that really is an image.

    Returns (None, reason) otherwise. The extension comes from sniffing the
    bytes, not from anything the sender claimed, and image_size() has to be
    able to read the header — so a .png that is actually a script is refused
    here rather than landing in the vault.
    """
    s = (data_url or '')
    if s.startswith('data:'):
        try:
            s = s.split(',', 1)[1]
        except IndexError:
            return None, 'bad data url'
    try:
        raw = base64.b64decode(s)
    except Exception:
        return None, 'bad base64'
    if not raw:
        return None, 'empty'
    if len(raw) > cap:
        return None, 'too large (max %dMB)' % (cap // (1024 * 1024))
    if raw[:8] == b'\x89PNG\r\n\x1a\n':
        ext = '.png'
    elif raw[:2] == b'\xff\xd8':
        ext = '.jpg'
    elif raw[:6] in (b'GIF87a', b'GIF89a'):
        ext = '.gif'
    elif raw[:4] == b'RIFF' and raw[8:12] == b'WEBP':
        ext = '.webp'
    else:
        return None, 'not an image'
    tmp = os.path.join('/tmp', '.gmd-probe' + ext)
    try:
        with open(tmp, 'wb') as f:
            f.write(raw)
        if not image_size(tmp):
            return None, 'not a readable image'
    except Exception:
        return None, 'could not read that image'
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    return raw, ext


def save_to_uploads(basename, raw, ext):
    """Write bytes into the vault's uploads folder and return its /maps/ path."""
    safe = ''.join(c for c in (basename or 'portrait')
                   if c.isalnum() or c in ' ._-()').strip() or 'portrait'
    upload_dir = os.path.join(STATIC_DIR, 'uploads')
    os.makedirs(upload_dir, exist_ok=True)
    candidate, n = safe + ext, 1
    while os.path.exists(os.path.join(upload_dir, candidate)):
        candidate = f'{safe}-{n}{ext}'
        n += 1
    full = os.path.join(upload_dir, candidate)
    with open(full, 'wb') as f:
        f.write(raw)
    FILE_INDEX.setdefault(candidate, full)
    for r in IMAGE_ROOTS:
        if full.startswith(r + os.sep):
            return '/maps/' + urllib.parse.quote(os.path.relpath(full, r))
    return '/maps/' + urllib.parse.quote(candidate)


def lan_address():
    """This machine's address on the local network, or ''.

    Opening a UDP socket toward an off-net address makes the OS pick the
    interface it would actually route through, which is the one another box on
    the wifi can reach. Nothing is sent.
    """
    import socket
    s_ = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s_.connect(('8.8.8.8', 9))        # never sent; just picks the interface
        ip = s_.getsockname()[0]
    except Exception:
        return ''
    finally:
        s_.close()
    # Loopback or a documentation range means we learned nothing useful.
    if ip.startswith(('127.', '192.0.2.', '198.51.100.', '203.0.113.')):
        return ''
    return ip


def _prune_markers():
    """Drop marker strokes older than MARKER_TTL. Caller holds state_lock."""
    now = time.time()
    stale = [k for k, m in markers.items() if now - m.get('t', 0) > MARKER_TTL]
    for k in stale:
        del markers[k]


# ---------------------------------------------------------------------------
# Which vault images a remote player may fetch
# ---------------------------------------------------------------------------
# Fog of war hid unrevealed AREAS of the map the GM chose to show. It never had
# anything to say about the rest of the vault, and /maps/ has always served any
# file anyone could name — with /api/maps handing out the index to name them
# from. A player's browser needs exactly three kinds of image: the map in front
# of them, the portraits on tokens they can already see, and legend swatches.
# That is the whole list, so that is what remote callers get.

def resolve_map_file(rel_path):
    """A /maps/ relative path -> an absolute file, or None. Same three-step
    lookup the handler has always used: each root, then the startup index by
    partial path, then by bare filename."""
    for root in IMAGE_ROOTS:
        full = os.path.join(root, rel_path)
        if os.path.isfile(full):
            return full
    index_key = rel_path.replace('\\', '/')
    if index_key in FILE_INDEX:
        return FILE_INDEX[index_key]
    basename = os.path.basename(rel_path)
    if basename in FILE_INDEX:
        return FILE_INDEX[basename]
    return None


def _rel_of(maps_url):
    """'/maps/A%20B/c.png' -> 'A B/c.png'. '' for anything else (a data: URL,
    say, which needs no fetch and so needs no permission)."""
    u = (maps_url or '').split('?')[0]
    if not u.startswith('/maps/'):
        return ''
    return urllib.parse.unquote(u[6:]).replace('\\', '/').strip('/')


def visible_to_players(doc):
    """The token doc as a remote browser is allowed to receive it.

    An NPC the GM has not revealed on this map is not merely undrawn on the
    player's screen — it is absent from the bytes the player's browser is
    handed. Filtering only at render time would leave four invisible K'n-yani,
    their names and their exact squares one devtools tab away, which is the
    whole ambush.

    PCs and the Company stay in the payload whatever their visibility. A
    player's own piece is not a secret from that player, and the roster on the
    join screen is built from this list — strip a hidden PC and the player who
    owns it can never claim it back after a refresh.
    """
    doc = doc or {}
    out = dict(doc)
    out['tokens'] = [t for t in (doc.get('tokens') or [])
                     if t.get('onMap') or t.get('side') != 'npc']
    return out


def published_assets():
    """The set of vault-relative paths currently published to the table."""
    with state_lock:
        frame = player_state['payload'] or {}
        doc = tokens_state['payload'] or {}
    out = set()
    gm_src = frame.get('imageSrc') or ''
    if gm_src:
        # On a split map the players' copy is published and the GM's is not,
        # so a guessed filename does not become a second way in.
        out.add(_rel_of(notes_api.player_variant(gm_src) or gm_src))
    # Same rule as the token doc itself: a hidden NPC's portrait is not
    # published either, or the art would still be fetchable by name once the
    # token was gone from the payload.
    for t in (visible_to_players(doc).get('tokens') or []):
        if t.get('img'):
            out.add(_rel_of(t['img']))
    # Handouts the GM has pinned to the campaign's bulletin board. Un-sharing
    # one takes it off this list, and its image stops being served.
    out |= board_api.published_assets()
    out.discard('')
    return out


def may_serve_remote(rel_path):
    """Which /maps/ paths a player may fetch BY NAME: legend swatches, and
    nothing else. Everything published to the table — the map, portraits,
    handouts — reaches players only under an opaque /a/ address, because a
    filename is information. 'Barbas.png' pinned to the board as Agent Exeter's
    photo gives away a reveal the story has not made yet."""
    norm = (rel_path or '').replace('\\', '/').strip('/')
    # Legend swatches are captions for a map the player is already looking at.
    return norm.startswith(notes_api.SUBDIR + '/legend-icons/')


# ---------------------------------------------------------------------------
# Opaque addresses for what players are shown
# ---------------------------------------------------------------------------
# A player's browser never sees a vault path. Each published image is served
# at /a/<token><ext>, where the token is an HMAC of its path under this
# install's secret key — stable (so browsers can cache it) but meaningless.
# The map's identity (which the party-notes and legend files are named after)
# goes out as an opaque "mk-" key the same way, and is turned back into the
# real path here when the player page asks for its notes.

def _hmac_hex(label, text):
    import hmac as _h, hashlib
    return _h.new(_load_gm_secret()['key'].encode(), f'{label}:{text}'.encode(),
                  hashlib.sha256).hexdigest()


def asset_token(rel):
    return _hmac_hex('asset', rel)[:22]


def public_url(maps_url):
    """'/maps/Agents/Barbas.png' -> '/a/3f9c…e1.png'. Anything that is not a
    vault image (a data: URL, '') is returned unchanged."""
    rel = _rel_of(maps_url)
    if not rel:
        return maps_url
    ext = os.path.splitext(rel)[1].lower()
    if ext not in ('.png', '.jpg', '.jpeg', '.gif', '.webp'):
        ext = ''
    return f'/a/{asset_token(rel)}{ext}'


def map_key_token(gm_src):
    return 'mk-' + _hmac_hex('map', _rel_of(gm_src) or gm_src)[:22]


def resolve_map_key(key):
    """An opaque map key from the player page -> the map's real identity.
    Only the map currently on the table resolves; anything else is ''."""
    key = key or ''
    if not key.startswith('mk-'):
        return key
    with state_lock:
        frame = player_state['payload'] or {}
    gm_src = frame.get('imageSrc') or ''
    return gm_src if gm_src and hmac_eq(map_key_token(gm_src), key) else ''


def resolve_asset(token):
    """/a/<token> -> the vault file, if (and only if) it is published now."""
    token = (token or '').split('.')[0]
    if not token:
        return None
    for rel in published_assets():
        if hmac_eq(asset_token(rel), token):
            return resolve_map_file(rel)
    return None


def tokens_for_players(doc):
    """visible_to_players(), with every portrait behind an opaque address."""
    out = visible_to_players(doc)
    toks = []
    for t in out.get('tokens') or []:
        if t.get('img'):
            t = dict(t)
            t['img'] = public_url(t['img'])
        toks.append(t)
    out['tokens'] = toks
    return out


# --- image dimensions, without a dependency --------------------------------
# The two halves of a split map share one grid calibration, one set of cell
# addresses and one fog mask, all of which are computed in MAP PIXELS. If the
# player copy is a different size, every hex silently lands somewhere else. The
# app ships no imaging library and is not about to grow one, so read the header.

def image_size(path):
    """(width, height) for PNG/GIF/JPEG/WebP, or None if it can't be read."""
    try:
        with open(path, 'rb') as f:
            head = f.read(32)
            if head[:8] == b'\x89PNG\r\n\x1a\n':
                return (int.from_bytes(head[16:20], 'big'),
                        int.from_bytes(head[20:24], 'big'))
            if head[:6] in (b'GIF87a', b'GIF89a'):
                return (int.from_bytes(head[6:8], 'little'),
                        int.from_bytes(head[8:10], 'little'))
            if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
                f.seek(12)
                chunk = f.read(8)
                if chunk[:4] == b'VP8X':
                    b = f.read(10)
                    return (int.from_bytes(b[4:7], 'little') + 1,
                            int.from_bytes(b[7:10], 'little') + 1)
                if chunk[:4] == b'VP8 ':
                    b = f.read(10)
                    return (int.from_bytes(b[6:8], 'little') & 0x3fff,
                            int.from_bytes(b[8:10], 'little') & 0x3fff)
                if chunk[:4] == b'VP8L':
                    b = f.read(5)
                    bits = int.from_bytes(b[1:5], 'little')
                    return ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
                return None
            if head[:2] == b'\xff\xd8':          # JPEG: walk the segments
                f.seek(2)
                while True:
                    marker = f.read(2)
                    if len(marker) < 2 or marker[0] != 0xff:
                        return None
                    size = int.from_bytes(f.read(2), 'big')
                    if 0xc0 <= marker[1] <= 0xcf and marker[1] not in (0xc4, 0xc8, 0xcc):
                        b = f.read(5)
                        return (int.from_bytes(b[3:5], 'big'),
                                int.from_bytes(b[1:3], 'big'))
                    f.seek(size - 2, 1)
    except Exception:
        return None
    return None


class GMHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    # Everything the app is actually made of. Without Cache-Control the browser
    # picks its own heuristic freshness and happily runs yesterday's module for
    # hours — which is exactly the "have to refresh" report. Map images are NOT
    # in this list: they are big, they never change, let them cache.
    APP_SOURCE = ('.html', '.js', '.mjs', '.css', '.map')

    def end_headers(self):
        """Stamp no-cache on app source, unless the handler already said so.

        The /api/* responses set their own 'no-store' and the .html branch in
        do_GET sets its own header; checking the buffer first keeps us from
        sending Cache-Control twice.
        """
        try:
            path = urllib.parse.urlparse(self.path).path
            want = None
            if path == '/' or path.endswith(self.APP_SOURCE):
                want = 'no-cache, must-revalidate'
            elif path.startswith('/api/') and not path.startswith('/api/image'):
                # Live state — the map list especially. /api/image is excluded:
                # those are big and immutable, let the browser keep them.
                want = 'no-store'
            if want:
                already = any(b'cache-control' in h.lower()
                              for h in getattr(self, '_headers_buffer', []) or [])
                if not already:
                    self.send_header('Cache-Control', want)
        except Exception:
            # A header quirk must never take the whole server down.
            pass
        super().end_headers()

    # --- helpers -----------------------------------------------------------
    def is_loopback(self):
        """True only for a request from a browser on THIS machine.

        ngrok (and most reverse proxies) inject X-Forwarded-For with the real
        visitor IP; a direct localhost hit from the GM's own browser does not.
        Anything else is another machine. The GM page, and every endpoint that
        pushes or drains the table's authoritative state, answers to this and
        nothing else — not even a logged-in GM on a tablet, whose browser holds
        none of the campaign and would overwrite the table with an empty one.
        """
        if self.headers.get('X-Forwarded-For') or self.headers.get('Forwarded'):
            return False
        peer = (self.client_address[0] if self.client_address else '')
        return peer in ('127.0.0.1', '::1', 'localhost', '')

    def gm_cookie(self):
        """True if this browser logged in with the GM code (see /api/gm-login)."""
        raw = self.headers.get('Cookie') or ''
        for part in raw.split(';'):
            k, _, v = part.strip().partition('=')
            if k == GM_COOKIE and v and hmac_eq(v, gm_token()):
                return True
        return False

    def is_remote(self):
        """True if this request gets the PLAYER's view of the table.

        This machine is the GM. So is a browser anywhere that logged in with
        the GM code — it can then move any token, see hidden ones and sign
        board notes as the GM, from the player page. Remote clients get the
        player page only and cannot push authoritative state (is_loopback).
        """
        # The GM's "preview as a player" page asks to be treated exactly like
        # a visitor on the tunnel, so what it shows is what the table gets.
        # (Only ever a downgrade: nothing can claim to be MORE local.)
        if self.headers.get('X-GMD-As') == 'player':
            return True
        if self.is_loopback():
            return False
        return not self.gm_cookie()

    def _send_json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', len(data))
        self.end_headers()
        self.wfile.write(data)

    def _read_json_body(self):
        length = int(self.headers.get('Content-Length', 0))
        if not length:
            return None
        try:
            return json.loads(self.rfile.read(length).decode())
        except (ValueError, UnicodeDecodeError):
            return None

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        # --- Cell notes, party notes and legends for any keyed map ---
        if notes_api.handle_get(self, parsed):
            return

        # --- The campaign bulletin board (long poll) ---
        if board_api.handle_get(self, parsed):
            return

        # realm.html was a page that existed only for the Mythic Bastionland
        # realm: its own hex geometry, its own note store, its own token code.
        # Every part of it is now general — any map with a grid calibration has
        # addressable cells, notes, a legend and tokens — so the page is gone
        # and old bookmarks land on the real thing.
        if parsed.path in ('/realm.html', '/realm_player.html', '/realm_data.json'):
            self.send_response(301)
            self.send_header('Location', '/gm.html')
            self.end_headers()
            return

        # --- Live tabletop sync (lightweight; polled frequently) ---
        # Returns token doc version, the token doc, and currently-active markers.
        # Clients compare versions client-side and only re-render on change.
        if parsed.path == '/api/sync':
            remote = self.is_remote()
            with state_lock:
                _prune_markers()
                doc = tokens_state['payload']
                out = {
                    'tokensVersion': tokens_state['version'],
                    'tokens': doc,
                    'frameVersion': player_state['version'],
                    'markers': list(markers.values()),
                    'now': time.time(),
                    # Whether this page may move a token without asking. Decided
                    # here, by where the request came from — the player page uses
                    # it to know it is the GM's own browser looking.
                    'local': not remote,
                    # Logged in with the GM code (rather than on this machine),
                    # so the page can offer to log out.
                    'gmLogin': (not remote) and not self.is_loopback(),
                }
            if remote:
                out['tokens'] = tokens_for_players(doc)
            self._send_json(out)
            return

        # --- Heavy player frame: map ref + RLE fog + crop + projection ---
        if parsed.path == '/api/player_state':
            with state_lock:
                ver = player_state['version']
                payload = player_state['payload']
            if payload:
                payload = dict(payload)
                gm_src = payload.get('imageSrc') or ''
                # The map's identity is the GM image, and every sidecar — notes,
                # party notes, legend, calibration — keys off it. Name it
                # explicitly so the player page files what it writes under the
                # same name the GM reads it back from, rather than under
                # whichever of the two images it happened to be handed.
                payload['mapKey'] = map_key_token(gm_src)
                variant = notes_api.player_variant(gm_src)
                payload['split'] = bool(variant)
                # This endpoint is the PLAYER's frame — remote.html is its only
                # reader; the GM page only ever POSTs here. So a split map serves
                # the players' copy to everyone who asks, full stop.
                #
                # This used to be conditional on is_remote(), which was the wrong
                # question: it made who-sees-what depend on where the browser sat
                # rather than on which page was asking. A player on the GM's own
                # machine — or the GM opening the player view to check it — was
                # handed the copy with the Myths on it. "Is this the player view?"
                # is the only thing that should decide, and for this endpoint the
                # answer is always yes.
                # ...and under an opaque address: the filename is not theirs.
                payload['imageSrc'] = public_url(variant or gm_src)
            self._send_json({'version': ver, 'payload': payload})
            return

        # --- A player asks how their request is going. Open to remote. ---
        # Answers with a state and nothing else: knowing your own request was
        # turned down should not also tell you who else is at the table.
        if parsed.path == '/api/join_status':
            q = urllib.parse.parse_qs(parsed.query)
            jid = (q.get('id') or [''])[0]
            with state_lock:
                if any(p['id'] == jid for p in pending_players):
                    state = 'pending'
                else:
                    state = join_results.get(jid, 'unknown')
            self._send_json({'state': state})
            return

        # --- The GM's queue of people asking to join. GM only. ---
        # The portraits ride along as data URLs so the GM can see what they are
        # actually approving. This is the only place a pending image is ever
        # served, and it is refused to anyone but this machine.
        if parsed.path == '/api/pending':
            if not self.is_loopback():
                self._send_json({'error': 'forbidden'}, status=403)
                return
            with state_lock:
                out = [dict(p) for p in pending_players]
            self._send_json({'pending': out})
            return

        # --- GM drains queued player actions (claims / proposed moves) ---
        if parsed.path == '/api/actions':
            if not self.is_loopback():
                self._send_json({'error': 'forbidden'}, status=403)
                return
            global player_actions
            with state_lock:
                acts = player_actions
                player_actions = []
            self._send_json({'actions': acts})
            return

        # Health check (used by menu bar app and build script)
        if parsed.path == '/api/health':
            health = {
                'status': 'ok',
                'roots': len(IMAGE_ROOTS),
                'port': PORT,
                'pid': os.getpid(),
                'started': STARTED_AT,
                'supervisor': SUPERVISOR,
                'build': web_build(),
                'python': sys.version.split()[0],
            }
            # Vault paths are nobody's business but this machine's.
            if not self.is_remote():
                health['image_roots'] = IMAGE_ROOTS
                health['script'] = os.path.abspath(__file__)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(health).encode())
            return

        if parsed.path == '/api/gm-code':
            if not self.is_loopback():
                self._send_json({'error': 'forbidden'}, status=403)
                return
            self._send_json({'code': gm_code()})
            return

        # Which version of the pages is on disk. Open pages compare it with
        # the one they loaded and offer a reload. Open to players: it is a
        # hash of file timestamps and says nothing about the vault.
        if parsed.path == '/api/build':
            self._send_json({'build': web_build()})
            return

        # Poll for pending commands (GM page calls this every 300ms)
        if parsed.path == '/api/command':
            global pending_command
            with command_lock:
                cmd = pending_command
                pending_command = None  # consume it
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            if cmd:
                self.wfile.write(json.dumps(cmd).encode())
            else:
                self.wfile.write(b'null')
            return

        # Published images under opaque addresses (see public_url). Open to
        # everyone — the token IS the permission, and it only resolves while
        # the image is on the table.
        if parsed.path.startswith('/a/'):
            full = resolve_asset(parsed.path[3:])
            if not full:
                self.send_error(404, 'Not found')
                return
            try:
                self.send_file(full)
            except Exception as e:
                self.send_error(500, f'Error serving file: {e}')
            return

        # Serve map/image files from configured roots
        if parsed.path.startswith('/maps/'):
            rel_path = urllib.parse.unquote(parsed.path[6:])  # strip /maps/

            # A remote player gets what is published to the table and nothing
            # else. 404 rather than 403: a refusal that distinguishes "not
            # allowed" from "not there" is itself an index of the vault.
            if self.is_remote() and not may_serve_remote(rel_path):
                self.send_error(404, f"Image not found: {rel_path}")
                return

            full_path = resolve_map_file(rel_path)
            if full_path:
                try:
                    self.send_file(full_path)
                except Exception as e:
                    print(f"Error serving {full_path}: {e}")
                    self.send_error(500, f"Error serving file: {e}")
                return

            # Nothing found — log diagnostics
            print(f"\n❌ 404: '{rel_path}' not found. Tried:")
            for root in IMAGE_ROOTS:
                full = os.path.join(root, rel_path)
                print(f"   {full}  {'✓ EXISTS' if os.path.isfile(full) else '✗'}")
            print(f"   Index lookup for '{rel_path}' — no match")
            print(f"   Filename lookup for '{os.path.basename(rel_path)}' — no match")
            print()
            self.send_error(404, f"Image not found: {rel_path}")
            return

        # List available maps. This is the vault's index — every handout, every
        # unrevealed map, by name — so it is the GM's alone.
        if parsed.path == '/api/maps':
            if not self.is_loopback():
                self._send_json({'error': 'forbidden'}, status=403)
                return
            maps = []
            for root in IMAGE_ROOTS:
                for dirpath, _, filenames in os.walk(root):
                    for f in filenames:
                        if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp', '.gif')):
                            rel = os.path.relpath(os.path.join(dirpath, f), root)
                            maps.append({'name': f, 'path': '/maps/' + urllib.parse.quote(rel)})
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(maps).encode())
            return

        # Remote visitors never get the GM control page. The app is now three
        # separate pages, so the GM markup is not merely hidden from them — it is
        # never sent. remote.html carries only the player view.
        if parsed.path in ('/', '', '/gm.html', '/gm_display.html') and not self.is_loopback():
            self.send_response(302)
            self.send_header('Location', '/remote.html')
            self.end_headers()
            return

        # Default: serve static files (no cache on HTML so updates appear immediately)
        if parsed.path == '/' or parsed.path == '':
            self.path = '/gm.html'

        # For HTML files, serve with no-cache headers
        if self.path.endswith('.html'):
            file_path = os.path.join(STATIC_DIR, self.path.lstrip('/'))
            if os.path.isfile(file_path):
                with open(file_path, 'rb') as f:
                    data = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', len(data))
                self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
                self.send_header('Pragma', 'no-cache')
                self.end_headers()
                self.wfile.write(data)
                return

        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)

        # --- Cell notes, party notes and legends for any keyed map ---
        if notes_api.handle_post(self, parsed):
            return

        # --- The campaign bulletin board ---
        if board_api.handle_post(self, parsed):
            return

        # --- Declare (or clear) the players' copy of a split map. GM only. ---
        # Lives here rather than in notes_api because validating the pair means
        # resolving both images against the vault, which is this file's job.
        if parsed.path == '/api/mapkey':
            if not self.is_loopback():
                self._send_json({'error': 'forbidden'}, status=403)
                return
            body = self._read_json_body()
            if not body or not body.get('map'):
                self._send_json({'error': 'map required'}, status=400)
                return
            if not notes_api.notes_dir():
                self._send_json({'error': 'no vault'}, status=503)
                return
            gm_src = body['map']
            player = (body.get('player') or '').strip()
            if player:
                player_url = notes_api._as_maps_url(player)
                gm_file = resolve_map_file(_rel_of(gm_src))
                pl_file = resolve_map_file(_rel_of(player_url))
                if not pl_file:
                    self._send_json({'error': 'that image is not in the vault'}, status=404)
                    return
                # Both halves are addressed in map pixels — same hexes, same
                # cell labels, same fog mask. Different dimensions would put
                # every note a little to the left of what it describes, and
                # would do it silently, so refuse the pair instead.
                gm_dim, pl_dim = image_size(gm_file or ''), image_size(pl_file)
                if gm_dim and pl_dim and gm_dim != pl_dim:
                    self._send_json({
                        'error': 'size mismatch',
                        'detail': (f'The GM map is {gm_dim[0]}×{gm_dim[1]} and that one is '
                                   f'{pl_dim[0]}×{pl_dim[1]}. Both copies have to be the same '
                                   'size — they share one grid, so the hexes have to line up.'),
                    }, status=409)
                    return
                player = player_url
            with notes_api._lock:
                path = notes_api.write_key(gm_src, {'player': player})
            self._send_json({'ok': True, 'player': player, 'file': path or ''})
            return

        # --- GM pushes authoritative token doc (local only) ---
        if parsed.path == '/api/tokens_state':
            if not self.is_loopback():
                self._send_json({'error': 'forbidden'}, status=403)
                return
            body = self._read_json_body()
            if body is None:
                self._send_json({'error': 'bad body'}, status=400)
                return
            with state_lock:
                tokens_state['payload'] = body
                tokens_state['version'] += 1
                ver = tokens_state['version']
            self._send_json({'ok': True, 'version': ver})
            return

        # --- GM pushes the heavy player frame (map + fog + crop) (local only) ---
        if parsed.path == '/api/player_state':
            if not self.is_loopback():
                self._send_json({'error': 'forbidden'}, status=403)
                return
            body = self._read_json_body()
            if body is None:
                self._send_json({'error': 'bad body'}, status=400)
                return
            with state_lock:
                player_state['payload'] = body
                player_state['version'] += 1
                ver = player_state['version']
            self._send_json({'ok': True, 'version': ver})
            return

        # --- A player submits an action (claim / release / propose move) ---
        # Open to remote clients; the GM validates and applies on its side.
        if parsed.path == '/api/action':
            body = self._read_json_body()
            if body is None:
                self._send_json({'error': 'bad body'}, status=400)
                return
            body['t'] = time.time()
            # Who may move a token outright rather than propose it is settled
            # HERE, by the socket, and stamped over whatever the sender wrote.
            # A remote browser can post kind:'gmmove' all it likes; it arrives
            # local=False and the GM page drops it.
            body['local'] = not self.is_remote()
            with state_lock:
                player_actions.append(body)
                # Guard against unbounded growth if the GM page is closed.
                if len(player_actions) > 500:
                    del player_actions[:-500]
            self._send_json({'ok': True})
            return

        # --- GM code login from the player page (any device) ---
        # Rate-limited per client: an 8-character code is not guessable in
        # eight tries per ten minutes.
        if parsed.path == '/api/gm-login':
            who = (self.headers.get('X-Forwarded-For') or '').split(',')[0].strip() \
                or (self.client_address[0] if self.client_address else '')
            now = time.time()
            tries = [t for t in _login_tries.get(who, []) if now - t < 600]
            if len(tries) >= 8:
                self._send_json({'error': 'too many tries — wait a few minutes'}, status=429)
                return
            body = self._read_json_body() or {}
            if not hmac_eq(_norm_code(body.get('code')), _norm_code(gm_code())):
                tries.append(now)
                _login_tries[who] = tries
                self._send_json({'error': 'that is not the GM code'}, status=403)
                return
            _login_tries.pop(who, None)
            secure = '; Secure' if (self.headers.get('X-Forwarded-Proto') == 'https') else ''
            data = json.dumps({'ok': True}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Set-Cookie', f'{GM_COOKIE}={gm_token()}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax{secure}')
            self.send_header('Content-Length', len(data))
            self.end_headers()
            self.wfile.write(data)
            print(f"🔑 GM logged in on the player page from {who}")
            return

        if parsed.path == '/api/gm-logout':
            data = json.dumps({'ok': True}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Set-Cookie', f'{GM_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax')
            self.send_header('Content-Length', len(data))
            self.end_headers()
            self.wfile.write(data)
            return

        # --- The GM page shows the code, and can make a new one. This machine only. ---
        if parsed.path == '/api/gm-code/new':
            if not self.is_loopback():
                self._send_json({'error': 'forbidden'}, status=403)
                return
            _load_gm_secret(regenerate=True)
            self._send_json({'code': gm_code()})
            return

        # --- A player introduces themselves. Open to remote. ---
        # This does not create anything. It puts a card in the GM's queue.
        if parsed.path == '/api/join':
            body = self._read_json_body()
            if not body:
                self._send_json({'error': 'bad body'}, status=400)
                return
            name = str(body.get('name') or '').strip()[:40]
            character = str(body.get('character') or '').strip()[:40]
            color = str(body.get('color') or '').strip()[:16]
            if not name or not character:
                self._send_json({'error': 'a name and a character are both required'},
                                status=400)
                return
            if not re.match(r'^#[0-9a-fA-F]{6}$', color):
                color = '#39ff14'
            img = ''
            if body.get('img'):
                raw, ext = decode_image(body['img'])
                if raw is None:
                    self._send_json({'error': 'that portrait did not work: ' + ext},
                                    status=400)
                    return
                # Kept in memory, deliberately. On disk it would be one guessed
                # URL away from the projector; a /maps/ path would put it on
                # every screen at the table before the GM had seen it.
                img = 'data:image/%s;base64,%s' % (
                    ext.lstrip('.'), base64.b64encode(raw).decode())
            with state_lock:
                if len(pending_players) >= PENDING_CAP:
                    self._send_json({'error': 'the GM has too many requests waiting'},
                                    status=429)
                    return
                # One request per person: asking twice replaces the first rather
                # than filling the GM's queue with the same player.
                for old in [p for p in pending_players if p['name'].lower() == name.lower()]:
                    pending_players.remove(old)
                    join_results.pop(old['id'], None)
                jid = _new_join_id()
                pending_players.append({
                    'id': jid, 'name': name, 'character': character,
                    'color': color, 'img': img, 't': time.time(),
                })
            print(f"🙋 {name} asks to join as {character}"
                  f"{' (with a portrait)' if img else ''}")
            self._send_json({'ok': True, 'id': jid})
            return

        # --- GM lets someone in, or does not. GM only. ---
        if parsed.path == '/api/pending/resolve':
            if not self.is_loopback():
                self._send_json({'error': 'forbidden'}, status=403)
                return
            body = self._read_json_body() or {}
            jid = str(body.get('id') or '')
            approve = bool(body.get('approve'))
            with state_lock:
                rec = next((p for p in pending_players if p['id'] == jid), None)
                if rec:
                    pending_players.remove(rec)
                    join_results[jid] = 'approved' if approve else 'rejected'
                    if len(join_results) > 200:
                        for k in list(join_results)[:100]:
                            del join_results[k]
            if not rec:
                self._send_json({'error': 'no such request'}, status=404)
                return
            if not approve:
                # The bytes go with it. Nothing rejected is kept anywhere.
                print(f"🚫 turned away: {rec['name']} as {rec['character']}")
                self._send_json({'ok': True, 'approved': False})
                return
            # Only now does the portrait become a real file in the vault.
            img_path = ''
            if rec.get('img'):
                raw, ext = decode_image(rec['img'])
                if raw is not None:
                    img_path = save_to_uploads(rec['character'], raw, ext)
            print(f"✅ let in: {rec['name']} as {rec['character']}")
            self._send_json({'ok': True, 'approved': True, 'player': {
                'name': rec['name'], 'character': rec['character'],
                'color': rec['color'], 'img': img_path,
            }})
            return

        # --- Ephemeral marker stroke (neon "laser pointer"). Anyone may post. ---
        # Body: {id, by, color, points:[[tx,ty],...]}. Re-posting the same id
        # extends the stroke; the server stamps a fresh timestamp each time.
        if parsed.path == '/api/marker':
            body = self._read_json_body()
            if body is None or 'id' not in body:
                self._send_json({'error': 'bad body'}, status=400)
                return
            with state_lock:
                _prune_markers()
                body['t'] = time.time()
                markers[body['id']] = body
            self._send_json({'ok': True})
            return

        # --- Upload artwork (local GM only). Body: {name, data} where data is a
        # data: URL or raw base64. Saved under .tools/gm-display/uploads/ inside
        # the vault so it is served via /maps/ like any other vault image. ---
        if parsed.path == '/api/upload':
            if not self.is_loopback():
                self._send_json({'error': 'forbidden'}, status=403)
                return
            body = self._read_json_body()
            if not body or not body.get('data') or not body.get('name'):
                self._send_json({'error': 'bad body'}, status=400)
                return
            name = os.path.basename(body['name'])
            # sanitize: keep letters/digits/space/dash/underscore/dot
            name = ''.join(c for c in name if c.isalnum() or c in ' ._-()').strip()
            root, ext = os.path.splitext(name)
            if ext.lower() not in ('.png', '.jpg', '.jpeg', '.webp', '.gif'):
                self._send_json({'error': 'unsupported file type'}, status=400)
                return
            data = body['data']
            if data.startswith('data:'):
                try:
                    data = data.split(',', 1)[1]
                except IndexError:
                    self._send_json({'error': 'bad data url'}, status=400)
                    return
            try:
                raw = base64.b64decode(data)
            except Exception:
                self._send_json({'error': 'bad base64'}, status=400)
                return
            if len(raw) > 60 * 1024 * 1024:
                self._send_json({'error': 'file too large'}, status=413)
                return
            upload_dir = os.path.join(STATIC_DIR, 'uploads')
            os.makedirs(upload_dir, exist_ok=True)
            # De-dupe filename
            candidate, n = name, 1
            while os.path.exists(os.path.join(upload_dir, candidate)):
                candidate = f'{root}-{n}{ext}'
                n += 1
            full = os.path.join(upload_dir, candidate)
            with open(full, 'wb') as f:
                f.write(raw)
            # Register in the index so /maps/ fallback finds it immediately
            FILE_INDEX.setdefault(candidate, full)
            # Build a /maps/ path relative to the vault root (first image root)
            served = None
            for r in IMAGE_ROOTS:
                if full.startswith(r + os.sep):
                    served = '/maps/' + urllib.parse.quote(os.path.relpath(full, r))
                    break
            if not served:
                served = '/maps/' + urllib.parse.quote(candidate)
            print(f"🖼  Uploaded artwork: {candidate} → {served}")
            self._send_json({'ok': True, 'path': served, 'name': candidate})
            return

        # Receive a command from the protocol handler
        if parsed.path == '/api/command':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode() if content_length else ''

            # Parse command from body or query params
            params = urllib.parse.parse_qs(parsed.query)
            if body:
                try:
                    cmd = json.loads(body)
                except json.JSONDecodeError:
                    params.update(urllib.parse.parse_qs(body))
                    cmd = None

            # If JSON had a "url" field (from AppleScript handler), parse it
            if cmd and 'url' in cmd and 'action' not in cmd:
                cmd = parse_gm_url(cmd['url'])
            elif not cmd:
                url = params.get('url', [''])[0]
                if url:
                    cmd = parse_gm_url(url)
                else:
                    cmd = {
                        'action': params.get('action', ['show'])[0],
                        'file': params.get('file', [''])[0]
                    }

            global pending_command
            with command_lock:
                pending_command = cmd

            print(f"📨 Command received: {json.dumps(cmd)}")

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': True, 'command': cmd}).encode())
            return

        self.send_error(405)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def send_file(self, path):
        ext = os.path.splitext(path)[1].lower()
        mime_types = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
        }
        mime = mime_types.get(ext, 'application/octet-stream')

        with open(path, 'rb') as f:
            data = f.read()
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', len(data))
        self.send_header('Cache-Control', 'max-age=3600')
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        # Quieter logging — only log errors
        if args and '404' in str(args[0]):
            super().log_message(format, *args)


def parse_gm_url(url):
    """Parse a gm://action/path URL into a command dict."""
    parsed = urllib.parse.urlparse(url)
    action = parsed.hostname  # 'show' or 'map'
    file_path = urllib.parse.unquote(parsed.path.lstrip('/'))
    return {
        'action': action or 'show',
        'file': f'/maps/{urllib.parse.quote(file_path)}'
    }


def send_command_to_server(url):
    """Send a gm:// URL to the running server via HTTP POST."""
    cmd = parse_gm_url(url)
    try:
        import urllib.request
        data = json.dumps(cmd).encode()
        req = urllib.request.Request(
            f'http://localhost:{PORT}/api/command',
            data=data,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        urllib.request.urlopen(req, timeout=2)
        return True
    except Exception as e:
        print(f"Failed to send command: {e}")
        return False


def open_gm_page(url):
    """Open the GM page, in a specific browser profile if one was named.

    Every campaign, roster, fog mask and grid calibration this app has lives in
    localStorage, which browsers key per PROFILE as well as per origin. So the
    profile a tab opens in is not cosmetic: land in the wrong one and the app
    is not "missing data", it is a different, empty world with the same URL.
    Nothing is lost, but there is no way to tell that from looking at it.

    Left to itself, `webbrowser.open` hands the URL to whichever profile
    happens to be frontmost. So the command can be named instead:

        --browser-cmd='open -na Dia --args --profile-directory=Default {url}'

    `{url}` is substituted; without it the URL is appended. The command is
    split like a shell would, but run WITHOUT a shell, so a path with spaces
    needs quoting and nothing here can turn into shell injection.
    """
    cmd = BROWSER_CMD or os.environ.get('GM_DISPLAY_BROWSER') or ''
    if not cmd.strip():
        webbrowser.open(url)
        return
    try:
        parts = shlex.split(cmd)
        parts = [p.replace('{url}', url) for p in parts]
        if not any('{url}' in p for p in shlex.split(cmd)):
            parts.append(url)
        subprocess.Popen(parts,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        # A browser that will not start is not a reason for the server not to.
        print(f"⚠️  --browser-cmd failed ({e}); falling back to the default browser")
        webbrowser.open(url)


def main():
    mode = 'server'  # default
    open_browser = True
    pending_url = None

    # Parse args
    global BIND_HOST, PORT, BROWSER_CMD
    for arg in sys.argv[1:]:
        if arg == '--no-browser':
            open_browser = False
        elif arg.startswith('--browser-cmd='):
            # How to open the GM page. Chiefly: which browser PROFILE, since
            # that decides which localStorage the app wakes up in.
            BROWSER_CMD = arg.split('=', 1)[1]
        elif arg == '--lan':
            # Listen on every interface, so another machine on the wifi can
            # reach the player page — including whatever box is running ngrok.
            BIND_HOST = '0.0.0.0'
        elif arg.startswith('--host='):
            BIND_HOST = arg.split('=', 1)[1] or '127.0.0.1'
        elif arg.startswith('--port='):
            try:
                PORT = int(arg.split('=', 1)[1])
            except ValueError:
                print(f"Ignoring bad --port: {arg}")
        elif arg.startswith('gm://'):
            # Protocol handler mode: POST to running server, then exit
            if send_command_to_server(arg):
                return
            else:
                print("Server not running — starting it first")
                mode = 'server_then_command'
                pending_url = arg
                break
        elif os.path.isdir(arg):
            IMAGE_ROOTS.append(os.path.abspath(arg))

    def add_vault(vault_path):
        """Add a vault root to IMAGE_ROOTS. gm:// links use vault-relative paths."""
        if vault_path not in IMAGE_ROOTS:
            IMAGE_ROOTS.append(vault_path)

    # --- Primary detection: server.py lives INSIDE the vault at .tools/gm-display/
    # so we can always find the vault by walking up from our own location ---
    script_dir = os.path.dirname(os.path.abspath(__file__))
    vault_from_script = os.path.dirname(os.path.dirname(script_dir))  # up from .tools/gm-display/

    # Validate: if we're in an .app bundle, __file__ isn't in the vault
    if '.app/Contents' not in script_dir and os.path.isdir(vault_from_script):
        add_vault(vault_from_script)

    # Direct vault paths — always try these (works from app bundle or anywhere)
    home = os.path.expanduser('~')
    for vault_name in ['Documents/RPG/Campaign Vault', 'Documents/Pathfinder', 'Documents/Obsidian Vault']:
        vault_candidate = os.path.join(home, vault_name)
        if os.path.isdir(vault_candidate):
            add_vault(vault_candidate)

    if not IMAGE_ROOTS:
        # Fallback: look for common locations
        candidates = [
            os.path.join(home, 'Documents', 'RPG', 'Pathfinder 1e'),
            os.path.join(home, 'Documents', 'RPG'),
        ]
        for c in candidates:
            if os.path.isdir(c):
                IMAGE_ROOTS.append(c)

    if not IMAGE_ROOTS:
        # Last resort: auto-detect vaults in ~/Documents by marker folders
        for vault_parent in [
            os.path.join(home, 'Documents'),
            os.path.join(home, 'Obsidian'),
            home,
        ]:
            if not os.path.isdir(vault_parent):
                continue
            try:
                for entry in os.listdir(vault_parent):
                    candidate = os.path.join(vault_parent, entry)
                    if not os.path.isdir(candidate):
                        continue
                    if (os.path.isdir(os.path.join(candidate, '.obsidian'))
                            or os.path.isdir(os.path.join(candidate, 'Darkmoon Vale'))):
                        add_vault(candidate)
            except PermissionError:
                print(f"Warning: cannot scan {vault_parent} (permission denied, skipping)")

    if mode == 'server' and SUPERVISOR != 'tray' and '--force' not in sys.argv[1:] \
            and sys.platform == 'darwin' and hand_off_to_tray():
        return

    if not IMAGE_ROOTS:
        print("\n⚠️  WARNING: No image directories found!")
        print("   Maps and images won't load. Check that ~/Documents/RPG/Campaign Vault exists.\n")
    else:
        print(f"\n✅ Image roots ({len(IMAGE_ROOTS)}):")
        for r in IMAGE_ROOTS:
            print(f"   {r}")
        print()

    # --- Build file index for instant fallback lookups ---
    # This lets us find "Dragonfall Maps/file.jpg" even when the full vault
    # path is "Darkmoon Vale/Dragonfall Maps/file.jpg"
    IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.gif'}
    vault_root = IMAGE_ROOTS[0] if IMAGE_ROOTS else None
    if vault_root:
        try:
            for dirpath, _, filenames in os.walk(vault_root):
                for f in filenames:
                    if os.path.splitext(f)[1].lower() in IMAGE_EXTS:
                        full = os.path.join(dirpath, f)
                        rel = os.path.relpath(full, vault_root)
                        # Index by every possible tail of the path
                        # e.g. "Darkmoon Vale/Dragonfall Maps/file.jpg"
                        #   → also indexed as "Dragonfall Maps/file.jpg"
                        #   → also indexed as "file.jpg"
                        parts = rel.replace('\\', '/').split('/')
                        for i in range(len(parts)):
                            key = '/'.join(parts[i:])
                            if key not in FILE_INDEX:  # first match wins
                                FILE_INDEX[key] = full
            print(f"📁 File index: {len(FILE_INDEX)} entries from {vault_root}")
        except PermissionError:
            print(f"⚠️  Cannot index {vault_root} (permission denied)")

    # --- Notes, party notes, legends and shipped calibrations live in the
    # vault as markdown beside the maps they belong to ---
    try:
        notes_api.init(vault_root)
    except Exception as e:
        print(f"⚠️  notes_api init failed: {e}")
    board_api.PUBLIC_URL = public_url
    notes_api.RESOLVE_MAP = resolve_map_key
    try:
        board_api.init(vault_root)
    except Exception as e:
        print(f"⚠️  board_api init failed: {e}")

    # --- Kill anything on our port before binding ---
    def kill_port(port):
        """Kill any process holding our port. Returns True if something was killed."""
        try:
            result = subprocess.run(
                ['lsof', '-ti', f':{port}'],
                capture_output=True, text=True, timeout=3
            )
            pids = result.stdout.strip().split('\n')
            pids = [p.strip() for p in pids if p.strip()]
            if pids:
                my_pid = str(os.getpid())
                other_pids = [p for p in pids if p != my_pid]
                if other_pids:
                    # The port has one owner, and it is us. Ask first (a GM
                    # Display server flushes the bulletin board on SIGTERM),
                    # then insist.
                    print(f"Taking port {port} from: {', '.join(other_pids)}")
                    for pid in other_pids:
                        try:
                            os.kill(int(pid), signal.SIGTERM)
                        except (ProcessLookupError, PermissionError):
                            pass
                    for _ in range(20):
                        time.sleep(0.1)
                        alive = []
                        for pid in other_pids:
                            try:
                                os.kill(int(pid), 0)
                                alive.append(pid)
                            except (ProcessLookupError, PermissionError):
                                pass
                        if not alive:
                            break
                    for pid in other_pids:
                        try:
                            os.kill(int(pid), signal.SIGKILL)
                        except (ProcessLookupError, PermissionError):
                            pass
                    time.sleep(0.3)
                    return True
        except Exception:
            pass
        return False

    # --- Bind with retry ---
    # ThreadingHTTPServer so many player browsers polling /api/sync concurrently
    # don't serialize behind one another (and behind the GM's own polling).
    BaseServer = getattr(http.server, 'ThreadingHTTPServer', http.server.HTTPServer)

    class ServerClass(BaseServer):
        allow_reuse_address = True
        daemon_threads = True

        def handle_error(self, request, client_address):
            # A browser that reloads or closes a tab mid-request (the board's
            # long poll, most often) is not an error worth a traceback.
            exc = sys.exc_info()[1]
            if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
                return
            super().handle_error(request, client_address)
    server = None
    for attempt in range(5):
        try:
            server = ServerClass((BIND_HOST, PORT), GMHandler)
            break
        except OSError as e:
            if 'Address already in use' in str(e):
                if attempt == 0:
                    kill_port(PORT)
                else:
                    print(f"   Port {PORT} still busy, retrying ({attempt+1}/5)...")
                    time.sleep(1)
            else:
                raise

    if server is None:
        print(f"\n❌ Could not bind to port {PORT} after 5 attempts.")
        print(f"   Run: kill -9 $(lsof -ti :{PORT})")
        print(f"   Then try again.")
        sys.exit(1)

    print(f"🎲 GM Display Server running on http://localhost:{PORT}")
    if BIND_HOST in ('0.0.0.0', '::'):
        lan = lan_address()
        print(f"   Listening on every interface (--lan).")
        if lan:
            print(f"   Players / ngrok:  http://{lan}:{PORT}/remote.html")
            print(f"   Point a tunnel at http://{lan}:{PORT}  (it lands on the player page)")
        print(f"   Anyone on this network can reach the PLAYER view. The GM page")
        print(f"   stays loopback-only — they get redirected, same as a tunnel visitor.")
    else:
        print(f"   Loopback only. Another machine (an ngrok host) cannot reach this;")
        print(f"   restart with --lan if you need it to.")
    print(f"   Press Ctrl+C to stop\n")

    # Ctrl+C and SIGTERM both stop the server cleanly. SIGTERM used to be
    # ignored, which is exactly why "Restart Server" in the menu bar never
    # restarted anything: the old process shrugged it off and kept serving
    # the old code.
    def handle_stop(sig, frame):
        print(f"\nShutting down ({'Ctrl+C' if sig == signal.SIGINT else 'SIGTERM'})...")
        # Shutdown from a separate thread to avoid deadlocking serve_forever()
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGINT, handle_stop)
    signal.signal(signal.SIGTERM, handle_stop)
    # Ignore SIGPIPE (broken pipe from disconnected clients)
    if hasattr(signal, 'SIGPIPE'):
        signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    # Open browser to GM page (only on interactive start, not when launched by app)
    if open_browser:
        if mode in ('server', 'server_then_command'):
            threading.Timer(0.5, lambda: open_gm_page(f'http://localhost:{PORT}')).start()
    if mode == 'server_then_command' and pending_url:
        def delayed_command():
            time.sleep(1)
            send_command_to_server(pending_url)
        threading.Thread(target=delayed_command, daemon=True).start()

    threading.Thread(target=watch_sources, args=(server,), daemon=True).start()
    server.serve_forever()

    # --- stopped: by a signal, or because our own code changed ---
    try:
        board_api.flush()            # a drag in the last second is still worth keeping
    except Exception:
        pass
    server.server_close()
    if _restart[0]:
        # Same process, same arguments, new code. Never re-open a browser tab
        # and never re-send a one-shot gm:// command.
        args = [a for a in sys.argv[1:] if not a.startswith('gm://')]
        if '--no-browser' not in args:
            args.append('--no-browser')
        print('🔄 Restarting with the new code…\n', flush=True)
        os.execv(sys.executable, [sys.executable, os.path.abspath(__file__)] + args)


_restart = [False]


def watch_sources(server):
    """Restart in place when server.py / notes_api.py / board_api.py change.

    Waits for the files to stop changing (a deploy writes several), and
    refuses to restart onto code that does not compile — a half-saved file
    must not take the table down."""
    paths = [os.path.join(STATIC_DIR, f) for f in PY_SOURCES]
    base = _stamp_of(paths)
    while True:
        time.sleep(1.0)
        cur = _stamp_of(paths)
        if cur == base:
            continue
        while True:                      # settle
            time.sleep(1.5)
            again = _stamp_of(paths)
            if again == cur:
                break
            cur = again
        bad = None
        for p in paths:
            try:
                with open(p, encoding='utf-8') as f:
                    compile(f.read(), p, 'exec')
            except FileNotFoundError:
                continue
            except Exception as e:
                bad = f'{os.path.basename(p)}: {e}'
                break
        if bad:
            print(f"⚠️  New server code does not compile — staying on the running version.\n   {bad}", flush=True)
            base = cur
            continue
        print('🔄 Server code changed on disk — restarting to pick it up.', flush=True)
        _restart[0] = True
        server.shutdown()
        return


def hand_off_to_tray():
    """If the menu-bar app is already running the server, a second copy from
    a Terminal would only fight it for the port. Ask the app to restart its
    server instead (which picks up the current code) and step aside."""
    try:
        import urllib.request
        with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/api/health', timeout=1) as r:
            h = json.loads(r.read())
    except Exception:
        return False
    if h.get('supervisor') != 'tray':
        return False
    try:
        subprocess.run(['open', '-g', 'gm://control/restart'], timeout=5)
    except Exception as e:
        print(f"⚠️  Could not reach the GM Display menu-bar app ({e}).")
        return False
    print("⚔️  The GM Display menu-bar app runs the server, so it has been asked to")
    print("   restart it with the current code. Nothing else to do here.")
    print("   Log:  tail -f ~/Library/Logs/gm-display.log")
    print("   (To run it from this Terminal instead: quit the menu-bar app, or pass --force.)")
    return True


if __name__ == '__main__':
    main()
