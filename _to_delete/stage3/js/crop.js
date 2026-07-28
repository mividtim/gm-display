// GM Display — crop.js
// Crop sliders and the text overlay.
// Classic script: load order matters (see gm_display.html).
// === Crop Sliders (controls what the projector shows) ===
// Sidebar sections are <details> elements; "toggle" means open/close that section.
import { S } from './store.js';
import { markPendingSync } from './fog-presets.js';
import { renderGMImage } from './fog.js';
import { saveState } from './games.js';
import { setStatus } from './keyboard.js';
import { activeFogChannel, saveCropForCurrentImage } from './per-map-store.js';
import { pushPlayerStateToServer } from './tokens.js';
function toggleSidebarSection(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return false;
  const details = panel.closest('details');
  if (!details) return false;
  details.open = !details.open;
  if (details.open) details.scrollIntoView({block: 'nearest', behavior: 'smooth'});
  return details.open;
}
export function toggleCropPanel() {
  const isOpen = toggleSidebarSection('crop-panel');
  const btnFog = document.getElementById('btn-crop');
  const btnImg = document.getElementById('btn-crop-img');
  if (btnFog) btnFog.classList.toggle('active', isOpen);
  if (btnImg) btnImg.classList.toggle('active', isOpen);
}

export function cropFit() {
  // Show the entire map — zoom 1x (default). Black bars fill gaps.
  S.cropZoom = 1; S.cropHPos = 0.5; S.cropVPos = 0.5;
  applyCropToSliders();
  highlightCropButton('fit');
  saveCropForCurrentImage();
  saveState();
}

// Stepwise zoom: nudges cropZoom by `delta` (e.g. 0.05 = +5%, -0.05 = -5%).
// Used by the View tab's +/- buttons in place of a slider.
export function zoomBy(delta) {
  S.cropZoom = Math.max(0.1, Math.min(10, S.cropZoom + delta));
  applyCropToSliders();
  saveCropForCurrentImage();
  saveState();
}

// Set zoom directly from a percent value (e.g. typed numeric input).
export function setZoomPercent(pct) {
  const v = parseFloat(pct);
  if (!isFinite(v)) return;
  S.cropZoom = Math.max(0.1, Math.min(10, v / 100));
  applyCropToSliders();
  saveCropForCurrentImage();
  saveState();
}

export function cropFill() {
  // Zoom so the map fills the screen completely (no black bars).
  // Fill = largest screen-ratio rect that fits inside the map.
  if (!S.mapWidth || !S.mapHeight) return;
  const targetIsShow = (S.currentMode === 'image') ||
                       (S.currentMode === 'fog' && S.fogContext === 'show');
  const baseScrW = targetIsShow ? S.sidecarW : S.projectorW;
  const baseScrH = targetIsShow ? S.sidecarH : S.projectorH;
  const activeRotation = targetIsShow ? S.showRotation : S.mapRotation;
  const isRotated90 = (activeRotation === 90 || activeRotation === 270);
  const scrW = isRotated90 ? baseScrH : baseScrW;
  const scrH = isRotated90 ? baseScrW : baseScrH;
  const screenAspect = scrW / scrH;
  const mapAspect = S.mapWidth / S.mapHeight;

  // Fill dimensions: largest screen-ratio rect inside the map
  let fillW, fillH;
  if (screenAspect > mapAspect) {
    fillW = S.mapWidth;
    fillH = S.mapWidth / screenAspect;
  } else {
    fillH = S.mapHeight;
    fillW = S.mapHeight * screenAspect;
  }

  // Solve for cropZoom such that the Fit baseline divided by cropZoom
  // equals the Fill rect. The Fit baseline is now the smallest screen-aspect
  // rect CONTAINING the map (matches computeViewportCrop):
  //   screen wider than map: baseW = mapHeight × screenAspect
  //   screen narrower:       baseW = mapWidth
  const baseW = (screenAspect > mapAspect)
    ? S.mapHeight * screenAspect
    : S.mapWidth;
  S.cropZoom = baseW / fillW;

  S.cropHPos = 0.5; S.cropVPos = 0.5;
  applyCropToSliders();
  highlightCropButton('fill');
  saveCropForCurrentImage();
  saveState();
}

export function applyCropToSliders() {
  const zoomPct = S.cropZoom * 100;
  document.getElementById('crop-zoom').value = Math.max(10, Math.min(1000, zoomPct));
  document.getElementById('crop-hpos').value = S.cropHPos * 100;
  document.getElementById('crop-vpos').value = S.cropVPos * 100;
  updateCropLabels();
  computeViewportCrop();
  updateViewportOutline();
  sendCropUpdate();
}

function highlightCropButton(which) {
  const fit = document.getElementById('btn-crop-fit');
  const fill = document.getElementById('btn-crop-fill');
  if (fit) { fit.style.background = which === 'fit' ? '#335' : '#444'; }
  if (fill) { fill.style.background = which === 'fill' ? '#335' : '#444'; }
}

