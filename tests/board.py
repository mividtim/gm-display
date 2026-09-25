#!/usr/bin/env python3
"""
End-to-end test of the campaign bulletin board: one GM page and two remote
players (X-Forwarded-For makes the server treat them as tunnel visitors).

    python3 server.py --no-browser /path/to/scratch-vault   # in one shell
    python3 tests/board.py

Run it against a SCRATCH server, not the one you play on: it switches the
server's active campaign to the fresh browser's "default" campaign and writes
Map Notes/Boards/default.board.json. It also assumes a clean board.

Set GMD_H1 / GMD_H2 / GMD_MAP to vault images (/maps/... URLs) if the
Lady Blackbird art is not where it is in this repo.
"""
import asyncio, json, os, sys, urllib.error, urllib.request
from playwright.async_api import async_playwright

BASE = 'http://localhost:7680'
LB = '/maps/.tools/gm-display/lady-blackbird/'
H1 = os.environ.get('GMD_H1', LB + 'Snargle.png')
H2 = os.environ.get('GMD_H2', LB + 'LadyBlackbird.png')
MAP = os.environ.get('GMD_MAP', LB + 'The%20Wild%20Blue.png')
fails = []
def check(ok, what, saw=''):
    print(('  ok   ' if ok else '  FAIL ') + what + (f'   [{saw}]' if saw and not ok else ''))
    if not ok: fails.append(what)

def cmd(action, file):
    urllib.request.urlopen(urllib.request.Request(BASE + '/api/command',
        data=json.dumps({'action': action, 'file': file}).encode(), headers={'Content-Type': 'application/json'}))

def board(remote=False):
    h = {'X-Forwarded-For': '203.0.113.9'} if remote else {}
    with urllib.request.urlopen(urllib.request.Request(BASE + '/api/board', headers=h)) as r:
        return json.loads(r.read())

async def vis_dbl(page, host, hid):
    pt = await page.evaluate("""([host, hid]) => { const e=document.querySelector(host+' .bb-handout[data-id="'+hid+'"]');
        const r=e.getBoundingClientRect();
        for (let y=r.top+40;y<r.bottom-5;y+=8) for (let x=r.left+5;x<r.right-5;x+=8) {
          const t=document.elementFromPoint(x,y); if (t && t.closest('.bb-handout')===e && !t.closest('.bb-act')) return [x,y]; } return null; }""", [host, hid])
    await page.mouse.dblclick(pt[0], pt[1])

