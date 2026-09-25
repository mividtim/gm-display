// The party log, on both pages, driven through the real modules in a real DOM.
//
// Not a browser — jsdom — so this asserts wiring and rendering rather than
// pixels: that the button toggles the panel, that the rows come out in the
// order the notes were written, that a player's text cannot inject markup,
// and that a row takes you back to its cell. tests/session.py is still the
// one that proves it against a real canvas.
//
//     python3 tests/party-log.py        # starts the fixture server, runs this
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

const BASE = process.env.PARTY_LOG_BASE || 'http://127.0.0.1:8913';
const MAP = '/maps/Realm.png';

let fail = 0;
const check = (ok, what, detail = '') => {
  if (!ok) fail++;
  console.log((ok ? '  ok   ' : '  BAD  ') + what + (!ok && detail ? '\n         ' + detail : ''));
};

// The real player page, minus its module script (we import the modules here),
// plus the one GM control this file also exercises.
const remoteHtml = readFileSync(new URL('../remote.html', import.meta.url), 'utf8')
  .replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(remoteHtml.replace('</body>',
  '<button id="btn-party-log"></button>'
  + '<div id="party-log" class="party-log" style="display:none;"></div></body>'),
  { url: BASE });

// jsdom ships no canvas. The pips are drawn on one and this file is not about
// pixels, so hand out a context that accepts every call and remembers nothing.
// Without it the party-notes listener throws before it reaches the panel.
const NOOP_CTX = new Proxy({}, {
  get: (t, k) => (k in t ? t[k]
    : (t[k] = typeof k === 'string' && /^(canvas)$/.test(k) ? null : () => NOOP_CTX)),
  set: () => true,
});
dom.window.HTMLCanvasElement.prototype.getContext = () => NOOP_CTX;

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.localStorage = dom.window.localStorage;
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(String(u).startsWith('http') ? u : BASE + u, o);

const PN = await import('../js/party-notes.js');
const { S } = await import('../js/store.js');

PN.setPartyNotesMap(MAP);
await new Promise(r => setTimeout(r, 250));
await PN.loadPartyNotes(true);

console.log('\n1. The order is the order they were written');
const log = PN.partyLog();
log.forEach(e => console.log(`     ${(e.at || '(undated)').padEnd(17)} ${e.cell.padEnd(5)} ${e.by}: ${e.text}`));
const dated = log.filter(e => e.at).map(e => e.at);
check(dated.length > 1, 'the fixture has something to order', String(dated.length));
check(dated.every((v, i) => i === 0 || dated[i - 1] <= v),
      'entries run oldest to newest across cells', JSON.stringify(dated));
check(log.findIndex(e => e.at) > log.map(e => !e.at).lastIndexOf(true),
      'undated entries come first — they predate anything dated');
const seen = new Set(log.map(e => e.cell + '|' + e.by));
check(seen.size === log.length, 'no entry appears twice');

