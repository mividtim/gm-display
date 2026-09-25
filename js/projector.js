// GM Display — projector.js
// Projector mirror: draws tokens, grid and markers under the keystone warp.
import { clamp01, drawMapGrid, isParty, kTokenDiam, snapNorm, tokenFrac } from './geometry.js';
import { ensureMarkerLoop } from './markers.js';
import { S } from './store.js';
import { applyGridWire, tokenFillOpacity } from './tokens.js';
// ===================================================================
// PROJECTOR (BroadcastChannel mirror) — draws tokens + grid + markers
// onto canvases INSIDE #player-canvas-wrap so the keystone warp applies.
// ===================================================================
export function projectorHandleMessage(d) {
  if (d.type === 'tokens') {
    S.pTokens = d.tokens || [];
    if (d.grid) { S.pTokenGrid = d.grid; applyGridWire(d.grid); }
    drawProjectorOverlay();
    return;
  }
  if (d.type === 'markers') { d.markers.forEach(m => S.activeMarkers[m.id] = { ...m, t: Date.now() }); ensureMarkerLoop(); return; }
}
// map-normalized (tx,ty) -> projector pre-rotation canvas coords, given xform
export function normToProjPre(tx, ty, xf) {
  const mx = tx * xf.mapW, my = ty * xf.mapH;
  return { x: (mx - xf.srcX) * xf.scale - xf.preW / 2, y: (my - xf.srcY) * xf.scale - xf.preH / 2 };
}
export function drawProjectorOverlay() {
  const xf = S.playerRenderXform;
  const tc = document.getElementById('player-token-canvas');
  if (!tc || !xf) return;
  // snapNorm() and the cell helpers read S.mapWidth/S.mapHeight through
  // mapDims(); on this window nothing else sets them, and without them a drag
  // here would snap against a map one pixel wide.
  S.mapWidth = xf.mapW; S.mapHeight = xf.mapH;
  tc.width = xf.wW; tc.height = xf.wH;
  tc.style.width = xf.wW + 'px'; tc.style.height = xf.wH + 'px';
  const ctx = tc.getContext('2d');
  ctx.clearRect(0, 0, xf.wW, xf.wH);
  ctx.save();
  ctx.translate(xf.wW / 2, xf.wH / 2);
  if (xf.rot) ctx.rotate(xf.rot * Math.PI / 180);
  // snap grid (so players see cells even inside black fog)
  if (S.pTokenGrid.enabled) drawProjGrid(ctx, xf);
  const unit = kTokenDiam(xf.mapW) * xf.scale / 2;
  S.pTokens.filter(t => t.onMap).forEach(t => {
    const rad = unit * tokenFrac(t);
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
  drawMapGrid(ctx, (mx, my) => normToProjPre(mx / xf.mapW, my / xf.mapH, xf), xf.mapW, xf.mapH, S.tokenGridColor);
}
function drawTokenCircle(ctx, x, y, r, t, isGhost) {
  ctx.save();
  if (isGhost) ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  // Fill only — the ring and the label below are drawn at full strength, so
  // the token marks its cell without covering what is drawn in it.
  const fillA = tokenFillOpacity(t);
  if (t.img && projTokenImg(t.img)) {
    ctx.save(); ctx.clip();
    ctx.globalAlpha = (isGhost ? 0.5 : 1) * fillA;
    const im = projTokenImg(t.img);
    ctx.drawImage(im, x - r, y - r, r * 2, r * 2);
    if (isGhost) { ctx.globalCompositeOperation = 'saturation'; ctx.fillStyle = '#888'; ctx.fillRect(x - r, y - r, r * 2, r * 2); }
    ctx.restore();
  } else {
    ctx.save();
    ctx.globalAlpha = (isGhost ? 0.5 : 1) * fillA;
    ctx.fillStyle = isGhost ? '#9aa' : t.color;
    ctx.fill();
    ctx.restore();
  }
  ctx.lineWidth = Math.max(2, r * (isParty(t) ? 0.16 : 0.12));
  ctx.strokeStyle = isGhost ? '#cfd6e0'
    : (t.ownerColor || (isParty(t) ? '#ffcf5c' : (t.side === 'pc' ? '#5fd0ff' : '#ff7a6b')));
  if (isGhost) ctx.setLineDash([r * 0.4, r * 0.3]);
  ctx.stroke();
  ctx.setLineDash([]);
  // The Company gets a second ring — at realm scale it must read as "the party
  // is here" from across the room, not as one more coloured disc.
  if (isParty(t) && !isGhost) {
    ctx.beginPath(); ctx.arc(x, y, r * 1.18, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.5, r * 0.06); ctx.strokeStyle = '#ffcf5c';
    ctx.stroke();
  }
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
// DRAGGING ON THE PROJECTOR
// ===================================================================
// The map display draws its tokens into a canvas, so there is no element to
// grab and no browser hit-testing to lean on: a pointer position has to be
// walked back through every transform between the screen and the map before it
// means anything.
//
// Three of them, in order:
//   1. the keystone warp (a projective matrix3d on #player-canvas-wrap),
//   2. the rotation baked into the canvas by ctx.rotate,
//   3. the crop/scale from map pixels to canvas pixels (normToProjPre).
// Skipping (1) is the tempting shortcut and it is wrong the moment a corner is
// nudged: on a keystoned projector the token would land somewhere near where
// you pointed and drift further the closer you got to a corner.

// Screen point -> the wrap's own untransformed pixels (which are canvas pixels,
// since the canvas is display:block sized in CSS px to match its backing store).
function projPointerToCanvas(clientX, clientY) {
  const wrap = document.getElementById('player-canvas-wrap');
  const rot = document.getElementById('player-rotation-wrap');
  if (!wrap || !rot) return null;
  // The rotation wrap is a pass-through (applyProjectionTransform sets it to
  // 'none' and bakes rotation into the canvas), so its box is the wrap's
  // geometry BEFORE the keystone — the one fixed point we can measure from.
  const r = rot.getBoundingClientRect();
  const lx = clientX - r.left, ly = clientY - r.top;
  const css = getComputedStyle(wrap).transform;
  if (!css || css === 'none') return { x: lx, y: ly };
  // transform-origin is '0 0' whenever a transform is set (see
  // applyProjectionTransform), so the computed matrix is the whole story.
  try {
    const p = new DOMMatrix(css).inverse().transformPoint(new DOMPoint(lx, ly, 0, 1));
    const w = p.w || 1;
    return { x: p.x / w, y: p.y / w };
  } catch (e) {
    return { x: lx, y: ly };            // singular matrix: better than nothing
  }
}

// Canvas pixels -> the pre-rotation space normToProjPre() draws in.
function projCanvasToPre(cx, cy, xf) {
  let dx = cx - xf.wW / 2, dy = cy - xf.wH / 2;
  if (xf.rot) {
    const a = -xf.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }
  return { x: dx, y: dy };
}

// ...and back out to map-normalized coords. The inverse of normToProjPre.
function projPreToNorm(p, xf) {
  const mx = (p.x + xf.preW / 2) / xf.scale + xf.srcX;
  const my = (p.y + xf.preH / 2) / xf.scale + xf.srcY;
  return { tx: clamp01(mx / xf.mapW), ty: clamp01(my / xf.mapH) };
}

// The topmost token under the pointer, or null. Searched back to front because
// that is the order they were painted in.
function projTokenAt(clientX, clientY) {
  const xf = S.playerRenderXform;
  if (!xf) return null;
  const c = projPointerToCanvas(clientX, clientY);
  if (!c) return null;
  const q = projCanvasToPre(c.x, c.y, xf);
  const unit = kTokenDiam(xf.mapW) * xf.scale / 2;
  const list = S.pTokens.filter(t => t.onMap);
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    const p = normToProjPre(t.tx, t.ty, xf);
    if (Math.hypot(q.x - p.x, q.y - p.y) <= unit * tokenFrac(t)) return t;
  }
  return null;
}

// This window is a mirror, not an authority. It moves the token on its own
// canvas so the drag looks live, and tells the GM page, which owns the roster,
// persists it and fans the move back out to everyone else.
let _projMoveTimer = null;
function sendProjMove(id, tx, ty, final) {
  if (!S.playerChannel) return;
  const post = () => S.playerChannel.postMessage({ type: 'token-move', id, tx, ty });
  if (final) { clearTimeout(_projMoveTimer); _projMoveTimer = null; post(); return; }
  if (_projMoveTimer) return;
  _projMoveTimer = setTimeout(() => { _projMoveTimer = null; post(); }, 90);
}

export function attachProjectorTokenDrag() {
  const wrap = document.getElementById('player-canvas-wrap');
  if (!wrap || wrap._tokDragWired) return;
  wrap._tokDragWired = true;
  let drag = null;

  wrap.addEventListener('pointerdown', (e) => {
    if (S.playerDisplay !== 'map') return;
    const t = projTokenAt(e.clientX, e.clientY);
    if (!t) return;
    e.preventDefault();
    try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
    drag = { t, tx: t.tx, ty: t.ty };
    wrap.style.cursor = 'grabbing';
  });

  wrap.addEventListener('pointermove', (e) => {
    if (!drag) {
      // Nothing here looks grabbable, so the cursor has to say so.
      if (S.playerDisplay === 'map') {
        wrap.style.cursor = projTokenAt(e.clientX, e.clientY) ? 'grab' : '';
      }
      return;
    }
    const xf = S.playerRenderXform;
    const c = projPointerToCanvas(e.clientX, e.clientY);
    if (!xf || !c) return;
    const n = projPreToNorm(projCanvasToPre(c.x, c.y, xf), xf);
    const s = snapNorm(n.tx, n.ty);
    drag.tx = s.tx; drag.ty = s.ty;
    drag.t.tx = s.tx; drag.t.ty = s.ty;   // optimistic; the GM page confirms
    drawProjectorOverlay();
    sendProjMove(drag.t.id, s.tx, s.ty, false);
  });

  const end = (e) => {
    if (!drag) return;
    try { wrap.releasePointerCapture(e.pointerId); } catch (err) {}
    sendProjMove(drag.t.id, drag.tx, drag.ty, true);
    drag = null;
    wrap.style.cursor = '';
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
}
