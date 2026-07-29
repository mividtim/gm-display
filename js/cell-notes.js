// GM Display — cell-notes.js
// Notes attached to grid cells, stored as markdown in the Obsidian vault.
//
// Once a map has a grid calibration its cells are addressable, so any map can
// carry notes. Clicking a cell in Notes mode opens an editor; the text is saved
// server-side into one markdown file per map, which means it is a real note in
// the vault — searchable, linkable, editable in Obsidian. Edits made there flow
// back here, because the server re-reads any file whose mtime changed.
import { cellAtMapPx, cellCenterMapPx, cellFromLabel, cellLabel, kStepX, kStepY, mapDims, relMapSrc } from './geometry.js';
import { onPartyNotesChanged, partyNoteCount, partyNotes, partyNotesFor, setPartyNotesMap, startPartyNotesPolling } from './party-notes.js';
import { S } from './store.js';
import { isTool, setActiveTool } from './tools.js';
let selectedCell = null;          // label string, e.g. "5,5"
let notes = {};                   // label -> text
let noteFile = '';
let saveTimer = null;
let pollTimer = null;

const el = (id) => document.getElementById(id);
const currentMap = () => relMapSrc(S.lastMapSrc || '');
const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g,
  c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- server ---
export async function loadNotes(silent) {
  const map = currentMap();
  if (!map) { notes = {}; renderNotesPanel(); return; }
  try {
    const r = await fetch('/api/notes?map=' + encodeURIComponent(map), { cache: 'no-store' });
    const d = await r.json();
    const changed = JSON.stringify(d.cells) !== JSON.stringify(notes);
    notes = d.cells || {};
    noteFile = d.file || '';
    if (changed || !silent) { drawNoteMarkers(); renderNotesPanel(); }
  } catch (e) {
    if (!silent) setNoteStatus('server not reachable');
  }
}

function saveNote(cell, text) {
  clearTimeout(saveTimer);
  setNoteStatus('saving…');
  saveTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ map: currentMap(), cell, text }),
      });
      if (!r.ok) throw new Error(r.status);
      if (text.trim()) notes[cell] = text; else delete notes[cell];
      setNoteStatus('saved to your vault');
      drawNoteMarkers(); renderNotesList();
    } catch (e) { setNoteStatus('not saved — is the server running?'); }
  }, 600);
}

// ------------------------------------------------------------------- mode ---
// Notes is a tool now, not a mode of its own. The sidebar button and the
// toolbar button are two ways to pick the same one.
const notesMode = () => isTool('notes');

export function toggleNotesMode() {
  setActiveTool(isTool('notes') ? 'tokens' : 'notes');
}

// Called by tools.js whenever the active tool changes.
export function notesToolChanged() {
  const b = el('btn-notes-mode');
  if (b) b.classList.toggle('active', notesMode());
  const st = el('notes-mode-status');
  if (st) st.textContent = notesMode() ? 'ON' : 'OFF';
  if (!notesMode()) { closeNotePop(); hideTip(); }
  drawNoteMarkers();          // your pips appear with the tool and go with it
  if (notesMode()) loadNotes();
}

function attachNotesLayer() {
  const layer = el('gm-notes-layer');
  if (!layer || layer._wired) return;
  layer._wired = true;
  layer.addEventListener('click', (e) => {
    const label = cellAtClient(e.clientX, e.clientY);
    if (label) openNoteAt(label, e.clientX, e.clientY);
  });
}

export function selectCell(label) {
  selectedCell = label;
  renderNotesPanel();
  drawNoteMarkers();
  const ta = el('note-text');
  if (ta) ta.focus();
}

// ------------------------------------------------------- notes on the map ---
// Reading a note should not mean looking away from the map. Hovering a cell
// peeks at what is written there, and right-clicking opens the editor on the
// spot — in any mode, because the moment you want to write something down is
// rarely the moment you were planning to switch modes. The sidebar keeps the
// index of every note on the map; it is no longer the only way in.

// Screen point -> cell label, or '' when the pointer is off the map or the map
// has no calibration (in which case a cell address would be invented).
function cellAtClient(cx, cy) {
  const wrap = el('gm-canvas-wrap');
  if (!wrap || !S.tokenGridEnabled) return '';
  const r = wrap.getBoundingClientRect();
  if (!r.width || !r.height) return '';
  if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return '';
  const { mw, mh } = mapDims();
  const mx = (cx - r.left) * (mw / r.width);
  const my = (cy - r.top) * (mh / r.height);
  return cellLabel(cellAtMapPx(mx, my, mw, mh));
}

