// GM Display — geometry.js
// Map-key geometry: cell size, origin, snapping, grid drawing.
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
// --- shared state ---
S.tokens = [];                 // tokens ACTIVE ON THE CURRENT MAP; mirrored on projector/remote
// Global roster: every token definition in the campaign (PCs + all NPCs).
// `tokens` is the subset active on the current map: all PCs, plus NPCs that
// have been added to this map. Positions + visibility (tx/ty/onMap) are
// per-map and hydrated into the shared def objects on map switch.
S.roster = [];
S.tokenMapSrc = null;          // map src whose placements are currently hydrated
// The players' copy of the current map, when that map is split (a GM realm
// sheet with the Myths on it, and a clean one for the table). '' means both
// sides see the same image. This is only ever "what to draw on a player-facing
// surface" — the map's IDENTITY stays S.lastMapSrc, which is what notes, the
// legend, the calibration and the fog mask are all keyed on.
S.playerMapSrc = '';
S.tokensReady = false;         // guards saves until loadTokens() has run
S.tokenGridEnabled = true;   // this map is calibrated: snap, address cells, notes
S.tokenGridShow = true;      // ...and draw the lines (off for maps with a printed grid)
S.tokenGridCells = 24;
S.tokenGridType = 'square';    // 'square' | 'hex' (pointy-top)
S.tokenGridColor = 'rgba(120,200,255,0.5)';  // grid line color (rgba)
// How solid a token's fill is. A token has to mark its cell without hiding
// what is drawn in it — on a realm hex the art IS the information. The ring,
// the initials and the label stay fully opaque; only the fill fades, so the
// token still reads at a glance while the hex shows through.
S.tokenOpacity = 0.62;
// --- Map key: per-map grid calibration -----------------------------------
// The old model could only say "N cells across the map width", with the grid
// origin welded to map pixel (0,0). That can't line up with a grid already
// printed on the map. These four values describe the grid in MAP PIXELS, so a
// printed grid can be matched exactly: cell size to a fraction of a pixel, and
// the origin nudged anywhere. Zero means "fall back to tokenGridCells".
S.keyCellPx = 0;   // cell width in map px  (hex: flat-to-flat distance)
S.keyCellYPx = 0;   // cell height in map px, square only; 0 = same as width
S.keyOx = 0;   // grid origin offset in map px
S.keyOy = 0;
S.keyLinkXY = true;  // keep cell height locked to cell width
// Token diameter as a fraction of one grid cell (slightly inset so it nests
// neatly inside the square). Used consistently across GM/projector/remote.
export const TOKEN_FRAC = 0.96;         // token diameter as a fraction of one grid cell
const SQRT3 = Math.sqrt(3);
S.markerMode = false;          // GM marker-draw armed
export const MARKER_TTL = 6.0;          // seconds (matches server)
S.activeMarkers = {};          // id -> {id,by,color,points:[[tx,ty]],t(ms)}
S.myActorId = 'gm-' + Math.random().toString(36).slice(2, 7);
S.myActorName = 'GM';
S.markerColor = '#39ff14';
S._markerStroke = null;        // stroke being drawn locally {id,color,points,by}
S._markerRAF = null;

// projector-side mirrors (populated from BroadcastChannel)
S.pTokens = [];
S.pTokenGrid = { enabled: true, cells: 24 };
S.playerRenderXform = null;    // set by renderPlayerFogDoubleBuffered

// remote-page state
S.isRemoteView = false;
S.remoteClaimId = null;        // token id this remote controls
S.remoteFrame = null;          // last player_state payload
S.remoteFrameVer = -1; S.remoteTokVer = -1;
S.remoteFit = null;            // {w,h} of the rendered (cropped) rectangle in px
S.remoteCrop = null;           // {x,y,w,h} map-px crop currently shown
S.remoteScale = 1;             // px per map-px for the current crop
S.remoteImg = null;            // cached map image for repaints on resize
S.remoteMarkerMode = false;
S.remoteScreen = 'select';     // 'select' (roster) | 'play' (map)
S.remotePlayerColor = '#39ff14';
S._remoteRestoreDone = false;  // auto-restore the claimed character once after a refresh
export const REMOTE_COLORS = ['#39ff14', '#ff2db3', '#27c4ff', '#ffd23f', '#ff7a1a', '#b06bff', '#ff4d4d', '#1ee0b0'];