console.log('\n2. What a row shows');
const html = PN.partyLogHTML();
check(/pl-time">\d{2}:\d{2}</.test(html), 'the time it was written');
check(html.includes('data-cell='), 'the cell, as a link back to the map');
check(html.includes('pl-day'), 'a date heading over each day');
check(html.includes('Before times were kept'),
      'and undated entries say so rather than borrowing a time');
check(html.includes('· edited'), 'an entry changed later is marked edited');

console.log('\n3. A note is player-typed text on a shared screen');
await PN.savePartyNote('5,5', '<img src=x onerror=alert(1)> & "q"', 'Knyan');
await PN.loadPartyNotes(true);
const evil = PN.partyLogHTML();
check(!evil.includes('<img src=x'), 'markup in a note is escaped');
check(evil.includes('&lt;img'), 'and shown as text');
const box = document.getElementById('party-log');
box.innerHTML = evil;
check(box.querySelectorAll('img').length === 0, 'and creates no element when parsed');

console.log('\n4. The GM button toggles the panel');
const CN = await import('../js/cell-notes.js');
const B = await import('../js/bindings.js');
S.lastMapSrc = MAP;
// Both pages' bindings, so a button wired into the wrong one is caught.
B.attachGmBindings();
B.attachRemoteBindings();
const unbound = B.unboundSelectors().join(' ');
check(!unbound.includes('#btn-party-log'), 'the GM button is actually bound', unbound);
check(!unbound.includes('#remote-log-btn'), 'and so is the player button', unbound);
const btn = document.getElementById('btn-party-log');
const click = (id) => document.getElementById(id).dispatchEvent(
  new dom.window.MouseEvent('click', { bubbles: true }));
click('btn-party-log');
check(box.style.display === 'block', 'first click opens it', box.style.display);
check(box.querySelectorAll('.pl-row').length === log.length + 1,
      'with a row per note', String(box.querySelectorAll('.pl-row').length));
check(/Hide party log/.test(btn.textContent), 'and the button says how to close it',
      btn.textContent);
click('btn-party-log');
check(box.style.display === 'none', 'second click closes it', box.style.display);
check(/Party log/.test(btn.textContent) && /\d/.test(btn.textContent),
      'and it goes back to naming the count', btn.textContent);

console.log('\n5. The player button toggles its sheet, and only one sheet at a time');
const RP = await import('../js/remote-page.js');
const sheet = document.getElementById('remote-log-panel');
click('remote-log-btn');
check(sheet.style.display === 'block', 'the log opens', sheet.style.display);
check(document.getElementById('remote-log-btn').classList.contains('active'),
      'and the button reads as on');
click('remote-legend-btn');
check(sheet.style.display === 'none', 'opening the legend closes the log', sheet.style.display);
click('remote-log-btn');
check(document.getElementById('remote-legend-panel').style.display === 'none',
      'and opening the log closes the legend');
RP.remoteToggleNotes();
check(sheet.style.display === 'none', 'as does opening notes', sheet.style.display);

console.log('\n6. Each name wears that player\'s colour');
const tinted = PN.partyLogHTML((who) => who === 'Knyan' ? '#22c55e' : '');
check(tinted.includes('style="color:#22c55e;"'), 'the author is tinted');
check((tinted.match(/style="color:/g) || []).length === 
      (PN.partyLog().filter(e => e.by === 'Knyan').length),
      'and only the players that have one are');

console.log('\n7. A hex accumulates notes');
// The player sheet's job changed: the box adds a note, it does not rewrite
// the one you left there last time. Drive it the way a finger does.
S.myActorName = 'Knyan';
S.remoteFrame = { width: 1000, height: 800 };
const CELL = '12,12';
await PN.addPartyNote(CELL, 'first thing I saw', 'Knyan');
await PN.addPartyNote(CELL, 'and later, a second', 'Knyan');
await PN.loadPartyNotes(true);
check(PN.partyNotesFor(CELL).length === 2, 'two notes from one player coexist',
      JSON.stringify(PN.partyNotesFor(CELL)));

const rendered = PN.partyNotesFor(CELL);
check(rendered[0].text === 'first thing I saw' && rendered[1].text === 'and later, a second',
      'and they stay in the order they were written', JSON.stringify(rendered));

// Editing one leaves the other alone.
await PN.editPartyNote(CELL, rendered[0].at, 'first thing I saw, corrected', 'Knyan');
await PN.loadPartyNotes(true);
const after = PN.partyNotesFor(CELL);
check(after.length === 2, 'editing one does not remove the other', JSON.stringify(after));
check(after[0].text === 'first thing I saw, corrected', 'the right one changed', JSON.stringify(after[0]));
check(after[1].text === 'and later, a second', 'the other is untouched', JSON.stringify(after[1]));

// Removing one leaves the other alone.
await PN.removePartyNote(CELL, after[0].at, 'Knyan');
await PN.loadPartyNotes(true);
const left = PN.partyNotesFor(CELL);
check(left.length === 1 && left[0].text === 'and later, a second',
      'and removing one leaves the rest', JSON.stringify(left));

// An empty add is nothing to say, and must not be read as a delete.
const before = PN.partyNotesFor(CELL).length;
await PN.addPartyNote(CELL, '   ', 'Knyan');
await PN.loadPartyNotes(true);
check(PN.partyNotesFor(CELL).length === before,
      'an empty note deletes nothing', String(PN.partyNotesFor(CELL).length));

console.log('\n7b. The player sheet lists what is on the hex, and adds to it');
// Tap a hex for real: notes mode on, then a click on the note canvas. jsdom
// reports a zero-origin rect, so with scale 1 and no crop, client coords are
// map coords and the cell a tap lands in is predictable.
S.remoteScale = 1;
S.remoteCrop = { x: 0, y: 0 };
S.remoteFit = { w: 1000, h: 800 };
S.tokenGridEnabled = true;
S.tokenGridShow = true;
S.keyCellPx = 100; S.keyCellYPx = 0; S.keyOx = 0; S.keyOy = 0;
S.tokenGridType = 'square';
S.myActorName = 'Knyan';
RP.setupRemoteView();
if (!document.getElementById('remote-note-panel').innerHTML) RP.remoteToggleNotes();

const canvas = document.getElementById('remote-note-canvas');
canvas.dispatchEvent(new dom.window.MouseEvent('click',
  { bubbles: true, clientX: 250, clientY: 250 }));
await new Promise(r => setTimeout(r, 30));
const panel = document.getElementById('remote-note-panel');
const tapped = (/Cell ([-\d,]+)/.exec(panel.textContent) || [])[1];
check(!!tapped, 'tapping a hex binds the sheet to it', panel.textContent.slice(0, 80));

if (tapped) {
  await PN.addPartyNote(tapped, 'a ford, shallow', 'Knyan');
  await PN.addPartyNote(tapped, 'and a heron', 'Knyan');
  await PN.addPartyNote(tapped, 'I saw the heron too', 'Dame Ada');
  await PN.loadPartyNotes(true);
  await new Promise(r => setTimeout(r, 30));

  const p = document.getElementById('remote-note-panel');
  check(p.querySelectorAll('.rn-entry').length === 3,
        'the sheet lists every note on the hex, not just yours',
        String(p.querySelectorAll('.rn-entry').length));
  check(p.querySelectorAll('.rn-entry.mine').length === 2,
        'marking which are yours', String(p.querySelectorAll('.rn-entry.mine').length));
  check(p.querySelectorAll('[data-edit]').length === 2
        && p.querySelectorAll('[data-del]').length === 2,
        'with edit and remove on yours only');
  check(/Add note/.test(p.textContent),
        'and the box adds a new one rather than rewriting the last',
        p.textContent.slice(-120));
  const ta = document.getElementById('remote-note-text');
  check(ta.value === '', 'so it starts empty', JSON.stringify(ta.value));

  // Adding through the button, the way a player does.
  ta.value = 'the heron left';
  ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  document.getElementById('remote-note-save').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  check(PN.partyNotesFor(tapped).length === 4,
        'the button adds a fourth note', JSON.stringify(PN.partyNotesFor(tapped).map(e => e.text)));
  check(PN.partyNotesFor(tapped).filter(e => e.by === 'Knyan').length === 3,
        'all three of yours still there', JSON.stringify(PN.partyNotesFor(tapped)));

  // Editing one of yours through its button.
  const p2 = document.getElementById('remote-note-panel');
  p2.querySelector('[data-edit]').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 30));
  const ta2 = document.getElementById('remote-note-text');
  check(ta2.value === 'a ford, shallow', 'the edit button loads that note into the box',
        JSON.stringify(ta2.value));
  check(/Save change/.test(document.getElementById('remote-note-panel').textContent),
        'and the button changes what it will do');
  ta2.value = 'a ford, shallow and stony';
  ta2.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  document.getElementById('remote-note-save').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  const texts = PN.partyNotesFor(tapped).map(e => e.text);
  check(texts.includes('a ford, shallow and stony') && texts.length === 4,
        'saving changes that one and only that one', JSON.stringify(texts));

  // Removing one of yours.
  const p3 = document.getElementById('remote-note-panel');
  p3.querySelector('[data-del]').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  check(PN.partyNotesFor(tapped).length === 3,
        'the remove button takes back one note',
        JSON.stringify(PN.partyNotesFor(tapped).map(e => e.text)));
  check(PN.partyNotesFor(tapped).some(e => e.by === 'Dame Ada'),
        "and never somebody else's");
}

console.log('\n8. Both of a player\'s notes reach the log');
const log2 = PN.partyLog().filter(e => e.cell === CELL);
check(log2.length === 1, 'the log carries what is left', JSON.stringify(log2));
await PN.addPartyNote(CELL, 'a third, much later', 'Knyan');
await PN.loadPartyNotes(true);
const log3 = PN.partyLog().filter(e => e.cell === CELL);
check(log3.length === 2, 'and grows as notes are added', JSON.stringify(log3));
check(log3[0].at <= log3[1].at, 'still oldest first', JSON.stringify(log3.map(e => e.at)));

console.log('\nFAILURES: ' + fail);
process.exit(fail ? 1 : 0);
