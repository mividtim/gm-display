// GM Display — player-view.js
// Projector rendering: test pattern, fog, keystone, grid overlay.
// Classic script: load order matters (see gm_display.html).
// === Test Pattern: solid white with 1" black grid ===
import { S } from './store.js';
import { parseHexColor } from './navigation.js';
import { drawAllMarkers, drawProjectorOverlay } from './tokens.js';
export function renderTestPattern() {
  const canvas = document.getElementById('player-canvas');
  const wrap = document.getElementById('player-canvas-wrap');
  const playerImg = document.getElementById('player-image');

  playerImg.style.display = 'none';
  wrap.style.display = 'inline-block';

  const wW = window.innerWidth, wH = window.innerHeight;
  canvas.width = wW;
  canvas.height = wH;

  const ctx = canvas.getContext('2d');
  // Solid white background
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, wW, wH);

  // Use grid spacing from projection settings (user-adjustable for their projection size)
  const gridPx = S.pGridPx || 40;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= wW; x += gridPx) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, wH);
  }
  for (let y = 0; y <= wH; y += gridPx) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(wW, y + 0.5);
  }
  ctx.stroke();

  // Corner markers — draw red circles at each corner for visual reference
  ctx.fillStyle = '#f00';
  const m = 20; // margin from edge
  [[m, m], [wW - m, m], [m, wH - m], [wW - m, wH - m]].forEach(([cx, cy]) => {
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.fill();
  });

  // Center crosshair
  ctx.strokeStyle = '#f00';
  ctx.lineWidth = 2;
  const cx = wW / 2, cy = wH / 2;
  ctx.beginPath();
  ctx.moveTo(cx - 30, cy); ctx.lineTo(cx + 30, cy);
  ctx.moveTo(cx, cy - 30); ctx.lineTo(cx, cy + 30);
  ctx.stroke();

  // Apply projection transform (keystone still affects test pattern)
  applyProjectionTransform();
}

// === Crop overlap helper (handles out-of-bounds crop positions) ===
// Given a crop rect {x,y,w,h} that may extend past the source image,
// returns the visible overlap: source rect and destination offset.
// Returns null if there's no overlap at all.
export function computeCropOverlap(crop, imgW, imgH) {
  const cx = crop.x, cy = crop.y, cw = crop.w, ch = crop.h;

  // Intersection of crop rect with image bounds
  const left   = Math.max(0, cx);
  const top    = Math.max(0, cy);
  const right  = Math.min(imgW, cx + cw);
  const bottom = Math.min(imgH, cy + ch);

  const srcW = right - left;
  const srcH = bottom - top;
  if (srcW <= 0 || srcH <= 0) return null;

  return {
    srcX: left,             // source image x
    srcY: top,              // source image y
    srcW: srcW,             // source width
    srcH: srcH,             // source height
    dstX: left - cx,        // destination x offset within the crop viewport
    dstY: top - cy          // destination y offset within the crop viewport
  };
}

// === Image rendering (sidecar, supports crop with overshoot) ===
export function renderPlayerImage(img, crop) {
  const playerImg = document.getElementById('player-image');
  const wrap = document.getElementById('player-canvas-wrap');
  const canvas = document.getElementById('player-canvas');

  if (!crop) {
    // No crop — just show the image as-is
    wrap.style.display = 'none';
    playerImg.style.display = 'block';
    playerImg.src = img.src;
    return;
  }

  // Crop mode — render to canvas (handles out-of-bounds crop positions).
  // Rotation is baked into the canvas via ctx.rotate so keystone (applied on
  // canvas-wrap) operates in fixed screen coordinates.
  playerImg.style.display = 'none';
  wrap.style.display = 'inline-block';

  const wW = window.innerWidth, wH = window.innerHeight;
  const isRot90 = (S.pRotation === 90 || S.pRotation === 270);
  const fitW = isRot90 ? wH : wW;
  const fitH = isRot90 ? wW : wH;
  const scale = Math.min(fitW / crop.w, fitH / crop.h);
  const preW = Math.max(1, Math.floor(crop.w * scale));
  const preH = Math.max(1, Math.floor(crop.h * scale));

  // Render unrotated crop to an offscreen, then composite rotated onto screen.
  const off = document.createElement('canvas');
  off.width = preW;
  off.height = preH;
  const offCtx = off.getContext('2d');
  offCtx.fillStyle = S.pBg;
  offCtx.fillRect(0, 0, preW, preH);
  const ol = computeCropOverlap(crop, img.width, img.height);
  if (ol) {
    offCtx.drawImage(img,
      ol.srcX, ol.srcY, ol.srcW, ol.srcH,
      ol.dstX * scale, ol.dstY * scale, ol.srcW * scale, ol.srcH * scale);
  }

  canvas.width = wW;
  canvas.height = wH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = S.pBg;
  ctx.fillRect(0, 0, wW, wH);
  ctx.save();
  ctx.translate(wW / 2, wH / 2);
  if (S.pRotation) ctx.rotate(S.pRotation * Math.PI / 180);
  ctx.drawImage(off, -preW / 2, -preH / 2);
  ctx.restore();
}

