#!/usr/bin/env python3
"""
Regression harness for GM Display.

Captures observable behaviour of the app as a JSON snapshot so a refactor can be
verified by diffing, rather than by hoping. Probes internal functions directly
(they are the things a module split can silently break) as well as driving real
clicks, and records the exact shapes of the messages the GM page emits to the
projector and to the server.

    python3 regress.py baseline.json          # capture
    python3 regress.py after.json baseline.json  # capture + diff
"""
import asyncio, json, sys, urllib.request, urllib.error, math
from playwright.async_api import async_playwright

BASE = 'http://localhost:7680'
MAP = '/maps/Maps/printed-grid.png'      # 1000x700, printed grid cell 53.3 offset (17,9)
HEXMAP = '/maps/Maps/realm-sheet.png'    # 2560x3400, flat-top 188.25 x 209.2 at (271,256.6)


def cmd(action, file):
    urllib.request.urlopen(urllib.request.Request(
        BASE + '/api/command',
        data=json.dumps({'action': action, 'file': file}).encode(),
        headers={'Content-Type': 'application/json'}))


def status_of(path):
    """HTTP status for a path, without going through a browser tab — a 404
    fetched in the page would write a console error and blunt errors.gm."""
    try:
        with urllib.request.urlopen(BASE + path) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 'unreachable'


async def load_map(pg, path, wait=2600):
    cmd('map', path)
    await pg.wait_for_timeout(wait)


# The app no longer publishes anything onto window — bindings.js wires the
# markup from modules, and main.js exposes a single `window.GMD` handle. This
# harness is a white-box test, so it installs its own convenience globals rather
# than making the application carry them.
TEST_SHIM = """
  Object.assign(window, window.GMD);
  for (const k of Object.keys(window.GMD.S)) {
    if (k in window) continue;
    Object.defineProperty(window, k, {
      get: () => window.GMD.S[k], set: (v) => { window.GMD.S[k] = v; }, configurable: true });
  }
  'ok'
"""


async def install_shim(pg):
    return await pg.evaluate(TEST_SHIM)


