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

        print('\n8. No JS errors anywhere')
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
