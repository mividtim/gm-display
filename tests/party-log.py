#!/usr/bin/env python3
"""The party's notes as a log — what the vault stores, and what the pages show.

Two halves, both run from here:

  * the vault half, in this file: the markdown a party note is stored as, and
    what happens to its timestamp when a player rewrites their own line. This
    is where the risk is — the file is edited in Obsidian too, so anything
    written has to parse back the way it went in.
  * the page half, in tests/party-log.mjs: the same modules the browser loads,
    in a jsdom document, fed by the fixture server started here.

    python3 tests/party-log.py

Exits non-zero on the first failure. tests/session.py remains the one that
proves any of this against a real canvas.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import http.server
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import notes_api as N                                          # noqa: E402

PORT = 8913
BASE = f'http://127.0.0.1:{PORT}'
MAP = '/maps/Realm.png'

fails = 0


def check(ok, what, detail=''):
    global fails
    if not ok:
        fails += 1
    print(('  ok   ' if ok else '  BAD  ') + what
          + (('\n         ' + str(detail)) if detail and not ok else ''))


# A map with a history: two lines from before timestamps existed, a session's
# worth of dated ones, and one that was edited the next morning.
FIXTURE = '''---
map: "/maps/Realm.png"
---
# Party Notes — Realm.png

## 1,1
- **Old Hand** — written before times were kept

## 3,4
- **Dame Ada** (2026-09-16 20:10) — a ruined tower
- **Sir Tim** (2026-09-16 21:05 · edited 2026-09-17 00:50) — we camped by the ford

## 9,9
- **Knyan** (2026-09-16 20:42) — hoofprints, many
'''


class Handler(http.server.BaseHTTPRequestHandler):
    def is_remote(self):
        return False

    def do_POST(self):
        p = urllib.parse.urlparse(self.path)
        if not N.handle_post(self, p):
            self.send_response(404); self.end_headers()

    def do_GET(self):
        p = urllib.parse.urlparse(self.path)
        if not N.handle_get(self, p):
            self.send_response(404); self.end_headers()

    def log_message(self, *a):
        pass


def post(cell, text, by, at=None, expect=200):
    body = {'map': MAP, 'cell': cell, 'text': text, 'by': by}
    if at is not None:
        body['at'] = at
    req = urllib.request.Request(
        BASE + '/api/partynotes', data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'})
    try:
        return 200, json.loads(urllib.request.urlopen(req).read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')


def cells():
    return json.loads(urllib.request.urlopen(
        BASE + '/api/partynotes?map=' + urllib.parse.quote(MAP)).read())['cells']


def main():
    vault = tempfile.mkdtemp(prefix='gmd-party-log-')
    N._vault_root = vault
    os.makedirs(os.path.join(vault, N.SUBDIR), exist_ok=True)
    path = N.party_path(MAP)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(FIXTURE)

    srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    time.sleep(0.3)

    try:
        print('\n1. The markdown round-trips')
        # Everything the parser can be handed, including the shapes a GM
        # typing into Obsidian will produce.
        sample = {
            '1,1': [{'by': 'Ada', 'text': 'plain, undated'}],
            '2,2': [{'by': 'Tim', 'text': 'dated', 'at': '2026-09-16 20:10'}],
            '3,3': [{'by': 'Knyan', 'text': 'edited', 'at': '2026-09-16 20:10',
                     'edited': '2026-09-17 09:00'}],
            '4,4': [{'by': 'Ada', 'text': 'the bridge — what is left of it — sags',
                     'at': '2026-09-16 20:11'}],
            '5,5': [{'by': 'Ada', 'text': '(we think) a cairn'}],
        }
        back = N._parse_party(N._compose_party(MAP, sample))
        check(back == sample, 'compose -> parse gives back exactly what went in', back)

        print('\n2. Writing a note records when it was written')
        post('7,7', 'a standing stone', 'Dame Ada')
        e = cells()['7,7'][0]
        check(e.get('at', '').startswith(time.strftime('%Y-%m-%d %H:%M', time.localtime())),
              'in local wall-clock', e)

        print('\n3. A hex accumulates — a second note does not replace the first')
        # This is the whole point: you come back to a hex having seen something
        # new. The old observation is still true.
        post('7,7', 'and a second stone, fallen', 'Dame Ada')
        got = cells()['7,7']
        check(len(got) == 2, 'the same player can write twice on one hex', got)
        check([x['text'] for x in got] ==
              ['a standing stone', 'and a second stone, fallen'],
              'oldest first, both intact', got)
        check(got[0]['at'] != got[1]['at'],
              'and the two are individually addressable', got)

        post('7,7', 'I saw it too', 'Knyan')
        check(len(cells()['7,7']) == 3, 'as can somebody else', cells()['7,7'])

        print('\n4. Your own entry is still yours to change or take back')
        at0 = cells()['7,7'][0]['at']
        post('7,7', 'a standing stone, mossy', 'Dame Ada', at=at0)
        got = cells()['7,7']
        check(got[0]['text'] == 'a standing stone, mossy', 'editing changes that one', got[0])
        check(got[0]['at'] == at0, 'and it keeps its place in the log', got[0])
        check(got[0].get('edited'), 'while recording that it changed', got[0])
        check(len(got) == 3, 'without disturbing the others', got)

        # An entry is addressed by WHO wrote it as well as when, so one player
        # cannot reach another's — not even when the two were written in the
        # same second and share a timestamp.
        knyan = next(x for x in cells()['7,7'] if x['by'] == 'Knyan')
        st, _ = post('7,7', 'not mine to touch', 'Dame Ada', at='1999-01-01 00:00:00')
        check(st == 404, 'editing an entry that does not exist is refused', st)
        post('7,7', 'not mine to touch', 'Mallory', at=knyan['at'])
        still = next(x for x in cells()['7,7'] if x['by'] == 'Knyan')
        check(still['text'] == knyan['text'],
              "and another player's entry is left alone", still)

        post('7,7', '', 'Dame Ada', at=at0)
        got = cells()['7,7']
        check(len(got) == 2 and all(x['text'] != 'a standing stone, mossy' for x in got),
              'and an empty text removes that one entry', got)

        print('\n5. An empty note is nothing to say, not a delete')
        st, d = post('7,7', '   ', 'Knyan')
        check(st == 400, 'adding blank text is refused', (st, d))
        check(len(cells()['7,7']) == 2, 'and removes nothing', cells()['7,7'])

        print('\n6. The vault file is still something you would read in Obsidian')
        with open(path, encoding='utf-8') as f:
            lines = [l for l in f.read().split('\n') if l.startswith('- **')]
        for l in lines[:4]:
            print('         ' + l)
        check(all(re.match(r'^- \*\*[^*]+\*\*( \([^)]*\))? — ', l) for l in lines),
              'every line is name, when, then the note', lines)

        # --- the page half ---
        print('\n--- the pages (tests/party-log.mjs) ---')
        env = dict(os.environ, PARTY_LOG_BASE=BASE)
        r = subprocess.run(['node', os.path.join(HERE, 'party-log.mjs')],
                           cwd=HERE, env=env)
        if r.returncode:
            print('\nthe page half failed')
            return 1
    finally:
        srv.shutdown()
        shutil.rmtree(vault, ignore_errors=True)

    print(f'\nvault failures: {fails}')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