async def capture(pg, results):
    """Record everything. Each entry must be deterministic."""
    def put(k, v): results[k] = v

    await install_shim(pg)

    # --- role branching -----------------------------------------------------
    put('role.gm', await pg.evaluate("[typeof isPlayerView, isPlayerView === false, isRemoteView === false]"))

    # --- map loaded ---------------------------------------------------------
    put('map.dims', await pg.evaluate("[mapWidth, mapHeight]"))
    put('map.mode', await pg.evaluate("[currentMode, fogContext]"))
    put('map.relsrc', await pg.evaluate("relMapSrc(lastMapSrc)"))

    # --- grid / key geometry ------------------------------------------------
    await pg.evaluate("setKeyShape('square'); resetMapKey(); setKeyCell(53.3); setKeyOx(17); setKeyOy(9);")
    await pg.wait_for_timeout(250)
    put('key.square.steps', await pg.evaluate("[+kStepX(mapWidth).toFixed(4), +kStepY(mapWidth).toFixed(4)]"))
    put('key.square.snap', await pg.evaluate("""
        [[0.10,0.10],[0.5,0.5],[0.93,0.87]].map(([x,y])=>{const s=snapNorm(x,y);
          return [+(s.tx*mapWidth).toFixed(3), +(s.ty*mapHeight).toFixed(3)];})"""))
    put('key.square.cellidx', await pg.evaluate("""
        [[200,200],[17,9],[999,699]].map(([x,y])=>{const c=cellAtMapPx(x,y);
          const k=cellCenterMapPx(c); return [c.col,c.row,+k.x.toFixed(3),+k.y.toFixed(3)];})"""))
    put('key.square.fingerprint', await pg.evaluate("""(()=>{
        let sx=0, sy=0, cells=0;
        for(let i=0;i<2000;i++){
          const tx=((i*7919)%10007)/10007, ty=((i*104729)%10009)/10009;
          const s=snapNorm(tx,ty); sx+=s.tx; sy+=s.ty;
          const c=cellAtMapPx(tx*mapWidth, ty*mapHeight); cells += c.col*31+c.row*17;
        }
        return [+sx.toFixed(9), +sy.toFixed(9), cells];})()"""))

    for shape in ('hex', 'hexflat'):
        await pg.evaluate(f"setKeyShape('{shape}')")
        await pg.wait_for_timeout(120)
        put(f'key.{shape}.steps', await pg.evaluate("[+kStepX(mapWidth).toFixed(4), +kStepY(mapWidth).toFixed(4)]"))
        put(f'key.{shape}.snap', await pg.evaluate("""
            [[0.2,0.2],[0.45,0.66],[0.8,0.3]].map(([x,y])=>{const s=snapNorm(x,y);
              return [+(s.tx*mapWidth).toFixed(3), +(s.ty*mapHeight).toFixed(3)];})"""))
        put(f'key.{shape}.roundtrip', await pg.evaluate("""(()=>{let worst=0;
            for(let i=0;i<400;i++){const mx=(i*37%1000), my=(i*53%700);
              const c=cellCenterMapPx(cellAtMapPx(mx,my));
              const c2=cellCenterMapPx(cellAtMapPx(c.x,c.y));
              worst=Math.max(worst,Math.hypot(c.x-c2.x,c.y-c2.y));}
            return +worst.toFixed(6);})()"""))
        put(f'key.{shape}.fingerprint', await pg.evaluate("""(()=>{
            // 2000 deterministic points; sum snapped centres at full precision
            let sx=0, sy=0, cells=0;
            for(let i=0;i<2000;i++){
              const tx=((i*7919)%10007)/10007, ty=((i*104729)%10009)/10009;
              const s=snapNorm(tx,ty); sx+=s.tx; sy+=s.ty;
              const c=cellAtMapPx(tx*mapWidth, ty*mapHeight);
              cells += (c.col!==undefined) ? (c.col*31+c.row*17) : (c.q*31+c.r*17);
            }
            return [+sx.toFixed(9), +sy.toFixed(9), cells];})()"""))

    # anisotropic hex: the whole point of the calibration work
    await pg.evaluate("""setKeyShape('hexflat');
        document.getElementById('key-link').checked=false; toggleKeyLink();
        setKeyCell(188.25); setKeyCellY(209.2); setKeyOx(271); setKeyOy(256.6);""")
    await pg.wait_for_timeout(200)
    put('key.aniso.steps', await pg.evaluate("[+kStepX(2560).toFixed(4), +kStepY(2560).toFixed(4)]"))
    put('key.aniso.centres', await pg.evaluate("""
        [[1,1],[2,1],[12,12],[7,4]].map(([col,row])=>{
          const c=cellCenterMapPx(cellAtMapPx(271+(col-1)*188.25,
                  256.6+(row-1)*209.2+(col%2===0?209.2/2:0), 2560, 3400), 2560, 3400);
          return [+c.x.toFixed(2), +c.y.toFixed(2)];})"""))
    put('key.aspect.note', await pg.evaluate("document.getElementById('key-aspect-note').textContent"))
    await pg.evaluate("resetMapKey(); setKeyShape('square'); setKeyCell(53.3); setKeyOx(17); setKeyOy(9);")
    await pg.wait_for_timeout(200)

    # --- cell notes ---------------------------------------------------------
    # Labels must round-trip through the axial form, or a note saved on one hex
    # comes back attached to a different one.
    put('notes.labels.square', await pg.evaluate("""(()=>{
        const G=window.GMD; const out=[];
        for (const [r,c] of [[1,1],[4,6],[13,19]]) {
          const cell=G.cellFromLabel(r+','+c);
          out.push([r+','+c, G.cellLabel(cell)]);
        } return out;})()"""))
    put('notes.labels.hex', await pg.evaluate("""(()=>{
        const G=window.GMD; const before=[G.S.tokenGridType];
        G.setKeyShape('hexflat');
        const out=[];
        for (const [r,c] of [[1,1],[1,2],[5,5],[11,3],[12,12]]) {
          out.push([r+','+c, G.cellLabel(G.cellFromLabel(r+','+c))]);
        }
        G.setKeyShape('square');
        return out;})()"""))
    # A map may ship its calibration beside its notes; a local adjustment must
    # still win, and the first map load must not stamp over the shipped one.
    put('notes.shippedkey', await pg.evaluate("""(async () => {
        const r = await fetch('/api/mapkey?map=' + encodeURIComponent('/maps/__nokey__.png'));
        const d = await r.json();
        return [d.key, typeof window.GMD.S.keyCellPx];
      })()"""))
    put('notes.api', await pg.evaluate("""(async () => {
        const map = '/maps/__harness__.png';
        await fetch('/api/notes', {method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({map, cell:'3,4', text:'harness probe'})});
        const a = await (await fetch('/api/notes?map=' + encodeURIComponent(map))).json();
        await fetch('/api/notes', {method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({map, cell:'3,4', text:''})});
        const b = await (await fetch('/api/notes?map=' + encodeURIComponent(map))).json();
        return [a.cells['3,4'] || null, a.count, b.count];
      })()"""))

    # --- party notes --------------------------------------------------------
    # The players' half of the map. Separate file from the GM's notes, one entry
    # per author per cell, and writing again replaces only your own line.
    put('party.api', await pg.evaluate("""(async () => {
        const map = '/maps/__harness__.png';
        const post = (cell, text, by) => fetch('/api/partynotes', {method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({map, cell, text, by})});
        const get = async () => (await (await fetch('/api/partynotes?map='
          + encodeURIComponent(map), {cache:'no-store'})).json()).cells;
        await post('2,3', 'first', 'Ayla');
        await post('2,3', 'second', 'Bors');
        const both = await get();
        await post('2,3', 'revised', 'Ayla');     // replaces only Ayla's line
        const revised = await get();
        await post('2,3', '', 'Ayla');            // empty removes yours
        await post('2,3', '', 'Bors');            // ...and the cell with it
        const empty = await get();
        return [both['2,3'], revised['2,3'], empty['2,3'] || null];
      })()"""))
    # The GM's notes are the GM's: a player must never be able to write them.
    # (Same origin here, so this only proves the endpoint shape; the remote
    # rejection is enforced by is_remote() on X-Forwarded-For.)
    put('party.separate.files', await pg.evaluate("""(async () => {
        const map = '/maps/__harness__.png';
        const n = await (await fetch('/api/notes?map=' + encodeURIComponent(map))).json();
        const p = await (await fetch('/api/partynotes?map=' + encodeURIComponent(map))).json();
        return [n.file.endsWith('__harness__.png.md'), 'file' in p, Object.keys(p.cells).length];
      })()"""))
    put('party.module', await pg.evaluate("""(()=>{
        const G = window.GMD;
        return [typeof G.partyNotes, typeof G.partyNotesFor, typeof G.savePartyNote,
                typeof G.setPartyNotesMap, typeof G.partyCount,
                Array.isArray(G.partyNotesFor('nope'))];})()"""))

    # --- legend -------------------------------------------------------------
    # What the symbols mean. Markdown in the vault, parsed server-side into
    # groups of entries, rendered identically on all three surfaces.
    put('legend.start', await pg.evaluate("""(async () => {
        const map = '/maps/__harness__.png';
        const r = await fetch('/api/legend/start', {method:'POST',
          headers:{'Content-Type':'application/json'}, body: JSON.stringify({map})});
        const d = await r.json();
        const g = await (await fetch('/api/legend?map=' + encodeURIComponent(map),
          {cache:'no-store'})).json();
        return [d.ok === true, d.file.endsWith('__harness__.png.legend.md'),
                g.groups.map(x => [x.title, x.entries.length]), g.count];
      })()"""))
    # The shapes a legend line can take: swatch or not, name or not, gloss or
    # not. Get this wrong and an entry silently disappears from the panel.
    put('legend.parse', await pg.evaluate("""(async () => {
        const map = '/maps/__parse__.png';
        const g = await (await fetch('/api/legend?map=' + encodeURIComponent(map),
          {cache:'no-store'})).json();
        return g.groups;
      })()"""))
    # Point the module at the fixture, then read what it would draw. Rows,
    # group headings, and how many entries have no swatch.
    await pg.evaluate("window.GMD.setLegendMap('/maps/__parse__.png')")
    await pg.wait_for_timeout(700)
    put('legend.render', await pg.evaluate("""(()=>{
        const html = window.GMD.legendHTML();
        return [(html.match(/lg-row/g)||[]).length, (html.match(/lg-group/g)||[]).length,
                (html.match(/lg-icon-none/g)||[]).length, window.GMD.legendCount()];})()"""))
    # A gloss carrying markup must arrive as text. The legend is the one place
    # the app puts vault content into innerHTML, on all three surfaces.
    put('legend.escapes', await pg.evaluate("""(()=>{
        const html = window.GMD.legendHTML();
        return [/<img/i.test(html), html.includes('&lt;img'),
                html.includes('markup must stay text')];})()"""))
    await pg.evaluate("window.GMD.setLegendMap(relMapSrc(lastMapSrc))")
    await pg.wait_for_timeout(300)

    # --- realm.html is retired ----------------------------------------------
    # It was a whole second app for one map: its own hex geometry, note store
    # and token code. All of that is general now, so the page is gone — but a
    # bookmark, a gm:// link or a projector window left open from last session
    # must still land somewhere sensible rather than on a 404.
    put('realm.retired', await pg.evaluate("""(async () => {
        const out = [];
        for (const p of ['/realm.html', '/realm_player.html', '/realm_data.json']) {
          const r = await fetch(p, {redirect: 'follow'});
          out.push([p, r.redirected, new URL(r.url).pathname]);
        }
        return out;
      })()"""))
    # The retired API is checked from Python, not the page: a 404 fetched in the
    # browser writes a console error, and errors.gm must stay a real signal.
    put('realm.api.gone', [status_of('/api/realm/state'), status_of('/api/realm/')])

    # --- persistence keys ---------------------------------------------------
    put('storage.keys', await pg.evaluate("""[
        gameKey('state'), gameKey('library'), gameKey('crop:X'), gameKey('bg:X'),
        gameKey('key:X'), campaignKey('roster'), mapTokensKey('X'), mapKeyStorageKey('X')]"""))
    put('storage.mapkey.saved', await pg.evaluate(
        "JSON.parse(localStorage.getItem(mapKeyStorageKey(lastMapSrc)))"))

    # --- fog ----------------------------------------------------------------
    put('fog.mask.len', await pg.evaluate("fogMask ? fogMask.length : null"))
    put('fog.rle.roundtrip', await pg.evaluate("""(()=>{
        const a=new Uint8Array(500); for(let i=0;i<500;i++) a[i]= (i%7<3)?255:0;
        const enc=rlEncode(a), dec=rlDecode(enc,500);
        let same=dec.length===a.length; for(let i=0;i<500&&same;i++) same = dec[i]===a[i];
        return [same, enc.length];})()"""))
    put('fog.presets', await pg.evaluate("fogPresets.map(p=>p.name)"))

    # --- crop ---------------------------------------------------------------
    await pg.evaluate("""
        document.getElementById('crop-zoom').value = 200;
        document.getElementById('crop-hpos').value = 30;
        document.getElementById('crop-vpos').value = 70;
        updateCrop();""")
    await pg.wait_for_timeout(200)
    put('crop.viewport', await pg.evaluate(
        "viewportCrop ? [+viewportCrop.x.toFixed(2),+viewportCrop.y.toFixed(2),"
        "+viewportCrop.w.toFixed(2),+viewportCrop.h.toFixed(2)] : null"))
    put('crop.overlap', await pg.evaluate("""(()=>{const o=computeCropOverlap({x:-50,y:20,w:400,h:300},1000,700);
        return [o.srcX,o.srcY,+o.srcW.toFixed(1),+o.srcH.toFixed(1),o.dstX,o.dstY];})()"""))
    await pg.evaluate("cropFit();")
    await pg.wait_for_timeout(200)

    # --- tokens -------------------------------------------------------------
    await pg.evaluate("tokens=[]; roster=[];")
    await pg.fill('#tok-name', 'Alpha')
    await pg.evaluate("createTokenFromForm()")
    await pg.wait_for_timeout(200)
    await pg.evaluate("duplicateToken(tokens[0].id)")
    await pg.wait_for_timeout(200)
    put('tokens.after.create', await pg.evaluate("""tokens.map(t=>{
        const c=cellAtMapPx(t.tx*mapWidth, t.ty*mapHeight);
        return [t.base, t.num, +(t.tx*mapWidth).toFixed(3), +(t.ty*mapHeight).toFixed(3), c.col, c.row];})"""))
    put('tokens.displayname', await pg.evaluate("tokens.map(tokenDisplayName)"))
    put('tokens.propose', await pg.evaluate("""(()=>{
        const t=tokens[0]; applyPlayerAction({kind:'propose', tokenId:t.id, player:'P', tx:0.31, ty:0.62});
        const p=t.pending; return p ? [+(p.tx*mapWidth).toFixed(2), +(p.ty*mapHeight).toFixed(2), p.by] : null;})()"""))
    await pg.evaluate("approveMove(tokens[0].id)")
    await pg.wait_for_timeout(150)
    put('tokens.after.approve', await pg.evaluate(
        "[+(tokens[0].tx*mapWidth).toFixed(2), +(tokens[0].ty*mapHeight).toFixed(2), tokens[0].pending]"))

    # duplicate again on a NON-square cell, where the two axes actually differ
    await pg.evaluate("""
        document.getElementById('key-link').checked=false; toggleKeyLink();
        setKeyCell(53.3); setKeyCellY(31.7);
        tokens=[]; roster=[];""")
    await pg.wait_for_timeout(200)
    await pg.fill('#tok-name', 'Beta')
    await pg.evaluate("createTokenFromForm()")
    await pg.wait_for_timeout(150)
    await pg.evaluate("duplicateToken(tokens[0].id)")
    await pg.wait_for_timeout(200)
    put('tokens.anisotropic.dup', await pg.evaluate("""tokens.map(t=>{
        const c=cellAtMapPx(t.tx*mapWidth, t.ty*mapHeight);
        return [t.num, +(t.tx*mapWidth).toFixed(3), +(t.ty*mapHeight).toFixed(3), c.col, c.row];})"""))
    await pg.evaluate("document.getElementById('key-link').checked=true; toggleKeyLink(); setKeyCell(53.3);")
    await pg.wait_for_timeout(150)

    # --- the Company ---------------------------------------------------------
    # The party as one piece: exactly one per campaign, on every map, owned by
    # nobody so anyone at the table may propose its move.
    await pg.evaluate("tokens=[]; roster=[];")
    await pg.evaluate("addCompanyToken(); addCompanyToken();")   # twice: still one
    await pg.wait_for_timeout(250)
    put('company.create', await pg.evaluate("""(()=>{
        const c = roster.filter(t=>t.side==='party');
        const t = c[0];
        return [c.length, tokens.filter(x=>x.side==='party').length,
                t.base, t.side, t.onMap, t.owner, t.color];})()"""))
    put('company.no.duplicate', await pg.evaluate("""(()=>{
        const t = tokens.find(x=>x.side==='party');
        duplicateToken(t.id);
        return roster.filter(x=>x.side==='party').length;})()"""))
    # 'party' must survive the roster round-trip. The old save normalised any
    # non-'pc' side to 'npc', which would silently demote the Company on reload.
    put('company.persists', await pg.evaluate("""(()=>{
        const raw = localStorage.getItem(campaignKey('roster'));
        const sides = JSON.parse(raw).roster.map(t=>t.side).sort();
        return sides;})()"""))
    # Anyone may move it — it is not one player's piece to hold.
    put('company.anyone.proposes', await pg.evaluate("""(()=>{
        const t = tokens.find(x=>x.side==='party');
        const a = applyPlayerAction({kind:'propose', tokenId:t.id, player:'Ayla', tx:0.31, ty:0.62});
        const first = t.pending && t.pending.by;
        const b = applyPlayerAction({kind:'propose', tokenId:t.id, player:'Bors', tx:0.44, ty:0.28});
        return [a, first, b, t.pending && t.pending.by];})()"""))
    # And it draws bigger than a figure — it is a group, and it must read as one
    # across a lit room.
    put('company.size', await pg.evaluate("""(()=>{
        const G=window.GMD, t=tokens.find(x=>x.side==='party'), pc=tokens.find(x=>x.side!=='party');
        return [G.tokenFrac(t), pc ? G.tokenFrac(pc) : G.TOKEN_FRAC,
                G.tokenClass(t), G.tokenClass({side:'pc'}), G.tokenClass({side:'npc'})];})()"""))
    # Where it is standing, in row,col — the fact you actually read off the list.
    put('company.cellhere', await pg.evaluate("""(()=>{
        const G=window.GMD, t=tokens.find(x=>x.side==='party');
        const out=[];
        for (const lab of ['1,1','4,6','9,13']) {
          const m=G.cellCenterMapPx(G.cellFromLabel(lab), mapWidth, mapHeight);
          const s=G.snapNorm(m.x/mapWidth, m.y/mapHeight);
          t.tx=s.tx; t.ty=s.ty;
          out.push([lab, G.cellHere(t)]);
        }
        return out;})()"""))
    await pg.evaluate("tokens=[]; roster=[]; localStorage.removeItem(campaignKey('roster'));")
    await pg.wait_for_timeout(150)

    # --- outbound wire shapes ------------------------------------------------
    put('wire.grid', await pg.evaluate("gridWirePayload()"))
    put('wire.broadcast', await pg.evaluate("""(()=>{
        const sent=[]; const orig=mapChannel.postMessage.bind(mapChannel);
        mapChannel.postMessage=(m)=>{sent.push(m); orig(m);};
        broadcastTokens(); sendProjectionSettings();
        mapChannel.postMessage=orig;
        return sent.map(m=>[m.type, Object.keys(m).sort()]);})()"""))
    put('wire.playerstate.keys', await pg.evaluate("""(()=>{
        const seen=[]; const of=window.fetch;
        window.fetch=(u,o)=>{ if(String(u).startsWith('/api/')) seen.push([String(u), o&&o.body?Object.keys(JSON.parse(o.body)).sort():null]);
                              return Promise.resolve(new Response('{}')); };
        pushTokensToServer(); pushPlayerStateToServer();
        return new Promise(r=>setTimeout(()=>{window.fetch=of;
          r(seen.filter(x=>x[1]).sort((a,b)=>a[0]<b[0]?-1:1));}, 300));})()"""))

    # --- projection ---------------------------------------------------------
    put('projection.corners', await pg.evaluate("JSON.parse(JSON.stringify(corners))"))
    put('projection.scale', await pg.evaluate("projScale"))

    # --- library ------------------------------------------------------------
    put('library.entries', await pg.evaluate("mapLibrary.map(e=>relMapSrc(e.src))"))

    # --- sidebar surface ----------------------------------------------------
    put('ui.panels', await pg.evaluate(
        "Array.from(document.querySelectorAll('.sb-section > summary')).map(s=>s.textContent.trim())"))
    put('ui.controls', await pg.evaluate("""
        Array.from(document.querySelectorAll('#sidebar [id]')).map(e=>e.id).sort()"""))
    # Every function named by an inline handler must actually resolve. Checking
    # that control ids still exist is not enough — a module split can leave the
    # markup intact while every handler quietly stops being reachable.
    # Inline handlers are gone; what matters now is that every generated
    # binding found its element and the count has not silently dropped.
    put('ui.bindings', await pg.evaluate(
        "[window.GMD.boundCount(), window.GMD.unboundSelectors()]"))
    put('ui.inline_left', await pg.evaluate(
        "document.querySelectorAll('[onclick],[oninput],[onchange],[ondblclick]').length"))



