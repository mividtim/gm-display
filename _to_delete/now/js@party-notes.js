// GM Display — party-notes.js
// Notes the players write on their own copy of the map.
//
// Kept in a separate vault file from the GM's cell notes, so neither side can
// clobber the other and the GM's prep is never served to a player. Both the GM
// page and the remote page use this module: the GM reads (and sees who wrote
// what), the players read and write.
import { S } from './store.js';
let cells = {};                  // label -> [{by, text}]
let mapSrc = '';
let pollTimer = null;
const listeners = [];

export function onPartyNotesChanged(fn) { listeners.push(fn); }
function announce() { listeners.forEach(fn => { try { fn(cells); } catch (e) {} }); }

export function partyNotes() { return cells; }
export function partyNotesFor(label) { return cells[label] || []; }
export function partyNoteCount() {
  return Object.values(cells).reduce((n, list) => n + list.length, 0);
}

export function setPartyNotesMap(src) {
  if (src === mapSrc) return;
  mapSrc = src || '';
  cells = {};
  announce();
  loadPartyNotes(true);
}

export async function loadPartyNotes(silent) {
  if (!mapSrc) return;
  try {
    const r = await fetch('/api/partynotes?map=' + encodeURIComponent(mapSrc), { cache: 'no-store' });
    const d = await r.json();
    const next = d.cells || {};
    if (JSON.stringify(next) !== JSON.stringify(cells)) { cells = next; announce(); }
  } catch (e) { /* offline: the map still works, notes just do not update */ }
}

// One entry per author per cell — writing again replaces your own line and
// leaves everyone else's alone. An empty string removes yours.
export async function savePartyNote(label, text, by) {
  if (!mapSrc || !label) return false;
  try {
    const r = await fetch('/api/partynotes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ map: mapSrc, cell: label, text, by: by || S.myActorName || 'a player' }),
    });
    if (!r.ok) throw new Error(r.status);
    await loadPartyNotes(true);
    return true;
  } catch (e) { return false; }
}

export function startPartyNotesPolling(ms) {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) loadPartyNotes(true); }, ms || 4000);
}
