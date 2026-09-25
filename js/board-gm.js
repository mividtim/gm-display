// GM Display — board-gm.js
// The GM's side of the campaign bulletin board.
//
// Handouts live in each MODULE's library; the board belongs to the CAMPAIGN.
// Sharing a handout pins it to the campaign's board, so the players end up
// with everything they have ever been handed in one place, whichever module
// it came from.
//
// Clicking a handout in the library shows it to the GM (and on the sidecar),
// exactly as before. Putting it in front of the players is a separate,
// deliberate click: the 📌 on its library card, or the button over the
// handout while it is open.
//
// The GM can also open the board itself and work it like any player — move
// things, string yarn, write notes — signed as "The Handler" (or whatever the
// campaign calls its GM).
import { boardDoc, mountBoard, onBoard, refreshBoard, sendOp, startBoardSync } from './board.js';
import { relMapSrc } from './geometry.js';
import { setStatus } from './keyboard.js';
import { setMainView } from './navigation.js';
import { S } from './store.js';

let board = null;

// Which campaign the table is in. The server needs to be told — campaigns
// live in this browser's storage — so it knows which board to hand players.
export function announceCampaign() {
  const c = (S.campaigns || []).find(x => x.slug === S.activeCampaign);
  if (!S.activeCampaign) return;
  fetch('/api/board/campaign', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: S.activeCampaign, name: c ? c.name : S.activeCampaign }),
  }).then(() => refreshBoard()).catch(() => {});
}

export function initBoardGM() {
  // The GM code for the player page lives with the other display controls.
  fetch('/api/gm-code').then(r => r.json()).then(d => {
    const el = document.getElementById('gm-code'); if (el) el.textContent = d.code || '?';
  }).catch(() => {});
  startBoardSync();
  announceCampaign();
  onBoard(() => { renderBoardSection(); updateShareFloat(); refreshShareButtons(); });
  // setMainView() calls this hook so the board can stop drawing when the GM
  // leaves it (navigation.js cannot import this module without a cycle).
  S._onMainView = (view) => { if (view !== 'board' && board) board.hide(); updateShareFloat(); };
  const yc = document.getElementById('board-yarn-color');
  if (yc) yc.addEventListener('change', () => sendOp({ op: 'settings', yarnColor: yc.value }));
  const gn = document.getElementById('board-gm-name');
  if (gn) gn.addEventListener('change', () => sendOp({ op: 'settings', gmName: gn.value }));
  const fl = document.getElementById('handout-share-float');
  if (fl) fl.addEventListener('click', () => {
    if (S.lastShowSrc) toggleShare(S.lastShowSrc, S.lastShowName);
  });
  renderBoardSection();
}

const norm = (s) => { try { return decodeURIComponent(relMapSrc(s || '')); } catch (e) { return s || ''; } };
function handoutFor(src) {
  const d = boardDoc();
  const n = norm(src);
  return d ? d.handouts.find(h => norm(h.src) === n) : null;
}
export function isShared(src) {
  const h = handoutFor(src);
  return !!(h && h.shared);
}

// Pin a handout to the players' board, or take it off. Sharing reads the
// image's size so it lands with the right proportions, on top, in the middle
// of whatever the table is looking at.
export function toggleShare(src, name) {
  if (!src || src.startsWith('data:')) { setStatus('Only images in the vault can be shared.'); return; }
  src = relMapSrc(src);
  const label = decodeURIComponent(String(name || src.split('/').pop()));
  if (isShared(src)) {
    sendOp({ op: 'unshare', src: handoutFor(src).src });
    setStatus(`Taken off the board: ${label}`);
    return;
  }
  const img = new Image();
  const go = (aw, ah) => {
    const mod = (S.games || []).find(g => g.slug === S.activeGame);
    sendOp({ op: 'share', src, name: label, module: mod ? mod.name : '', aw, ah });
    setStatus(`Shared with the players: ${label}`);
  };
  img.onload = () => go(img.naturalWidth || 1, img.naturalHeight || 1);
  img.onerror = () => go(1, 1);
  img.src = src;
}

