// GM Display — tokens.js
// The GM side: token roster, per-map placement, rendering, controls.
import { drawNoteMarkers, initCellNotes, notesOnMapChanged } from './cell-notes.js';
import { rlEncode } from './games.js';
import { TOKEN_SIDES, cellAtMapPx, cellLabel, clamp01, drawMapGrid, isFlatHex, isHexKey, isParty, kCellH, kCellW, kRegularStepY, kStepY, kTokenDiam, mapDims, relMapSrc, snapNorm, tokenClass, tokenDisplayName, tokenFrac, uid } from './geometry.js';
import { setStatus } from './keyboard.js';
import { initLegendGM, legendOnMapChanged } from './legend.js';
import { ensureMarkerLoop } from './markers.js';
import { parseHexColor } from './navigation.js';
import { campaignKey, gameKey } from './state.js';
import { S } from './store.js';
// ===================================================================
// GM SIDE
// ===================================================================
// One-time seed of the six pre-generated Delta Green agents into the Delta
// Green campaign's shared token store. Runs only if that campaign exists and
// hasn't been seeded; preserves any tokens already there and never resurrects
// ones the GM later deletes (guarded by a localStorage flag). Portraits live in
// the vault under .tools/gm-display/agent-tokens and are served via /maps/.
function maybeSeedDeltaGreenAgents() {
  const dg = S.campaigns.find(c => c.slug === 'delta-green');
  if (!dg) return;
  const flag = 'gm-display:camp:delta-green:seeded';
  if (localStorage.getItem(flag)) return;
  // Ensure any legacy single-blob token store is migrated to roster format
  // first, so seeding merges instead of shadowing it.
  migrateLegacyTokens('delta-green',
    S.activeCampaign === 'delta-green' ? S.lastMapSrc : null);
  const key = 'gm-display:camp:delta-green:roster';
  let doc = { roster: [], tokenGridEnabled: true, tokenGridCells: 24 };
  try { const r = localStorage.getItem(key); if (r) doc = JSON.parse(r); } catch (e) {}
  if (!Array.isArray(doc.roster)) doc.roster = [];
  const have = new Set(doc.roster.map(t => t.base));
  const img = n => '/maps/.tools/gm-display/agent-tokens/' + n + '.png';
  const defs = [
    ['SA Cornwell', 'Cornwell', '#3b6fb0'],
    ['Dr. Kamaroff', 'Kamaroff', '#7a4fb0'],
    ['Kurtz', 'Kurtz', '#2f9e6f'],
    ['McMurtry', 'McMurtry', '#b07a2f'],
    ['Dr. Palmer', 'Palmer', '#b03b6f'],
    ['Dr. Schell', 'Schell', '#4f8fb0'],
  ];
  const seeds = defs.filter(d => !have.has(d[0])).map((d) => ({
    id: uid('t'), base: d[0], num: 0, color: d[2], img: img(d[1]), side: 'pc',
    owner: '', ownerColor: ''
  }));
  if (seeds.length) {
    doc.roster = doc.roster.concat(seeds);
    localStorage.setItem(key, JSON.stringify(doc));
  }
  localStorage.setItem(flag, '1');
}

// === Per-map grid calibration ======================================
// The key describes the grid in map pixels, so it belongs to the MAP, not the
// campaign. Campaign-wide grid settings stay as the default for maps that have
// never been calibrated.
export function mapKeyStorageKey(src) { return gameKey('key:' + relMapSrc(src || '__no-map__')); }

// `src` is required, deliberately. On the first map load there is no outgoing
// map, and a `src || S.lastMapSrc` fallback would then write the INCOMING map's
// entry — masking any calibration it ships with.
function saveMapKey(src) {
  if (S.isPlayerView || S.isRemoteView || !src) return;
  try {
    localStorage.setItem(mapKeyStorageKey(src), JSON.stringify({
      type: S.tokenGridType, cells: S.tokenGridCells, enabled: S.tokenGridEnabled,
      cell: S.keyCellPx, cellY: S.keyCellYPx, ox: S.keyOx, oy: S.keyOy, link: S.keyLinkXY
    }));
  } catch (e) { console.warn('save map key failed', e); }
}

function applySavedMapKey(src) {
  if (S.isPlayerView || S.isRemoteView) return;
  let k = null;
  try { const raw = localStorage.getItem(mapKeyStorageKey(src)); if (raw) k = JSON.parse(raw); } catch (e) {}
  if (k) {
    if (typeof k.enabled === 'boolean') S.tokenGridEnabled = k.enabled;
    if (k.cells) S.tokenGridCells = k.cells;
    if (k.type) S.tokenGridType = k.type;
    S.keyCellPx  = +k.cell  || 0;
    S.keyCellYPx = +k.cellY || 0;
    S.keyOx = +k.ox || 0;
    S.keyOy = +k.oy || 0;
    S.keyLinkXY = k.link !== false;
  } else {
    // Never calibrated here. A map may still ship a calibration beside its
    // notes in the vault — fetch it, so a prepared map arrives ready to use.
    S.keyCellPx = 0; S.keyCellYPx = 0; S.keyOx = 0; S.keyOy = 0; S.keyLinkXY = true;
    applyShippedMapKey(src);
  }
  syncKeyPanel();
}

