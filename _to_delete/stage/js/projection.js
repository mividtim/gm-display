// GM Display — projection.js
// Projection settings, background, rotation.
// Classic script: load order matters (see gm_display.html).
// === Projection Settings (GM -> Projector only) ===
// Keystone, scale, grid, and projector rotation. Sidecar gets its own minimal
// settings via sendShowSettings — it doesn't need keystone/scale/grid.
function sendProjectionSettings() {
  if (!mapChannel) return;
  mapChannel.postMessage({
    type: 'projection',
    corners: JSON.parse(JSON.stringify(corners)),
    scale: projScale,
    rotation: mapRotation,
    background: mapBg,
    gridEnabled, gridPx, gridOpacity,
    gridColor: gridColorTemplate.replace('__A__', gridOpacity)
  });
}

// Sidecar-specific settings: rotation + background.
function sendShowSettings() {
  if (!showChannel) return;
  showChannel.postMessage({ type: 'show-settings', rotation: showRotation, background: showBg });
}

// === Background ===
function setMapBg(color) {
  mapBg = color || '#000000';
  updateBgUI();
  sendProjectionSettings();
  // Persist per-image when a map is currently loaded — the bg becomes part of
  // that map's saved state and auto-applies next time it's opened.
  if (lastMapSrc) saveBgForSrc(lastMapSrc, mapBg);
  saveState();
}
function setShowBg(color) {
  showBg = color || '#000000';
  updateBgUI();
  sendShowSettings();
  if (currentMode === 'image') renderGMImage();
  if (lastShowSrc) saveBgForSrc(lastShowSrc, showBg);
  saveState();
}
function updateBgUI() {
  // Single bg-color UI — reflects whichever target is active.
  const c = activeBg();
  const m = document.getElementById('map-bg-color');
  if (m) m.value = c;
  // Legacy element kept for backward compat.
  const s = document.getElementById('show-bg-color');
  if (s) s.value = c;
}

// === Rotation ===
// Rotation is per-display: projector and sidecar rotate independently.
function normalizeDeg(d) { return ((Math.round(+d) % 360) + 360) % 360; }

function setMapRotation(deg) {
  mapRotation = normalizeDeg(deg);
  updateRotationUI();
  if (currentMode === 'fog') {
    computeViewportCrop();
    updateViewportOutline();
    sendCropUpdate();
  }
  sendProjectionSettings();
  saveState();
}

function setShowRotation(deg) {
  showRotation = normalizeDeg(deg);
  updateRotationUI();
  if (currentMode === 'image') {
    computeViewportCrop();
    updateViewportOutline();
    sendCropUpdate();
  }
  sendShowSettings();
  // Mirror the rotation in the GM preview if it's the active view.
  if (currentMode === 'image') renderGMImage();
  saveState();
}

function rotateMap(delta) { setMapRotation(mapRotation + delta); }
function rotateShow(delta) { setShowRotation(showRotation + delta); }

// Returns the rotation value for the currently-active edit target.
function activeRotation() {
  return fogContext === 'show' ? showRotation : mapRotation;
}

// All rotation controls now route based on fogContext (the active edit target).
// One slider, one set of buttons — applies to whichever display the active
// entry targets.
function rotateBy(delta) {
  if (fogContext === 'show') rotateShow(delta);
  else rotateMap(delta);
}
function setRotation(deg) {
  if (fogContext === 'show') setShowRotation(deg);
  else setMapRotation(deg);
}
function updateRotation(val) { setRotation(val); }

// Unified background-color setter — routes based on fogContext.
function setBg(color) {
  if (fogContext === 'show') setShowBg(color);
  else setMapBg(color);
}
function activeBg() {
  return fogContext === 'show' ? showBg : mapBg;
}

function updateRotationUI() {
  // Single rotation UI now — reflects whichever target is active.
  const r = activeRotation();
  const slider = document.getElementById('rotation-slider');
  const valEl = document.getElementById('rotation-val');
  if (slider) slider.value = r;
  if (valEl) valEl.textContent = r + '°';
  // Legacy element kept for backward compat in case any handler still updates it.
  const valElImg = document.getElementById('rotation-val-img');
  if (valElImg) valElImg.textContent = r + '°';
}

// 4-corner keystone
function nudgeCorner(corner, axis, dir) {
  const step = window.event && window.event.shiftKey ? 10 : 1;
  corners[corner][axis] += dir * step;
  document.getElementById('corner-' + corner + '-val').textContent =
    corners[corner].x + ',' + corners[corner].y;
  sendProjectionSettings();
  saveState();
}

function resetCorner(corner) {
  corners[corner] = { x: 0, y: 0 };
  document.getElementById('corner-' + corner + '-val').textContent = '0,0';
  sendProjectionSettings();
  saveState();
}

// --- Joystick drag for keystone corners ---
// Click and hold a drag pad, then move the mouse — 1px of cursor movement = 1px of corner offset.
let dragCorner = null;
let dragStartX = 0, dragStartY = 0;
let dragStartCornerX = 0, dragStartCornerY = 0;

