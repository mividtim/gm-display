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
let notesMode = false;
let selectedCell = null;          // label string, e.g. "5,5"
let notes = {};                   // label -> text
let noteFile = '';
let saveTimer = null;
let pollTimer = null;

const el = (id) => document.getElementById(id);
const currentMap = () => relMapSrc(S.lastMapSrc || '');

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
export function toggleNotesMode() {
  notesMode = !notesMode;
  const layer = el('gm-notes-layer');
  if (layer) layer.style.pointerEvents = notesMode ? 'auto' : 'none';
  const b = el('btn-notes-mode');
  if (b) b.classList.toggle('active', notesMode);
  const st = el('notes-mode-status');
  if (st) st.textContent = notesMode ? 'ON' : 'OFF';
  const tl = el('gm-token-layer');
  if (tl) tl.classList.toggle('markerblock', notesMode);
  drawNoteMarkers();          // your pips appear with the mode and go with it
  if (notesMode) loadNotes();
}

function attachNotesLayer() {
  const layer = el('gm-notes-layer');
  if (!layer || layer._wired) return;
  layer._wired = true;
  layer.addEventListener('click', (e) => {
    const r = layer.getBoundingClientRect();
    const { mw, mh } = mapDims();
    const mx = (e.clientX - r.left) * (mw / r.width);
    const my = (e.clientY - r.top) * (mh / r.height);
    selectCell(cellLabel(cellAtMapPx(mx, my)));
  });
}

export function selectCell(label) {
  selectedCell = label;
  renderNotesPanel();
  drawNoteMarkers();
  const ta = el('note-text');
  if (ta) ta.focus();
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
  if (notesMode) {
    for (const label of Object.keys(notes)) pip(label, 'rgba(255,203,84,0.92)', party[label] ? -r : 0);
  }
  for (const label of Object.keys(party)) pip(label, 'rgba(96,165,250,0.95)', (notesMode && notes[label]) ? r : 0);
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

function setNoteStatus(t) { const s = el('note-status'); if (s) s.textContent = t; }

function renderNotesPanel() {
  const body = el('note-editor');
  if (!body) return;
  if (!selectedCell) {
    body.innerHTML = '<div style="color:#888;font-size:11px;">'
      + (notesMode ? 'Click a cell on the map.' : 'Turn Notes mode on, then click a cell.')
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
  const fileLine = noteFile
    ? '<div style="font-size:10px;color:#666;margin-top:6px;word-break:break-all;">' + noteFile + '</div>'
    : '';
  if (!keys.length) {
    list.innerHTML = '<div style="color:#888;font-size:11px;">No notes on this map yet.</div>' + fileLine;
    return;
  }
  list.innerHTML = keys.map(k =>
    '<div class="note-row" data-cell="' + k + '" style="cursor:pointer;padding:3px 0;'
    + 'border-bottom:1px dotted #333;font-size:12px;">'
    + '<b style="color:#e0c060;">' + k + '</b> '
    + '<span style="color:#aaa;">' + notes[k].replace(/[<>&]/g, '').slice(0, 44)
    + (notes[k].length > 44 ? '…' : '') + '</span></div>').join('') + fileLine;
  list.querySelectorAll('[data-cell]').forEach(row =>
    row.addEventListener('click', () => selectCell(row.dataset.cell)));
}

// ------------------------------------------------------------------- init ---
export function initCellNotes() {
  attachNotesLayer();
  loadNotes(true);
  setPartyNotesMap(currentMap());
  startPartyNotesPolling(4000);
  onPartyNotesChanged(() => { drawNoteMarkers(); renderPartyBlock(); });
  // Pick up edits made in Obsidian while the page is open.
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) loadNotes(true); }, 4000);
}

// Called when the GM switches map: the notes belong to the map, not the session.
export function notesOnMapChanged() {
  selectedCell = null;
  notes = {};
  loadNotes(true);
  setPartyNotesMap(currentMap());
}

export function notesCount() { return Object.keys(notes).length; }
export function partyCount() { return partyNoteCount(); }
export function notesModeOn() { return notesMode; }
