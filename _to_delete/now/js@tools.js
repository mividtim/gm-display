// GM Display — tools.js
// One tool at a time, and one place that decides what a click on the map does.
//
// This used to be three independent flags — `S.currentTool` for the fog brush,
// `S.markerMode`, and a private `notesMode` in cell-notes — each reaching into
// the layer stack to switch pointer-events on its own. Nothing stopped two
// being on at once, and clicking the map meant different things depending on
// which panel you had touched last. There is now a single `S.activeTool`, and
// `applyTool()` below is the only code that decides which layer is live.
//
// The layer stack, bottom to top:
//   gm-map-canvas     the map
//   gm-fog-canvas     fog — painted by the Reveal/Hide tools
//   gm-grid-canvas    grid + note pips (never interactive)
//   gm-marker-canvas  the laser
//   gm-token-layer    token discs
//   gm-notes-layer    invisible click-catcher for Notes
import { S } from './store.js';
// 'none' first and deliberately: during play the safest thing a click on the
// map can do is nothing. Esc lands here.
export const TOOLS = ['none', 'reveal', 'hide', 'tokens', 'notes', 'marker'];

export const TOOL_META = {
  // key null: Escape is owned by keyboard.js, which escalates through it.
  none:   { key: null, keyLabel: 'Esc', icon: '⊘', label: 'None',
            hint: 'Clicks do nothing — safe while the map is up' },
  reveal: { key: 'r', icon: '☀', label: 'Reveal', panel: '#btn-reveal',
            hint: 'Paint fog away — drag on the map' },
  hide:   { key: 'h', icon: '☁', label: 'Hide', panel: '#btn-hide',
            hint: 'Paint fog back over the map' },
  tokens: { key: 'v', icon: '✥', label: 'Tokens', panel: '#token-list',
            hint: 'Drag tokens; they snap to the grid' },
  notes:  { key: 'n', icon: '✎', label: 'Notes', panel: '#note-list',
            hint: 'Click a cell to write a note on it' },
  marker: { key: 'm', icon: '✒', label: 'Marker', panel: '#btn-marker',
            hint: 'Draw a glowing line everyone sees' },
};

const el = (id) => document.getElementById(id);
// 'none' has no letter key — Escape reaches it, and keyboard.js owns Escape.
const keyLabel = (m) => m.keyLabel || (m.key ? m.key.toUpperCase() : '');
const listeners = [];
export function onToolChanged(fn) { listeners.push(fn); }

export function activeTool() { return S.activeTool; }
export function isTool(name) { return S.activeTool === name; }

export function setActiveTool(name, opts) {
  if (!TOOLS.includes(name)) return;
  S.activeTool = name;
  // The fog brush still needs to know which way it paints; the two fog tools
  // are the same brush with opposite polarity.
  if (name === 'reveal' || name === 'hide') S.currentTool = name;
  applyTool();
  if (!(opts && opts.silent)) {
    revealToolPanel(name);
    listeners.forEach(fn => { try { fn(name); } catch (e) {} });
  }
}

// The single place that decides which layer is live. Everything here is
// derived from S.activeTool — no other code should touch pointer-events on
// these elements, or we are back to two sources of truth.
export function applyTool() {
  const t = S.activeTool;
  const fogTool = (t === 'reveal' || t === 'hide');

  const fog = el('gm-fog-canvas');
  if (fog) {
    fog.style.pointerEvents = fogTool ? 'auto' : 'none';
    fog.style.cursor = fogTool ? 'crosshair' : 'default';
  }
  const marker = el('gm-marker-canvas');
  if (marker) marker.style.pointerEvents = (t === 'marker') ? 'auto' : 'none';

  const notes = el('gm-notes-layer');
  if (notes) notes.style.pointerEvents = (t === 'notes') ? 'auto' : 'none';

  // Tokens are only draggable under the Tokens tool. `markerblock` is the
  // existing class that makes the discs transparent to the pointer.
  const layer = el('gm-token-layer');
  if (layer) layer.classList.toggle('markerblock', t !== 'tokens');

  renderToolbar();
}

// Picking a tool brings its settings into view: the brush size lives with the
// fog tools, the roster with tokens, the note index with notes. Opening the
// section by hand every time is the kind of friction that makes people stop
// using the settings at all.
export function revealToolPanel(name) {
  const sel = (TOOL_META[name] || {}).panel;
  if (!sel) return;
  const anchor = document.querySelector(sel);
  if (!anchor) return;
  let el = anchor;
  while (el) {
    if (el.tagName === 'DETAILS') el.open = true;
    el = el.parentElement;
  }
  const section = anchor.closest('details.sb-section') || anchor;
  section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

export function renderToolbar() {
  const bar = el('tool-bar');
  if (!bar) return;
  if (!bar._built) {
    bar._built = true;
    bar.innerHTML = TOOLS.map(name => {
      const m = TOOL_META[name];
      return '<button class="tool-btn" data-tool="' + name + '" title="'
        + m.label + ' (' + keyLabel(m) + ') — ' + m.hint + '">'
        + '<span class="tb-icon">' + m.icon + '</span>'
        + '<span class="tb-label">' + m.label + '</span>'
        + '<span class="tb-key">' + keyLabel(m) + '</span></button>';
    }).join('') + '<span class="tool-hint" id="tool-hint"></span>';
    bar.querySelectorAll('[data-tool]').forEach(b =>
      b.addEventListener('click', () => setActiveTool(b.dataset.tool)));
  }
  bar.querySelectorAll('[data-tool]').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === S.activeTool));
  const hint = el('tool-hint');
  if (hint) hint.textContent = (TOOL_META[S.activeTool] || {}).hint || '';
}

// Keyboard. Deliberately single, unmodified letters: during play a hand is on
// the mouse and the other is picking a tool.
export function initTools() {
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.target.isContentEditable) return;
    const k = e.key.toLowerCase();
    const hit = TOOLS.find(n => TOOL_META[n].key && TOOL_META[n].key === k);
    if (!hit) return;
    e.preventDefault();
    setActiveTool(hit);
  });
  setActiveTool(S.activeTool || 'none', { silent: true });
}
