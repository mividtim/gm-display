#!/usr/bin/env python3
"""
End-to-end session test for GM Display.

regress.py is a white-box harness: it calls internals and diffs a snapshot.
It was green while the projector showed the players a black rectangle, because
nothing in it ever asked the only question that matters at the table —

    can the players see the map?

This drives the app the way a GM does, through the actual controls, and asserts
on PIXELS in the projector window. No internals, no shims.

    python3 server.py --no-browser /path/to/vault      # in one shell
    python3 tests/session.py

Exits non-zero on the first failure, and says what a GM would have seen.
"""
import asyncio
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

from playwright.async_api import async_playwright

BASE = 'http://localhost:7680'
MAP = '/maps/Maps/printed-grid.png'
HEXMAP = '/maps/Mythic Bastionland/GM/MB Campaign 1 Realm (GM).png'

fails = []


def check(ok, what, saw=''):
    print(('  ok   ' if ok else '  FAIL ') + what + (f'   [{saw}]' if saw and not ok else ''))
    if not ok:
        fails.append(what)
    return ok


def cmd(action, file):
    urllib.request.urlopen(urllib.request.Request(
        BASE + '/api/command',
        data=json.dumps({'action': action, 'file': file}).encode(),
        headers={'Content-Type': 'application/json'}))


