// GM Display — tokens.js
// Map-key geometry, tokens, markers, remote players.
// Classic script: load order matters (see gm_display.html).
// TOKENS · MARKERS · REMOTE PLAYERS
// ===================================================================
// Coordinate model: every token position is stored normalized (tx,ty in 0..1)
// as a fraction of the FULL map. Each surface (GM view, projector, remote page)
// transforms those into its own pixels, so a token is in the same map spot on
// every screen even though framing/crop differ. The GM page is authoritative:
// it owns the token list, pushes it to the local projector (BroadcastChannel)
// and to the server (for remote players), drains player-submitted actions, and
// is the only one that can approve a proposed move.
import { S } from './store.js';
import { rlDecode, rlEncode } from './games.js';
import { init } from './init.js';
import { parseHexColor } from './navigation.js';
import { renderPlayerFogDoubleBuffered } from './player-view.js';
import { campaignKey, gameKey, slugify } from './state.js';

// --- shared state ---
S.tokens = [];                 // tokens ACTIVE ON THE CURRENT MAP; mirrored on projector/remote
// Global roster: every token definition in the campaign (PCs + all NPCs).
// `tokens` is the subset active on the current map: all PCs, plus NPCs that
// have been added to this map. Positions + visibility (tx/ty/onMap) are
// per-map and hydrated into the shared def objects on map switch.
S.roster = [];
S.tokenMapSrc = null;          // map src whose placements are currently hydrated
S.tokensReady = false;         // guards saves until loadTokens() has run
let tokenGridEnabled = true;
let tokenGridCells = 24;
let tokenGridType = 'square';    // 'square' | 'hex' (pointy-top)
let tokenGridColor = 'rgba(120,200,255,0.5)';  // grid line color (rgba)
// --- Map key: per-map grid calibration -----------------------------------
// The old model could only say "N cells across the map width", with the grid
// origin welded to map pixel (0,0). That can't line up with a grid already
// printed on the map. These four values describe the grid in MAP PIXELS, so a
// printed grid can be matched exactly: cell size to a fraction of a pixel, and
// the origin nudged anywhere. Zero means "fall back to tokenGridCells".
let keyCellPx  = 0;   // cell width in map px  (hex: flat-to-flat distance)
let keyCellYPx = 0;   // cell height in map px, square only; 0 = same as width
let keyOx      = 0;   // grid origin offset in map px
let keyOy      = 0;
let keyLinkXY  = true;  // keep cell height locked to cell width
// Token diameter as a fraction of one grid cell (slightly inset so it nests
// neatly inside the square). Used consistently across GM/projector/remote.
const TOKEN_FRAC = 0.96;         // token diameter as a fraction of one grid cell
const SQRT3 = Math.sqrt(3);
let markerMode = false;          // GM marker-draw armed
const MARKER_TTL = 6.0;          // seconds (matches server)
let activeMarkers = {};          // id -> {id,by,color,points:[[tx,ty]],t(ms)}
let myActorId = 'gm-' + Math.random().toString(36).slice(2, 7);
let myActorName = 'GM';
let markerColor = '#39ff14';
let _markerStroke = null;        // stroke being drawn locally {id,color,points,by}
let _markerRAF = null;

// projector-side mirrors (populated from BroadcastChannel)
let pTokens = [];
let pTokenGrid = { enabled: true, cells: 24 };
S.playerRenderXform = null;    // set by renderPlayerFogDoubleBuffered

// remote-page state
S.isRemoteView = false;
let remoteClaimId = null;        // token id this remote controls
let remoteFrame = null;          // last player_state payload
let remoteFrameVer = -1, remoteTokVer = -1;
let remoteFit = null;            // {w,h} of the rendered (cropped) rectangle in px
let remoteCrop = null;           // {x,y,w,h} map-px crop currently shown
let remoteScale = 1;             // px per map-px for the current crop
let remoteImg = null;            // cached map image for repaints on resize
let remoteMarkerMode = false;
let remoteScreen = 'select';     // 'select' (roster) | 'play' (map)
let remotePlayerColor = '#39ff14';
let _remoteRestoreDone = false;  // auto-restore the claimed character once after a refresh
const REMOTE_COLORS = ['#39ff14', '#ff2db3', '#27c4ff', '#ffd23f', '#ff7a1a', '#b06bff', '#ff4d4d', '#1ee0b0'];

const uid = (p) => (p || 't') + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
// Convert an (often absolute) image URL to an origin-relative path so it loads
// from whatever origin the viewer is on (localhost, LAN, or ngrok). Data URLs
// are passed through unchanged.
export function relMapSrc(s) {
  if (!s || s.startsWith('data:')) return s;
  try { const u = new URL(s, location.href); return u.pathname + u.search; } catch (e) { return s; }
}
export function tokenDisplayName(t) { return t.num > 0 ? (t.base + ' ' + t.num) : t.base; }

// ---- grid geometry & snapping ----
// The grid is defined in MAP pixel coordinates so it stays locked to the map as
// any surface pans/zooms. `tokenGridCells` = columns across the map width.
function mapDims() {
  return {
    mw: S.mapWidth || (remoteFrame && remoteFrame.width) || 1,
    mh: S.mapHeight || (remoteFrame && remoteFrame.height) || 1
  };
}
// Grid spacing in MAP PIXELS, as two independent numbers.
//   square      : cell width, cell height
//   flat-top hex: column spacing, vertical spacing of stacked centres
//   pointy hex  : spacing along a row, row spacing
// Two numbers rather than one because printed grids are very often NOT regular
// hexagons — a few percent of vertical squash is common, and with a single
// size the overlay drifts off the printed grid by half a cell across a map.
export function kStepX(mw) {
  if (keyCellPx > 0) return keyCellPx;
  mw = mw || mapDims().mw;
  return Math.max(2, mw / (tokenGridCells || 24));
}
export function kStepY(mw) {
  if (keyCellYPx > 0) return keyCellYPx;
  const sx = kStepX(mw);
  if (!isHexKey()) return sx;                       // square: same as width
  return isFlatHex() ? sx * (2 / SQRT3) : sx * (SQRT3 / 2);   // regular hexagon
}
function kCellW(mw) { return kStepX(mw); }
function kCellH(mw) { return kStepY(mw); }
// Largest circle that fits a cell of either shape.
function kTokenDiam(mw) { return Math.min(kStepX(mw), kStepY(mw)); }
function isHexKey() { return tokenGridType === 'hex' || tokenGridType === 'hexflat'; }
function isFlatHex() { return tokenGridType === 'hexflat'; }
// The hex spacing that WOULD be regular, for the readout.
function kRegularStepY(mw) {
  const sx = kStepX(mw);
  return isFlatHex() ? sx * (2 / SQRT3) : sx * (SQRT3 / 2);
}