// === Double-buffered fog rendering (no flicker!) ===
export function renderPlayerFogDoubleBuffered(data) {
  const canvas = document.getElementById('player-canvas');
  const wW = window.innerWidth, wH = window.innerHeight;

  // For 90°/270° rotation we scale the source to fit the SWAPPED target
  // dims, but the visible canvas is always at screen dims (wW × wH). Rotation
  // is baked into the canvas via ctx.rotate so the keystone matrix3d (applied
  // on canvas-wrap) operates in fixed screen coordinates — "Top Left" of the
  // keystone always means the projector's physical top-left.
  const isRot90 = (S.pRotation === 90 || S.pRotation === 270);
  const fitW = isRot90 ? wH : wW;
  const fitH = isRot90 ? wW : wH;

  const crop = data.crop;
  const srcW = crop ? crop.w : data.width;
  const srcH = crop ? crop.h : data.height;
  const srcX = crop ? crop.x : 0;
  const srcY = crop ? crop.y : 0;

  const scale = Math.min(fitW / srcW, fitH / srcH);
  // Pre-rotation buffer dims (the image+fog as if not rotated).
  const preW = Math.max(1, Math.floor(srcW * scale));
  const preH = Math.max(1, Math.floor(srcH * scale));

  if (!S.offscreenCanvas || S.offscreenCanvas.width !== preW || S.offscreenCanvas.height !== preH) {
    S.offscreenCanvas = document.createElement('canvas');
    S.offscreenCanvas.width = preW;
    S.offscreenCanvas.height = preH;
    S.offscreenCtx = S.offscreenCanvas.getContext('2d');
  }

  const doRender = (img) => {
    const ctx = S.offscreenCtx;
    const [bgR, bgG, bgB] = parseHexColor(S.pBg);
    ctx.fillStyle = S.pBg;
    ctx.fillRect(0, 0, preW, preH);

    const ol = crop ? computeCropOverlap(crop, data.width, data.height) : null;
    if (crop && ol) {
      ctx.drawImage(img,
        ol.srcX, ol.srcY, ol.srcW, ol.srcH,
        ol.dstX * scale, ol.dstY * scale, ol.srcW * scale, ol.srcH * scale);
    } else if (!crop) {
      ctx.drawImage(img, 0, 0, data.width, data.height, 0, 0, preW, preH);
    }

    // Apply fog mask onto the pre-rotation buffer.
    const imgData = ctx.getImageData(0, 0, preW, preH);
    const px = imgData.data;
    const mask = data.fogMask;
    for (let y = 0; y < preH; y++) {
      for (let x = 0; x < preW; x++) {
        const mapX = srcX + Math.floor(x / scale);
        const mapY = srcY + Math.floor(y / scale);
        if (mapX < 0 || mapX >= data.width || mapY < 0 || mapY >= data.height) {
          const i = (y * preW + x) * 4;
          px[i] = bgR; px[i+1] = bgG; px[i+2] = bgB; px[i+3] = 255;
        } else if (mask[mapY * data.width + mapX] === 0) {
          const i = (y * preW + x) * 4;
          px[i] = bgR; px[i+1] = bgG; px[i+2] = bgB; px[i+3] = 255;
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);

    // Composite onto the visible canvas at FULL SCREEN dims, with rotation
    // baked into the draw. Canvas-wrap's keystone matrix3d will then warp the
    // whole screen-aligned output for projector geometry.
    canvas.width = wW;
    canvas.height = wH;
    const visCtx = canvas.getContext('2d');
    visCtx.fillStyle = S.pBg;
    visCtx.fillRect(0, 0, wW, wH);
    visCtx.save();
    visCtx.translate(wW / 2, wH / 2);
    if (S.pRotation) visCtx.rotate(S.pRotation * Math.PI / 180);
    visCtx.drawImage(S.offscreenCanvas, -preW / 2, -preH / 2);
    visCtx.restore();

    drawGrid();
    // Record the map->screen transform so the token/marker overlay canvases
    // (also inside #player-canvas-wrap, so the keystone warp applies) line up.
    S.playerRenderXform = { wW, wH, scale, srcX, srcY, preW, preH, rot: S.pRotation, mapW: data.width, mapH: data.height };
    if (S.playerDisplay === 'map') { drawProjectorOverlay(); drawAllMarkers(); }
  };

  if (S.cachedMapImage && S.cachedMapImage.complete && S.cachedMapSrc === data.imageSrc) {
    doRender(S.cachedMapImage);
  } else {
    S.cachedMapSrc = data.imageSrc;
    S.cachedMapImage = new Image();
    S.cachedMapImage.onload = () => doRender(S.cachedMapImage);
    S.cachedMapImage.src = data.imageSrc;
  }
}

// === 4-Corner Perspective Transform ===
// Computes a CSS matrix3d from 4 corner offsets to warp the projection.
// Rotation is baked into the canvas (via ctx.rotate in renderPlayer*), so the
// #player-rotation-wrap is a pass-through. Keystone matrix3d on
// #player-canvas-wrap operates in fixed screen coordinates — "Top Left"
// always means the projector's physical top-left, independent of pRotation.
// For sidecar's no-crop <img> mode there's no keystone, so we still apply CSS
// rotation directly to the img.
export function applyProjectionTransform() {
  const wrap = document.getElementById('player-canvas-wrap');
  const rotWrap = document.getElementById('player-rotation-wrap');
  const playerImg = document.getElementById('player-image');
  if (!wrap) return;

  // Rotation wrap is a pass-through; rotation is baked into canvas drawing.
  if (rotWrap) rotWrap.style.transform = 'none';
  // The <img> in sidecar-no-crop mode is positioned at the viewport level and rotated
  // independently. For 90°/270°, clamp its max-width/height to swapped viewport dims so
  // the rotated image fills the screen instead of overflowing or under-filling.
  if (playerImg) {
    playerImg.style.transformOrigin = 'center center';
    playerImg.style.transform = S.pRotation ? `rotate(${S.pRotation}deg)` : '';
    if (S.pRotation === 90 || S.pRotation === 270) {
      playerImg.style.maxWidth = window.innerHeight + 'px';
      playerImg.style.maxHeight = window.innerWidth + 'px';
    } else {
      playerImg.style.maxWidth = '';
      playerImg.style.maxHeight = '';
    }
  }

  const canvas = document.getElementById('player-canvas');
  if (!canvas) return;
  const w = canvas.width || canvas.clientWidth || 800;
  const h = canvas.height || canvas.clientHeight || 600;

  const c = S.pCorners;
  const hasKeystone = c.tl.x || c.tl.y || c.tr.x || c.tr.y ||
                      c.bl.x || c.bl.y || c.br.x || c.br.y;

  if (!hasKeystone && S.pScale === 100) {
    wrap.style.transform = 'none';
    return;
  }

  let transform = '';
  if (S.pScale !== 100) transform += `scale(${S.pScale / 100}) `;

  if (hasKeystone) {
    // Source corners (original rectangle)
    const src = [[0, 0], [w, 0], [0, h], [w, h]];
    // Destination corners (adjusted by offsets)
    const dst = [
      [c.tl.x, c.tl.y],
      [w + c.tr.x, c.tr.y],
      [c.bl.x, h + c.bl.y],
      [w + c.br.x, h + c.br.y]
    ];
    const matrix = computeMatrix3d(src, dst);
    if (matrix) transform += `matrix3d(${matrix})`;
  }

  wrap.style.transformOrigin = '0 0';
  wrap.style.transform = transform.trim() || 'none';
}

// Compute CSS matrix3d from 4 source→destination point pairs
// Uses general projective (homography) transform
function computeMatrix3d(src, dst) {
  // src/dst: [[x0,y0], [x1,y1], [x2,y2], [x3,y3]]
  // Solve for 3x3 projective matrix H where H * src_i = dst_i (homogeneous)
  // Then embed in 4x4 for CSS matrix3d

  const s = src, d = dst;

  // Build 8x8 system: for each point pair, 2 equations
  // x'*(h31*x + h32*y + h33) = h11*x + h12*y + h13
  // y'*(h31*x + h32*y + h33) = h21*x + h22*y + h23
  // Rewrite as Ah = 0 where h = [h11..h33] (h33=1)
  // Actually solve as 8x8 linear system with h33=1

  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const sx = s[i][0], sy = s[i][1];
    const dx = d[i][0], dy = d[i][1];
    A.push([sx, sy, 1, 0, 0, 0, -dx*sx, -dx*sy]);
    b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -dy*sx, -dy*sy]);
    b.push(dy);
  }

  // Solve via Gaussian elimination
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Partial pivoting
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];

    if (Math.abs(M[col][col]) < 1e-10) return null; // singular

    for (let row = col + 1; row < n; row++) {
      const f = M[row][col] / M[col][col];
      for (let j = col; j <= n; j++) M[row][j] -= f * M[col][j];
    }
  }

  // Back substitution
  const h = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    h[i] = M[i][n];
    for (let j = i + 1; j < n; j++) h[i] -= M[i][j] * h[j];
    h[i] /= M[i][i];
  }

  // h = [h11, h12, h13, h21, h22, h23, h31, h32], h33 = 1
  // 3x3 matrix H:
  // h[0] h[1] h[2]
  // h[3] h[4] h[5]
  // h[6] h[7] 1

  // CSS matrix3d is column-major 4x4:
  // a1 a2 a3 a4     col1: x
  // b1 b2 b3 b4     col2: y
  // c1 c2 c3 c4     col3: z
  // d1 d2 d3 d4     col4: w
  //
  // For 2D projective transform, embed 3x3 into 4x4:
  // H11 H21 0 H31
  // H12 H22 0 H32
  // 0   0   1 0
  // H13 H23 0 H33

  return [
    h[0], h[3], 0, h[6],
    h[1], h[4], 0, h[7],
    0,    0,    1, 0,
    h[2], h[5], 0, 1
  ].join(',');
}

// === Grid Overlay ===
export function drawGrid() {
  const gridCanvas = document.getElementById('player-grid-canvas');
  if (!gridCanvas) return;
  const mapCanvas = document.getElementById('player-canvas');
  if (!mapCanvas) return;

  // Match grid canvas to map canvas size
  gridCanvas.width = mapCanvas.width;
  gridCanvas.height = mapCanvas.height;
  gridCanvas.style.width = mapCanvas.style.width || mapCanvas.width + 'px';
  gridCanvas.style.height = mapCanvas.style.height || mapCanvas.height + 'px';

  const ctx = gridCanvas.getContext('2d');
  ctx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);

  if (!S.pGridEnabled || S.pGridPx < 5) return;

  ctx.strokeStyle = S.pGridColor;
  ctx.lineWidth = 1;
  ctx.beginPath();

  // Vertical lines
  for (let x = S.pGridPx; x < gridCanvas.width; x += S.pGridPx) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, gridCanvas.height);
  }
  // Horizontal lines
  for (let y = S.pGridPx; y < gridCanvas.height; y += S.pGridPx) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(gridCanvas.width, y + 0.5);
  }

  ctx.stroke();
}
