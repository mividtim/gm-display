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

// Notes ACCUMULATE on a hex. Coming back to somewhere you have already
// written about is the normal case — you saw something new — so a second note
// is a second entry rather than a rewrite of the first.
//
// `at` addresses one entry you already wrote, to change it or take it back.
// Without it this adds a new one. An empty text with no `at` is nothing to
// say, and is rejected rather than quietly deleting something.
async function postPartyNote(label, body) {
  if (!mapSrc || !label) return false;
  try {
    const r = await fetch('/api/partynotes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ map: mapSrc, cell: label }, body)),
    });
    if (!r.ok) throw new Error(r.status);
    await loadPartyNotes(true);
    return true;
  } catch (e) { return false; }
}

export function addPartyNote(label, text, by) {
  if (!String(text || '').trim()) return Promise.resolve(false);
  return postPartyNote(label, { text, by: by || S.myActorName || 'a player' });
}

export function editPartyNote(label, at, text, by) {
  return postPartyNote(label, { at, text, by: by || S.myActorName || 'a player' });
}

export function removePartyNote(label, at, by) {
  return postPartyNote(label, { at, text: '', by: by || S.myActorName || 'a player' });
}

// Kept for callers that still mean "put this on the hex": it adds.
export function savePartyNote(label, text, by) {
  return addPartyNote(label, text, by);
}

// --- the party's notes as a log ---------------------------------------------
// The same entries the map shows, read down the page in the order they were
// written instead of across the map by cell. Which is the question you ask
// after the session rather than during it: what did we find, and when.
//
// Entries written before timestamps existed have no time. They sort first —
// they are older than anything dated, by definition — and say so rather than
// borrowing a time they never had.
export function partyLog() {
  const out = [];
  Object.keys(cells).forEach(cell =>
    (cells[cell] || []).forEach(e => out.push(Object.assign({ cell }, e))));
  out.sort((a, b) => {
    if (!a.at && !b.at) return byCell(a.cell, b.cell);
    if (!a.at) return -1;
    if (!b.at) return 1;
    return a.at < b.at ? -1 : a.at > b.at ? 1 : byCell(a.cell, b.cell);
  });
  return out;
}

function byCell(a, b) {
  const na = String(a).split(',').map(Number), nb = String(b).split(',').map(Number);
  return (na[0] - nb[0]) || (na[1] - nb[1]) || 0;
}

const esc = (t) => String(t == null ? '' : t).replace(/[<>&"]/g,
  ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));

// "2026-09-17 00:44" -> "17 Sep, 00:44". The date is dropped on a run of
// entries from the same day, so a session reads as a list of times with one
// date above it rather than the same date repeated forty times.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function stampDay(at) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(at || '');
  if (!m) return '';
  return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1];
}

function stampTime(at) {
  // The stamp carries seconds so two entries can be told apart; a log is read
  // in minutes.
  const m = /\d{4}-\d{2}-\d{2} (\d{2}:\d{2})/.exec(at || '');
  return m ? m[1] : '';
}

// `colorFor` lets the player page tint each name with that player's own colour,
// the way their marker ink and token already are. The GM page has no such map
// and passes nothing.
export function partyLogHTML(colorFor) {
  const log = partyLog();
  if (!log.length) {
    return '<div class="pl-empty">Nothing written on this map yet.</div>';
  }
  let day = null;
  const rows = log.map(e => {
    let head = '';
    const d = stampDay(e.at);
    const label = e.at ? d : 'Before times were kept';
    if (label !== day) { day = label; head = '<div class="pl-day">' + esc(label) + '</div>'; }
    const who = e.by || 'a player';
    const tint = (colorFor && colorFor(who)) || '';
    return head
      + '<div class="pl-row">'
      + '<span class="pl-time">' + esc(stampTime(e.at) || '··:··') + '</span>'
      + '<span class="pl-cell" data-cell="' + esc(e.cell) + '">' + esc(e.cell) + '</span>'
      + '<span class="pl-by"' + (tint ? ' style="color:' + esc(tint) + ';"' : '') + '>'
      + esc(who) + '</span>'
      + '<span class="pl-text">' + esc(e.text)
      + (e.edited ? '<span class="pl-edited" title="Edited ' + esc(e.edited)
                    + '"> · edited</span>' : '')
      + '</span></div>';
  });
  return rows.join('');
}

export function startPartyNotesPolling(ms) {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) loadPartyNotes(true); }, ms || 4000);
}