export function openBoardView() {
  setMainView('board');
  if (!board) {
    board = mountBoard(document.getElementById('gm-board'), {
      identity: () => ({ name: 'GM', character: '', gm: true }),
      canUnshare: (h) => { if (confirm(`Take “${h.title || h.name}” off the players’ board?`)) sendOp({ op: 'unshare', src: h.src }); },
      canRetitle: retitle,
    });
  }
  board.show();
  setStatus('Bulletin board — you are working it alongside the players. Notes you add are signed as '
    + (((boardDoc() || {}).gmName) || 'The Handler') + '.');
}

// Players never see a handout's filename. If it should have a caption on the
// board, this is where the GM gives it one — in the story's words, not the
// file's.
export function retitle(h) {
  if (!h) return;
  const t = prompt('Title the players see for this handout (leave empty for none).\n'
    + 'They never see the filename: ' + (h.name || ''), h.title || '');
  if (t === null) return;
  sendOp({ op: 'retitle', id: h.id, title: t.trim() });
}

// --- sidebar -----------------------------------------------------------------
function renderBoardSection() {
  const d = boardDoc();
  const yc = document.getElementById('board-yarn-color');
  if (yc && d && document.activeElement !== yc) yc.value = d.yarnColor || '#c0392b';
  const gn = document.getElementById('board-gm-name');
  if (gn && d && document.activeElement !== gn) gn.value = d.gmName || 'The Handler';
  const st = document.getElementById('board-status');
  const list = document.getElementById('board-shared-list');
  if (!st || !list) return;
  const shared = d ? d.handouts.filter(h => h.shared) : [];
  const c = (S.campaigns || []).find(x => x.slug === S.activeCampaign);
  st.textContent = shared.length + ' on the board' + (c ? ' · ' + c.name : '');
  const esc = (t) => String(t == null ? '' : t).replace(/[<>&"]/g,
    ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
  list.innerHTML = shared.length ? shared.map(h => {
    const n = ((d.notes || {})[h.id] || []).length;
    const shown = h.title
      ? `${esc(h.title)} <small title="The filename — only you see it">· ${esc(h.name)}</small>`
      : `<i style="color:#888;" title="Players see no caption">untitled</i> <small>· ${esc(h.name)}</small>`;
    return `<div class="bsl-row"><img src="${esc(h.src)}" alt=""><span>${shown}`
      + `${h.module ? ` <small>· ${esc(h.module)}</small>` : ''}</span>`
      + `${n ? `<small>${n}✎</small>` : ''}`
      + `<button data-retitle="${esc(h.id)}" title="Title the players see">✎</button>`
      + `<button data-unshare="${esc(h.src)}" title="Take off the board">✕</button></div>`;
  }).join('') : '<div style="font-size:11px;color:#777;">Nothing shared yet. Use 📌 on a handout in the Library.</div>';
  list.querySelectorAll('[data-retitle]').forEach(b => b.onclick = () => retitle(d.handouts.find(h => h.id === b.dataset.retitle)));
  list.querySelectorAll('[data-unshare]').forEach(b => b.onclick = () => sendOp({ op: 'unshare', src: b.dataset.unshare }));
}

// The button over an open handout: the separate, explicit click that puts
// what the GM is looking at in front of the players.
function updateShareFloat() {
  const b = document.getElementById('handout-share-float');
  if (!b) return;
  const show = S.currentMode === 'fog' && S.fogContext === 'show' && !!S.lastShowSrc
    && !String(S.lastShowSrc).startsWith('data:');
  b.style.display = show ? 'block' : 'none';
  if (!show) return;
  const on = isShared(S.lastShowSrc);
  b.classList.toggle('on', on);
  b.textContent = on ? '📌 On the players’ board — take it off' : '📌 Share with players';
}
export { updateShareFloat };

// Library cards carry a 📌 each; keep them honest as the board changes.
function refreshShareButtons() {
  document.querySelectorAll('.lib-share[data-src]').forEach(b => {
    const on = isShared(b.dataset.src);
    b.classList.toggle('on', on);
    b.title = on ? 'On the players’ bulletin board — click to take it off' : 'Share with the players (pin to the campaign board)';
  });
}
export { refreshShareButtons };
