// GM Display — crop.js
// Crop sliders and the text overlay.
// Classic script: load order matters (see gm_display.html).
// === Crop Sliders (controls what the projector shows) ===
// Sidebar sections are <details> elements; "toggle" means open/close that section.
function toggleSidebarSection(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return false;
  const details = panel.closest('details');
  if (!details) return false;
  details.open = !details.open;
  if (details.open) details.scrollIntoView({block: 'nearest', behavior: 'smooth'});
  return details.open;
}
function toggleCropPanel() {
  const isOpen = toggleSidebarSection('crop-panel');
  const btnFog = document.getElementById('btn-crop');
  const btnImg = document.getElementById('btn-crop-img');
  if (btnFog) btnFog.classList.toggle('active', isOpen);
  if (btnImg) btnImg.classList.toggle('active', isOpen);
}

function cropFit() {
  // Show the entire map — zoom 1x (default). Black bars fill gaps.
  cropZoom = 1; cropHPos = 0.5; cropVPos = 0.5;
  applyCropToSliders();
  highlightCropButton('fit');
  saveCropForCurrentImage();
  saveState();
}

// Stepwise zoom: nudges cropZoom by `delta` (e.g. 0.05 = +5%, -0.05 = -5%).
// Used by the View tab's +/- buttons in place of a slider.
function zoomBy(delta) {
  cropZoom = Math.max(0.1, Math.min(10, cropZoom + delta));
  applyCropToSliders();
  saveCropForCurrentImage();
  saveState();
}

// Set zoom directly from a percent value (e.g. typed numeric input).
function setZoomPercent(pct) {
  const v = parseFloat(pct);
  if (!isFinite(v)) return;
  cropZoom = Math.max(0.1, Math.min(10, v / 100));
  applyCropToSliders();
  saveCropForCurrentImage();
  saveState();
}

function cropFill() {
  // Zoom so the map fills the screen completely (no black bars).
  // Fill = largest screen-ratio rect that fits inside the map.
  if (!mapWidth || !mapHeight) return;
  const targetIsShow = (currentMode === 'image') ||
                       (currentMode === 'fog' && fogContext === 'show');
  const baseScrW = targetIsShow ? sidecarW : projectorW;
  const baseScrH = targetIsShow ? sidecarH : projectorH;
  const activeRotation = targetIsShow ? showRotation : mapRotation;
  const isRotated90 = (activeRotation === 90 || activeRotation === 270);
  const scrW = isRotated90 ? baseScrH : baseScrW;
  const scrH = isRotated90 ? baseScrW : baseScrH;
  const screenAspect = scrW / scrH;
  const mapAspect = mapWidth / mapHeight;

  // Fill dimensions: largest screen-ratio rect inside the map
  let fillW, fillH;
  if (screenAspect > mapAspect) {
    fillW = mapWidth;
    fillH = mapWidth / screenAspect;
  } else {
    fillH = mapHeight;
    fillW = mapHeight * screenAspect;
  }

  // Solve for cropZoom such that the Fit baseline divided by cropZoom
  // equals the Fill rect. The Fit baseline is now the smallest screen-aspect
  // rect CONTAINING the map (matches computeViewportCrop):
  //   screen wider than map: baseW = mapHeight × screenAspect
  //   screen narrower:       baseW = mapWidth
  const baseW = (screenAspect > mapAspect)
    ? mapHeight * screenAspect
    : mapWidth;
  cropZoom = baseW / fillW;

  cropHPos = 0.5; cropVPos = 0.5;
  applyCropToSliders();
  highlightCropButton('fill');
  saveCropForCurrentImage();
  saveState();
}