def api(path, data=None, remote=False):
    """(status, parsed body). `remote=True` is a player on the tunnel: the
    server calls anything carrying X-Forwarded-For remote, which is exactly
    what ngrok puts on a visitor's request."""
    headers = {'Content-Type': 'application/json'}
    if remote:
        headers['X-Forwarded-For'] = '203.0.113.9'
    req = urllib.request.Request(
        BASE + path, data=json.dumps(data).encode() if data is not None else None,
        headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            body = r.read()
            try:
                return r.status, json.loads(body)
            except ValueError:
                return r.status, None
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, None
    except Exception:
        return 'unreachable', None


# How much of the projector canvas is not black? The single number that
# answers "can the players see anything".
LIT = """(() => {
  const c = document.getElementById('player-canvas');
  if (!c || !c.width) return -1;
  const d = c.getContext('2d', {willReadFrequently: true})
             .getImageData(0, 0, c.width, c.height).data;
  let lit = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 97) {
    n++;
    if (d[i] > 24 || d[i+1] > 24 || d[i+2] > 24) lit++;
  }
  return Math.round(lit / n * 100);
})()"""

# Gold ink on the GM's grid canvas — the note pips and the selection ring.
# Counting pixels is the only way to catch "redrawn without clearing": the
# survivors get painted straight over the stale dot and it stays on screen.
GOLD = """(() => {
  const c = document.getElementById('gm-grid-canvas');
  if (!c || !c.width) return -1;
  const d = c.getContext('2d', {willReadFrequently: true})
             .getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i+3] > 40 && d[i] > 190 && d[i+1] > 140 && d[i+2] < 150) n++;
  }
  return n;
})()"""

# Grid lines drawn by the map key, on the projector's token canvas.
GRIDPX = """(() => {
  const c = document.getElementById('player-token-canvas');
  if (!c || !c.width) return -1;
  const d = c.getContext('2d', {willReadFrequently: true})
             .getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4 * 41) if (d[i] > 8) n++;
  return n;
})()"""


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900})
        errs = []
        gm = await ctx.new_page()
        gm.on('pageerror', lambda e: errs.append('GM ' + str(e)))
        gm.on('console', lambda m: errs.append('GM ' + m.text) if m.type == 'error' else None)
        await gm.goto(BASE + '/gm.html')
        await gm.wait_for_timeout(800)
        await gm.evaluate("localStorage.clear()")
        await gm.reload()
        await gm.wait_for_timeout(1200)

        pj = await ctx.new_page()
        pj.on('pageerror', lambda e: errs.append('PJ ' + str(e)))
        pj.on('console', lambda m: errs.append('PJ ' + m.text) if m.type == 'error' else None)
        await pj.goto(BASE + '/display.html?display=map')
        await pj.wait_for_timeout(1000)

        print('\n1. Load a map with the projector open')
        cmd('map', MAP)
        await gm.wait_for_timeout(3000)
        check(await gm.evaluate("window.GMD.S.currentMode") == 'fog',
              'GM lands in fog mode')
        lit = await pj.evaluate(LIT)
        check(lit == 0, 'projector starts fully fogged', f'{lit}% lit')

        print('\n2. Reveal All — the players must now see the map')
        # The controls a GM needs first must be reachable without hunting.
        check(await gm.evaluate("""(() => {
            let el = document.querySelector('[data-act=\"b13\"]');
            while (el) { if (el.tagName === 'DETAILS' && !el.open) return false;
                         el = el.parentElement; } return true; })()"""),
              'Reveal All is reachable without expanding a panel')
        await gm.click('[data-act="b13"]')          # Reveal All
        await gm.wait_for_timeout(1500)
        lit = await pj.evaluate(LIT)
        check(lit > 60, 'projector shows the map after Reveal All', f'{lit}% lit')

        print('\n3. Hide All puts it back')
        await gm.click('[data-act="b14"]')
        await gm.wait_for_timeout(1500)
        lit = await pj.evaluate(LIT)
        check(lit < 5, 'projector goes dark after Hide All', f'{lit}% lit')

        print('\n4. Staged mode: edits must NOT reach the projector, and the')
        print('   GM must be told so somewhere they cannot collapse away')
        await gm.click('#btn-live-sync')            # Live -> Staged
        await gm.wait_for_timeout(300)
        await gm.click('[data-act="b13"]')          # Reveal All, staged
        await gm.wait_for_timeout(1200)
        lit = await pj.evaluate(LIT)
        check(lit < 5, 'staged edits stay off the projector', f'{lit}% lit')
        banner = await gm.evaluate(
            "getComputedStyle(document.getElementById('fog-staged-banner')).display")
        check(banner != 'none', 'the staged warning is visible on the map', banner)
        # ...and it is not hidden inside a collapsed section
        inside = await gm.evaluate("""(() => {
            let el = document.getElementById('fog-staged-banner');
            while (el) {
              if (el.tagName === 'DETAILS' && !el.open) return true;
              el = el.parentElement;
            } return false; })()""")
        check(not inside, 'the warning is not inside a collapsed panel')

        print('\n5. Sync Now — clicking the warning pushes it')
        await gm.click('#fog-staged-banner')
        await gm.wait_for_timeout(1500)
        lit = await pj.evaluate(LIT)
        check(lit > 60, 'projector catches up after Sync Now', f'{lit}% lit')
        banner = await gm.evaluate(
            "getComputedStyle(document.getElementById('fog-staged-banner')).display")
        check(banner == 'none', 'the warning clears once synced', banner)
        await gm.click('#btn-live-sync')            # back to Live
        await gm.wait_for_timeout(400)

        print('\n6. Grid lines: drawing them is separate from using them')
        cmd('map', HEXMAP)
        await gm.wait_for_timeout(3200)
        dark = await pj.evaluate(LIT)          # this map, fogged
        await gm.click('[data-act="b13"]')
        await gm.wait_for_timeout(1500)
        shown = await pj.evaluate(LIT)         # ...and revealed
        check(shown > dark + 25, 'the hex map reaches the projector',
              f'{dark}% fogged -> {shown}% revealed')
        # This map ships show:false — its hexes are printed on the artwork.
        off0 = await pj.evaluate(GRIDPX)
        check(off0 == 0, 'a map that ships show:false draws no lines', f'{off0} px')
        await gm.evaluate("""(() => { const b = document.getElementById('btn-tokgrid');
            let el = b; while (el) { if (el.tagName === 'DETAILS') el.open = true;
                                     el = el.parentElement; } })()""")
        await gm.wait_for_timeout(200)
        await gm.click('#btn-tokgrid')              # lines ON
        await gm.wait_for_timeout(1200)
        on = await pj.evaluate(GRIDPX)
        check(on > 0, 'grid lines draw when Draw grid lines is ON', f'{on} px')
        # Grid settings are a settings panel — opening it is a fair thing to
        # ask of a GM, unlike hunting for Reveal All mid-session.
        await gm.evaluate("""(() => { const b = document.getElementById('btn-tokgrid');
            let el = b; while (el) { if (el.tagName === 'DETAILS') el.open = true;
                                     el = el.parentElement; } })()""")
        await gm.wait_for_timeout(200)
        await gm.click('#btn-tokgrid')              # turn the LINES off
        await gm.wait_for_timeout(1200)
        off = await pj.evaluate(GRIDPX)
        check(off == 0, 'no grid lines on the projector when turned off', f'{off} px')
        # ...but the map is still calibrated: cells still address and snap
        still = await gm.evaluate("""(() => {
            const G = window.GMD;
            const s = G.snapNorm(0.4137, 0.6021);
            return [G.S.tokenGridEnabled, G.cellLabel(G.cellAtMapPx(
              s.tx * G.S.mapWidth, s.ty * G.S.mapHeight, G.S.mapWidth, G.S.mapHeight))];
          })()""")
        check(still[0] is True and ',' in str(still[1]),
              'snapping and cell addresses still work with lines off', str(still))
        lit = await pj.evaluate(LIT)
        check(abs(lit - shown) < 8, 'turning lines off did not disturb the map',
              f'{shown}% -> {lit}%')
        # Shoot the projector at the moment that matters: map revealed, the
        # app's own grid off, the map's printed hexes doing the work.
        await pj.screenshot(path='/tmp/session_table.png')
        await gm.click('#btn-tokgrid')              # lines back on

        print('\n7. Notes belong to a map file — say which one')
        panel = await gm.evaluate("""(() => {
            document.querySelectorAll('details.sb-section').forEach(
              d => d.open = (d.id === 'section-notes'));
            return document.getElementById('note-list').textContent; })()""")
        check('MB Campaign 1 Realm (GM).png' in panel,
              'the notes panel names the file it is reading', panel[:80])
        # A map with no notes must say so by name, not just "no notes"
        cmd('map', '/maps/Maps/realm-sheet.png')
        await gm.wait_for_timeout(3000)
        panel = await gm.evaluate("document.getElementById('note-list').textContent")
        check('realm-sheet.png' in panel,
              'an unnoted map names itself rather than going silent', panel[:80])

        print('\n8. The tool strip: one tool at a time, and only that tool')
        cmd('map', MAP)
        await gm.wait_for_timeout(3000)
        check(await gm.evaluate(
            "getComputedStyle(document.getElementById('tool-bar')).display") != 'none',
            'the tool strip is on the map')
        # Exactly one lit, and every layer derived from it.
        async def pick(tool):
            await gm.click(f'#tool-bar [data-tool="{tool}"]')
            await gm.wait_for_timeout(350)
            return await gm.evaluate("""(() => {
                const ce = id => { const e = document.getElementById(id);
                  return e ? getComputedStyle(e).pointerEvents : 'missing'; };
                return {
                  lit: [...document.querySelectorAll('#tool-bar .tool-btn.active')]
                         .map(b => b.dataset.tool),
                  fog: ce('gm-fog-canvas'),
                  marker: ce('gm-marker-canvas'),
                  notes: ce('gm-notes-layer'),
                  tokensLive: !document.getElementById('gm-token-layer')
                                .classList.contains('markerblock'),
                }; })()""")

        for tool, want in [
            ('none',   dict(fog='none', marker='none', notes='none', tokensLive=False)),
            ('reveal', dict(fog='auto', marker='none', notes='none', tokensLive=False)),
            ('hide',   dict(fog='auto', marker='none', notes='none', tokensLive=False)),
            ('tokens', dict(fog='none', marker='none', notes='none', tokensLive=True)),
            ('notes',  dict(fog='none', marker='none', notes='auto', tokensLive=False)),
            ('marker', dict(fog='none', marker='auto', notes='none', tokensLive=False)),
        ]:
            got = await pick(tool)
            ok = (got['lit'] == [tool]
                  and all(got[k] == v for k, v in want.items()))
            check(ok, f'{tool}: exactly one tool lit, only its layer live', json.dumps(got))

        # Keyboard reaches the same place.
        await gm.click('#gm-canvas-wrap', position={'x': 5, 'y': 5}, force=True)
        for key, tool in [('r', 'reveal'), ('v', 'tokens'), ('n', 'notes'), ('m', 'marker')]:
            await gm.keyboard.press(key)
            await gm.wait_for_timeout(200)
            check(await gm.evaluate("window.GMD.S.activeTool") == tool,
                  f'key {key} selects {tool}')
        # Escape steps out rather than jumping home.
        await gm.keyboard.press('Escape')
        await gm.wait_for_timeout(250)
        check(await gm.evaluate("window.GMD.S.activeTool") == 'none',
              'Escape drops to None')
        check(await gm.evaluate("window.GMD.S.currentMode") == 'fog',
              'Escape did not leave the map')
        # Picking a tool opens its settings.
        await gm.evaluate("document.querySelectorAll('details.sb-section')"
                          ".forEach(d => d.open = false)")
        await gm.click('#tool-bar [data-tool="notes"]')
        await gm.wait_for_timeout(400)
        check(await gm.evaluate(
            "document.getElementById('section-notes').open"),
            'picking Notes opens the Notes section')

        print('\n9. Painting fog actually paints — the core loop')
        cmd('map', MAP)
        await gm.wait_for_timeout(3000)
        # Step 8 collapsed every section. Picking a fog tool is what should
        # bring Fog Tools back — which is the feature, so use it.
        await gm.click('#tool-bar [data-tool="reveal"]')
        await gm.wait_for_timeout(400)
        check(await gm.evaluate("""(() => { const b =
            document.querySelector('[data-act=\"b14\"]');
            return !!(b && b.offsetParent); })()"""),
              'picking a fog tool brings Hide All back into view')
        await gm.click('[data-act="b14"]')          # Hide All
        await gm.wait_for_timeout(1200)
        before = await pj.evaluate(LIT)
        await gm.click('#tool-bar [data-tool="reveal"]')
        await gm.wait_for_timeout(300)
        box = await gm.evaluate("""(() => { const r = document.getElementById(
            'gm-canvas-wrap').getBoundingClientRect();
            return {x: r.left, y: r.top, w: r.width, h: r.height}; })()""")
        await gm.mouse.move(box['x'] + box['w'] * 0.35, box['y'] + box['h'] * 0.4)
        await gm.mouse.down()
        for i in range(1, 9):
            await gm.mouse.move(box['x'] + box['w'] * (0.35 + i * 0.03),
                                box['y'] + box['h'] * 0.4)
        await gm.mouse.up()
        await gm.wait_for_timeout(1500)
        after = await pj.evaluate(LIT)
        check(after > before, 'dragging with Reveal paints fog away on the projector',
              f'{before}% -> {after}%')
        # ...and the same drag under a non-fog tool must do nothing
        await gm.click('#tool-bar [data-tool="none"]')
        await gm.wait_for_timeout(300)
        held = await pj.evaluate(LIT)
        await gm.mouse.move(box['x'] + box['w'] * 0.6, box['y'] + box['h'] * 0.7)
        await gm.mouse.down()
        for i in range(1, 9):
            await gm.mouse.move(box['x'] + box['w'] * (0.6 + i * 0.03),
                                box['y'] + box['h'] * 0.7)
        await gm.mouse.up()
        await gm.wait_for_timeout(1200)
        check(await pj.evaluate(LIT) == held,
              'the same drag under None changes nothing')

        print('\n10. Tokens mark their cell without hiding it')
        await gm.evaluate("""(() => {
            const G = window.GMD;
            G.S.roster = []; G.S.tokens = [];
            G.addCompanyToken(); })()""")
        await gm.wait_for_timeout(500)
        fill = await gm.evaluate("""(() => {
            const f = document.querySelector('#gm-token-layer .token.party .tok-fill');
            const el = document.querySelector('#gm-token-layer .token.party');
            if (!f || !el) return null;
            return [ +getComputedStyle(f).opacity,
                     +getComputedStyle(el).opacity,
                     getComputedStyle(el).borderTopWidth ]; })()""")
        check(fill and fill[0] < 0.5, 'the Company fill is see-through', json.dumps(fill))
        check(fill and fill[1] == 1, 'its ring and label stay solid', json.dumps(fill))

        print('\n11. An emptied note is a deleted note')
        cmd('map', MAP)
        await gm.wait_for_timeout(3000)
        read = """(async () => {
            const G = window.GMD;
            const d = await (await fetch('/api/notes?map=' + encodeURIComponent(
              G.relMapSrc(G.S.lastMapSrc)), {cache: 'no-store'})).json();
            return { count: G.notesCount(),
                     server: Object.keys(d.cells).sort(),
                     rows: document.querySelectorAll('#note-list [data-cell]').length,
                     pop: G.notePopOpen() }; })()"""
        typeIn = lambda v: gm.evaluate(
            "(v) => { const ta = document.getElementById('note-pop-text');"
            "  ta.value = v; ta.dispatchEvent(new Event('input')); }", v)

        base = await gm.evaluate(read)
        await gm.evaluate("window.GMD.openNoteAt('7,3', 500, 400)")
        await gm.wait_for_timeout(300)
        await typeIn('Boot prints.')
        await gm.wait_for_timeout(1500)
        wrote = await gm.evaluate(read)
        check('7,3' in wrote['server'] and wrote['count'] == base['count'] + 1,
              'writing a note adds it', json.dumps(wrote))

        await typeIn('')
        await gm.wait_for_timeout(1600)
        gone = await gm.evaluate(read)
        check('7,3' not in gone['server'], 'emptying it removes it from the vault',
              json.dumps(gone))
        check(gone['rows'] == base['rows'], 'and from the note index', json.dumps(gone))
        check(gone['pop'] is False, 'and closes the editor rather than sitting on nothing')

        # Whitespace is empty too.
        await gm.evaluate("window.GMD.openNoteAt('7,4', 500, 400)")
        await gm.wait_for_timeout(300)
        await typeIn('Something')
        await gm.wait_for_timeout(1500)
        await typeIn('   \n  \t\n ')
        await gm.wait_for_timeout(1600)
        ws = await gm.evaluate(read)
        check('7,4' not in ws['server'], 'whitespace counts as empty', json.dumps(ws))

        # The pip and the selection ring must go in real time, not on the next
        # accidental redraw. The shared canvas is only cleared by one owner.
        await gm.click('#tool-bar [data-tool="notes"]')
        await gm.wait_for_timeout(400)
        empty_gold = await gm.evaluate(GOLD)
        await gm.evaluate("window.GMD.openNoteAt('8,8', 500, 400)")
        await gm.wait_for_timeout(300)
        await typeIn('A pip should appear.')
        await gm.wait_for_timeout(1500)
        with_gold = await gm.evaluate(GOLD)
        check(with_gold > empty_gold, 'writing a note puts gold ink on the map',
              f'{empty_gold} -> {with_gold}')
        await typeIn('')
        await gm.wait_for_timeout(1600)
        after_gold = await gm.evaluate(GOLD)
        check(after_gold == empty_gold,
              'emptying it wipes the pip and ring off the canvas immediately',
              f'{empty_gold} -> {with_gold} -> {after_gold}')

        # Hovering a cell with nothing written must show nothing at all.
        await gm.click('#tool-bar [data-tool="notes"]')
        await gm.wait_for_timeout(300)
        pt = await gm.evaluate("""(() => {
            const G = window.GMD;
            const r = document.getElementById('gm-canvas-wrap').getBoundingClientRect();
            const m = G.cellCenterMapPx(G.cellFromLabel('7,3'), G.S.mapWidth, G.S.mapHeight);
            return {x: r.left + m.x / G.S.mapWidth * r.width,
                    y: r.top + m.y / G.S.mapHeight * r.height}; })()""")
        await gm.mouse.move(pt['x'], pt['y'])
        await gm.wait_for_timeout(500)
        check(await gm.evaluate(
            "getComputedStyle(document.getElementById('gm-note-tip')).display") == 'none',
            'no tooltip on a cell with nothing written')
        # ...but a cell that does have one still peeks.
        pt2 = await gm.evaluate("""(() => {
            const G = window.GMD;
            const r = document.getElementById('gm-canvas-wrap').getBoundingClientRect();
            const m = G.cellCenterMapPx(G.cellFromLabel('4,6'), G.S.mapWidth, G.S.mapHeight);
            return {x: r.left + m.x / G.S.mapWidth * r.width,
                    y: r.top + m.y / G.S.mapHeight * r.height}; })()""")
        await gm.mouse.move(pt2['x'], pt2['y'])
        await gm.wait_for_timeout(500)
        check(await gm.evaluate(
            "getComputedStyle(document.getElementById('gm-note-tip')).display") == 'block',
            'a cell that has a note still peeks')

        # The question this file exists to ask, pointed the other way: not
        # "can the players see the map" but "can they see anything else".
        print('\n12. What a player on the tunnel can reach')
        gm_map = await gm.evaluate("window.GMD.S.lastMapSrc")
        gm_map = urllib.parse.urlparse(gm_map or '').path
        s, _ = api('/api/notes?map=' + urllib.parse.quote(gm_map), remote=True)
        check(s == 403, 'the GM\'s prep notes are refused to a player', str(s))
        s, d = api('/api/notes?map=' + urllib.parse.quote(gm_map))
        check(s == 200 and isinstance(d, dict), 'and still readable by the GM', str(s))
        s, _ = api('/api/maps', remote=True)
        check(s == 403, 'the vault index is refused to a player', str(s))
        s, d = api('/api/maps')
        check(s == 200 and len(d or []) > 0, 'and still listed for the GM', str(s))

        # Any vault image that is not the map on the table, a token portrait or
        # a legend swatch. Pick one the GM is demonstrably not showing.
        others = [m['path'] for m in (d or []) if urllib.parse.unquote(m['path'][6:])
                  not in gm_map and 'legend-icons' not in m['path']]
        if others:
            s, _ = api(others[0], remote=True)
            check(s == 404, 'an unpublished vault image is not served to a player', str(s))
            s, _ = api(others[0])
            check(s == 200, 'the GM can still fetch it', str(s))

        print('\n13. Split map: the GM\'s copy and the table\'s')
        s, frame = api('/api/player_state', remote=True)
        check((frame or {}).get('payload', {}).get('mapKey') == gm_map,
              'the frame names the map identity, not just the image',
              str((frame or {}).get('payload', {}).get('mapKey')))

        # Find a same-size sibling to stand in for the players' copy. A vault
        # without one is not a failure — there is simply nothing to pair.
        twin = ''
        for cand in others:
            st, res = api('/api/mapkey', {'map': gm_map, 'player': cand})
            if st == 200:
                twin = res['player']
                break
        if not twin:
            print('  skip   no same-size second image in this vault to pair with')
        else:
            s, frame = api('/api/player_state', remote=True)
            pay = (frame or {}).get('payload') or {}
            check(pay.get('imageSrc') == twin, 'a player is served the players\' copy',
                  str(pay.get('imageSrc')))
            check(pay.get('mapKey') == gm_map,
                  'while notes still key on the GM\'s copy', str(pay.get('mapKey')))
            s, frame2 = api('/api/player_state')
            check((frame2['payload'] or {}).get('imageSrc') == gm_map,
                  'the GM page still gets its own copy')
            s, _ = api(gm_map, remote=True)
            check(s == 404, 'the GM\'s copy is not fetchable by a player', str(s))
            s, _ = api(twin, remote=True)
            check(s == 200, 'the players\' copy is', str(s))

            # And what they write on it has to come back to the GM, under the
            # GM map's name — the whole point of keying on the identity.
            api('/api/partynotes', {'map': gm_map, 'cell': '2,3',
                                    'text': 'a cairn here', 'by': 'Ana'}, remote=True)
            s, notes = api('/api/partynotes?map=' + urllib.parse.quote(gm_map))
            wrote = [e['text'] for e in (notes or {}).get('cells', {}).get('2,3', [])]
            check('a cairn here' in wrote,
                  'what a player writes reaches the GM\'s copy', str(wrote))
            api('/api/mapkey', {'map': gm_map, 'player': ''})     # leave it unsplit

        print('\n14. Peeking works whatever tool is selected')
        # Reading what you wrote about a hex is not an edit, so it should not
        # cost you a trip to the toolbar first. Only a drag suppresses it.
        cmd('map', MAP)
        await gm.wait_for_timeout(3000)
        api('/api/notes', {'map': MAP, 'cell': '4,6', 'text': 'Sentries on the ridge.'})
        await gm.evaluate("window.GMD.loadNotes()")
        await gm.wait_for_timeout(600)
        pt = await gm.evaluate("""(() => {
            const G = window.GMD;
            const r = document.getElementById('gm-canvas-wrap').getBoundingClientRect();
            const m = G.cellCenterMapPx(G.cellFromLabel('4,6'), G.S.mapWidth, G.S.mapHeight);
            return {x: r.left + m.x / G.S.mapWidth * r.width,
                    y: r.top + m.y / G.S.mapHeight * r.height}; })()""")
        for tool in ['none', 'reveal', 'hide', 'tokens', 'notes', 'marker']:
            await gm.click(f'#tool-bar [data-tool="{tool}"]')
            await gm.wait_for_timeout(220)
            await gm.mouse.move(pt['x'] - 4, pt['y'] - 4)   # a real move, not a jump
            await gm.mouse.move(pt['x'], pt['y'])
            await gm.wait_for_timeout(320)
            d = await gm.evaluate(
                "getComputedStyle(document.getElementById('gm-note-tip')).display")
            check(d == 'block', f'the note peeks under the {tool} tool', d)

        print('\n15. The players get the same peek, and only their own notes')
        # A party note on the same cell the GM has prep on. The player must see
        # theirs and never the GM's — that cell is the whole test.
        api('/api/partynotes', {'map': MAP, 'cell': '4,6',
                                'text': 'We camped here.', 'by': 'Sir Tim'})
        await gm.evaluate("""(() => {
            const G = window.GMD;
            G.S.roster = []; G.S.tokens = [];
            G.S.roster.push({id: 'pc-a', base: 'Dame Ada', num: 0, color: '#22c55e',
              img: '', side: 'pc', owner: '', ownerColor: '',
              tx: 0.2, ty: 0.9, onMap: true, pending: null});
            G.S.tokens.push(G.S.roster[0]);
            G.pushTokensToServer(); G.pushPlayerStateToServer(); })()""")
        await gm.wait_for_timeout(900)
        rp = await ctx.new_page()
        rp.on('pageerror', lambda e: errs.append('RP ' + str(e)))
        rp.on('console', lambda m: errs.append('RP ' + m.text) if m.type == 'error' else None)
        await rp.goto(BASE + '/remote.html')
        await rp.wait_for_timeout(1600)
        await rp.fill('#remote-name', 'Sir Kay')
        await rp.click('.remote-card')
        await rp.wait_for_timeout(2200)

        def cell_pt(label):
            return ("(() => {"
                    "  const G = window.GMD;"
                    "  const c = document.getElementById('remote-note-canvas');"
                    "  const r = c.getBoundingClientRect();"
                    "  const m = G.cellCenterMapPx(G.cellFromLabel('" + label + "'),"
                    "    G.S.remoteFrame.width, G.S.remoteFrame.height);"
                    "  const p = G.remoteMapToCanvas(m.x, m.y);"
                    "  return {x: r.left + p.x, y: r.top + p.y}; })()")

        # Tapping a hex means "I want to write here": the cursor has to land in
        # the box. On a phone that is also what raises the keyboard. Use a cell
        # nobody has written on, so this is about typing and not leftover text.
        fresh = await rp.evaluate(cell_pt('11,11'))
        await rp.click('#remote-notes-btn')
        await rp.wait_for_timeout(400)
        await rp.mouse.click(fresh['x'], fresh['y'])
        await rp.wait_for_timeout(500)
        check(await rp.evaluate("document.activeElement && document.activeElement.id")
              == 'remote-note-text', "tapping a hex focuses the player's text box")
        was = await rp.evaluate("document.getElementById('remote-note-text').value")
        await rp.keyboard.type('Tracks in the mud.')
        now = await rp.evaluate("document.getElementById('remote-note-text').value")
        check(now == was + 'Tracks in the mud.',
              'and typing goes straight in, no second click', repr(was) + ' -> ' + repr(now))

        # Peek with notes mode OFF — and never carrying the GM's prep.
        cpt = await rp.evaluate(cell_pt('4,6'))
        await rp.click('#remote-notes-btn')
        await rp.wait_for_timeout(400)
        await rp.mouse.move(cpt['x'] - 6, cpt['y'] - 6)
        await rp.mouse.move(cpt['x'], cpt['y'])
        await rp.wait_for_timeout(500)
        tip = await rp.evaluate("""(() => {
            const t = document.getElementById('remote-note-tip');
            return [getComputedStyle(t).display, t.innerHTML]; })()""")
        check(tip[0] == 'block', 'players peek with notes mode off too', tip[0])
        check('Sir Tim' in tip[1], 'the peek is attributed', tip[1][:120])
        check('Sentries' not in tip[1],
              "and never carries the GM's note for that cell", tip[1][:120])
        await rp.close()
        api('/api/notes', {'map': MAP, 'cell': '4,6', 'text': ''})

        print('\n16. No JS errors anywhere')
        errs = [e for e in errs if 'favicon' not in e and 'willReadFrequently' not in e]
        check(not errs, 'clean console on both pages', '; '.join(errs[:3]))

        await pj.screenshot(path='/tmp/session_projector.png')
        await gm.screenshot(path='/tmp/session_gm.png')
        await b.close()

    print()
    if fails:
        print(f'{len(fails)} FAILED:')
        for f in fails:
            print('  - ' + f)
        sys.exit(1)
    print('all session checks passed')


asyncio.run(main())