// A calibration shipped with the map, at Map Notes/<map>.key.json in the vault.
// Only consulted when this browser has never calibrated the map itself, so a
// local adjustment always wins.
async function applyShippedMapKey(src) {
  if (!src) return;
  try {
    const r = await fetch('/api/mapkey?map=' + encodeURIComponent(relMapSrc(src || '')));
    const d = await r.json();
    const k = d && d.key;
    if (!k || relMapSrc(S.lastMapSrc || '') !== relMapSrc(src || '')) return;
    if (k.shape) setKeyShape(k.shape);
    if (typeof k.enabled === 'boolean') S.tokenGridEnabled = k.enabled;
    S.keyCellPx  = +k.cell  || 0;
    S.keyCellYPx = +k.cellY || 0;
    S.keyOx = +k.ox || 0;
    S.keyOy = +k.oy || 0;
    S.keyLinkXY = k.link !== false;
    resnapAllTokens();
    keyChanged();
    setStatus('Grid calibration loaded from the vault');
  } catch (e) { /* no server, or no shipped key — the sliders still work */ }
}

// === Per-map token storage =========================================
// Roster (defs) is campaign-wide:      gm-display:camp:<c>:roster
// Placements (tx/ty/onMap) are per-map: gm-display:camp:<c>:map-tokens:<src>
export function mapTokensKey(src) {
  return campaignKey('map-tokens:' + (src || '__no-map__'));
}

// One-time migration from the legacy single-blob store
// (gm-display:camp:<c>:tokens) to roster + per-map placements. The legacy
// positions/visibility land on `mapSrc` (the map active at migration time).
function migrateLegacyTokens(campSlug, mapSrc) {
  const rosterKey = `gm-display:camp:${campSlug}:roster`;
  if (localStorage.getItem(rosterKey)) return;
  const raw = localStorage.getItem(`gm-display:camp:${campSlug}:tokens`);
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    const toks = Array.isArray(s.tokens) ? s.tokens : [];
    const defs = toks.map(t => ({
      id: t.id, base: t.base, num: t.num || 0, color: t.color, img: t.img || '',
      side: TOKEN_SIDES.includes(t.side) ? t.side : 'npc',
      owner: t.owner || '', ownerColor: t.ownerColor || ''
    }));
    const placements = {};
    toks.forEach(t => {
      placements[t.id] = { tx: t.tx, ty: t.ty, onMap: !!(t.owner || t.onMap) };
    });
    localStorage.setItem(rosterKey, JSON.stringify({
      roster: defs,
      tokenGridEnabled: s.tokenGridEnabled, tokenGridCells: s.tokenGridCells,
      tokenGridType: s.tokenGridType, tokenGridColor: s.tokenGridColor
    }));
    localStorage.setItem(
      `gm-display:camp:${campSlug}:map-tokens:${mapSrc ? relMapSrc(mapSrc) : '__no-map__'}`,
      JSON.stringify({ placements }));
    console.log(`[GM Display] Migrated legacy tokens for campaign "${campSlug}" (${defs.length} defs)`);
  } catch (e) { console.warn('token migration failed', e); }
}

// Build the active token set for a map: all PCs + NPCs placed on that map,
// hydrating per-map position/visibility into the shared def objects.
function hydrateTokensForMap(src) {
  // Normalize to an origin-relative path — img.src is sometimes absolute
  // (http://localhost:7680/maps/...) and sometimes relative (/maps/...).
  S.tokenMapSrc = src ? relMapSrc(src) : null;
  let placements = {};
  try {
    const raw = localStorage.getItem(mapTokensKey(S.tokenMapSrc));
    if (raw) placements = JSON.parse(raw).placements || {};
  } catch (e) {}
  S.tokens = [];
  let pcIdx = 0;
  S.roster.forEach(d => {
    const p = placements[d.id];
    if (d.side === 'party') {
      // The Company travels with the game, so it is on every map. It starts in
      // the middle rather than the PC row — on a realm map that is roughly
      // where a party begins, and it is never hiding under a portrait.
      d.tx = p ? clamp01(p.tx) : 0.5;
      d.ty = p ? clamp01(p.ty) : 0.5;
      d.onMap = p ? !!p.onMap : true;
      d.pending = null;
      S.tokens.push(d);
    } else if (d.side === 'pc') {
      // PCs are on every map. Default spot: staggered row near the bottom.
      d.tx = p ? clamp01(p.tx) : clamp01(0.15 + (pcIdx * 0.1) % 0.7);
      d.ty = p ? clamp01(p.ty) : 0.9;
      // Visibility is per-map; claimed PCs default to visible on new maps.
      d.onMap = p ? !!p.onMap : !!d.owner;
      d.pending = null;
      pcIdx++;
      S.tokens.push(d);
    } else if (p) {
      d.tx = clamp01(p.tx); d.ty = clamp01(p.ty); d.onMap = !!p.onMap;
      d.pending = null;
      S.tokens.push(d);
    }
  });
}

// Switch the token layer to a different map. Persists the outgoing map's
// placements first, then hydrates the new map's.
export function setTokenMap(src) {
  if (S.isPlayerView || S.isRemoteView || !S.tokensReady) return;
  src = src ? relMapSrc(src) : null;
  if (src === S.tokenMapSrc) return;
  saveTokens();                       // outgoing map, keyed by old tokenMapSrc
  // Name the outgoing map explicitly: S.lastMapSrc already points at the
  // incoming one, so an unqualified save would stamp the new map with the old
  // map's calibration and mask any key it ships with.
  saveMapKey(S.tokenMapSrc);
  hydrateTokensForMap(src);
  applySavedMapKey(src);
  notesOnMapChanged();                // notes belong to the map, not the session
  legendOnMapChanged();               // and so does the legend
  renderTokenList();
  renderGMTokens();
  broadcastTokens();
  pushTokensToServer();
  saveTokens();
}