async def run(out_path):
    results = {}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1600, 'height': 1000})

        # --- GM page ---
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
        pg.on('console', lambda m: errs.append('console: ' + m.text) if m.type == 'error' else None)
        await pg.goto(BASE + '/gm.html')
        await pg.wait_for_timeout(1400)
        await load_map(pg, MAP)
        await capture(pg, results)
        results['errors.gm'] = [e for e in errs if 'favicon' not in e]
        await pg.close()

        # --- projector + sidecar + remote load clean ---
        for label, url in [('projector', '/display.html?display=map'),
                           ('sidecar',   '/display.html?display=show'),
                           ('remote',    '/remote.html'),
                           ('legacy-gm', '/gm_display.html')]:
            p2 = await ctx.new_page(); e2 = []
            p2.on('pageerror', lambda e, E=e2: E.append('pageerror: ' + str(e)))
            p2.on('console', lambda m, E=e2: E.append('console: ' + m.text) if m.type == 'error' else None)
            await p2.goto(BASE + url)
            await p2.wait_for_timeout(2000)
            results[f'errors.{label}'] = [x for x in e2 if 'favicon' not in x]
            results[f'role.{label}'] = await p2.evaluate(
                "[window.GMD.S.isPlayerView, window.GMD.S.isRemoteView, window.GMD.S.playerDisplay || null]")
            if label == 'remote':
                # A player who has not picked a character yet must see the join
                # screen and nothing else. The play stage and the bottom bar
                # used to be hidden by inline styles; when those were stripped
                # in the module refactor they covered the roster and the page
                # still "loaded clean", so screen state is now a probe.
                results['remote.screens'] = await p2.evaluate("""(()=>{
                    const d = id => getComputedStyle(document.getElementById(id)).display;
                    return [d('remote-view'), d('remote-select'), d('remote-stage'),
                            d('remote-bar'), d('remote-note-panel'),
                            d('remote-legend-panel')];})()""")
                results['remote.notes.controls'] = await p2.evaluate("""(()=>{
                    const c = document.getElementById('remote-note-canvas');
                    return [!!document.getElementById('remote-notes-btn'), !!c,
                            c.classList.contains('armed'),
                            getComputedStyle(c).pointerEvents];})()""")
            if label == 'projector':
                # The projector card shrinks its own type until every entry
                # fits. Nobody can scroll a wall, so a legend that overflows
                # is not "mostly shown" — the rest never reaches the table.
                results['legend.projector.fit'] = await p2.evaluate("""(()=>{
                    const box = document.getElementById('player-legend');
                    if (!box) return 'no box';
                    let rows = '';
                    for (let i = 0; i < 40; i++)
                      rows += '<div class="lg-row"><span class="lg-icon"></span>'
                            + '<span class="lg-text"><b>Entry ' + i + '</b>'
                            + ' — a gloss of roughly the usual length</span></div>';
                    box.innerHTML = rows;
                    box.style.display = 'block';
                    const scale = window.GMD.fitLegendBox(box);
                    const over = [box.scrollHeight - box.clientHeight,
                                  box.scrollWidth - box.clientWidth];
                    box.style.display = 'none'; box.innerHTML = '';
                    return [scale < 1, over[0] <= 1, over[1] <= 1];})()""")
            await p2.close()
        await b.close()

    with open(out_path, 'w') as f:
        json.dump(results, f, indent=1, sort_keys=True)
    return results


def diff(new, old):
    bad = []
    for k in sorted(set(new) | set(old)):
        a, b = old.get(k, '<missing>'), new.get(k, '<missing>')
        if json.dumps(a, sort_keys=True) != json.dumps(b, sort_keys=True):
            bad.append((k, a, b))
    return bad


if __name__ == '__main__':
    out = sys.argv[1]
    res = asyncio.run(run(out))
    nerr = sum(len(v) for k, v in res.items() if k.startswith('errors.'))
    print(f'captured {len(res)} probes -> {out}   js errors: {nerr}')
    if len(sys.argv) > 2:
        old = json.load(open(sys.argv[2]))
        bad = diff(res, old)
        if not bad:
            print('IDENTICAL to', sys.argv[2])
        else:
            print(f'\n{len(bad)} DIFFERENCE(S) vs {sys.argv[2]}:')
            for k, a, b in bad:
                print(f'\n  {k}\n    was: {json.dumps(a)[:300]}\n    now: {json.dumps(b)[:300]}')
            sys.exit(1)