// Where a cell sits on screen, so the editor opens against it rather than
// wherever the cursor happened to be.
function cellClientPoint(label) {
  const wrap = el('gm-canvas-wrap');
  if (!wrap) return null;
  const cell = cellFromLabel(label);
  if (!cell) return null;
  const r = wrap.getBoundingClientRect();
  const { mw, mh } = mapDims();
  const c = cellCenterMapPx(cell, mw, mh);
  return { x: r.left + c.x / mw * r.width, y: r.top + c.y / mh * r.height };
}

// Notes are markdown, because they are real files in the vault. The editor
// shows the source — that is what you are editing — but a peek should read
// like prose, not like a diff. Enough of markdown to cover what a map note
// actually uses: headings, bold, italic and bullets.
export function mdLite(src) {
  return esc(src).trim().split('\n').map(line => {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) return '<div class="nt-h">' + inline(h[2]) + '</div>';
    const b = line.match(/^[-*]\s+(.*)$/);
    if (b) return '<div class="nt-li">' + inline(b[1]) + '</div>';
    if (!line.trim()) return '<div class="nt-gap"></div>';
    return '<div>' + inline(line) + '</div>';
  }).join('');
}
function inline(s) {
  return s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
          .replace(/(^|\W)\*(\S(?:.*?\S)?)\*(?=\W|$)/g, '$1<i>$2</i>')
          .replace(/`(.+?)`/g, '<code>$1</code>');
}

function noteSummary(label) {
  const mine = (notes[label] || '').trim();
  const theirs = partyNotesFor(label);
  if (!mine && !theirs.length) return '';
  return '<div class="nt-cell">' + esc(label) + '</div>'
    + (mine ? '<div class="nt-mine">' + mdLite(mine) + '</div>' : '')
    + theirs.map(e => '<div class="nt-party"><b>' + esc(e.by || 'a player') + '</b> '
        + esc(e.text || '') + '</div>').join('');
}

// --- hover peek -------------------------------------------------------------
let hoverLabel = '';
let hoverRaf = 0;

function hideTip() {
  const tip = el('gm-note-tip');
  if (tip) tip.style.display = 'none';
  if (hoverRaf) { cancelAnimationFrame(hoverRaf); hoverRaf = 0; }
  hoverLabel = '';
}

function showTipAt(label, cx, cy) {
  const tip = el('gm-note-tip');
  if (!tip) return;
  // The editor is open on some cell: a tooltip floating over it is noise, and
  // a stray mousemove must not resurrect one behind the popover.
  if (notePopOpen()) { hideTip(); return; }
  const body = noteSummary(label);
  // With nothing written here there is nothing to peek at — except in Notes
  // mode, where the label tells you which cell you are about to write on.
  if (!body && !notesMode()) { hideTip(); return; }
  tip.innerHTML = body || '<div class="nt-cell">' + esc(label) + '</div>'
    + '<div class="nt-empty">no notes — click to write one</div>';
  tip.style.display = 'block';
  // Keep it on screen: flip to the other side of the cursor near an edge.
  const r = tip.getBoundingClientRect();
  let x = cx + 16, y = cy + 16;
  if (x + r.width > window.innerWidth - 8) x = cx - r.width - 16;
  if (y + r.height > window.innerHeight - 8) y = cy - r.height - 16;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}

function attachMapHover() {
  const wrap = el('gm-canvas-wrap');
  if (!wrap || wrap._noteHoverWired) return;
  wrap._noteHoverWired = true;
  wrap.addEventListener('mousemove', (e) => {
    // Never while a drag is in flight: painting fog or moving a token is not
    // the moment to be shown a tooltip.
    if (e.buttons || isTool('marker')) { hideTip(); return; }
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const label = cellAtClient(e.clientX, e.clientY);
      if (!label) { hideTip(); return; }
      hoverLabel = label;
      showTipAt(label, e.clientX, e.clientY);
    });
  });
  wrap.addEventListener('mouseleave', hideTip);
  wrap.addEventListener('pointerdown', hideTip);
  // Right-click opens the editor on the cell, in any mode. Nothing else in the
  // app uses the context menu, and this is the fast path: see something, write
  // it down, without first switching what the left button does.
  wrap.addEventListener('contextmenu', (e) => {
    const label = cellAtClient(e.clientX, e.clientY);
    if (!label) return;
    e.preventDefault();
    openNoteAt(label, e.clientX, e.clientY);
  });
}

// --- the editor, on the map -------------------------------------------------
function popRows(text) {
  const lines = String(text || '').split('\n').length;
  return Math.max(5, Math.min(14, lines + 1));
}