export function initTokensGM() {
  maybeSeedDeltaGreenAgents();
  loadTokens();
  const _set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
  _set('tokgrid-cells', el => el.value = S.tokenGridCells);
  _set('tokgrid-cells-val', el => el.textContent = S.tokenGridCells);
  _set('tokgrid-status', el => el.textContent = S.tokenGridEnabled ? 'ON' : 'OFF');
  _set('btn-tokgrid', el => el.classList.toggle('active', S.tokenGridEnabled));
  updateGridShapeButton();
  initGridColorControls();
  document.getElementById('marker-color').value = S.markerColor;
  attachGmMarkerHandlers();
  renderTokenList();
  renderGMTokens();
  refreshTokenImageOptions();
  applySavedMapKey(S.lastMapSrc);
  initCellNotes();
  initLegendGM();
  syncKeyPanel();
  attachKeyNudgeKeys();
  pushTokensToServer();
  // Drain player actions + pull remote markers a few times a second.
  setInterval(gmLiveTick, 350);
}

// Arrow keys nudge the grid origin while the Grid Calibration panel is open —
// the fastest way to walk an overlay onto a printed grid.
function attachKeyNudgeKeys() {
  document.addEventListener('keydown', (e) => {
    const panel = document.getElementById('section-mapkey');
    if (!panel || !panel.open) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    nudgeKeyOrigin(d[0], d[1], e.shiftKey ? 10 : (e.altKey ? 0.1 : 1));
  });
}

// Creating a token adds it to the GLOBAL roster and (in one step) to the
// current map's active set.
export function createTokenFromForm() {
  const nameEl = document.getElementById('tok-name');
  const name = (nameEl.value || '').trim();
  if (!name) { nameEl.focus(); return; }
  const color = document.getElementById('tok-color').value;
  const img = document.getElementById('tok-image').value || '';
  const side = document.getElementById('tok-side').value || 'npc';
  const c = snapNorm(0.5, 0.5);            // land on a cell centre, not mid-cell
  const t = {
    id: uid(), base: name, num: 0, color, img, side,
    tx: c.tx, ty: c.ty, onMap: false, owner: '', ownerColor: '', pending: null
  };
  S.roster.push(t);
  S.tokens.push(t);
  nameEl.value = '';
  onTokensChanged();
}

// The Company: the party as one piece. There is only ever one per campaign, so
// the button either creates it or brings the existing one back onto this map.
export function addCompanyToken() {
  let t = S.roster.find(x => x.side === 'party');
  if (!t) {
    const nameEl = document.getElementById('tok-name');
    const typed = ((nameEl && nameEl.value) || '').trim();
    t = {
      id: uid(), base: typed || 'The Company', num: 0,
      // Always gold. The Company is identified by its double ring rather than
      // by a colour a player might also be using.
      color: '#d4a017',
      img: (document.getElementById('tok-image') || {}).value || '',
      side: 'party', tx: 0.5, ty: 0.5, onMap: true,
      owner: '', ownerColor: '', pending: null,
    };
    const c = snapNorm(t.tx, t.ty);
    t.tx = c.tx; t.ty = c.ty;
    S.roster.push(t);
    if (nameEl) nameEl.value = '';
  }
  if (!S.tokens.includes(t)) S.tokens.push(t);
  t.onMap = true;
  onTokensChanged();
  setStatus(tokenDisplayName(t) + ' is on the map — drag it, or let a player propose the move');
}

// Add an existing roster NPC to the current map.
function addRosterTokenToMap(id) {
  const d = S.roster.find(t => t.id === id);
  if (!d || S.tokens.includes(d)) return;
  const c = snapNorm(0.5, 0.5);
  d.tx = c.tx; d.ty = c.ty; d.onMap = false; d.pending = null;
  S.tokens.push(d);
  onTokensChanged();
}
export function addRosterTokenFromSelect() {
  const sel = document.getElementById('tok-roster-add');
  if (!sel || !sel.value) return;
  addRosterTokenToMap(sel.value);
}

// Remove an NPC from THIS map only (it stays in the global roster).
function removeTokenFromMap(id) {
  S.tokens = S.tokens.filter(t => t.id !== id);
  onTokensChanged();
}

export function duplicateToken(id) {
  const src = S.tokens.find(t => t.id === id);
  if (!src || isParty(src)) return;      // there is only one Company
  const group = S.roster.filter(t => t.base === src.base);
  if (group.length === 1 && group[0].num === 0) group[0].num = 1; // first dupe numbers the original
  const maxNum = Math.max(0, ...group.map(t => t.num));
  const { mw, mh } = mapDims();
  const off = { nx: kCellW(mw) / mw, ny: kCellH(mw) / mh };
  const dup = snapNorm(clamp01(src.tx + off.nx), clamp01(src.ty + off.ny));
  const copy = {
    ...src, id: uid(), num: maxNum + 1, owner: '', ownerColor: '', pending: null,
    tx: dup.tx, ty: dup.ty
  };
  S.roster.push(copy);
  S.tokens.push(copy);
  onTokensChanged();
}

// Delete from the global roster (and therefore from every map).
function deleteToken(id) {
  const d = S.roster.find(t => t.id === id);
  if (d && !confirm(`Delete "${tokenDisplayName(d)}" from the campaign roster (all maps)?`)) return;
  S.roster = S.roster.filter(t => t.id !== id);
  S.tokens = S.tokens.filter(t => t.id !== id);
  onTokensChanged();
}