function applyCropToSliders() {
  const zoomPct = cropZoom * 100;
  document.getElementById('crop-zoom').value = Math.max(10, Math.min(1000, zoomPct));
  document.getElementById('crop-hpos').value = cropHPos * 100;
  document.getElementById('crop-vpos').value = cropVPos * 100;
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

function updateCrop() {
  cropZoom = parseFloat(document.getElementById('crop-zoom').value) / 100;
  cropHPos = parseFloat(document.getElementById('crop-hpos').value) / 100;
  cropVPos = parseFloat(document.getElementById('crop-vpos').value) / 100;

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
  document.getElementById('crop-zoom-val').textContent = cropZoom.toFixed(2) + 'x';
  const hPx = mapWidth ? Math.round(cropHPos * mapWidth) : 0;
  const vPx = mapHeight ? Math.round(cropVPos * mapHeight) : 0;
  document.getElementById('crop-hpos-val').textContent =
    (cropHPos * 100).toFixed(1) + '%' + (mapWidth ? ' (' + hPx + 'px)' : '');
  document.getElementById('crop-vpos-val').textContent =
    (cropVPos * 100).toFixed(1) + '%' + (mapHeight ? ' (' + vPx + 'px)' : '');
}

function sendCropUpdate() {
  // Route the crop update to whichever display the GM is currently editing.
  if (currentMode === 'fog') {
    const ch = activeFogChannel();
    if (!ch) return;
    if (fogContext === 'map' && !liveSync) {
      markPendingSync();
      return;
    }
    ch.postMessage({ type: 'crop-update', crop: viewportCrop });
    if (fogContext === 'map') pushPlayerStateToServer();
  } else if (currentMode === 'image' && showChannel) {
    showChannel.postMessage({ type: 'crop-update', crop: viewportCrop });
    // Mirror the sidecar's view in the GM preview.
    renderGMImage();
  }
}

function computeViewportCrop() {
  if (!mapWidth || !mapHeight) { viewportCrop = null; return; }

  // The "no crop needed" short-circuit fires only at exactly 1.0 (within 0.1%
  // for slider rounding). At zoom > 1 we crop into the map (zoom-in); at
  // zoom < 1 we use a viewport larger than the map (zoom-out, letterboxed
  // with the background color). Both need a real crop rect computed below.
  if (currentMode === 'fog' && Math.abs(cropZoom - 1.0) < 0.001 && Math.abs(cropHPos - 0.5) < 0.001 && Math.abs(cropVPos - 0.5) < 0.001) {
    viewportCrop = null;
    return;
  }
  if (currentMode === 'image' && Math.abs(cropZoom - 1.0) < 0.001 && Math.abs(cropHPos - 0.5) < 0.001 && Math.abs(cropVPos - 0.5) < 0.001) {
    viewportCrop = null;
    return;
  }

  // Viewport matches the target screen's aspect ratio.
  // Target display: image mode AND show-fog mode both target the sidecar.
  const targetIsShow = (currentMode === 'image') ||
                       (currentMode === 'fog' && fogContext === 'show');
  const baseScrW = targetIsShow ? sidecarW : projectorW;
  const baseScrH = targetIsShow ? sidecarH : projectorH;
  const activeRotation = targetIsShow ? showRotation : mapRotation;
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
  const mapAspect = mapWidth / mapHeight;
  let baseW, baseH;
  if (screenAspect > mapAspect) {
    baseH = mapHeight;
    baseW = mapHeight * screenAspect;
  } else {
    baseW = mapWidth;
    baseH = mapWidth / screenAspect;
  }

  let w = baseW / cropZoom;
  let h = baseH / cropZoom;

  w = Math.max(1, Math.floor(w));
  h = Math.max(1, Math.floor(h));

  // Position: allow panning past map edges so any area can be centered.
  // At 50% = centered on map. 0%/100% = viewport extends half its size
  // past the map edge, so edge content can be centered on screen.
  // Range: x from -(w/2) to (mapWidth - w/2)
  const rangeX = mapWidth;
  const rangeY = mapHeight;
  let x = Math.floor(cropHPos * rangeX - w / 2);
  let y = Math.floor(cropVPos * rangeY - h / 2);

  // Snap-to-edge: if within 15px of a clean alignment, snap to it
  const snap = 15;
  // Snap: left edge of map at left edge of viewport (x=0)
  if (Math.abs(x) < snap) x = 0;
  // Snap: right edge of map at right edge of viewport
  if (Math.abs(x - (mapWidth - w)) < snap) x = mapWidth - w;
  // Snap: top edge
  if (Math.abs(y) < snap) y = 0;
  // Snap: bottom edge
  if (Math.abs(y - (mapHeight - h)) < snap) y = mapHeight - h;
  // Snap: centered
  const cx = Math.floor((mapWidth - w) / 2);
  const cy = Math.floor((mapHeight - h) / 2);
  if (Math.abs(x - cx) < snap) x = cx;
  if (Math.abs(y - cy) < snap) y = cy;

  viewportCrop = { x, y, w, h };
}

function resetCrop() {
  cropZoom = 1; cropHPos = 0.5; cropVPos = 0.5;
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
  viewportCrop = null;
  updateViewportOutline();
  sendCropUpdate();
  setStatus('Crop reset — projector shows full map');
}

function updateViewportOutline() {
  // Fog mode outline. The canvas wrap is now sized to fit the view (scaled
  // down from raw map pixels), so we position the outline as percentages of
  // the wrap (which is the same as percentages of the map, since the wrap
  // preserves the map's aspect ratio).
  const outline = document.getElementById('viewport-outline');
  if (outline) {
    if (!viewportCrop || !mapWidth || !mapHeight) {
      outline.style.display = 'none';
    } else {
      outline.style.display = 'block';
      outline.style.left = (viewportCrop.x / mapWidth * 100) + '%';
      outline.style.top = (viewportCrop.y / mapHeight * 100) + '%';
      outline.style.width = (viewportCrop.w / mapWidth * 100) + '%';
      outline.style.height = (viewportCrop.h / mapHeight * 100) + '%';
    }
  }

  // Image mode outline (positioned as percentages over the preview image)
  const imgOutline = document.getElementById('image-viewport-outline');
  if (imgOutline) {
    if (!viewportCrop || !mapWidth || !mapHeight) {
      imgOutline.style.display = 'none';
    } else {
      imgOutline.style.display = 'block';
      // Convert map-pixel crop rect to percentage of image dimensions
      imgOutline.style.left = (viewportCrop.x / mapWidth * 100) + '%';
      imgOutline.style.top = (viewportCrop.y / mapHeight * 100) + '%';
      imgOutline.style.width = (viewportCrop.w / mapWidth * 100) + '%';
      imgOutline.style.height = (viewportCrop.h / mapHeight * 100) + '%';
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
function toggleTextPanel() { toggleSidebarSection('text-overlay-panel'); }
function toggleProjectionPanel() {
  const isOpen = toggleSidebarSection('projection-panel');
  const btn = document.getElementById('btn-projection');
  if (btn) btn.classList.toggle('active', isOpen);
}
function showTextOnPlayer() {
  const text = document.getElementById('text-input').value.trim();
  if (text && mapChannel) mapChannel.postMessage({ type: 'show-text', text });
}
function hideTextOnPlayer() {
  if (mapChannel) mapChannel.postMessage({ type: 'hide-text' });
}
