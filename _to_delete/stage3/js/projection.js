// GM Display — projection.js
// Projection settings, background, rotation.
// Classic script: load order matters (see gm_display.html).
// === Projection Settings (GM -> Projector only) ===
// Keystone, scale, grid, and projector rotation. Sidecar gets its own minimal
// settings via sendShowSettings — it doesn't need keystone/scale/grid.
import { S } from './store.js';
import { applyCropToSliders, computeViewportCrop, sendCropUpdate, updateViewportOutline } from './crop.js';
import { renderGMImage } from './fog.js';
import { saveState } from './games.js';
import { saveBgForSrc, saveCropForCurrentImage } from './per-map-store.js';
export function sendProjectionSettings() {
  if (!S.mapChannel) return;
  S.mapChannel.postMessage({
    type: 'projection',
    corners: JSON.parse(JSON.stringify(S.corners)),
    scale: S.projScale,
    rotation: S.mapRotation,
    background: S.mapBg,
    gridEnabled: S.gridEnabled, gridPx: S.gridPx, gridOpacity: S.gridOpacity,
    gridColor: S.gridColorTemplate.replace('__A__', S.gridOpacity)
  });
}

// Sidecar-specific settings: rotation + background.
export function sendShowSettings() {
  if (!S.showChannel) return;
  S.showChannel.postMessage({ type: 'show-settings', rotation: S.showRotation, background: S.showBg });
}

// === Background ===
function setMapBg(color) {
  S.mapBg = color || '#000000';
  updateBgUI();
  sendProjectionSettings();
  // Persist per-image when a map is currently loaded — the bg becomes part of
  // that map's saved state and auto-applies next time it's opened.
  if (S.lastMapSrc) saveBgForSrc(S.lastMapSrc, S.mapBg);
  saveState();
}
function setShowBg(color) {
  S.showBg = color || '#000000';
  updateBgUI();
  sendShowSettings();
  if (S.currentMode === 'image') renderGMImage();
  if (S.lastShowSrc) saveBgForSrc(S.lastShowSrc, S.showBg);
  saveState();
}
export function updateBgUI() {
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
  S.mapRotation = normalizeDeg(deg);
  updateRotationUI();
  if (S.currentMode === 'fog') {
    computeViewportCrop();
    updateViewportOutline();
    sendCropUpdate();
  }
  sendProjectionSettings();
  saveState();
}

function setShowRotation(deg) {
  S.showRotation = normalizeDeg(deg);
  updateRotationUI();
  if (S.currentMode === 'image') {
    computeViewportCrop();
    updateViewportOutline();
    sendCropUpdate();
  }
  sendShowSettings();
  // Mirror the rotation in the GM preview if it's the active view.
  if (S.currentMode === 'image') renderGMImage();
  saveState();
}

function rotateMap(delta) { setMapRotation(S.mapRotation + delta); }
function rotateShow(delta) { setShowRotation(S.showRotation + delta); }

// Returns the rotation value for the currently-active edit target.
function activeRotation() {
  return S.fogContext === 'show' ? S.showRotation : S.mapRotation;
}

// All rotation controls now route based on fogContext (the active edit target).
// One slider, one set of buttons — applies to whichever display the active
// entry targets.
export function rotateBy(delta) {
  if (S.fogContext === 'show') rotateShow(delta);
  else rotateMap(delta);
}
export function setRotation(deg) {
  if (S.fogContext === 'show') setShowRotation(deg);
  else setMapRotation(deg);
}
function updateRotation(val) { setRotation(val); }

// Unified background-color setter — routes based on fogContext.
export function setBg(color) {
  if (S.fogContext === 'show') setShowBg(color);
  else setMapBg(color);
}
export function activeBg() {
  return S.fogContext === 'show' ? S.showBg : S.mapBg;
}