async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch()
        errs = []
        gmc = await br.new_context(viewport={'width': 1400, 'height': 900})
        gm = await gmc.new_page()
        gm.on('pageerror', lambda e: errs.append('gm: ' + str(e)))
        await gm.goto(BASE + '/gm.html'); await gm.wait_for_timeout(800)
        cmd('map', MAP); await gm.wait_for_timeout(1500)
        await gm.evaluate("""() => { document.getElementById('tok-name').value='Lady Blackbird';
            document.getElementById('tok-side').value='pc'; GMD.createTokenFromForm();
            document.getElementById('tok-name').value='Snargle';
            document.getElementById('tok-side').value='pc'; GMD.createTokenFromForm(); }""")
        await gm.evaluate(f"() => {{ GMD.addToImageLibrary('{H1}', 'Snargle'); GMD.addToImageLibrary('{H2}', 'Lady Blackbird'); }}")
        await gm.wait_for_timeout(600)
        check(await gm.locator('.lib-share').count() == 2, 'each handout card has a share pin')

        # Clicking a handout shows it to the GM but does not share it.
        await gm.locator('.map-lib-card[data-target="sidecar"]').first.click()
        await gm.wait_for_timeout(1200)
        b = board(True)
        check(b['board'] is not None and len(b['board']['handouts']) == 0, 'clicking a handout does not share it')
        check(await gm.locator('#handout-share-float').is_visible(), 'share button shows over an open handout')
        tools_fog_disabled = await gm.evaluate("() => document.querySelector('[data-tool=reveal]').disabled")
        check(tools_fog_disabled, 'reveal tool disabled on a handout')
        check(await gm.evaluate("() => GMD.S.handoutGridShow === false"), 'handout grid lines default off')
        check((await gm.locator('#tokgrid-status').text_content()) == 'OFF', 'grid toggle UI says OFF on handout')
        await gm.evaluate("() => document.getElementById('btn-tokgrid').click()"); await gm.wait_for_timeout(100)
        check(await gm.evaluate("() => GMD.S.handoutGridShow === true"), 'grid toggles on for this handout')
        # back to map then handout again — setting remembered per image
        await gm.locator('.map-lib-card[data-target="projector"]').first.click(); await gm.wait_for_timeout(1000)
        check((await gm.locator('#tokgrid-status').text_content()) == 'ON', 'map keeps its own grid setting (ON)')
        await gm.locator('.map-lib-card[data-target="sidecar"]').first.click(); await gm.wait_for_timeout(1000)
        check(await gm.evaluate("() => GMD.S.handoutGridShow === true"), 'handout grid choice persisted per image')
        await gm.evaluate("() => document.getElementById('btn-tokgrid').click()")

        # Explicit share.
        await gm.click('#handout-share-float'); await gm.wait_for_timeout(800)
        b = board(True)
        check(len(b['board']['handouts']) == 1, 'share button pins it to the board', b['board']['handouts'])
        def remote_status(path):
            try:
                return urllib.request.urlopen(urllib.request.Request(BASE + path, headers={'X-Forwarded-For': '1.1.1.1'})).status
            except urllib.error.HTTPError as e:
                return e.code
        pub = b['board']['handouts'][0]['src']
        check(pub.startswith('/a/') and remote_status(pub) == 200, 'shared handout reaches players at an opaque address', pub)
        check(remote_status(H1) == 404, 'players cannot fetch it by its filename')
        # share second through card pin
        await gm.locator('.lib-share').nth(1).click(); await gm.wait_for_timeout(800)
        b = board(True)
        check(len(b['board']['handouts']) == 2, 'card pin shares the second handout')
        check('module' not in b['board']['handouts'][0], 'module name not sent to players')
        # No filename anywhere a player's browser can see.
        def remote_json(path):
            with urllib.request.urlopen(urllib.request.Request(BASE + path, headers={'X-Forwarded-For': '1.1.1.1'})) as r:
                return r.read().decode()
        blob = remote_json('/api/board') + remote_json('/api/sync') + remote_json('/api/player_state')
        leaks = [w for w in ('Snargle.png', 'LadyBlackbird', 'Wild Blue', 'Wild%20Blue', '/maps/', 'Handouts', 'lady-blackbird') if w in blob]
        check(not leaks, 'no filenames or vault paths in anything players are sent', leaks)
        # The GM can give it a title; that is the only name players see.
        await gm.click('#btn-open-board'); await gm.wait_for_timeout(800)
        hid0 = b['board']['handouts'][0]['id']
        gm.once('dialog', lambda d: asyncio.ensure_future(d.accept('Agent Exeter')))
        await gm.locator(f'#board-shared-list [data-retitle="{hid0}"]').click(); await gm.wait_for_timeout(800)
        t = [h.get('title') for h in board(True)['board']['handouts'] if h['id'] == hid0]
        check(t == ['Agent Exeter'], 'GM title reaches players', t)
        await gm.locator('.map-lib-card[data-target="sidecar"]').first.click(); await gm.wait_for_timeout(600)

        # Two remote players.
        pages = []
        for name, char in (('Tim', 'Lady Blackbird'), ('Ada', 'Snargle')):
            c = await br.new_context(viewport={'width': 1200, 'height': 800}, extra_http_headers={'X-Forwarded-For': '203.0.113.9'})
            pg = await c.new_page()
            pg.on('pageerror', lambda e, n=name: errs.append(n + ': ' + str(e)))
            await pg.goto(BASE + '/remote.html'); await pg.wait_for_timeout(1200)
            await pg.fill('#remote-name', name)
            await pg.locator('.remote-card', has_text=char).click()
            await pg.wait_for_timeout(600)
            pages.append(pg)
        p1, p2 = pages
        check(await p1.locator('#remote-tool-board .rt-badge.on').count() == 1, 'board button shows a new-handout badge')
        await p1.click('#remote-tool-board'); await p2.click('#remote-tool-board')
        await p1.wait_for_timeout(800)
        check(await p1.locator('#remote-stage').is_hidden(), 'map stage hidden in board mode')
        check(await p1.locator('#remote-marker-btn').is_hidden(), 'map-only buttons hidden in board mode')
        n = await p1.locator('#remote-board .bb-handout').count()
        check(n == 2, 'player sees both handouts', n)

        # Drag a pin on p1 → p2 follows.
        pin = p1.locator('#remote-board .bb-pin').first
        bb = await pin.bounding_box()
        x0, y0 = bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2
        hid = await p1.evaluate(f"() => document.elementFromPoint({x0},{y0}).closest('.bb-pin').dataset.id")
        await p1.mouse.move(x0, y0); await p1.mouse.down()
        for i in range(10):
            await p1.mouse.move(x0 + 20 * (i + 1), y0 + 8 * (i + 1)); await p1.wait_for_timeout(30)
        await p1.mouse.up(); await p1.wait_for_timeout(800)
        pos1 = await p1.evaluate(f"() => {{ const e=document.querySelector('#remote-board .bb-handout[data-id=\"{hid}\"]'); return [e.style.left, e.style.top]; }}")
        pos2 = await p2.evaluate(f"() => {{ const e=document.querySelector('#remote-board .bb-handout[data-id=\"{hid}\"]'); return [e.style.left, e.style.top]; }}")
        check(pos1 == pos2 and pos1[0] != '-160px', 'moving a pin moves it for the other player', (pos1, pos2))
        top2 = await p2.evaluate("() => { const hs=[...document.querySelectorAll('#remote-board .bb-handout')]; return hs.sort((a,b)=>b.style.zIndex-a.style.zIndex)[0].dataset.id; }")
        check(top2 == hid, 'dragged handout came to the top')

        # Pan on p2 (dragging on a handout body) → p1's view follows; no raise.
        other = await p2.evaluate(f"() => [...document.querySelectorAll('#remote-board .bb-handout')].find(e=>e.dataset.id!=='{hid}').dataset.id")
        v0 = board(True)['board']['view']
        await p2.mouse.move(300, 500); await p2.mouse.down()
        for i in range(8): await p2.mouse.move(300 + 15 * i, 500 - 10 * i); await p2.wait_for_timeout(25)
        await p2.mouse.up(); await p2.wait_for_timeout(800)
        v1 = board(True)['board']['view']
        check(v1 != v0, 'panning changes the shared view', (v0, v1))
        t1 = await p1.evaluate("() => document.querySelector('#remote-board .bb-world').style.transform")
        t2 = await p2.evaluate("() => document.querySelector('#remote-board .bb-world').style.transform")
        # viewports same size so transforms should match
        check(t1 == t2, 'both players see the same pan', (t1, t2))

        # Click (press+release) on the partly-covered handout raises it.
        box = await p1.locator(f'#remote-board .bb-handout[data-id="{other}"]').bounding_box()
        # find a visible point of 'other' not covered
        pt = await p1.evaluate(f"""() => {{ const e=document.querySelector('#remote-board .bb-handout[data-id="{other}"]');
            const r=e.getBoundingClientRect();
            for (let y=r.top+30;y<r.bottom-5;y+=10) for (let x=r.left+5;x<r.right-5;x+=10) {{
              const t=document.elementFromPoint(x,y); if (t && t.closest('.bb-handout')===e) return [x,y]; }} return null; }}""")
        if pt:
            await p1.mouse.click(pt[0], pt[1]); await p1.wait_for_timeout(800)
            top = await p2.evaluate("() => { const hs=[...document.querySelectorAll('#remote-board .bb-handout')]; return hs.sort((a,b)=>b.style.zIndex-a.style.zIndex)[0].dataset.id; }")
            check(top == other, 'clicking a visible part of a lower handout brings it to the top')
        else:
            check(False, 'found a visible point on the lower handout')

        # Send to back via action button.
        await p1.locator(f'#remote-board .bb-handout[data-id="{other}"] .bb-act[title^="Send"]').click(force=True)
        await p1.wait_for_timeout(700)
        hs = board(True)['board']['handouts']
        zs = {h['id']: h['z'] for h in hs}
        check(zs[other] < zs[hid], 'send to bottom works', zs)

        # Yarn: drag the loose end hanging off one pin onto the other handout.
        # No mode to switch into.
        check(await p1.locator('#remote-board [data-bb="yarn"]').count() == 0, 'no yarn mode toggle')
        ta = await p1.locator(f'#remote-board .bb-tail[data-id="{hid}"]').bounding_box()
        pb = await p1.locator(f'#remote-board .bb-pin[data-id="{other}"]').bounding_box()
        sx, sy = ta['x'] + ta['width'] * 0.7, ta['y'] + ta['height'] * 0.85
        await p1.mouse.move(sx, sy); await p1.mouse.down()
        for i in range(1, 9):
            await p1.mouse.move(sx + (pb['x'] + 11 - sx) * i / 8, sy + (pb['y'] + 11 - sy) * i / 8)
            await p1.wait_for_timeout(20)
        await p1.mouse.up(); await p1.wait_for_timeout(800)
        y = board(True)['board']['yarn']
        check(len(y) == 1, 'yarn strung by dragging a pin tail', y)
        check(await p2.locator('#remote-board .bb-string').count() == 1, 'other player sees the yarn')
        pos_after_yarn = board(True)['board']['handouts']
        check(all(h['x'] == hh['x'] for h in hs for hh in pos_after_yarn if h['id'] == hh['id']), 'dragging the tail does not move the handout')
        # move handout and yarn redraws
        d_before = await p2.evaluate("() => document.querySelector('#remote-board .bb-string').getAttribute('d')")
        pa = await p1.locator(f'#remote-board .bb-pin[data-id="{other}"]').bounding_box()
        await p1.mouse.move(pa['x'] + 11, pa['y'] + 11); await p1.mouse.down()
        await p1.mouse.move(pa['x'] + 80, pa['y'] + 140, steps=6); await p1.mouse.up(); await p1.wait_for_timeout(800)
        d_after = await p2.evaluate("() => document.querySelector('#remote-board .bb-string').getAttribute('d')")
        check(d_before != d_after, 'yarn follows a moved handout on other screens')
        # Scissors near both ends: hidden until you are near the string.
        check(await p1.locator('#remote-board .bb-snip').count() == 2, 'a string has scissors at both ends')
        await p1.mouse.click(1150, 90); await p1.mouse.move(1150, 110); await p1.wait_for_timeout(300)   # empty cork: deselect
        check(await p1.locator('#remote-board .bb-snip.on').count() == 0, 'scissors hidden when not near the string')
        mid = await p1.evaluate("""() => { const p=document.querySelector('#remote-board .bb-string-hit');
            const L=p.getTotalLength(), q=p.getPointAtLength(L/2), m=p.getScreenCTM(); return [q.x*m.a+m.e, q.y*m.d+m.f]; }""")
        await p1.mouse.move(mid[0], mid[1]); await p1.wait_for_timeout(300)
        check(await p1.locator('#remote-board .bb-snip.on').count() == 2, 'hovering a string shows its scissors')
        await p1.locator('#remote-board .bb-snip.on').first.click(); await p1.wait_for_timeout(800)
        check(len(board(True)['board']['yarn']) == 0 and await p2.locator('#remote-board .bb-string').count() == 0, 'cut removes the yarn for everyone')

        # Full-screen for everyone, notes.
        await vis_dbl(p1, '#remote-board', hid); await p1.wait_for_timeout(800)
        check(await p2.locator('#remote-board .bb-modal').is_visible(), 'full-screen opens for everyone')
        await p1.fill('#remote-board .bb-pane textarea', 'This phone number matches the diary.')
        await p1.click('#remote-board .bb-note-save'); await p1.wait_for_timeout(900)
        txt = await p2.locator('#remote-board .bb-note').first.text_content()
        check('phone number' in txt and 'Tim' in txt and 'Lady Blackbird' in txt, 'note shows with player and character', txt)
        bubble = await p2.locator('#remote-board .bb-bubble').first.inner_text()
        check('Session of' in bubble, 'note info bubble shows the session date', bubble)
        check(await p2.locator('#remote-board [data-nedit]').count() == 0, "a player can't edit someone else's note")
        # side by side
        await p2.click('#remote-board .bb-modal-side'); await p2.click('#remote-board .bb-pick'); await p2.wait_for_timeout(800)
        check(await p1.locator('#remote-board .bb-pane').count() == 2, 'side-by-side shows for everyone')
        await p2.click('#remote-board .bb-modal-close'); await p2.wait_for_timeout(800)
        check(await p1.locator('#remote-board .bb-modal').is_hidden(), 'closing full-screen closes it for everyone')

        # GM works the board, notes signed as The Handler.
        await gm.click('#btn-open-board'); await gm.wait_for_timeout(1000)
        check(await gm.locator('#gm-board .bb-handout').count() == 2, 'GM sees the board')
        await vis_dbl(gm, '#gm-board', hid); await gm.wait_for_timeout(700)
        await gm.fill('#gm-board .bb-pane textarea', 'Handler here.')
        await gm.click('#gm-board .bb-note-save'); await gm.wait_for_timeout(900)
        txt = await p1.locator('#remote-board .bb-note.gm').first.text_content()
        check('The Handler' in txt, 'GM note signed as The Handler', txt)
        await gm.keyboard.press('Escape'); await gm.wait_for_timeout(600)
        check(await p1.locator('#remote-board .bb-modal').is_hidden(), 'GM Esc closes the full-screen for all')
        check(await gm.evaluate("() => GMD.S.currentMode") == 'board', 'Esc did not throw GM out of the board')

        # Yarn colour
        await gm.evaluate("() => { const i=document.getElementById('board-yarn-color'); i.value='#2255ff'; i.dispatchEvent(new Event('change')); }")
        await gm.wait_for_timeout(800)
        col = await p1.evaluate("() => getComputedStyle(document.querySelector('#remote-board')).getPropertyValue('--bb-yarn').trim()")
        check(col == '#2255ff', 'GM yarn colour reaches players', col)

        # Unshare → gone for players and image no longer served
        await gm.evaluate(f"() => GMD.S.lastShowSrc")
        await gm.locator('#board-shared-list [data-unshare]').first.click(); await gm.wait_for_timeout(900)
        check(await p1.locator('#remote-board .bb-handout').count() == 1, 'unsharing removes it from players')
        check(await gm.locator('#gm-board .bb-handout').count() == 1, 'unsharing removes it from the GM board too')
        # modal screenshot, notes view
        await vis_dbl(p1, '#remote-board', (await p1.locator('#remote-board .bb-handout').first.get_attribute('data-id')))
        await p1.wait_for_timeout(700)
        await p1.locator('#remote-board .bb-info').first.hover()
        await p1.screenshot(path='/tmp/gmd-board-modal.png')
        await p1.click('#remote-board .bb-modal-close'); await p1.wait_for_timeout(500)
        # remote forbidden ops
        req = urllib.request.Request(BASE + '/api/board/op', data=json.dumps({'op': 'settings', 'yarnColor': '#000000'}).encode(),
                                     headers={'X-Forwarded-For': '1.1.1.1'})
        try: urllib.request.urlopen(req); code = 200
        except urllib.error.HTTPError as e: code = e.code
        check(code == 403, 'players cannot change GM settings', code)

        await p1.screenshot(path='/tmp/gmd-board-p1.png')
        await gm.screenshot(path='/tmp/gmd-board-gm.png')
        # Post-it stack shows the note count.
        stack = await p1.locator('#remote-board .bb-notes-stack .bb-postit-n').all_text_contents()
        check('2' in stack, 'post-it stack shows how many notes', stack)
        # Cut-out: a handout on a flat background gets its background removed.
        cut = await p1.evaluate("() => [...document.querySelectorAll('#remote-board .bb-handout.cutout')].length")
        print('   (cut-out handouts on the board: %d)' % cut)
        check(await p1.locator('#remote-board .bb-act[title^="Take this off"]').count() == 0, 'players have no un-share ✕')
        check(not errs, 'no page errors', errs)
        await br.close()
    print('\n%d failures' % len(fails)); sys.exit(1 if fails else 0)

asyncio.run(main())