function onTokensChanged() {
  renderTokenList();
  renderGMTokens();
  broadcastTokens();
  pushTokensToServer();
  saveTokens();
}

// approve / reject a proposed move
export function approveMove(id) {
  const t = S.tokens.find(x => x.id === id);
  if (!t || !t.pending) return;
  t.tx = t.pending.tx; t.ty = t.pending.ty; t.pending = null;
  onTokensChanged();
}
function rejectMove(id) {
  const t = S.tokens.find(x => x.id === id);
  if (!t) return;
  t.pending = null;
  onTokensChanged();
}

// Where a token is standing, in your row,column notation. Empty when the map
// has no calibration, because then a cell address would be a guess.
export function cellHere(t) {
  if (!t || !S.tokenGridEnabled) return '';
  const { mw, mh } = mapDims();
  if (!mw || !mh) return '';
  return cellLabel(cellAtMapPx(t.tx * mw, t.ty * mh, mw, mh));
}

// ---- GM sidebar token list (current map's active set) ----
export function renderTokenList() {
  const wrap = document.getElementById('token-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!S.tokens.length) {
    wrap.innerHTML = '<div style="color:#666;font-size:11px;">No tokens on this map yet.</div>';
  }
  S.tokens.forEach(t => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;background:#1d1d22;border:1px solid #333;border-radius:4px;padding:3px 5px;';
    const sw = document.createElement('span');
    sw.style.cssText = 'width:14px;height:14px;border-radius:50%;flex:none;border:1px solid #000;background:' + (t.img ? '#444' : t.color);
    if (t.img) { sw.style.backgroundImage = 'url("' + t.img + '")'; sw.style.backgroundSize = 'cover'; }
    if (isParty(t)) { sw.style.borderRadius = '3px'; sw.style.borderColor = '#ffcf5c'; }
    const label = document.createElement('span');
    label.style.cssText = 'flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    // On a keyed map the cell is the useful fact about a token — "The Company
    // is on 5,5" is what you actually want to read off the list.
    const where = S.tokenGridEnabled ? cellHere(t) : '';
    label.textContent = tokenDisplayName(t)
      + (where ? '  ·  ' + where : '')
      + (t.owner ? '  ·  ' + t.owner : '');
    label.title = isParty(t) ? 'The party, as one piece — any player may propose its move'
      : (t.owner ? ('Controlled by ' + t.owner) : (t.side === 'pc' ? 'Player token (unclaimed)' : 'NPC'));
    row.append(sw, label);
    // Show/hide on this map — applies to PCs too (split party!). Sticks per map.
    const vis = mkMini(t.onMap ? '◉' : '○',
      t.onMap ? 'Visible on this map — click to hide' : 'Hidden — click to show on this map',
      () => { t.onMap = !t.onMap; onTokensChanged(); });
    if (t.onMap) vis.style.color = '#6fd06f';
    row.append(vis);
    const dup = mkMini('⧉', 'Duplicate', () => duplicateToken(t.id));
    row.append(dup);
    // NPCs can be taken off this map without leaving the campaign roster.
    if (t.side === 'npc') {
      row.append(mkMini('✕', 'Remove from this map (stays in roster)', () => removeTokenFromMap(t.id)));
    }
    if (isParty(t)) dup.remove();   // there is only one Company
    row.append(mkMini('🗑', 'Delete from roster (all maps)', () => deleteToken(t.id)));
    if (t.owner) { const rel = mkMini('⏏', 'Release claim', () => { t.owner = ''; t.ownerColor = ''; onTokensChanged(); }); row.append(rel); }
    wrap.appendChild(row);
  });
  renderRosterAddOptions();
}

// Populate the "add NPC from roster" picker with roster NPCs not on this map.
function renderRosterAddOptions() {
  const sel = document.getElementById('tok-roster-add');
  const rowEl = document.getElementById('tok-roster-row');
  if (!sel || !rowEl) return;
  const activeIds = new Set(S.tokens.map(t => t.id));
  const avail = S.roster.filter(t => t.side === 'npc' && !activeIds.has(t.id));
  rowEl.style.display = avail.length ? 'flex' : 'none';
  sel.innerHTML = '<option value="">Add NPC from roster…</option>';
  avail.forEach(t => {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = tokenDisplayName(t);
    sel.appendChild(o);
  });
}
function mkMini(txt, title, fn) {
  const b = document.createElement('button');
  b.textContent = txt; b.title = title;
  b.style.cssText = 'flex:none;padding:2px 5px;font-size:11px;background:#2a2a30;border:1px solid #444;border-radius:3px;cursor:pointer;color:#ddd;';
  b.onclick = fn; return b;
}

export function refreshTokenImageOptions() {
  fetch('/api/maps').then(r => r.json()).then(list => {
    const sel = document.getElementById('tok-image');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">No image (colored disc)</option>';
    list.forEach(m => {
      const o = document.createElement('option');
      o.value = m.path; o.textContent = m.name;
      sel.appendChild(o);
    });
    sel.value = cur;
  }).catch(() => {});
}