// Centre of hex (q,r), relative to the grid origin.
function hexToPx(q, r, sx, sy, flat) {
  return flat ? { x: sx * q,           y: sy * (r + q / 2) }
              : { x: sx * (q + r / 2), y: sy * r };
}
// Inverse. Dividing by the two steps first maps the (possibly stretched) grid
// onto the canonical lattice; a hex tiling is preserved exactly by that affine
// map, so cube rounding there picks exactly the right cell.
function hexAxial(x, y, sx, sy, flat) {
  const u = x / sx, v = y / sy;
  const q = flat ? u : u - v / 2;
  const r = flat ? v - u / 2 : v;
  let X = q, Z = r, Y = -X - Z;
  let rx = Math.round(X), ry = Math.round(Y), rz = Math.round(Z);
  const dx = Math.abs(rx - X), dy = Math.abs(ry - Y), dz = Math.abs(rz - Z);
  if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz; else rz = -rx - ry;
  return { q: rx, r: rz };
}
// Cell index under a map-px point, and the map-px centre of a cell index.
export function cellAtMapPx(mx, my, mw, mh) {
  const d = mapDims(); mw = mw || d.mw; mh = mh || d.mh;
  if (isHexKey()) return hexAxial(mx - keyOx, my - keyOy, kStepX(mw), kStepY(mw), isFlatHex());
  return { col: Math.floor((mx - keyOx) / kStepX(mw)), row: Math.floor((my - keyOy) / kStepY(mw)) };
}
export function cellCenterMapPx(cell, mw, mh) {
  const d = mapDims(); mw = mw || d.mw; mh = mh || d.mh;
  if (isHexKey()) {
    const c = hexToPx(cell.q, cell.r, kStepX(mw), kStepY(mw), isFlatHex());
    return { x: c.x + keyOx, y: c.y + keyOy };
  }
  return { x: keyOx + (cell.col + 0.5) * kStepX(mw), y: keyOy + (cell.row + 0.5) * kStepY(mw) };
}