export function updateRotationUI() {
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
export function nudgeCorner(corner, axis, dir) {
  const step = window.event && window.event.shiftKey ? 10 : 1;
  S.corners[corner][axis] += dir * step;
  document.getElementById('corner-' + corner + '-val').textContent =
    S.corners[corner].x + ',' + S.corners[corner].y;
  sendProjectionSettings();
  saveState();
}

export function resetCorner(corner) {
  S.corners[corner] = { x: 0, y: 0 };
  document.getElementById('corner-' + corner + '-val').textContent = '0,0';
  sendProjectionSettings();
  saveState();
}

// --- Joystick drag for keystone corners ---
// Click and hold a drag pad, then move the mouse — 1px of cursor movement = 1px of corner offset.
let dragCorner = null;
let dragStartX = 0, dragStartY = 0;
let dragStartCornerX = 0, dragStartCornerY = 0;

export function initCornerDrag() {
  document.querySelectorAll('.corner-drag').forEach(pad => {
    pad.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragCorner = pad.dataset.corner;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragStartCornerX = S.corners[dragCorner].x;
      dragStartCornerY = S.corners[dragCorner].y;
      pad.classList.add('dragging');
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragCorner) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    S.corners[dragCorner].x = dragStartCornerX + dx;
    S.corners[dragCorner].y = dragStartCornerY + dy;
    document.getElementById('corner-' + dragCorner + '-val').textContent =
      S.corners[dragCorner].x + ',' + S.corners[dragCorner].y;
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

export function initPanDrag() {
  const pad = document.getElementById('pan-drag');
  if (!pad) return;
  pad.addEventListener('mousedown', (e) => {
    e.preventDefault();
    panDragging = true;
    panDragStartX = e.clientX;
    panDragStartY = e.clientY;
    panDragStartH = S.cropHPos;
    panDragStartV = S.cropVPos;
    pad.classList.add('dragging');
  });

  document.addEventListener('mousemove', (e) => {
    if (!panDragging) return;
    const dx = e.clientX - panDragStartX;
    const dy = e.clientY - panDragStartY;
    if (S.mapWidth)  S.cropHPos = Math.max(0, Math.min(1, panDragStartH + dx / S.mapWidth));
    if (S.mapHeight) S.cropVPos = Math.max(0, Math.min(1, panDragStartV + dy / S.mapHeight));
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
S.testPatternActive = false;

export function toggleTestPattern() {
  S.testPatternActive = !S.testPatternActive;
  const btn = document.getElementById('btn-test-pattern');
  if (btn) {
    btn.classList.toggle('active', S.testPatternActive);
    btn.textContent = S.testPatternActive ? 'Show Map (exit test)' : 'Test Pattern (white + grid)';
  }
  if (S.mapChannel) {
    S.mapChannel.postMessage({ type: 'test-pattern', enabled: S.testPatternActive });
  }
  saveState();
}

export function updateScale(val) {
  S.projScale = parseInt(val);
  document.getElementById('scale-val').textContent = S.projScale + '%';
  sendProjectionSettings();
  saveState();
}
export function toggleGrid() {
  S.gridEnabled = !S.gridEnabled;
  document.getElementById('grid-status').textContent = S.gridEnabled ? 'ON' : 'OFF';
  document.getElementById('btn-grid').classList.toggle('active', S.gridEnabled);
  sendProjectionSettings();
  saveState();
}
export function updateGridSize(val) {
  S.gridPx = parseInt(val);
  document.getElementById('grid-px-val').textContent = S.gridPx + 'px';
  sendProjectionSettings();
  saveState();
}
export function updateGridOpacity(val) {
  S.gridOpacity = parseInt(val) / 100;
  document.getElementById('grid-opacity-val').textContent = val + '%';
  sendProjectionSettings();
  saveState();
}
export function setGridColor(template) {
  S.gridColorTemplate = template;
  sendProjectionSettings();
  saveState();
}
export function resetProjection() {
  S.corners = { tl: {x:0,y:0}, tr: {x:0,y:0}, bl: {x:0,y:0}, br: {x:0,y:0} };
  S.projScale = 100;
  // Reset only the projector rotation here (this panel is the projector's controls).
  // Sidecar rotation has its own reset button on the image page.
  S.mapRotation = 0;
  S.gridEnabled = false; S.gridPx = 50; S.gridOpacity = 0.4;
  S.gridColorTemplate = 'rgba(255,255,255,__A__)';
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
  if (S.testPatternActive) toggleTestPattern();
  // Recompute crop after rotation reset
  computeViewportCrop();
  updateViewportOutline();
  sendCropUpdate();
  sendProjectionSettings();
  saveState();
}
