// Does "hide the grid" survive a refresh?
//
// There are two places the answer is written down — the campaign roster
// (tokenGridShow) and the per-map key (show) — and a page load reads them in
// that order, so whichever one the toggle forgets to update wins on the way
// back in. This drives the real tokens.js in a jsdom document with a real
// localStorage, toggles the grid, and then replays what a page load does.
import { JSDOM } from 'jsdom';

let fail = 0;
const check = (ok, what, detail = '') => {
  if (!ok) fail++;
  console.log((ok ? '  ok   ' : '  BAD  ') + what + (!ok && detail ? '\n         ' + detail : ''));
};

const dom = new JSDOM(`<!DOCTYPE html><body>
  <span id="tokgrid-status"></span><button id="btn-tokgrid"></button>
  <input id="tokgrid-cells" type="range"><span id="tokgrid-cells-val"></span>
  <input id="marker-color" type="color">
  <button id="btn-gridshape"></button>
  <div id="token-list"></div><div id="gm-canvas-wrap"></div>
  <select id="tok-image"></select><select id="split-player-map"></select>
  <canvas id="gm-grid-canvas"></canvas><div id="gm-token-layer"></div>
</body>`, { url: 'http://127.0.0.1:1/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.Image = dom.window.Image;
// No server: the vault image list is empty rather than absent, because the
// pickers iterate it.
globalThis.fetch = async () => ({ ok: true, json: async () => [] });

const T = await import('../js/tokens.js');
const { S } = await import('../js/store.js');

const MAP = '/maps/Realm.png';

// A GM opens a map, calibrates it, and the grid is on.
S.activeCampaign = 'test';
S.activeGame = 'test';
S.lastMapSrc = MAP;
S.tokenMapSrc = MAP;
S.mapWidth = 1000; S.mapHeight = 800;
T.loadTokens();
S.tokenGridEnabled = true;
S.tokenGridShow = true;
T.setKeyCell(50);          // calibrating writes the per-map key, with show: true
await new Promise(r => setTimeout(r, 50));

const keyRaw = localStorage.getItem(T.mapKeyStorageKey(MAP));
check(!!keyRaw, 'calibrating writes a per-map key', String(keyRaw));
check(JSON.parse(keyRaw || '{}').show === true, 'which records that the grid is shown');

// The map has its own grid printed on it, so the GM turns ours off.
T.toggleTokenGrid();
check(S.tokenGridShow === false, 'the toggle turns the grid off', String(S.tokenGridShow));

// --- the refresh ---
// A page load restores the campaign roster, then applies the per-map key over
// the top. Replay exactly that order against what is on disk now.
const rosterRaw = localStorage.getItem('gm-display:test:roster')
  || Object.keys(localStorage).map(k => k).find(k => k.includes('roster'));
console.log('\n     stored after the toggle:');
console.log('       per-map key : ' + localStorage.getItem(T.mapKeyStorageKey(MAP)));
for (let i = 0; i < localStorage.length; i++) {
  const k = localStorage.key(i);
  if (k.includes('roster')) console.log('       roster      : ' + localStorage.getItem(k));
}
console.log();

S.tokenGridShow = true;                 // module defaults, as on a fresh load
T.loadTokens();                         // restores the roster, then the map key
check(S.tokenGridShow === false,
      'after a reload the grid is still off', String(S.tokenGridShow));
T.initTokensGM();
await new Promise(r => setTimeout(r, 80));
check(S.tokenGridShow === false,
      'and still off once the panel has initialised', String(S.tokenGridShow));
check(document.getElementById('tokgrid-status').textContent === 'OFF',
      'the button agrees', document.getElementById('tokgrid-status').textContent);

// Turning it back on has to stick just as hard.
T.toggleTokenGrid();
check(S.tokenGridShow === true, 'toggling back on');
S.tokenGridShow = false;
T.loadTokens();
check(S.tokenGridShow === true, 'survives a reload too', String(S.tokenGridShow));

console.log('\n2. Hiding the grid does not cost the map its shipped calibration');
// A map the GM has never calibrated here, but which ships one in the vault.
// Hiding the grid writes a map key — and that key must not be mistaken for
// "already calibrated", or the vault's calibration would never arrive.
const MAP2 = '/maps/Shipped.png';
globalThis.fetch = async (u) => ({
  ok: true,
  json: async () => String(u).includes('/api/mapkey')
    ? { key: { shape: 'hex', cell: 128, ox: 4, oy: 6, show: true, enabled: true } }
    : [],
});
S.lastMapSrc = MAP2; S.tokenMapSrc = MAP2;
S.keyCellPx = 0; S.tokenGridShow = true;
check(!localStorage.getItem(T.mapKeyStorageKey(MAP2)), 'this map has no local key yet');

T.toggleTokenGrid();                       // hide it before ever calibrating
check(S.tokenGridShow === false, 'the grid is hidden');
check(!!localStorage.getItem(T.mapKeyStorageKey(MAP2)),
      'which does write a map key');

S.keyCellPx = 0;
T.loadTokens();                            // the reload
await new Promise(r => setTimeout(r, 120));
check(S.keyCellPx === 128, "the vault's calibration is still adopted", String(S.keyCellPx));
check(S.tokenGridShow === false,
      'and it does not turn the grid back on behind the GM', String(S.tokenGridShow));

console.log('\nFAILURES: ' + fail);
process.exit(fail ? 1 : 0);