export function updateCrop() {
  S.cropZoom = parseFloat(document.getElementById('crop-zoom').value) / 100;
  S.cropHPos = parseFloat(document.getElementById('crop-hpos').value) / 100;
  S.cropVPos = parseFloat(document.getElementById('crop-vpos').value) / 100;

  updateCropLabels();

  computeViewportCrop();
  updateViewportOutline();
  // Send lightweight crop-only update (no fog mask re-send)
  sendCropUpdate();
  saveCropForCurrentImage();
  saveState();
}

// Update the value displays — extracted so we can reuse it from joystick drag
// without re-reading the slider DOM. Shows pixel-equivalent next to percent
// for fine-grained pan feedback.
function updateCropLabels() {
  document.getElementById('crop-zoom-val').textContent = S.cropZoom.toFixed(2) + 'x';
  const hPx = S.mapWidth ? Math.round(S.cropHPos * S.mapWidth) : 0;
  const vPx = S.mapHeight ? Math.round(S.cropVPos * S.mapHeight) : 0;
  document.getElementById('crop-hpos-val').textContent =
    (S.cropHPos * 100).toFixed(1) + '%' + (S.mapWidth ? ' (' + hPx + 'px)' : '');
  document.getElementById('crop-vpos-val').textContent =
    (S.cropVPos * 100).toFixed(1) + '%' + (S.mapHeight ? ' (' + vPx + 'px)' : '');
}

export function sendCropUpdate() {
  // Route the crop update to whichever display the GM is currently editing.
  if (S.currentMode === 'fog') {
    const ch = activeFogChannel();
    if (!ch) return;
    if (S.fogContext === 'map' && !S.liveSync) {
      markPendingSync();
      return;
    }
    ch.postMessage({ type: 'crop-update', crop: S.viewportCrop });
    if (S.fogContext === 'map') pushPlayerStateToServer();
  } else if (S.currentMode === 'image' && S.showChannel) {
    S.showChannel.postMessage({ type: 'crop-update', crop: S.viewportCrop });
    // Mirror the sidecar's view in the GM preview.
    renderGMImage();
  }
}

export function computeViewportCrop() {
  if (!S.mapWidth || !S.mapHeight) { S.viewportCrop = null; return; }

  // The "no crop needed" short-circuit fires only at exactly 1.0 (within 0.1%
  // for slider rounding). At zoom > 1 we crop into the map (zoom-in); at
  // zoom < 1 we use a viewport larger than the map (zoom-out, letterboxed
  // with the background color). Both need a real crop rect computed below.
  if (S.currentMode === 'fog' && Math.abs(S.cropZoom - 1.0) < 0.001 && Math.abs(S.cropHPos - 0.5) < 0.001 && Math.abs(S.cropVPos - 0.5) < 0.001) {
    S.viewportCrop = null;
    return;
  }
  if (S.currentMode === 'image' && Math.abs(S.cropZoom - 1.0) < 0.001 && Math.abs(S.cropHPos - 0.5) < 0.001 && Math.abs(S.cropVPos - 0.5) < 0.001) {
    S.viewportCrop = null;
    return;
  }

  // Viewport matches the target screen's aspect ratio.
  // Target display: image mode AND show-fog mode both target the sidecar.
  const targetIsShow = (S.currentMode === 'image') ||
                       (S.currentMode === 'fog' && S.fogContext === 'show');
  const baseScrW = targetIsShow ? S.sidecarW : S.projectorW;
  const baseScrH = targetIsShow ? S.sidecarH : S.projectorH;
  const activeRotation = targetIsShow ? S.showRotation : S.mapRotation;
  const isRotated90 = (activeRotation === 90 || activeRotation === 270);
  const scrW = isRotated90 ? baseScrH : baseScrW;
  const scrH = isRotated90 ? baseScrW : baseScrH;
  const screenAspect = scrW / scrH;

  // Base dimensions at zoom=1: the smallest screen-aspect rectangle that
  // CONTAINS the entire map. So zoom=1x exactly means "Fit" — whole map
  // visible, letterbox on whichever axis is short.
  //   • screen wider than map → fit rect is wider than the map (letterbox L/R)
  //   • screen taller than map → fit rect is taller than the map (letterbox T/B)
  // Zoom multiplies this rect inversely: 2x = half the rect (zoom in, crop
  // into map); 0.5x = double the rect (zoom out, more letterbox).
  // No clamping is needed — the formula is monotonic and continuous through
  // every zoom value, including across cropZoom = 1.
  const mapAspect = S.mapWidth / S.mapHeight;
  let baseW, baseH;
  if (screenAspect > mapAspect) {
    baseH = S.mapHeight;
    baseW = S.mapHeight * screenAspect;
  } else {
    baseW = S.mapWidth;
    baseH = S.mapWidth / screenAspect;
  }

  let w = baseW / S.cropZoom;
  let h = baseH / S.cropZoom;

  w = Math.max(1, Math.floor(w));
  h = Math.max(1, Math.floor(h));

  // Position: allow panning past map edges so any area can be centered.
  // At 50% = centered on map. 0%/100% = viewport extends half its size
  // past the map edge, so edge content can be centered on screen.
  // Range: x from -(w/2) to (mapWidth - w/2)
  const rangeX = S.mapWidth;
  const rangeY = S.mapHeight;
  let x = Math.floor(S.cropHPos * rangeX - w / 2);
  let y = Math.floor(S.cropVPos * rangeY - h / 2);

  // Snap-to-edge: if within 15px of a clean alignment, snap to it
  const snap = 15;
  // Snap: left edge of map at left edge of viewport (x=0)
  if (Math.abs(x) < snap) x = 0;
  // Snap: right edge of map at right edge of viewport
  if (Math.abs(x - (S.mapWidth - w)) < snap) x = S.mapWidth - w;
  // Snap: top edge
  if (Math.abs(y) < snap) y = 0;
  // Snap: bottom edge
  if (Math.abs(y - (S.mapHeight - h)) < snap) y = S.mapHeight - h;
  // Snap: centered
  const cx = Math.floor((S.mapWidth - w) / 2);
  const cy = Math.floor((S.mapHeight - h) / 2);
  if (Math.abs(x - cx) < snap) x = cx;
  if (Math.abs(y - cy) < snap) y = cy;

  S.viewportCrop = { x, y, w, h };
}