function initCornerDrag() {
  document.querySelectorAll('.corner-drag').forEach(pad => {
    pad.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragCorner = pad.dataset.corner;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragStartCornerX = corners[dragCorner].x;
      dragStartCornerY = corners[dragCorner].y;
      pad.classList.add('dragging');
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragCorner) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    corners[dragCorner].x = dragStartCornerX + dx;
    corners[dragCorner].y = dragStartCornerY + dy;
    document.getElementById('corner-' + dragCorner + '-val').textContent =
      corners[dragCorner].x + ',' + corners[dragCorner].y;
    sendProjectionSettings();
  });

  document.addEventListener('mouseup', () => {
    if (dragCorner) {
      const pad = document.querySelector(`.corner-drag[data-corner="${dragCorner}"]`);
      if (pad) pad.classList.remove('dragging');
      dragCorner = null;
      saveState();
    }
  });
}

// --- Joystick drag for crop pan (pixel precision) ---
// Click and hold the pan pad, then move the mouse — 1px of cursor movement = 1px of map pan.
// Mirrors initCornerDrag.
let panDragging = false;
let panDragStartX = 0, panDragStartY = 0;
let panDragStartH = 0, panDragStartV = 0;

function initPanDrag() {
  const pad = document.getElementById('pan-drag');
  if (!pad) return;
  pad.addEventListener('mousedown', (e) => {
    e.preventDefault();
    panDragging = true;
    panDragStartX = e.clientX;
    panDragStartY = e.clientY;
    panDragStartH = cropHPos;
    panDragStartV = cropVPos;
    pad.classList.add('dragging');
  });

  document.addEventListener('mousemove', (e) => {
    if (!panDragging) return;
    const dx = e.clientX - panDragStartX;
    const dy = e.clientY - panDragStartY;
    if (mapWidth)  cropHPos = Math.max(0, Math.min(1, panDragStartH + dx / mapWidth));
    if (mapHeight) cropVPos = Math.max(0, Math.min(1, panDragStartV + dy / mapHeight));
    applyCropToSliders();
  });

  document.addEventListener('mouseup', () => {
    if (panDragging) {
      panDragging = false;
      const pad = document.getElementById('pan-drag');
      if (pad) pad.classList.remove('dragging');
      saveCropForCurrentImage();
      saveState();
    }
  });
}

// --- Test pattern: solid white rectangle with 1" grid ---
let testPatternActive = false;

function toggleTestPattern() {
  testPatternActive = !testPatternActive;
  const btn = document.getElementById('btn-test-pattern');
  if (btn) {
    btn.classList.toggle('active', testPatternActive);
    btn.textContent = testPatternActive ? 'Show Map (exit test)' : 'Test Pattern (white + grid)';
  }
  if (mapChannel) {
    mapChannel.postMessage({ type: 'test-pattern', enabled: testPatternActive });
  }
  saveState();
}

function updateScale(val) {
  projScale = parseInt(val);
  document.getElementById('scale-val').textContent = projScale + '%';
  sendProjectionSettings();
  saveState();
}
function toggleGrid() {
  gridEnabled = !gridEnabled;
  document.getElementById('grid-status').textContent = gridEnabled ? 'ON' : 'OFF';
  document.getElementById('btn-grid').classList.toggle('active', gridEnabled);
  sendProjectionSettings();
  saveState();
}
function updateGridSize(val) {
  gridPx = parseInt(val);
  document.getElementById('grid-px-val').textContent = gridPx + 'px';
  sendProjectionSettings();
  saveState();
}
function updateGridOpacity(val) {
  gridOpacity = parseInt(val) / 100;
  document.getElementById('grid-opacity-val').textContent = val + '%';
  sendProjectionSettings();
  saveState();
}
function setGridColor(template) {
  gridColorTemplate = template;
  sendProjectionSettings();
  saveState();
}
function resetProjection() {
  corners = { tl: {x:0,y:0}, tr: {x:0,y:0}, bl: {x:0,y:0}, br: {x:0,y:0} };
  projScale = 100;
  // Reset only the projector rotation here (this panel is the projector's controls).
  // Sidecar rotation has its own reset button on the image page.
  mapRotation = 0;
  gridEnabled = false; gridPx = 50; gridOpacity = 0.4;
  gridColorTemplate = 'rgba(255,255,255,__A__)';
  document.getElementById('scale-slider').value = 100;
  document.getElementById('grid-px-slider').value = 50;
  document.getElementById('grid-opacity-slider').value = 40;
  document.getElementById('scale-val').textContent = '100%';
  document.getElementById('grid-px-val').textContent = '50px';
  document.getElementById('grid-opacity-val').textContent = '40%';
  document.getElementById('grid-status').textContent = 'OFF';
  document.getElementById('btn-grid').classList.remove('active');
  updateRotationUI();
  ['tl','tr','bl','br'].forEach(c =>
    document.getElementById('corner-' + c + '-val').textContent = '0,0');
  // Turn off test pattern if active
  if (testPatternActive) toggleTestPattern();
  // Recompute crop after rotation reset
  computeViewportCrop();
  updateViewportOutline();
  sendCropUpdate();
  sendProjectionSettings();
  saveState();
}
