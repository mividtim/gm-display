// GM Display — legend.js
// What the symbols on the map mean.
//
// A beautiful map is not a readable one. The realm sheet is a wall of
// hand-drawn terrain and glyphs, and nobody at the table can tell a Sanctum
// from a Monument without being told. The legend is markdown in the vault
// beside the notes, so it is written in Obsidian where prep already happens,
// and read live here — the server re-reads a file whose mtime changed.
//
// Shared by all three pages: the GM reads it in the sidebar, the projector
// shows it as a corner panel, and players can open it on their own screen. It
// is the map's own caption, so nobody is kept from it.
import { relMapSrc } from './geometry.js';
import { setStatus } from './keyboard.js';
import { S } from './store.js';
let groups = [];
let mapSrc = '';
let file = '';
let pollTimer = null;
const listeners = [];

export function onLegendChanged(fn) { listeners.push(fn); }
function announce() { listeners.forEach(fn => { try { fn(groups); } catch (e) {} }); }

export function legendGroups() { return groups; }
export function legendFile() { return file; }
export function legendCount() {
  return groups.reduce((n, g) => n + g.entries.length, 0);
}

export function setLegendMap(src) {
  const next = src ? relMapSrc(src) : '';
  if (next === mapSrc) return;
  mapSrc = next;
  groups = []; file = '';
  announce();
  loadLegend(true);
}

export async function loadLegend(silent) {
  if (!mapSrc) { groups = []; file = ''; announce(); return; }
  try {
    const r = await fetch('/api/legend?map=' + encodeURIComponent(mapSrc), { cache: 'no-store' });
    const d = await r.json();
    const next = d.groups || [];
    if (JSON.stringify(next) !== JSON.stringify(groups) || d.file !== file) {
      groups = next; file = d.file || '';
      announce();
    }
  } catch (e) { /* offline: the map still works, the legend just does not update */ }
}

// Writes a template into the vault so "start a legend" opens something in
// Obsidian rather than leaving the GM to guess the filename.
export async function startLegend() {
  if (!mapSrc) return '';
  try {
    const r = await fetch('/api/legend/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ map: mapSrc }),
    });
    const d = await r.json();
    await loadLegend(true);
    return d.file || '';
  } catch (e) { return ''; }
}

export function startLegendPolling(ms) {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) loadLegend(true); }, ms || 4000);
}

// ------------------------------------------------------------------ paint ---
const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g,
  c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

// One renderer for all three surfaces — the sidebar, the projector card and a
// player's phone show the same rows at different sizes.
export function legendHTML() {
  if (!groups.length) return '';
  return groups.map(g =>
    (g.title ? '<div class="lg-group">' + esc(g.title) + '</div>' : '')
    + g.entries.map(e =>
      '<div class="lg-row">'
      + (e.icon ? '<span class="lg-icon" style="background-image:url(&quot;'
                  + esc(encodeURI(e.icon)) + '&quot;)"></span>'
                : '<span class="lg-icon lg-icon-none"></span>')
      + '<span class="lg-text">'
      + (e.name ? '<b>' + esc(e.name) + '</b>' : '')
      + (e.name && e.text ? ' — ' : '')
      + (e.text ? '<span class="lg-gloss">' + esc(e.text) + '</span>' : '')
      + '</span></div>').join('')
  ).join('');
}

// ------------------------------------------------------------------- GM ---
const el = (id) => document.getElementById(id);

export function renderLegendPanel() {
  const body = el('legend-body');
  if (!body) return;
  const n = legendCount();
  const status = el('legend-status');
  if (status) status.textContent = n ? (n + ' entries') : 'none yet';
  if (!n) {
    body.innerHTML = '<div style="color:#888;font-size:11px;">'
      + (mapSrc
          ? 'No legend for this map yet. Start one and write it in Obsidian — it appears here as you save.'
          : 'Load a map first.')
      + '</div>';
  } else {
    body.innerHTML = '<div class="legend-list">' + legendHTML() + '</div>'
      + (file ? '<div style="font-size:10px;color:#666;margin-top:6px;word-break:break-all;">'
                + esc(file) + '</div>' : '');
  }
  const btn = el('btn-legend-show');
  if (btn) btn.classList.toggle('active', !!S.legendOnProjector);
}

// The projector and the players' page both take the legend over the same
// channels the tokens use, so it arrives with everything else.
export function toggleLegendOnProjector() {
  S.legendOnProjector = !S.legendOnProjector;
  pushLegend();
  renderLegendPanel();
}

export function pushLegend() {
  if (S.mapChannel) {
    S.mapChannel.postMessage({
      type: 'legend',
      show: !!S.legendOnProjector,
      html: S.legendOnProjector ? legendHTML() : '',
    });
  }
}

// ------------------------------------------------------------ projector ---
export function projectorLegend(d) {
  const box = el('player-legend');
  if (!box) return;
  if (!d.show || !d.html) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.innerHTML = d.html;
  box.style.display = 'block';
  fitLegendBox(box);
}

// Shrink the type until every entry fits the card. Nobody can scroll a wall,
// so a legend that overflows is not "mostly shown" — the rows past the fold
// simply never reach the table, and silently.
export function fitLegendBox(box) {
  const MIN = 0.45;
  let scale = 1;
  box.style.setProperty('--lg-scale', scale);
  const overflows = () => box.scrollHeight > box.clientHeight + 1
                       || box.scrollWidth > box.clientWidth + 1;
  while (overflows() && scale > MIN) {
    scale = Math.max(MIN, +(scale - 0.05).toFixed(2));
    box.style.setProperty('--lg-scale', scale);
  }
  return scale;
}

// "Start one" writes the template and then tells the GM where it went, since
// the whole point is that they go and edit it in Obsidian.
export async function startLegendFromButton() {
  const path = await startLegend();
  setStatus(path ? ('Legend started — edit it in Obsidian: ' + path)
                 : 'Could not create the legend file');
  renderLegendPanel();
}

export function initLegendGM() {
  onLegendChanged(() => { renderLegendPanel(); if (S.legendOnProjector) pushLegend(); });
  setLegendMap(S.lastMapSrc || '');
  startLegendPolling(4000);
  renderLegendPanel();
}

// Called when the GM switches map: the legend belongs to the map.
export function legendOnMapChanged() {
  setLegendMap(S.lastMapSrc || '');
}
