// GM Display — markers.js
// Shared marker fade/render loop.
import { MARKER_TTL } from './geometry.js';
import { normToProjPre } from './projector.js';
import { remoteMapToCanvas } from './remote-page.js';
import { S } from './store.js';
// ===================================================================
// MARKERS — shared fade/render loop. Each surface supplies a projector fn.
// ===================================================================
export function ensureMarkerLoop() {
  if (S._markerRAF) return;
  const tick = () => {
    const now = Date.now();
    Object.keys(S.activeMarkers).forEach(id => {
      if ((now - S.activeMarkers[id].t) / 1000 > MARKER_TTL) delete S.activeMarkers[id];
    });
    drawAllMarkers();
    if (Object.keys(S.activeMarkers).length || S._markerStroke) {
      S._markerRAF = requestAnimationFrame(tick);
    } else { S._markerRAF = null; drawAllMarkers(); }
  };
  S._markerRAF = requestAnimationFrame(tick);
}
function drawMarkersOn(canvas, toXY) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const now = Date.now();
  Object.values(S.activeMarkers).forEach(m => {
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
    if (c && S.remoteFit && S.remoteCrop && S.remoteFrame) {
      c.width = S.remoteFit.w; c.height = S.remoteFit.h;
      const mw = S.remoteFrame.width, mh = S.remoteFrame.height;
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
      Object.values(S.activeMarkers).forEach(m => {
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