export function toggleTokenGrid() {
  S.tokenGridEnabled = !S.tokenGridEnabled;
  document.getElementById('tokgrid-status').textContent = S.tokenGridEnabled ? 'ON' : 'OFF';
  document.getElementById('btn-tokgrid').classList.toggle('active', S.tokenGridEnabled);
  renderGMTokens(); broadcastTokens(); pushTokensToServer(); saveTokens();
}
function setTokenGridCells(v) {
  S.tokenGridCells = Math.max(4, Math.min(80, parseInt(v) || 24));
  document.getElementById('tokgrid-cells-val').textContent = S.tokenGridCells;
  // Coarse control: it sets the absolute cell size, which Grid Calibration
  // then fine-tunes. Keeping one number in charge avoids the two fighting.
  if (S.mapWidth) S.keyCellPx = S.mapWidth / S.tokenGridCells;
  if (S.keyLinkXY) S.keyCellYPx = 0;
  // Re-snap placed/owned tokens to the new grid so they stay on cell centers.
  resnapAllTokens();
  keyChanged();
}
export function setTokenGridColor() {
  const hex = document.getElementById('tokgrid-color').value;
  const op = (parseInt(document.getElementById('tokgrid-opacity').value) || 50) / 100;
  const [r, g, b] = parseHexColor(hex);
  S.tokenGridColor = `rgba(${r},${g},${b},${op})`;
  drawGMGrid(); broadcastTokens(); pushTokensToServer(); saveTokens();
}
function initGridColorControls() {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(S.tokenGridColor);
  if (!m) return;
  const hex = '#' + [m[1], m[2], m[3]].map(n => (+n).toString(16).padStart(2, '0')).join('');
  const c = document.getElementById('tokgrid-color'); if (c) c.value = hex;
  const o = document.getElementById('tokgrid-opacity'); if (o) o.value = Math.round((m[4] ? parseFloat(m[4]) : 0.5) * 100);
}
const KEY_SHAPES = ['square', 'hex', 'hexflat'];
const KEY_SHAPE_LABEL = { square: 'Square ⬛', hex: 'Hex ⬡', hexflat: 'Hex ⬢' };
function toggleGridShape() {
  setKeyShape(KEY_SHAPES[(KEY_SHAPES.indexOf(S.tokenGridType) + 1) % KEY_SHAPES.length]);
}
export function setKeyShape(shape) {
  S.tokenGridType = KEY_SHAPES.includes(shape) ? shape : 'square';
  updateGridShapeButton();
  resnapAllTokens();
  keyChanged();
}
function updateGridShapeButton() {
  const b = document.getElementById('btn-tokgrid-shape');
  if (b) b.textContent = KEY_SHAPE_LABEL[S.tokenGridType] || KEY_SHAPE_LABEL.square;
  KEY_SHAPES.forEach(k => {
    const el = document.getElementById('btn-key-' + k);
    if (el) el.classList.toggle('active', S.tokenGridType === k);
  });
  // vertical spacing is adjustable for every shape now — printed hex grids are
  // routinely a few percent off regular, which is what threw the overlay off
}