export function openNoteAt(label, cx, cy) {
  const pop = el('gm-note-pop');
  if (!pop) { selectCell(label); return; }   // no popover markup: fall back
  hideTip();
  selectedCell = label;
  drawNoteMarkers();
  renderNotesList();
  pop.innerHTML =
    '<div class="np-head"><b>' + esc(label) + '</b>'
    + '<span class="np-status" id="note-pop-status"></span>'
    + '<button class="np-close" id="note-pop-close" title="Close (Esc)">✕</button></div>'
    // Tall enough to show what is already written, within reason — a realm hex
    // carries a paragraph of prep and a five-row box hides most of it.
    + '<textarea id="note-pop-text" rows="' + popRows(notes[label] || '')
    + '" placeholder="What is here?"></textarea>'
    + '<div id="note-pop-party"></div>';
  pop.style.display = 'block';
  const anchor = cellClientPoint(label) || { x: cx, y: cy };
  const r = pop.getBoundingClientRect();
  let x = anchor.x + 18, y = anchor.y - r.height / 2;
  if (x + r.width > window.innerWidth - 10) x = anchor.x - r.width - 18;
  y = Math.min(Math.max(10, y), window.innerHeight - r.height - 10);
  pop.style.left = Math.max(10, x) + 'px';
  pop.style.top = y + 'px';

  const ta = el('note-pop-text');
  ta.value = notes[label] || '';
  ta.addEventListener('input', () => saveNote(label, ta.value));
  ta.focus();
  // Caret at the end, because you are almost always adding a line — but
  // scrolled to the top, because you opened this to read what is already here.
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.scrollTop = 0;
  el('note-pop-close').addEventListener('click', closeNotePop);
  renderPopParty();
  // Also mirror into the sidebar, so the panel and the popover never disagree.
  renderNotesPanel();
}

function renderPopParty() {
  const host = el('note-pop-party');
  if (host) host.innerHTML = selectedCell ? partyBlock(selectedCell) : '';
}

export function closeNotePop() {
  const pop = el('gm-note-pop');
  if (pop) { pop.style.display = 'none'; pop.innerHTML = ''; }
}

export function notePopOpen() {
  const pop = el('gm-note-pop');
  return !!pop && pop.style.display === 'block';
}

function attachNotePopDismiss() {
  if (document._notePopWired) return;
  document._notePopWired = true;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && notePopOpen()) { e.stopPropagation(); closeNotePop(); }
  });
  document.addEventListener('pointerdown', (e) => {
    const pop = el('gm-note-pop');
    if (!pop || pop.style.display !== 'block') return;
    if (pop.contains(e.target)) return;
    closeNotePop();
  }, true);
}