export const uid = (p) => (p || 't') + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
export const clamp01 = (v) => Math.max(0, Math.min(1, v));
// Convert an (often absolute) image URL to an origin-relative path so it loads
// from whatever origin the viewer is on (localhost, LAN, or ngrok). Data URLs
// are passed through unchanged.
export function relMapSrc(s) {
  if (!s || s.startsWith('data:')) return s;
  try { const u = new URL(s, location.href); return u.pathname + u.search; } catch (e) { return s; }
}
export function tokenDisplayName(t) { return t.num > 0 ? (t.base + ' ' + t.num) : t.base; }

// A token is one of three things. 'party' is the Company: the whole group as a
// single piece, which is how a realm-scale map wants to move the players —
// one marker crossing hexes, not five portraits stacked on the same hex.
// It belongs to no one player, so anyone at the table may propose its move.
export const TOKEN_SIDES = ['pc', 'npc', 'party'];
export const isParty = (t) => !!t && t.side === 'party';
// The Company fills its hex; individual figures sit slightly inside theirs.
export function tokenFrac(t) { return isParty(t) ? 1.0 : TOKEN_FRAC; }
export function tokenClass(t) { return isParty(t) ? 'party' : (t && t.side === 'pc' ? 'pc' : 'npc'); }

// ---- grid geometry & snapping ----
// The grid is defined in MAP pixel coordinates so it stays locked to the map as
// any surface pans/zooms. `tokenGridCells` = columns across the map width.
export function mapDims() {
  return {
    mw: S.mapWidth || (S.remoteFrame && S.remoteFrame.width) || 1,
    mh: S.mapHeight || (S.remoteFrame && S.remoteFrame.height) || 1
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
  if (S.keyCellPx > 0) return S.keyCellPx;
  mw = mw || mapDims().mw;
  return Math.max(2, mw / (S.tokenGridCells || 24));
}
export function kStepY(mw) {
  if (S.keyCellYPx > 0) return S.keyCellYPx;
  const sx = kStepX(mw);
  if (!isHexKey()) return sx;                       // square: same as width
  return isFlatHex() ? sx * (2 / SQRT3) : sx * (SQRT3 / 2);   // regular hexagon
}
export function kCellW(mw) { return kStepX(mw); }
export function kCellH(mw) { return kStepY(mw); }
// Largest circle that fits a cell of either shape.
export function kTokenDiam(mw) { return Math.min(kStepX(mw), kStepY(mw)); }
export function isHexKey() { return S.tokenGridType === 'hex' || S.tokenGridType === 'hexflat'; }
export function isFlatHex() { return S.tokenGridType === 'hexflat'; }
// The hex spacing that WOULD be regular, for the readout.
export function kRegularStepY(mw) {
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
  if (isHexKey()) return hexAxial(mx - S.keyOx, my - S.keyOy, kStepX(mw), kStepY(mw), isFlatHex());
  return { col: Math.floor((mx - S.keyOx) / kStepX(mw)), row: Math.floor((my - S.keyOy) / kStepY(mw)) };
}
export function cellCenterMapPx(cell, mw, mh) {
  const d = mapDims(); mw = mw || d.mw; mh = mh || d.mh;
  if (isHexKey()) {
    const c = hexToPx(cell.q, cell.r, kStepX(mw), kStepY(mw), isFlatHex());
    return { x: c.x + S.keyOx, y: c.y + S.keyOy };
  }
  return { x: S.keyOx + (cell.col + 0.5) * kStepX(mw), y: S.keyOy + (cell.row + 0.5) * kStepY(mw) };
}

export function snapNorm(tx, ty) {
  if (!S.tokenGridEnabled) return { tx: clamp01(tx), ty: clamp01(ty) };
  const { mw, mh } = mapDims();
  const c = cellCenterMapPx(cellAtMapPx(tx * mw, ty * mh, mw, mh), mw, mh);
  return { tx: clamp01(c.x / mw), ty: clamp01(c.y / mh) };
}
// Draw the grid (square or hex) using a map-px -> canvas-px transform `m2c`.
// This makes the same code work full-map (GM) or cropped (projector/remote).
export function drawMapGrid(ctx, m2c, mw, mh, color) {
  // Two separate questions, and they used to be one flag. `tokenGridEnabled`
  // is "this map is calibrated" — it drives snapping, cell addresses and
  // notes. `tokenGridShow` is "draw the lines". A map with a grid already
  // printed on it (the realm sheet, most battlemaps) wants the first and not
  // the second: overlaying our hexes on its hexes gives the table two grids
  // to look at, one of which is ours.
  if (!S.tokenGridEnabled || !S.tokenGridShow) return;
  ctx.strokeStyle = color || 'rgba(120,200,255,0.30)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const sx = kStepX(mw), sy = kStepY(mw);
  if (isHexKey()) {
    const flat = isFlatHex(), pad = Math.max(sx, sy);
    if (flat) {
      const qA = Math.floor((-S.keyOx - pad) / sx), qB = Math.ceil((mw - S.keyOx + pad) / sx);
      for (let q = qA; q <= qB; q++) {
        const rA = Math.floor((-S.keyOy - pad) / sy - q / 2);
        const rB = Math.ceil((mh - S.keyOy + pad) / sy - q / 2);
        for (let r = rA; r <= rB; r++) hexPath(ctx, m2c, q, r, sx, sy, flat);
      }
    } else {
      const rA = Math.floor((-S.keyOy - pad) / sy), rB = Math.ceil((mh - S.keyOy + pad) / sy);
      for (let r = rA; r <= rB; r++) {
        const qA = Math.floor((-S.keyOx - pad) / sx - r / 2);
        const qB = Math.ceil((mw - S.keyOx + pad) / sx - r / 2);
        for (let q = qA; q <= qB; q++) hexPath(ctx, m2c, q, r, sx, sy, flat);
      }
    }
  } else {
    let x0 = S.keyOx % sx; if (x0 > 0) x0 -= sx;
    let y0 = S.keyOy % sy; if (y0 > 0) y0 -= sy;
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
  const cx = c.x + S.keyOx, cy = c.y + S.keyOy;
  const rx = flat ? sx / 1.5 : sx / SQRT3;
  const ry = flat ? sy / SQRT3 : sy / 1.5;
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i + (flat ? 0 : -30));
    const p = m2c(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
}

// ---- cell labels -----------------------------------------------------------
// Cells are addressed as "row,col", 1-indexed, matching how a printed hex or
// square grid is numbered. Hex cells are stored axially, so convert through the
// offset form on the way in and out.
export function cellLabel(cell) {
  if (!cell) return '';
  if (cell.col !== undefined) return (cell.row + 1) + ',' + (cell.col + 1);
  if (isFlatHex()) {
    const col = cell.q, row = cell.r + ((col - (col & 1)) >> 1);
    return (row + 1) + ',' + (col + 1);
  }
  const row = cell.r, col = cell.q + ((row - (row & 1)) >> 1);
  return (row + 1) + ',' + (col + 1);
}

export function cellFromLabel(label) {
  const m = /^(-?\d+),(-?\d+)$/.exec(String(label || '').trim());
  if (!m) return null;
  const row = parseInt(m[1], 10) - 1, col = parseInt(m[2], 10) - 1;
  if (!isHexKey()) return { col, row };
  if (isFlatHex()) return { q: col, r: row - ((col - (col & 1)) >> 1) };
  return { q: col - ((row - (row & 1)) >> 1), r: row };
}
