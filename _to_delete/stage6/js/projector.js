// GM Display — projector.js
// Projector mirror: draws tokens, grid and markers under the keystone warp.
import { TOKEN_FRAC, drawMapGrid, kTokenDiam } from './geometry.js';
import { ensureMarkerLoop } from './markers.js';
import { S } from './store.js';
import { applyGridWire } from './tokens.js';
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
  tc.width = xf.wW; tc.height = xf.wH;
  tc.style.width = xf.wW + 'px'; tc.style.height = xf.wH + 'px';
  const ctx = tc.getContext('2d');
  ctx.clearRect(0, 0, xf.wW, xf.wH);
  ctx.save();
  ctx.translate(xf.wW / 2, xf.wH / 2);
  if (xf.rot) ctx.rotate(xf.rot * Math.PI / 180);
  // snap grid (so players see cells even inside black fog)
  if (S.pTokenGrid.enabled) drawProjGrid(ctx, xf);
  const rad = kTokenDiam(xf.mapW) * xf.scale * (TOKEN_FRAC / 2);
  S.pTokens.filter(t => t.onMap).forEach(t => {
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