// --- map key controls ---
// One fan-out for every calibration change: redraw here, mirror to the
// projector and remote players, and remember it against this map.
function keyChanged() {
  syncKeyPanel();
  renderGMTokens();
  broadcastTokens(); pushTokensToServer(); pushPlayerStateToServer();
  saveTokens(); saveMapKey(S.lastMapSrc);
}
export function setKeyCell(v) {
  S.keyCellPx = Math.max(2, parseFloat(v) || 0);
  if (S.keyLinkXY) S.keyCellYPx = 0;
  resnapAllTokens();
  keyChanged();
}
export function nudgeKeyCell(d) { setKeyCell(kCellW(S.mapWidth) + d); }
// "Cells across" is just another way of stating the cell size; writing either
// updates the other, so the two can never contradict each other.
export function setKeyAcross(v) {
  const n = parseFloat(v);
  if (!n || n <= 0 || !S.mapWidth) return;
  setKeyCell(S.mapWidth / n);
}
export function setKeyCellY(v) { S.keyCellYPx = Math.max(2, parseFloat(v) || 0); resnapAllTokens(); keyChanged(); }
export function nudgeKeyCellY(d) { setKeyCellY(kStepY(S.mapWidth) + d); }
export function toggleKeyLink() {
  S.keyLinkXY = document.getElementById('key-link').checked;
  if (S.keyLinkXY) S.keyCellYPx = 0; else S.keyCellYPx = kStepY(S.mapWidth);
  resnapAllTokens();
  keyChanged();
}
export function setKeyOx(v) { S.keyOx = parseFloat(v) || 0; resnapAllTokens(); keyChanged(); }
export function setKeyOy(v) { S.keyOy = parseFloat(v) || 0; resnapAllTokens(); keyChanged(); }
export function nudgeKeyOrigin(dx, dy, step) {
  step = step || 1;
  S.keyOx += dx * step; S.keyOy += dy * step;
  resnapAllTokens();
  keyChanged();
}
export function resetMapKey() {
  S.keyCellPx = 0; S.keyCellYPx = 0; S.keyOx = 0; S.keyOy = 0; S.keyLinkXY = true;
  resnapAllTokens();
  keyChanged();
}
// Push the current key values back into the panel controls.
function syncKeyPanel() {
  const mw = S.mapWidth || 1000;
  const cw = kCellW(mw), ch = kCellH(mw);
  const set = (id, v) => { const el = document.getElementById(id); if (el && el.value != v) el.value = v; };
  const txt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const cellMax = Math.max(400, Math.round(mw / 3));
  const cs = document.getElementById('key-cell');
  if (cs) cs.max = cellMax;
  const cys = document.getElementById('key-celly');
  if (cys) cys.max = cellMax;
  ['key-ox', 'key-oy'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.min = -Math.ceil(cw); el.max = Math.ceil(cw); }
  });
  set('key-cell', cw.toFixed(1));
  set('key-celly', ch.toFixed(1));
  set('key-ox', S.keyOx.toFixed(1));
  set('key-oy', S.keyOy.toFixed(1));
  txt('key-cell-val', cw.toFixed(1) + ' px');
  txt('key-celly-val', ch.toFixed(1) + ' px');
  txt('key-ox-val', S.keyOx.toFixed(1));
  txt('key-oy-val', S.keyOy.toFixed(1));
  const across = S.mapWidth ? (S.mapWidth / cw) : 0;
  txt('key-across-val', across ? across.toFixed(2) : '—');
  if (document.activeElement !== document.getElementById('key-across'))
    set('key-across', across ? across.toFixed(2) : '');
  // keep the legacy integer form in step for anything still reading it
  if (across) {
    S.tokenGridCells = Math.max(1, Math.round(across));
    const legacy = document.getElementById('tokgrid-cells');
    if (legacy) legacy.value = S.tokenGridCells;
    const legacyVal = document.getElementById('tokgrid-cells-val');
    if (legacyVal) legacyVal.textContent = S.tokenGridCells;
  }
  const lk = document.getElementById('key-link');
  if (lk) lk.checked = S.keyLinkXY;
  const hex = isHexKey();
  const relabel = (id, text, valId, valText) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = text + ' <span class="val" id="' + valId + '">' + valText + '</span>';
  };
  relabel('key-cell-label',
    hex ? (isFlatHex() ? 'Column spacing (map px)' : 'Spacing along a row (map px)') : 'Cell size (map px)',
    'key-cell-val', cw.toFixed(1) + ' px');
  relabel('key-celly-label', hex ? 'Row spacing (map px)' : 'Row height (map px)',
    'key-celly-val', ch.toFixed(1) + ' px');
  txt('key-link-label', hex ? 'Regular hexes (row spacing follows)' : 'Square cells (row height = cell size)');
  const note = document.getElementById('key-aspect-note');
  if (note) {
    if (hex) {
      const pct = (ch / kRegularStepY(mw) - 1) * 100;
      note.textContent = Math.abs(pct) < 0.05 ? 'Regular hexagons.'
        : (pct < 0 ? Math.abs(pct).toFixed(1) + '% shorter than regular'
                   : pct.toFixed(1) + '% taller than regular');
    } else note.textContent = '';
  }
  const rc = document.getElementById('key-rowh-controls');
  if (rc) rc.style.display = S.keyLinkXY ? 'none' : '';
  updateGridShapeButton();
}
// Re-snap every token to the current grid (used when the grid shape/size changes).
function resnapAllTokens() {
  S.tokens.forEach(t => {
    const s = snapNorm(t.tx, t.ty); t.tx = s.tx; t.ty = s.ty;
    if (t.pending) { const p = snapNorm(t.pending.tx, t.pending.ty); t.pending.tx = p.tx; t.pending.ty = p.ty; }
  });
}

// ---- GM token rendering (DOM overlay on the fog view) ----
function gmLayerBox() {
  const layer = document.getElementById('gm-token-layer');
  return layer ? layer.getBoundingClientRect() : null;
}
export function renderGMTokens() {
  const layer = document.getElementById('gm-token-layer');
  if (!layer) return;
  layer.innerHTML = '';
  drawGMGrid();
  // Tokens belong to the MAP (projector) only. Never draw them while editing
  // fog on a sidecar handout (fogContext 'show') — that's the image display.
  if (S.currentMode !== 'fog' || S.fogContext !== 'map') return;
  const unit = (kTokenDiam(S.mapWidth) / (S.mapWidth || 1)) * 100;
  // Draw only tokens the GM has made visible on this map (onMap is per-map).
  S.tokens.filter(t => t.onMap).forEach(t => {
    const sizePct = unit * tokenFrac(t);
    // base token (solid) at its committed position
    layer.appendChild(makeTokenEl(t, t.tx, t.ty, sizePct, false, true));
    if (t.pending) {
      // ghosted proposed position + accept/reject controls
      layer.appendChild(makeTokenEl(t, t.pending.tx, t.pending.ty, sizePct, true, true));
      const ctrl = document.createElement('div');
      ctrl.className = 'token-approve';
      ctrl.style.left = (t.pending.tx * 100) + '%';
      ctrl.style.top = (t.pending.ty * 100 - sizePct) + '%';
      const ok = document.createElement('button'); ok.className = 'accept'; ok.textContent = '✓';
      ok.title = 'Approve move'; ok.onclick = (e) => { e.stopPropagation(); approveMove(t.id); };
      const no = document.createElement('button'); no.className = 'reject'; no.textContent = '✕';
      no.title = 'Reject move'; no.onclick = (e) => { e.stopPropagation(); rejectMove(t.id); };
      ctrl.append(ok, no);
      layer.appendChild(ctrl);
    }
  });
}
function makeTokenEl(t, tx, ty, sizePct, isGhost, draggable) {
  const el = document.createElement('div');
  el.className = 'token ' + tokenClass(t) + (isGhost ? ' ghost' : '') + (draggable ? ' draggable' : '');
  el.style.left = (tx * 100) + '%';
  el.style.top = (ty * 100) + '%';
  el.style.width = sizePct + '%';
  el.style.aspectRatio = '1';
  el.style.height = 'auto';
  if (t.img) { el.style.backgroundImage = 'url("' + t.img + '")'; }
  else { el.style.background = t.color; el.textContent = initialsOf(t.base); }
  if (!isGhost && t.ownerColor) el.style.borderColor = t.ownerColor;
  const lab = document.createElement('span');
  lab.className = 'tok-label';
  lab.textContent = tokenDisplayName(t);
  el.appendChild(lab);
  if (t.num > 0) { const n = document.createElement('span'); n.className = 'tok-num'; n.textContent = t.num; el.appendChild(n); }
  if (draggable) attachGmTokenDrag(el, t, isGhost);
  return el;
}
export function initialsOf(name) {
  return (name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 3).toUpperCase();
}