export function snapNorm(tx, ty) {
  if (!tokenGridEnabled) return { tx: clamp01(tx), ty: clamp01(ty) };
  const { mw, mh } = mapDims();
  const c = cellCenterMapPx(cellAtMapPx(tx * mw, ty * mh, mw, mh), mw, mh);
  return { tx: clamp01(c.x / mw), ty: clamp01(c.y / mh) };
}
// Draw the grid (square or hex) using a map-px -> canvas-px transform `m2c`.
// This makes the same code work full-map (GM) or cropped (projector/remote).
function drawMapGrid(ctx, m2c, mw, mh, color) {
  if (!tokenGridEnabled) return;
  ctx.strokeStyle = color || 'rgba(120,200,255,0.30)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const sx = kStepX(mw), sy = kStepY(mw);
  if (isHexKey()) {
    const flat = isFlatHex(), pad = Math.max(sx, sy);
    if (flat) {
      const qA = Math.floor((-keyOx - pad) / sx), qB = Math.ceil((mw - keyOx + pad) / sx);
      for (let q = qA; q <= qB; q++) {
        const rA = Math.floor((-keyOy - pad) / sy - q / 2);
        const rB = Math.ceil((mh - keyOy + pad) / sy - q / 2);
        for (let r = rA; r <= rB; r++) hexPath(ctx, m2c, q, r, sx, sy, flat);
      }
    } else {
      const rA = Math.floor((-keyOy - pad) / sy), rB = Math.ceil((mh - keyOy + pad) / sy);
      for (let r = rA; r <= rB; r++) {
        const qA = Math.floor((-keyOx - pad) / sx - r / 2);
        const qB = Math.ceil((mw - keyOx + pad) / sx - r / 2);
        for (let q = qA; q <= qB; q++) hexPath(ctx, m2c, q, r, sx, sy, flat);
      }
    }
  } else {
    let x0 = keyOx % sx; if (x0 > 0) x0 -= sx;
    let y0 = keyOy % sy; if (y0 > 0) y0 -= sy;
    for (let x = x0; x <= mw + 0.5; x += sx) { const a = m2c(x, 0), b = m2c(x, mh); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    for (let y = y0; y <= mh + 0.5; y += sy) { const a = m2c(0, y), b = m2c(mw, y); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
  }
  ctx.stroke();
}
// A hex outline is the affine image of a regular one, so scale the vertex
// offsets by each axis independently — that keeps the drawn cell identical to
// the cell snapNorm computes, however stretched the grid is.
function hexPath(ctx, m2c, q, r, sx, sy, flat) {
  const c = hexToPx(q, r, sx, sy, flat);
  const cx = c.x + keyOx, cy = c.y + keyOy;
  const rx = flat ? sx / 1.5 : sx / SQRT3;
  const ry = flat ? sy / SQRT3 : sy / 1.5;
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i + (flat ? 0 : -30));
    const p = m2c(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
}

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

function saveMapKey() {
  if (S.isPlayerView || S.isRemoteView || !S.lastMapSrc) return;
  try {
    localStorage.setItem(mapKeyStorageKey(S.lastMapSrc), JSON.stringify({
      type: tokenGridType, cells: tokenGridCells, enabled: tokenGridEnabled,
      cell: keyCellPx, cellY: keyCellYPx, ox: keyOx, oy: keyOy, link: keyLinkXY
    }));
  } catch (e) { console.warn('save map key failed', e); }
}

function applySavedMapKey(src) {
  if (S.isPlayerView || S.isRemoteView) return;
  let k = null;
  try { const raw = localStorage.getItem(mapKeyStorageKey(src)); if (raw) k = JSON.parse(raw); } catch (e) {}
  if (k) {
    if (typeof k.enabled === 'boolean') tokenGridEnabled = k.enabled;
    if (k.cells) tokenGridCells = k.cells;
    if (k.type) tokenGridType = k.type;
    keyCellPx  = +k.cell  || 0;
    keyCellYPx = +k.cellY || 0;
    keyOx = +k.ox || 0;
    keyOy = +k.oy || 0;
    keyLinkXY = k.link !== false;
  } else {
    // Never calibrated: start from the campaign default, origin at (0,0).
    keyCellPx = 0; keyCellYPx = 0; keyOx = 0; keyOy = 0; keyLinkXY = true;
  }
  syncKeyPanel();
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
      side: t.side === 'pc' ? 'pc' : 'npc', owner: t.owner || '', ownerColor: t.ownerColor || ''
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
    if (d.side === 'pc') {
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
  saveMapKey();                       // outgoing map's grid calibration
  hydrateTokensForMap(src);
  applySavedMapKey(src);
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
  _set('tokgrid-cells', el => el.value = tokenGridCells);
  _set('tokgrid-cells-val', el => el.textContent = tokenGridCells);
  _set('tokgrid-status', el => el.textContent = tokenGridEnabled ? 'ON' : 'OFF');
  _set('btn-tokgrid', el => el.classList.toggle('active', tokenGridEnabled));
  updateGridShapeButton();
  initGridColorControls();
  document.getElementById('marker-color').value = markerColor;
  attachGmMarkerHandlers();
  renderTokenList();
  renderGMTokens();
  refreshTokenImageOptions();
  applySavedMapKey(S.lastMapSrc);
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
  if (!src) return;
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
    const label = document.createElement('span');
    label.style.cssText = 'flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    label.textContent = tokenDisplayName(t) + (t.owner ? '  ·  ' + t.owner : '');
    label.title = t.owner ? ('Controlled by ' + t.owner) : (t.side === 'pc' ? 'Player token (unclaimed)' : 'NPC');
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
  tokenGridEnabled = !tokenGridEnabled;
  document.getElementById('tokgrid-status').textContent = tokenGridEnabled ? 'ON' : 'OFF';
  document.getElementById('btn-tokgrid').classList.toggle('active', tokenGridEnabled);
  renderGMTokens(); broadcastTokens(); pushTokensToServer(); saveTokens();
}
function setTokenGridCells(v) {
  tokenGridCells = Math.max(4, Math.min(80, parseInt(v) || 24));
  document.getElementById('tokgrid-cells-val').textContent = tokenGridCells;
  // Coarse control: it sets the absolute cell size, which Grid Calibration
  // then fine-tunes. Keeping one number in charge avoids the two fighting.
  if (S.mapWidth) keyCellPx = S.mapWidth / tokenGridCells;
  if (keyLinkXY) keyCellYPx = 0;
  // Re-snap placed/owned tokens to the new grid so they stay on cell centers.
  resnapAllTokens();
  keyChanged();
}
export function setTokenGridColor() {
  const hex = document.getElementById('tokgrid-color').value;
  const op = (parseInt(document.getElementById('tokgrid-opacity').value) || 50) / 100;
  const [r, g, b] = parseHexColor(hex);
  tokenGridColor = `rgba(${r},${g},${b},${op})`;
  drawGMGrid(); broadcastTokens(); pushTokensToServer(); saveTokens();
}
function initGridColorControls() {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(tokenGridColor);
  if (!m) return;
  const hex = '#' + [m[1], m[2], m[3]].map(n => (+n).toString(16).padStart(2, '0')).join('');
  const c = document.getElementById('tokgrid-color'); if (c) c.value = hex;
  const o = document.getElementById('tokgrid-opacity'); if (o) o.value = Math.round((m[4] ? parseFloat(m[4]) : 0.5) * 100);
}
const KEY_SHAPES = ['square', 'hex', 'hexflat'];
const KEY_SHAPE_LABEL = { square: 'Square ⬛', hex: 'Hex ⬡', hexflat: 'Hex ⬢' };
function toggleGridShape() {
  setKeyShape(KEY_SHAPES[(KEY_SHAPES.indexOf(tokenGridType) + 1) % KEY_SHAPES.length]);
}
export function setKeyShape(shape) {
  tokenGridType = KEY_SHAPES.includes(shape) ? shape : 'square';
  updateGridShapeButton();
  resnapAllTokens();
  keyChanged();
}
function updateGridShapeButton() {
  const b = document.getElementById('btn-tokgrid-shape');
  if (b) b.textContent = KEY_SHAPE_LABEL[tokenGridType] || KEY_SHAPE_LABEL.square;
  KEY_SHAPES.forEach(k => {
    const el = document.getElementById('btn-key-' + k);
    if (el) el.classList.toggle('active', tokenGridType === k);
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
  saveTokens(); saveMapKey();
}
export function setKeyCell(v) {
  keyCellPx = Math.max(2, parseFloat(v) || 0);
  if (keyLinkXY) keyCellYPx = 0;
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
export function setKeyCellY(v) { keyCellYPx = Math.max(2, parseFloat(v) || 0); resnapAllTokens(); keyChanged(); }
export function nudgeKeyCellY(d) { setKeyCellY(kStepY(S.mapWidth) + d); }
export function toggleKeyLink() {
  keyLinkXY = document.getElementById('key-link').checked;
  if (keyLinkXY) keyCellYPx = 0; else keyCellYPx = kStepY(S.mapWidth);
  resnapAllTokens();
  keyChanged();
}
export function setKeyOx(v) { keyOx = parseFloat(v) || 0; resnapAllTokens(); keyChanged(); }
export function setKeyOy(v) { keyOy = parseFloat(v) || 0; resnapAllTokens(); keyChanged(); }
export function nudgeKeyOrigin(dx, dy, step) {
  step = step || 1;
  keyOx += dx * step; keyOy += dy * step;
  resnapAllTokens();
  keyChanged();
}
export function resetMapKey() {
  keyCellPx = 0; keyCellYPx = 0; keyOx = 0; keyOy = 0; keyLinkXY = true;
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
  set('key-ox', keyOx.toFixed(1));
  set('key-oy', keyOy.toFixed(1));
  txt('key-cell-val', cw.toFixed(1) + ' px');
  txt('key-celly-val', ch.toFixed(1) + ' px');
  txt('key-ox-val', keyOx.toFixed(1));
  txt('key-oy-val', keyOy.toFixed(1));
  const across = S.mapWidth ? (S.mapWidth / cw) : 0;
  txt('key-across-val', across ? across.toFixed(2) : '—');
  if (document.activeElement !== document.getElementById('key-across'))
    set('key-across', across ? across.toFixed(2) : '');
  // keep the legacy integer form in step for anything still reading it
  if (across) {
    tokenGridCells = Math.max(1, Math.round(across));
    const legacy = document.getElementById('tokgrid-cells');
    if (legacy) legacy.value = tokenGridCells;
    const legacyVal = document.getElementById('tokgrid-cells-val');
    if (legacyVal) legacyVal.textContent = tokenGridCells;
  }
  const lk = document.getElementById('key-link');
  if (lk) lk.checked = keyLinkXY;
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
  if (rc) rc.style.display = keyLinkXY ? 'none' : '';
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
  const sizePct = (kTokenDiam(S.mapWidth) / (S.mapWidth || 1)) * 100 * TOKEN_FRAC;
  // Draw only tokens the GM has made visible on this map (onMap is per-map).
  S.tokens.filter(t => t.onMap).forEach(t => {
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
  el.className = 'token ' + (t.side === 'pc' ? 'pc' : 'npc') + (isGhost ? ' ghost' : '') + (draggable ? ' draggable' : '');
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
function initialsOf(name) {
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
  drawMapGrid(ctx, (mx, my) => ({ x: mx / mw * w, y: my / mh * h }), mw, mh, tokenGridColor);
}

// ---- GM marker drawing ----
export function toggleMarkerMode() {
  markerMode = !markerMode;
  markerColor = document.getElementById('marker-color').value;
  document.getElementById('marker-status').textContent = markerMode ? 'ON' : 'OFF';
  document.getElementById('btn-marker').classList.toggle('active', markerMode);
  const mc = document.getElementById('gm-marker-canvas');
  if (mc) mc.style.pointerEvents = markerMode ? 'auto' : 'none';
  const layer = document.getElementById('gm-token-layer');
  if (layer) layer.classList.toggle('markerblock', markerMode);
}
function attachGmMarkerHandlers() {
  const mc = document.getElementById('gm-marker-canvas');
  if (!mc) return;
  const box = () => mc.getBoundingClientRect();
  mc.addEventListener('pointerdown', (e) => {
    if (!markerMode) return;
    mc.setPointerCapture(e.pointerId);
    const b = box();
    markerColor = document.getElementById('marker-color').value;
    _markerStroke = { id: uid('m'), by: myActorName, color: markerColor, points: [] };
    addMarkerPoint(e, b);
  });
  mc.addEventListener('pointermove', (e) => { if (_markerStroke) addMarkerPoint(e, box()); });
  const end = () => { _markerStroke = null; };
  mc.addEventListener('pointerup', end);
  mc.addEventListener('pointerleave', end);
}
function addMarkerPoint(e, box) {
  const tx = clamp01((e.clientX - box.left) / box.width);
  const ty = clamp01((e.clientY - box.top) / box.height);
  _markerStroke.points.push([tx, ty]);
  activeMarkers[_markerStroke.id] = { ...(_markerStroke), t: Date.now() };
  postMarker(_markerStroke);
  ensureMarkerLoop();
}
function postMarker(stroke) {
  // To server (remote players) + BroadcastChannel (local projector).
  fetch('/api/marker', { method: 'POST', body: JSON.stringify(stroke) }).catch(() => {});
  if (S.mapChannel) S.mapChannel.postMessage({ type: 'markers', markers: Object.values(activeMarkers) });
}

// ---- GM live tick: pull remote markers, drain player actions ----
function gmLiveTick() {
  fetch('/api/sync').then(r => r.json()).then(s => {
    // merge remote markers (skip our own ids to avoid lag on our screen)
    (s.markers || []).forEach(m => {
      if (m.by === myActorName) return;
      activeMarkers[m.id] = { ...m, t: Date.now() };
    });
    if (s.markers && s.markers.length) {
      if (S.mapChannel) S.mapChannel.postMessage({ type: 'markers', markers: Object.values(activeMarkers) });
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
    enabled: tokenGridEnabled, cells: tokenGridCells,
    type: tokenGridType, color: tokenGridColor,
    cell: keyCellPx, cellY: keyCellYPx, ox: keyOx, oy: keyOy
  };
}
function applyGridWire(g) {
  if (!g) return;
  tokenGridEnabled = !!g.enabled;
  tokenGridCells = g.cells || 24;
  tokenGridType = g.type || 'square';
  if (g.color) tokenGridColor = g.color;
  keyCellPx  = +g.cell  || 0;
  keyCellYPx = +g.cellY || 0;
  keyOx = +g.ox || 0;
  keyOy = +g.oy || 0;
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
      side: t.side === 'pc' ? 'pc' : 'npc', owner: t.owner || '', ownerColor: t.ownerColor || ''
    }));
    localStorage.setItem(campaignKey('roster'), JSON.stringify({
      roster: defs, tokenGridEnabled, tokenGridCells, tokenGridType, tokenGridColor
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
      if (typeof s.tokenGridEnabled === 'boolean') tokenGridEnabled = s.tokenGridEnabled;
      if (s.tokenGridCells) tokenGridCells = s.tokenGridCells;
      tokenGridType = ['hex', 'hexflat'].includes(s.tokenGridType) ? s.tokenGridType : 'square';
      if (s.tokenGridColor) tokenGridColor = s.tokenGridColor;
    }
  } catch (e) { console.warn('load tokens failed', e); }
  hydrateTokensForMap(S.lastMapSrc);
  S.tokensReady = true;
}

// ===================================================================
// PROJECTOR (BroadcastChannel mirror) — draws tokens + grid + markers
// onto canvases INSIDE #player-canvas-wrap so the keystone warp applies.
// ===================================================================
export function projectorHandleMessage(d) {
  if (d.type === 'tokens') {
    pTokens = d.tokens || [];
    if (d.grid) { pTokenGrid = d.grid; applyGridWire(d.grid); }
    drawProjectorOverlay();
    return;
  }
  if (d.type === 'markers') { d.markers.forEach(m => activeMarkers[m.id] = { ...m, t: Date.now() }); ensureMarkerLoop(); return; }
}
// map-normalized (tx,ty) -> projector pre-rotation canvas coords, given xform
function normToProjPre(tx, ty, xf) {
  const mx = tx * xf.mapW, my = ty * xf.mapH;
  return { x: (mx - xf.srcX) * xf.scale - xf.preW / 2, y: (my - xf.srcY) * xf.scale - xf.preH / 2 };
}
export function drawProjectorOverlay() {
  const xf = S.playerRenderXform;
  const tc = document.getElementById('player-token-canvas');
  if (!tc || !xf) return;
  tc.width = xf.wW; tc.height = xf.wH;
  tc.style.width = xf.wW + 'px'; tc.style.height = xf.wH + 'px';
  const ctx = tc.getContext('2d');
  ctx.clearRect(0, 0, xf.wW, xf.wH);
  ctx.save();
  ctx.translate(xf.wW / 2, xf.wH / 2);
  if (xf.rot) ctx.rotate(xf.rot * Math.PI / 180);
  // snap grid (so players see cells even inside black fog)
  if (pTokenGrid.enabled) drawProjGrid(ctx, xf);
  const rad = kTokenDiam(xf.mapW) * xf.scale * (TOKEN_FRAC / 2);
  pTokens.filter(t => t.onMap).forEach(t => {
    const p = normToProjPre(t.tx, t.ty, xf);
    drawTokenCircle(ctx, p.x, p.y, rad, t, false);
    if (t.pending) {
      const g = normToProjPre(t.pending.tx, t.pending.ty, xf);
      drawTokenCircle(ctx, g.x, g.y, rad, t, true);
    }
  });
  ctx.restore();
}
function drawProjGrid(ctx, xf) {
  drawMapGrid(ctx, (mx, my) => normToProjPre(mx / xf.mapW, my / xf.mapH, xf), xf.mapW, xf.mapH, tokenGridColor);
}
function drawTokenCircle(ctx, x, y, r, t, isGhost) {
  ctx.save();
  if (isGhost) ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (t.img && projTokenImg(t.img)) {
    ctx.save(); ctx.clip();
    const im = projTokenImg(t.img);
    ctx.drawImage(im, x - r, y - r, r * 2, r * 2);
    if (isGhost) { ctx.globalCompositeOperation = 'saturation'; ctx.fillStyle = '#888'; ctx.fillRect(x - r, y - r, r * 2, r * 2); }
    ctx.restore();
  } else {
    ctx.fillStyle = isGhost ? '#9aa' : t.color;
    ctx.fill();
  }
  ctx.lineWidth = Math.max(2, r * 0.12);
  ctx.strokeStyle = isGhost ? '#cfd6e0' : (t.ownerColor || (t.side === 'pc' ? '#5fd0ff' : '#ff7a6b'));
  if (isGhost) ctx.setLineDash([r * 0.4, r * 0.3]);
  ctx.stroke();
  ctx.setLineDash([]);
  // label (base name; the duplicate number is shown as a corner badge instead)
  ctx.globalAlpha = isGhost ? 0.7 : 1;
  ctx.fillStyle = '#fff';
  ctx.font = '700 ' + Math.max(10, r * 0.7) + 'px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.lineWidth = 3; ctx.strokeStyle = '#000';
  const nm = t.base;
  ctx.strokeText(nm, x, y + r + 2);
  ctx.fillText(nm, x, y + r + 2);
  // corner number badge for duplicated tokens
  if (t.num > 0) {
    const br = Math.max(7, r * 0.45);
    const bx = x + r * 0.72, by = y - r * 0.72;
    ctx.globalAlpha = isGhost ? 0.7 : 1;
    ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(14,14,18,0.95)'; ctx.fill();
    ctx.lineWidth = Math.max(1.5, br * 0.18); ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '800 ' + Math.round(br * 1.15) + 'px system-ui, sans-serif';
    ctx.fillText(String(t.num), bx, by + br * 0.05);
  }
  ctx.restore();
}
const _projImgCache = {};
function projTokenImg(src) {
  if (_projImgCache[src]) return _projImgCache[src].complete ? _projImgCache[src] : null;
  const im = new Image(); im.onload = () => drawProjectorOverlay(); im.src = src;
  _projImgCache[src] = im;
  return null;
}

// ===================================================================
// MARKERS — shared fade/render loop. Each surface supplies a projector fn.
// ===================================================================
function ensureMarkerLoop() {
  if (_markerRAF) return;
  const tick = () => {
    const now = Date.now();
    Object.keys(activeMarkers).forEach(id => {
      if ((now - activeMarkers[id].t) / 1000 > MARKER_TTL) delete activeMarkers[id];
    });
    drawAllMarkers();
    if (Object.keys(activeMarkers).length || _markerStroke) {
      _markerRAF = requestAnimationFrame(tick);
    } else { _markerRAF = null; drawAllMarkers(); }
  };
  _markerRAF = requestAnimationFrame(tick);
}
function drawMarkersOn(canvas, toXY) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const now = Date.now();
  Object.values(activeMarkers).forEach(m => {
    if (!m.points || m.points.length < 1) return;
    const age = (now - m.t) / 1000;
    const fade = age > (MARKER_TTL - 1.2) ? Math.max(0, (MARKER_TTL - age) / 1.2) : 1;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.strokeStyle = m.color || '#39ff14';
    ctx.shadowColor = m.color || '#39ff14';
    ctx.shadowBlur = 12;
    ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    m.points.forEach((p, i) => {
      const xy = toXY(p[0], p[1]);
      if (i === 0) ctx.moveTo(xy.x, xy.y); else ctx.lineTo(xy.x, xy.y);
    });
    if (m.points.length === 1) { const xy = toXY(m.points[0][0], m.points[0][1]); ctx.arc(xy.x, xy.y, 3, 0, Math.PI * 2); }
    ctx.stroke();
    ctx.restore();
  });
}
export function drawAllMarkers() {
  if (S.isRemoteView) {
    const c = document.getElementById('remote-marker-canvas');
    if (c && remoteFit && remoteCrop && remoteFrame) {
      c.width = remoteFit.w; c.height = remoteFit.h;
      const mw = remoteFrame.width, mh = remoteFrame.height;
      drawMarkersOn(c, (tx, ty) => remoteMapToCanvas(tx * mw, ty * mh));
    }
    return;
  }
  if (S.isPlayerView) {
    const c = document.getElementById('player-marker-canvas');
    const xf = S.playerRenderXform;
    if (c && xf) {
      c.width = xf.wW; c.height = xf.wH; c.style.width = xf.wW + 'px'; c.style.height = xf.wH + 'px';
      const ctx = c.getContext('2d'); ctx.clearRect(0, 0, xf.wW, xf.wH);
      ctx.save(); ctx.translate(xf.wW / 2, xf.wH / 2); if (xf.rot) ctx.rotate(xf.rot * Math.PI / 180);
      // draw with pre-rotation coords
      const now = Date.now();
      Object.values(activeMarkers).forEach(m => {
        if (!m.points || !m.points.length) return;
        const ageF = Math.max(0, Math.min(1, (MARKER_TTL - (now - m.t) / 1000) / 1.2));
        ctx.save(); ctx.globalAlpha = ageF; ctx.strokeStyle = m.color; ctx.shadowColor = m.color; ctx.shadowBlur = 12;
        ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath();
        m.points.forEach((p, i) => { const q = normToProjPre(p[0], p[1], xf); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
        ctx.stroke(); ctx.restore();
      });
      ctx.restore();
    }
    return;
  }
  // GM view
  const wrap = document.getElementById('gm-canvas-wrap');
  const c = document.getElementById('gm-marker-canvas');
  if (c && wrap) {
    c.width = wrap.clientWidth; c.height = wrap.clientHeight;
    drawMarkersOn(c, (tx, ty) => ({ x: tx * c.width, y: ty * c.height }));
  }
}

// ===================================================================
// REMOTE PLAYER PAGE  (remote.html)
// ===================================================================
export function setupRemoteView() {
  S.isRemoteView = true;
  // remote.html carries only the remote markup, so the GM shell is simply
  // absent; on the legacy ?mode=remote URL it is present and has to be hidden.
  const app = document.getElementById('app'); if (app) app.style.display = 'none';
  const sb = document.getElementById('status-bar'); if (sb) sb.style.display = 'none';
  const rv = document.getElementById('remote-view'); if (rv) rv.style.display = 'block';
  // Prefill the player's name + color from last time (remembered per device).
  const savedName = localStorage.getItem('gm-display:remote:name');
  if (savedName) document.getElementById('remote-name').value = savedName;
  const savedColor = localStorage.getItem('gm-display:remote:color');
  if (savedColor) remotePlayerColor = savedColor;
  renderColorSwatches();
  attachRemoteMarkerHandlers();
  window.addEventListener('resize', () => { if (remoteScreen === 'play') remoteRelayout(); });
  // Poll from the start so the roster fills in (and stays current) on the
  // selection screen, then keeps the map live once a character is chosen.
  setInterval(remoteSyncTick, 300);
  remoteSyncTick();
}

function renderColorSwatches() {
  const wrap = document.getElementById('remote-color-swatches');
  if (!wrap) return;
  wrap.innerHTML = '';
  REMOTE_COLORS.forEach(col => {
    const s = document.createElement('div');
    s.className = 'color-swatch' + (col === remotePlayerColor ? ' selected' : '');
    s.style.background = col;
    s.onclick = () => {
      remotePlayerColor = col;
      renderColorSwatches();
      const dot = document.getElementById('remote-color-dot'); if (dot) dot.style.background = col;
    };
    wrap.appendChild(s);
  });
}

// Pick a character profile (+ the chosen color) and enter the play screen.
function selectCharacter(t) {
  const savedName = localStorage.getItem('gm-display:remote:name');
  if (t.owner && t.owner !== savedName && t.id !== remoteClaimId) return; // someone else's
  const nameEl = document.getElementById('remote-name');
  const name = (nameEl.value || '').trim();
  if (!name) { nameEl.focus(); nameEl.style.borderColor = '#c0392b'; return; }
  enterPlayWith(t, name, remotePlayerColor);
}

// Shared "join the map controlling token t" used by manual select and by the
// auto-restore after a page refresh.
function enterPlayWith(t, name, color) {
  myActorName = name;
  myActorId = 'pl-' + slugify(name);
  remotePlayerColor = color;
  remoteClaimId = t.id;
  // Remember everything so a refresh drops us straight back in.
  localStorage.setItem('gm-display:remote:name', name);
  localStorage.setItem('gm-display:remote:color', color);
  localStorage.setItem('gm-display:remote:claim', t.id);
  _remoteRestoreDone = true;
  sendAction({ kind: 'claim', tokenId: t.id, player: name, color: color });
  remoteScreen = 'play';
  document.getElementById('remote-select').style.display = 'none';
  document.getElementById('remote-stage').style.display = 'flex';
  document.getElementById('remote-bar').style.display = 'flex';
  document.getElementById('remote-who').textContent = name;
  const dot = document.getElementById('remote-color-dot'); if (dot) dot.style.background = color;
  // Render after the stage is laid out so the canvas has real dimensions.
  requestAnimationFrame(() => { renderRemoteFrame(); renderRemoteTokens(); });
}

// After a refresh the player lands on the roster; if they still hold their
// token (per the server), put them straight back on the map. Runs once.
function attemptRemoteRestore() {
  if (_remoteRestoreDone || remoteScreen === 'play') return;
  const savedName = localStorage.getItem('gm-display:remote:name');
  const savedClaim = localStorage.getItem('gm-display:remote:claim');
  const savedColor = localStorage.getItem('gm-display:remote:color') || remotePlayerColor;
  if (!savedName || !savedClaim) return;
  const t = S.tokens.find(x => x.id === savedClaim);
  if (!t) return;                                  // token gone — keep trying until it loads
  if (t.owner && t.owner !== savedName) { _remoteRestoreDone = true; return; } // taken by another
  enterPlayWith(t, savedName, savedColor);
}

export function remoteChangeCharacter() {
  if (remoteClaimId) sendAction({ kind: 'release', tokenId: remoteClaimId, player: myActorName });
  remoteClaimId = null;
  // Intentional change: forget the saved claim so a later refresh stays on the roster.
  localStorage.removeItem('gm-display:remote:claim');
  remoteScreen = 'select';
  remoteMarkerMode = false;
  document.getElementById('remote-marker-btn').classList.remove('active');
  document.getElementById('remote-stage').style.display = 'none';
  document.getElementById('remote-bar').style.display = 'none';
  document.getElementById('remote-select').style.display = 'flex';
  renderColorSwatches();
  renderRemoteRoster();
}

// The selection screen: one big card per character (portrait + name).
function renderRemoteRoster() {
  const wrap = document.getElementById('remote-roster');
  if (!wrap) return;
  // Players only choose from player characters; NPCs are never claimable.
  const pcs = S.tokens.filter(t => t.side === 'pc');
  if (!pcs.length) { wrap.innerHTML = '<div class="remote-empty">No characters yet — the GM hasn\'t added any.</div>'; return; }
  wrap.innerHTML = '';
  const savedName = localStorage.getItem('gm-display:remote:name');
  pcs.forEach(t => {
    const mine = !!t.owner && t.owner === savedName;       // your own (after a refresh)
    const taken = !!t.owner && !mine;                      // someone else's
    const card = document.createElement('div');
    card.className = 'remote-card ' + (t.side === 'pc' ? 'pc' : 'npc') + (taken ? ' taken' : '');
    const por = document.createElement('div');
    por.className = 'rc-portrait';
    if (t.img) por.style.backgroundImage = 'url("' + t.img + '")';
    else { por.style.background = t.color; por.textContent = initialsOf(t.base); }
    if (t.ownerColor && t.owner) por.style.borderColor = t.ownerColor;
    const name = document.createElement('div');
    name.className = 'rc-name'; name.textContent = tokenDisplayName(t);
    const status = document.createElement('div');
    status.className = 'rc-status';
    status.textContent = mine ? 'You — tap to resume' : (taken ? ('Taken by ' + t.owner) : 'Available');
    card.append(por, name, status);
    if (!taken) card.onclick = () => selectCharacter(t);
    wrap.appendChild(card);
  });
}

export function remoteToggleMarker() {
  remoteMarkerMode = !remoteMarkerMode;
  document.getElementById('remote-marker-btn').classList.toggle('active', remoteMarkerMode);
}
function remoteSyncTick() {
  fetch('/api/sync').then(r => r.json()).then(s => {
    // markers from everyone else
    (s.markers || []).forEach(m => { if (m.by !== myActorName) activeMarkers[m.id] = { ...m, t: Date.now() }; });
    ensureMarkerLoop();
    if (s.tokensVersion !== remoteTokVer) {
      remoteTokVer = s.tokensVersion;
      const doc = s.tokens || {};
      S.tokens = doc.tokens || [];
      if (doc.grid) applyGridWire(doc.grid);
      attemptRemoteRestore();
      if (remoteScreen === 'select') renderRemoteRoster();
      else renderRemoteTokens();
    }
    if (s.frameVersion !== remoteFrameVer) {
      remoteFrameVer = s.frameVersion;
      fetch('/api/player_state').then(r => r.json()).then(ps => {
        remoteFrame = ps.payload; if (remoteScreen === 'play') renderRemoteFrame();
      }).catch(() => {});
    }
  }).catch(() => {});
}
// The remote view mirrors the GM's current crop (pan/zoom). Everything is
// computed in MAP pixels, so the grid hexes/squares stay fixed on the map and
// tokens remain snapped as the GM pans and zooms.
function remoteMapToCanvas(mx, my) {
  return { x: (mx - remoteCrop.x) * remoteScale, y: (my - remoteCrop.y) * remoteScale };
}
function layoutRemote() {
  const stage = document.getElementById('remote-stage');
  if (!stage || !remoteFrame) return;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const mw = remoteFrame.width, mh = remoteFrame.height;
  const crop = remoteFrame.crop || { x: 0, y: 0, w: mw, h: mh };
  remoteCrop = crop;
  remoteScale = Math.min(sw / crop.w, sh / crop.h);
  remoteFit = { w: Math.max(1, Math.round(crop.w * remoteScale)), h: Math.max(1, Math.round(crop.h * remoteScale)) };
  ['remote-canvas', 'remote-grid-canvas', 'remote-marker-canvas'].forEach(id => {
    const c = document.getElementById(id);
    c.width = remoteFit.w; c.height = remoteFit.h;
    c.style.width = remoteFit.w + 'px'; c.style.height = remoteFit.h + 'px';
  });
  const layer = document.getElementById('remote-token-layer');
  layer.style.width = remoteFit.w + 'px'; layer.style.height = remoteFit.h + 'px';
}
function renderRemoteFrame() {
  if (!remoteFrame) return;
  layoutRemote();
  const img = new Image();
  img.onload = () => { remoteImg = img; paintRemoteFog(img); renderRemoteTokens(); drawAllMarkers(); };
  img.src = remoteFrame.imageSrc;
}
// Repaint after a resize without re-fetching the image.
function remoteRelayout() {
  layoutRemote();
  if (remoteImg) paintRemoteFog(remoteImg);
  renderRemoteTokens();
  drawAllMarkers();
}
function paintRemoteFog(img) {
  if (!remoteFit) layoutRemote();
  const c = document.getElementById('remote-canvas');
  const ctx = c.getContext('2d');
  const W = remoteFit.w, H = remoteFit.h;
  const mw = remoteFrame.width, mh = remoteFrame.height;
  const crop = remoteCrop, scale = remoteScale;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  // Draw only the cropped region of the map (the part outside the map stays black).
  const sx = Math.max(0, crop.x), sy = Math.max(0, crop.y);
  const ex = Math.min(mw, crop.x + crop.w), ey = Math.min(mh, crop.y + crop.h);
  if (ex > sx && ey > sy) {
    ctx.drawImage(img, sx, sy, ex - sx, ey - sy,
      (sx - crop.x) * scale, (sy - crop.y) * scale, (ex - sx) * scale, (ey - sy) * scale);
  }
  // Fog: hidden cells -> solid black (players never see unrevealed art).
  // Guarded so a (hypothetical) tainted canvas can't also kill the grid below.
  const fog = remoteFrame.fogRLE ? rlDecode(remoteFrame.fogRLE, mw * mh) : null;
  if (fog) {
    try {
      const id = ctx.getImageData(0, 0, W, H);
      const px = id.data;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const mx = Math.floor(crop.x + x / scale), my = Math.floor(crop.y + y / scale);
          let black = false;
          if (mx < 0 || mx >= mw || my < 0 || my >= mh) black = true;
          else if (fog[my * mw + mx] === 0) black = true;
          if (black) { const i = (y * W + x) * 4; px[i] = px[i + 1] = px[i + 2] = 0; px[i + 3] = 255; }
        }
      }
      ctx.putImageData(id, 0, 0);
    } catch (e) { console.warn('fog apply failed', e); }
  }
  // Grid over fog (so players can place tokens in the dark), locked to the map.
  const gc = document.getElementById('remote-grid-canvas');
  const gx = gc.getContext('2d'); gx.clearRect(0, 0, W, H);
  drawMapGrid(gx, remoteMapToCanvas, mw, mh, tokenGridColor);
}
function renderRemoteTokens() {
  const layer = document.getElementById('remote-token-layer');
  if (!layer || !remoteFrame || !remoteCrop) return;
  layer.innerHTML = '';
  const mw = remoteFrame.width;
  const diamPx = kTokenDiam(mw) * remoteScale * TOKEN_FRAC;
  const mine = S.tokens.find(t => t.id === remoteClaimId);
  document.getElementById('remote-token-info').textContent =
    mine ? ('Playing ' + tokenDisplayName(mine) + ' — drag to move') : '';
  // Draw only tokens the GM has made visible on this map (onMap is per-map).
  S.tokens.filter(t => t.onMap).forEach(t => {
    const canControl = (t.id === remoteClaimId);
    layer.appendChild(makeRemoteTokenEl(t, t.tx, t.ty, diamPx, false, canControl));
    if (t.pending) layer.appendChild(makeRemoteTokenEl(t, t.pending.tx, t.pending.ty, diamPx, true, false));
  });
}
function makeRemoteTokenEl(t, tx, ty, diamPx, isGhost, canControl) {
  const el = document.createElement('div');
  el.className = 'token ' + (t.side === 'pc' ? 'pc' : 'npc') + (isGhost ? ' ghost' : '') + (canControl ? ' draggable' : '');
  const mw = remoteFrame.width, mh = remoteFrame.height;
  const p = remoteMapToCanvas(tx * mw, ty * mh);
  el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
  el.style.width = diamPx + 'px'; el.style.height = diamPx + 'px';
  if (t.img) el.style.backgroundImage = 'url("' + t.img + '")';
  else { el.style.background = t.color; el.textContent = initialsOf(t.base); }
  if (!isGhost && t.ownerColor) el.style.borderColor = t.ownerColor;
  const lab = document.createElement('span'); lab.className = 'tok-label'; lab.textContent = tokenDisplayName(t);
  el.appendChild(lab);
  if (t.num > 0) { const n = document.createElement('span'); n.className = 'tok-num'; n.textContent = t.num; el.appendChild(n); }
  if (canControl && !isGhost) attachRemoteTokenDrag(el, t);
  return el;
}
function attachRemoteTokenDrag(el, t) {
  el.addEventListener('pointerdown', (e) => {
    if (remoteMarkerMode) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const layer = document.getElementById('remote-token-layer');
    const box = layer.getBoundingClientRect();
    const mw = remoteFrame.width, mh = remoteFrame.height;
    let last = { tx: t.tx, ty: t.ty };
    const move = (ev) => {
      const mx = remoteCrop.x + (ev.clientX - box.left) / remoteScale;
      const my = remoteCrop.y + (ev.clientY - box.top) / remoteScale;
      last.tx = clamp01(mx / mw); last.ty = clamp01(my / mh);
      const s = snapNorm(last.tx, last.ty);
      const p = remoteMapToCanvas(s.tx * mw, s.ty * mh);
      el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
    };
    const up = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
      const s = snapNorm(last.tx, last.ty);
      sendAction({ kind: 'propose', tokenId: t.id, player: myActorName, tx: s.tx, ty: s.ty });
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  });
}
function sendAction(a) { fetch('/api/action', { method: 'POST', body: JSON.stringify(a) }).catch(() => {}); }

function attachRemoteMarkerHandlers() {
  const stage = document.getElementById('remote-stage');
  if (!stage) return;
  const box = () => document.getElementById('remote-marker-canvas').getBoundingClientRect();
  stage.addEventListener('pointerdown', (e) => {
    if (!remoteMarkerMode) return;
    const b = box();
    _markerStroke = { id: uid('m'), by: myActorName, color: remotePlayerColor, points: [] };
    remoteAddMarkerPoint(e, b);
  });
  stage.addEventListener('pointermove', (e) => { if (_markerStroke && remoteMarkerMode) remoteAddMarkerPoint(e, box()); });
  const end = () => { _markerStroke = null; };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointerleave', end);
}
function remoteAddMarkerPoint(e, box) {
  // Markers are stored in map-normalized coords so they line up on every surface.
  const mw = remoteFrame.width, mh = remoteFrame.height;
  const mx = remoteCrop.x + (e.clientX - box.left) / remoteScale;
  const my = remoteCrop.y + (e.clientY - box.top) / remoteScale;
  const tx = clamp01(mx / mw), ty = clamp01(my / mh);
  _markerStroke.points.push([tx, ty]);
  activeMarkers[_markerStroke.id] = { ...(_markerStroke), t: Date.now() };
  fetch('/api/marker', { method: 'POST', body: JSON.stringify(_markerStroke) }).catch(() => {});
  ensureMarkerLoop();
}

// init() is called by main.js once every module has evaluated.