// ------------------------------------------------------------------ paint ---
// Drawn on the grid canvas, straight after the grid itself.
export function drawNoteMarkers() {
  const wrap = el('gm-canvas-wrap'), gc = el('gm-grid-canvas');
  if (!wrap || !gc) return;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  const ctx = gc.getContext('2d');
  const { mw, mh } = mapDims();
  const m2c = (mx, my) => ({ x: mx / mw * w, y: my / mh * h });
  const r = Math.max(4, Math.min(kStepX(mw), kStepY(mw)) / mw * w * 0.16);

  const pip = (label, fill, dx) => {
    const cell = cellFromLabel(label);
    if (!cell) return;
    const c = cellCenterMapPx(cell, mw, mh);
    const p = m2c(c.x, c.y);
    ctx.beginPath();
    ctx.arc(p.x + dx, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.strokeStyle = 'rgba(40,28,10,0.85)';
    ctx.lineWidth = 2;
    ctx.fill(); ctx.stroke();
  };
  const party = partyNotes();
  // Your own pips only while you are working with notes. On a realm sheet every
  // hex carries prep, and 144 gold dots over the art tell you nothing during
  // play. What the party wrote is always shown: that is news, and there is
  // never much of it.
  if (notesMode()) {
    for (const label of Object.keys(notes)) pip(label, 'rgba(255,203,84,0.92)', party[label] ? -r : 0);
  }
  for (const label of Object.keys(party)) pip(label, 'rgba(96,165,250,0.95)', (notesMode() && notes[label]) ? r : 0);
  if (selectedCell) {
    const cell = cellFromLabel(selectedCell);
    if (cell) {
      const c = cellCenterMapPx(cell, mw, mh);
      const p = m2c(c.x, c.y);
      const rr = Math.min(kStepX(mw), kStepY(mw)) / mw * w * 0.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffcf5c'; ctx.lineWidth = 3;
      ctx.stroke();
    }
  }
}

// ------------------------------------------------------------------ panel ---
// What the players have written here. Read-only for the GM: it is their half of
// the map, and overwriting it from this side would be rude and confusing.
function partyBlock(label) {
  const list = partyNotesFor(label);
  if (!list.length) return '';
  return '<div style="margin-top:10px;border-top:1px solid #333;padding-top:6px;">'
    + '<label>From the party</label>'
    + list.map(e =>
        '<div style="font-size:12px;margin-bottom:4px;">'
        + '<b style="color:#60a5fa;">' + (e.by || 'a player').replace(/[<>&]/g, '') + '</b> '
        + '<span style="color:#ccc;">' + (e.text || '').replace(/[<>&]/g, '') + '</span></div>').join('')
    + '</div>';
}

// Refreshed on its own, so the four-second party poll never rebuilds the
// textarea underneath the GM while they are typing into it.
function renderPartyBlock() {
  const host = el('note-party');
  if (host) host.innerHTML = selectedCell ? partyBlock(selectedCell) : '';
}

// Both editors show the same status: whichever one you are typing in should
// tell you whether it reached the vault.
function setNoteStatus(t) {
  ['note-status', 'note-pop-status'].forEach(id => {
    const s = el(id); if (s) s.textContent = t;
  });
}

function renderNotesPanel() {
  const body = el('note-editor');
  if (!body) return;
  if (!selectedCell) {
    body.innerHTML = '<div style="color:#888;font-size:11px;">'
      + (notesMode() ? 'Click a cell on the map.' : 'Pick the Notes tool, then click a cell.')
      + '</div>';
  } else {
    body.innerHTML =
      '<label>Cell <span class="val">' + selectedCell + '</span></label>'
      + '<textarea id="note-text" rows="6" style="width:100%;background:#222;color:#eee;'
      + 'border:1px solid #555;padding:6px;font:13px/1.45 system-ui;resize:vertical;"></textarea>'
      + '<div style="font-size:11px;color:#888;margin-top:4px;" id="note-status"></div>'
      + '<div id="note-party"></div>';
    const ta = el('note-text');
    ta.value = notes[selectedCell] || '';
    ta.addEventListener('input', () => saveNote(selectedCell, ta.value));
    renderPartyBlock();
  }
  renderNotesList();
}

function renderNotesList() {
  const list = el('note-list');
  if (!list) return;
  const keys = Object.keys(notes).sort((a, b) => {
    const na = a.split(',').map(Number), nb = b.split(',').map(Number);
    return (na[0] - nb[0]) || (na[1] - nb[1]);
  });
  // Always name the file, even — especially — when there are no notes. Notes
  // are keyed per map image, so "no notes on this map" and "you have the wrong
  // map open" look identical unless the panel says which file it is reading.
  const fileLine = noteFile
    ? '<div style="font-size:10px;color:#666;margin-top:6px;word-break:break-all;">'
      + 'Reading: ' + esc(noteFile) + '</div>'
    : '';
  if (!keys.length) {
    list.innerHTML = '<div style="color:#888;font-size:11px;">No notes on <b>'
      + esc(currentMap().split('/').pop() || 'this map') + '</b> yet. '
      + 'Notes belong to the map file — another copy of the same map has its own.'
      + '</div>' + fileLine;
    return;
  }
  list.innerHTML = keys.map(k =>
    '<div class="note-row" data-cell="' + k + '" style="cursor:pointer;padding:3px 0;'
    + 'border-bottom:1px dotted #333;font-size:12px;">'
    + '<b style="color:#e0c060;">' + k + '</b> '
    + '<span style="color:#aaa;">' + notes[k].replace(/[<>&]/g, '').slice(0, 44)
    + (notes[k].length > 44 ? '…' : '') + '</span></div>').join('') + fileLine;
  list.querySelectorAll('[data-cell]').forEach(row =>
    // Picking a note from the index takes you to it on the map, editor open,
    // rather than only filling the panel underneath.
    row.addEventListener('click', () => {
      const label = row.dataset.cell;
      const p = cellClientPoint(label);
      if (p) openNoteAt(label, p.x, p.y); else selectCell(label);
    }));
}

// ------------------------------------------------------------------- init ---
export function initCellNotes() {
  attachNotesLayer();
  attachMapHover();
  attachNotePopDismiss();
  loadNotes(true);
  setPartyNotesMap(currentMap());
  startPartyNotesPolling(4000);
  onPartyNotesChanged(() => { drawNoteMarkers(); renderPartyBlock(); renderPopParty(); });
  // Pick up edits made in Obsidian while the page is open.
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) loadNotes(true); }, 4000);
}

// Called when the GM switches map: the notes belong to the map, not the session.
export function notesOnMapChanged() {
  selectedCell = null;
  notes = {};
  noteFile = '';
  closeNotePop();
  hideTip();
  // Paint the empty state now. loadNotes(silent) only repaints on a diff, and
  // {} vs {} is not a diff — so on a map with no notes the panel would keep
  // showing the last map's, which is worse than showing nothing.
  renderNotesPanel();
  loadNotes(true);
  setPartyNotesMap(currentMap());
}

export function notesCount() { return Object.keys(notes).length; }
export function partyCount() { return partyNoteCount(); }
export function notesModeOn() { return notesMode(); }