// GM dragging: a token with no pending move is moved directly (authoritative);
// dragging the ghost adjusts the proposed position before approval.
function attachGmTokenDrag(el, t, isGhost) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    let raw = { tx: isGhost ? t.pending.tx : t.tx, ty: isGhost ? t.pending.ty : t.ty };
    const box = gmLayerBox();
    const move = (ev) => {
      raw.tx = clamp01((ev.clientX - box.left) / box.width);
      raw.ty = clamp01((ev.clientY - box.top) / box.height);
      const s = snapNorm(raw.tx, raw.ty);
      if (isGhost) { t.pending.tx = s.tx; t.pending.ty = s.ty; }
      else { t.tx = s.tx; t.ty = s.ty; }
      el.style.left = (s.tx * 100) + '%'; el.style.top = (s.ty * 100) + '%';
      throttledTokenPush();
    };
    const up = (ev) => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      onTokensChanged();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}
let _tokPushTimer = null;
function throttledTokenPush() {
  renderGMGridOnly();
  if (_tokPushTimer) return;
  _tokPushTimer = setTimeout(() => { _tokPushTimer = null; broadcastTokens(); pushTokensToServer(); }, 110);
}
function renderGMGridOnly() { /* positions already set inline during drag */ }

function drawGMGrid() {
  const wrap = document.getElementById('gm-canvas-wrap');
  const gc = document.getElementById('gm-grid-canvas');
  if (!wrap || !gc) return;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  gc.width = w; gc.height = h;
  const ctx = gc.getContext('2d'); ctx.clearRect(0, 0, w, h);
  const { mw, mh } = mapDims();
  drawMapGrid(ctx, (mx, my) => ({ x: mx / mw * w, y: my / mh * h }), mw, mh, S.tokenGridColor);
  drawNoteMarkers();          // cells carrying a note get a pip on the same layer
}

// ---- GM marker drawing ----
export function toggleMarkerMode() {
  S.markerMode = !S.markerMode;
  S.markerColor = document.getElementById('marker-color').value;
  document.getElementById('marker-status').textContent = S.markerMode ? 'ON' : 'OFF';
  document.getElementById('btn-marker').classList.toggle('active', S.markerMode);
  const mc = document.getElementById('gm-marker-canvas');
  if (mc) mc.style.pointerEvents = S.markerMode ? 'auto' : 'none';
  const layer = document.getElementById('gm-token-layer');
  if (layer) layer.classList.toggle('markerblock', S.markerMode);
}
function attachGmMarkerHandlers() {
  const mc = document.getElementById('gm-marker-canvas');
  if (!mc) return;
  const box = () => mc.getBoundingClientRect();
  mc.addEventListener('pointerdown', (e) => {
    if (!S.markerMode) return;
    mc.setPointerCapture(e.pointerId);
    const b = box();
    S.markerColor = document.getElementById('marker-color').value;
    S._markerStroke = { id: uid('m'), by: S.myActorName, color: S.markerColor, points: [] };
    addMarkerPoint(e, b);
  });
  mc.addEventListener('pointermove', (e) => { if (S._markerStroke) addMarkerPoint(e, box()); });
  const end = () => { S._markerStroke = null; };
  mc.addEventListener('pointerup', end);
  mc.addEventListener('pointerleave', end);
}
function addMarkerPoint(e, box) {
  const tx = clamp01((e.clientX - box.left) / box.width);
  const ty = clamp01((e.clientY - box.top) / box.height);
  S._markerStroke.points.push([tx, ty]);
  S.activeMarkers[S._markerStroke.id] = { ...(S._markerStroke), t: Date.now() };
  postMarker(S._markerStroke);
  ensureMarkerLoop();
}
function postMarker(stroke) {
  // To server (remote players) + BroadcastChannel (local projector).
  fetch('/api/marker', { method: 'POST', body: JSON.stringify(stroke) }).catch(() => {});
  if (S.mapChannel) S.mapChannel.postMessage({ type: 'markers', markers: Object.values(S.activeMarkers) });
}

// ---- GM live tick: pull remote markers, drain player actions ----
function gmLiveTick() {
  fetch('/api/sync').then(r => r.json()).then(s => {
    // merge remote markers (skip our own ids to avoid lag on our screen)
    (s.markers || []).forEach(m => {
      if (m.by === S.myActorName) return;
      S.activeMarkers[m.id] = { ...m, t: Date.now() };
    });
    if (s.markers && s.markers.length) {
      if (S.mapChannel) S.mapChannel.postMessage({ type: 'markers', markers: Object.values(S.activeMarkers) });
      ensureMarkerLoop();
    }
  }).catch(() => {});
  fetch('/api/actions').then(r => r.json()).then(d => {
    if (!d.actions || !d.actions.length) return;
    let changed = false;
    d.actions.forEach(a => { if (applyPlayerAction(a)) changed = true; });
    if (changed) onTokensChanged();
  }).catch(() => {});
}
export function applyPlayerAction(a) {
  const t = S.tokens.find(x => x.id === a.tokenId);
  if (!t) return false;
  if (a.kind === 'claim') {
    if (!t.owner || t.owner === a.player) {
      t.owner = a.player; if (a.color) t.ownerColor = a.color;
      t.onMap = true;  // a freshly claimed PC becomes visible on the current map
      return true;
    }
    return false; // already claimed by someone else
  }
  if (a.kind === 'release') { if (t.owner === a.player) { t.owner = ''; t.ownerColor = ''; return true; } return false; }
  if (a.kind === 'propose') {
    if (t.owner && t.owner !== a.player) return false; // only controller may propose
    const s = snapNorm(a.tx, a.ty);
    t.pending = { tx: s.tx, ty: s.ty, by: a.player };
    return true;
  }
  return false;
}