function resetCrop() {
  S.cropZoom = 1; S.cropHPos = 0.5; S.cropVPos = 0.5;
  const z = document.getElementById('crop-zoom');
  const hp = document.getElementById('crop-hpos');
  const vp = document.getElementById('crop-vpos');
  if (z) z.value = 100;
  if (hp) hp.value = 50;
  if (vp) vp.value = 50;
  const zv = document.getElementById('crop-zoom-val');
  const hv = document.getElementById('crop-hpos-val');
  const vv = document.getElementById('crop-vpos-val');
  if (zv) zv.textContent = '1.0x';
  if (hv) hv.textContent = '50%';
  if (vv) vv.textContent = '50%';
  S.viewportCrop = null;
  updateViewportOutline();
  sendCropUpdate();
  setStatus('Crop reset — projector shows full map');
}

export function updateViewportOutline() {
  // Fog mode outline. The canvas wrap is now sized to fit the view (scaled
  // down from raw map pixels), so we position the outline as percentages of
  // the wrap (which is the same as percentages of the map, since the wrap
  // preserves the map's aspect ratio).
  const outline = document.getElementById('viewport-outline');
  if (outline) {
    if (!S.viewportCrop || !S.mapWidth || !S.mapHeight) {
      outline.style.display = 'none';
    } else {
      outline.style.display = 'block';
      outline.style.left = (S.viewportCrop.x / S.mapWidth * 100) + '%';
      outline.style.top = (S.viewportCrop.y / S.mapHeight * 100) + '%';
      outline.style.width = (S.viewportCrop.w / S.mapWidth * 100) + '%';
      outline.style.height = (S.viewportCrop.h / S.mapHeight * 100) + '%';
    }
  }

  // Image mode outline (positioned as percentages over the preview image)
  const imgOutline = document.getElementById('image-viewport-outline');
  if (imgOutline) {
    if (!S.viewportCrop || !S.mapWidth || !S.mapHeight) {
      imgOutline.style.display = 'none';
    } else {
      imgOutline.style.display = 'block';
      // Convert map-pixel crop rect to percentage of image dimensions
      imgOutline.style.left = (S.viewportCrop.x / S.mapWidth * 100) + '%';
      imgOutline.style.top = (S.viewportCrop.y / S.mapHeight * 100) + '%';
      imgOutline.style.width = (S.viewportCrop.w / S.mapWidth * 100) + '%';
      imgOutline.style.height = (S.viewportCrop.h / S.mapHeight * 100) + '%';
    }
  }
}

// === Text Overlay ===
function closeCropPanel() {
  const panel = document.getElementById('crop-panel');
  const details = panel && panel.closest('details');
  if (details) details.open = false;
  const btnFog = document.getElementById('btn-crop');
  const btnImg = document.getElementById('btn-crop-img');
  if (btnFog) btnFog.classList.remove('active');
  if (btnImg) btnImg.classList.remove('active');
}
export function toggleTextPanel() { toggleSidebarSection('text-overlay-panel'); }
export function toggleProjectionPanel() {
  const isOpen = toggleSidebarSection('projection-panel');
  const btn = document.getElementById('btn-projection');
  if (btn) btn.classList.toggle('active', isOpen);
}
export function showTextOnPlayer() {
  const text = document.getElementById('text-input').value.trim();
  if (text && S.mapChannel) S.mapChannel.postMessage({ type: 'show-text', text });
}
export function hideTextOnPlayer() {
  if (S.mapChannel) S.mapChannel.postMessage({ type: 'hide-text' });
}