// ---- push state outward ----
// Everything the other surfaces need to draw the same grid we do: the legacy
// `cells` plus the map-key calibration (absolute cell size and origin offset).
export function gridWirePayload() {
  return {
    enabled: S.tokenGridEnabled, cells: S.tokenGridCells,
    type: S.tokenGridType, color: S.tokenGridColor,
    cell: S.keyCellPx, cellY: S.keyCellYPx, ox: S.keyOx, oy: S.keyOy
  };
}
export function applyGridWire(g) {
  if (!g) return;
  S.tokenGridEnabled = !!g.enabled;
  S.tokenGridCells = g.cells || 24;
  S.tokenGridType = g.type || 'square';
  if (g.color) S.tokenGridColor = g.color;
  S.keyCellPx  = +g.cell  || 0;
  S.keyCellYPx = +g.cellY || 0;
  S.keyOx = +g.ox || 0;
  S.keyOy = +g.oy || 0;
}
export function broadcastTokens() {
  if (!S.mapChannel) return;
  S.mapChannel.postMessage({
    type: 'tokens',
    tokens: S.tokens,
    grid: gridWirePayload()
  });
}
let _serverTokTimer = null;
export function pushTokensToServer() {
  if (_serverTokTimer) return;
  _serverTokTimer = setTimeout(() => {
    _serverTokTimer = null;
    fetch('/api/tokens_state', {
      method: 'POST',
      body: JSON.stringify({
        tokens: S.tokens, grid: gridWirePayload(),
        mapW: S.mapWidth, mapH: S.mapHeight
      })
    }).catch(() => {});
  }, 60);
}
let _serverFrameTimer = null;
export function pushPlayerStateToServer() {
  if (S.isPlayerView || S.isRemoteView) return;
  if (!S.fogImage || !S.fogMask) return;
  if (_serverFrameTimer) return;
  _serverFrameTimer = setTimeout(() => {
    _serverFrameTimer = null;
    const payload = {
      // Send a RELATIVE path so remote players (on an ngrok/LAN origin) load the
      // map from their own origin — an absolute localhost URL would be
      // cross-origin, fail to load, and taint the fog canvas.
      imageSrc: relMapSrc(S.fogImage.src),
      width: S.mapWidth, height: S.mapHeight,
      fogRLE: rlEncode(S.fogMask),
      crop: S.viewportCrop,
      grid: gridWirePayload()
    };
    fetch('/api/player_state', { method: 'POST', body: JSON.stringify(payload) }).catch(() => {});
  }, 120);
}

// ---- persistence ----
// Roster (defs + grid settings) is campaign-wide; placements are per-map.
function saveTokens() {
  if (S.isPlayerView || S.isRemoteView || !S.tokensReady) return;
  try {
    const defs = S.roster.map(t => ({
      id: t.id, base: t.base, num: t.num || 0, color: t.color, img: t.img || '',
      side: TOKEN_SIDES.includes(t.side) ? t.side : 'npc',
      owner: t.owner || '', ownerColor: t.ownerColor || ''
    }));
    localStorage.setItem(campaignKey('roster'), JSON.stringify({
      roster: defs, tokenGridEnabled: S.tokenGridEnabled, tokenGridCells: S.tokenGridCells, tokenGridType: S.tokenGridType, tokenGridColor: S.tokenGridColor
    }));
    const placements = {};
    S.tokens.forEach(t => { placements[t.id] = { tx: t.tx, ty: t.ty, onMap: !!t.onMap }; });
    localStorage.setItem(mapTokensKey(S.tokenMapSrc), JSON.stringify({ placements }));
  } catch (e) { console.warn('save tokens failed', e); }
}
export function loadTokens() {
  S.tokensReady = false;
  S.roster = []; S.tokens = [];
  migrateLegacyTokens(S.activeCampaign, S.lastMapSrc);
  try {
    const raw = localStorage.getItem(campaignKey('roster'));
    if (raw) {
      const s = JSON.parse(raw);
      S.roster = Array.isArray(s.roster) ? s.roster : [];
      S.roster.forEach(t => { t.pending = null; if (t.owner === undefined) t.owner = ''; });
      if (typeof s.tokenGridEnabled === 'boolean') S.tokenGridEnabled = s.tokenGridEnabled;
      if (s.tokenGridCells) S.tokenGridCells = s.tokenGridCells;
      S.tokenGridType = ['hex', 'hexflat'].includes(s.tokenGridType) ? s.tokenGridType : 'square';
      if (s.tokenGridColor) S.tokenGridColor = s.tokenGridColor;
    }
  } catch (e) { console.warn('load tokens failed', e); }
  hydrateTokensForMap(S.lastMapSrc);
  S.tokensReady = true;
}
