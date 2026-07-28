// GM Display — sidebar.js
// Sidebar resize and collapse.
// Classic script: load order matters (see gm_display.html).
// === Sidebar resize + collapse ===
const SIDEBAR_WIDTH_KEY = 'gm-display:sidebar-width';
const SIDEBAR_COLLAPSED_KEY = 'gm-display:sidebar-collapsed';

function initSidebarResize() {
  const sidebar = document.getElementById('sidebar');
  const handle = document.getElementById('sidebar-resize-handle');
  if (!sidebar || !handle) return;

  // Restore persisted state
  const savedWidth = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
  if (savedWidth && !isNaN(savedWidth) && savedWidth >= 240 && savedWidth <= 700) {
    sidebar.style.width = savedWidth + 'px';
  }
  if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1') {
    sidebar.classList.add('collapsed');
    const btn = document.getElementById('sidebar-collapse-btn');
    if (btn) btn.textContent = '▶';
  }

  let dragging = false;
  let startX = 0, startWidth = 0;
  handle.addEventListener('mousedown', (e) => {
    if (sidebar.classList.contains('collapsed')) return;
    dragging = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    document.body.style.cursor = 'ew-resize';
    handle.classList.add('dragging');
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newW = Math.max(240, Math.min(700, startWidth + (e.clientX - startX)));
    sidebar.style.width = newW + 'px';
    if (typeof scheduleFitCanvas === 'function') scheduleFitCanvas();
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    handle.classList.remove('dragging');
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebar.offsetWidth)); } catch (e) {}
    if (typeof scheduleFitCanvas === 'function') scheduleFitCanvas();
  });
}

function toggleSidebarCollapsed() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const collapsed = sidebar.classList.toggle('collapsed');
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch (e) {}
  const btn = document.getElementById('sidebar-collapse-btn');
  if (btn) btn.textContent = collapsed ? '▶' : '◀';
  if (typeof scheduleFitCanvas === 'function') scheduleFitCanvas();
}

// Inline rename for sidecar image filename: double-click to edit.
function initImageNameRename() {
  const el = document.getElementById('img-filename');
  if (!el) return;
  el.style.cursor = 'text';
  el.title = 'Double-click to rename';
  el.ondblclick = (e) => {
    e.stopPropagation();
    if (!lastShowSrc) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = decodeURIComponent(lastShowName || '');
    input.style.cssText = 'background:#222;color:#eee;border:1px solid #6a4;font-size:13px;padding:2px 6px;border-radius:3px;width:100%;box-sizing:border-box;';
    const commit = () => {
      const v = (input.value || '').trim();
      if (v) renameSidecarImage(v);
      else el.textContent = decodeURIComponent(lastShowName || '');
      input.replaceWith(el);
    };
    input.onblur = commit;
    input.onkeydown = (ke) => {
      if (ke.key === 'Enter') input.blur();
      else if (ke.key === 'Escape') { input.value = lastShowName || ''; input.blur(); }
    };
    el.replaceWith(input);
    input.focus();
    input.select();
  };
}

function renameSidecarImage(newName) {
  if (!lastShowSrc) return;
  lastShowName = newName;
  // Update both the image-info filename and the landing-page thumbnail label.
  const fnEl = document.getElementById('img-filename');
  if (fnEl) fnEl.textContent = decodeURIComponent(newName);
  updateShowThumbnail(lastShowSrc, newName);
  saveState();
}

// Attach (or re-attach) the painting handlers on the GM fog canvas. Idempotent.
// Scale the canvas wrap to fit inside the available main-view area while
// preserving the map's aspect ratio. Called on image load, window resize,
// and sidebar resize. The canvases' intrinsic pixel dimensions stay at
// mapWidth × mapHeight (so fog math is unaffected); only their CSS display
// size changes. paintAt() uses getBoundingClientRect, so cursor → pixel
// translation works correctly at any scale.
function fitCanvasToView() {
  if (!mapWidth || !mapHeight) return;
  const wrap = document.getElementById('gm-canvas-wrap');
  const view = document.getElementById('view-fog');
  if (!wrap || !view) return;

  // Available area = main-view's content box. Subtract a small padding so
  // the canvas doesn't kiss the edges and to leave room for the green
  // viewport-outline overlay (which sits inside the wrap).
  const padX = 16, padY = 16;
  const availW = Math.max(50, view.clientWidth  - padX);
  const availH = Math.max(50, view.clientHeight - padY);

  // Scale to fit: never upscale past 1× native. (The user can still zoom
  // into the *content* via cropZoom, which is independent of display scale.)
  const scale = Math.min(availW / mapWidth, availH / mapHeight, 1);
  const dispW = Math.round(mapWidth  * scale);
  const dispH = Math.round(mapHeight * scale);

  wrap.style.width  = dispW + 'px';
  wrap.style.height = dispH + 'px';
  // Keep the viewport-outline overlay's positioning in sync if it's visible.
  updateViewportOutline();
  // Token overlay + snap grid follow the resized canvas.
  if (typeof renderGMTokens === 'function') { renderGMTokens(); drawAllMarkers(); }
}

// Re-fit on window resize. Use a small debounce since the resize event fires
// continuously while the user drags.
let _fitDebounceTimer = null;
function scheduleFitCanvas() {
  if (_fitDebounceTimer) clearTimeout(_fitDebounceTimer);
  _fitDebounceTimer = setTimeout(() => { _fitDebounceTimer = null; fitCanvasToView(); }, 50);
}
window.addEventListener('resize', scheduleFitCanvas);

function attachFogCanvasHandlers() {
  const fogCanvas = document.getElementById('gm-fog-canvas');
  if (!fogCanvas) return;
  fogCanvas.style.cursor = 'crosshair';
  fogCanvas.onmousedown = (e) => { painting = true; paintAt(e); };
  fogCanvas.onmousemove = (e) => { if (painting) paintAt(e); };
  fogCanvas.onmouseup = () => { painting = false; pushFogHistory(); syncToMapDisplay(); renderPresetThumbnails(); saveState(); };
  fogCanvas.onmouseleave = () => { if (painting) { painting = false; pushFogHistory(); syncToMapDisplay(); renderPresetThumbnails(); saveState(); } };
}

function paintAt(e) {
  const canvas = document.getElementById('gm-fog-canvas');
  const rect = canvas.getBoundingClientRect();
  const scaleX = mapWidth / rect.width;
  const scaleY = mapHeight / rect.height;
  const cx = Math.floor((e.clientX - rect.left) * scaleX);
  const cy = Math.floor((e.clientY - rect.top) * scaleY);
  const r = Math.floor(brushSize * scaleX);
  const val = currentTool === 'reveal' ? 255 : 0;

  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx*dx + dy*dy <= r*r) {
        const px = cx + dx, py = cy + dy;
        if (px >= 0 && px < mapWidth && py >= 0 && py < mapHeight)
          fogMask[py * mapWidth + px] = val;
      }
    }
  }
  renderGMFog();
  if (!window._syncTimer) {
    window._syncTimer = setTimeout(() => { syncToMapDisplay(); window._syncTimer = null; }, 50);
  }
}

function renderGMFog() {
  if (!fogMask || !mapWidth || !mapHeight) return;
  const canvas = document.getElementById('gm-fog-canvas');
  const ctx = canvas.getContext('2d');
  // Ensure canvas dimensions match current map
  if (canvas.width !== mapWidth || canvas.height !== mapHeight) {
    canvas.width = mapWidth;
    canvas.height = mapHeight;
  }
  const imgData = ctx.createImageData(mapWidth, mapHeight);
  const d = imgData.data;
  const len = Math.min(fogMask.length, mapWidth * mapHeight);
  for (let i = 0; i < len; i++) {
    if (fogMask[i] === 0) { const idx = i*4; d[idx]=0; d[idx+1]=0; d[idx+2]=0; d[idx+3]=160; }
  }
  ctx.putImageData(imgData, 0, 0);
}

function revealAll() { fogMask.fill(255); pushFogHistory(); renderGMFog(); syncToMapDisplay(); renderPresetThumbnails(); saveState(); }
function hideAll() { fogMask.fill(0); pushFogHistory(); renderGMFog(); syncToMapDisplay(); renderPresetThumbnails(); saveState(); }

// --- Fog undo/redo ---
function pushFogHistory() {
  if (!fogMask) return;
  // Discard any redo states beyond current position
  fogHistory = fogHistory.slice(0, fogHistoryIdx + 1);
  // Push a copy of the current fog mask
  fogHistory.push(new Uint8Array(fogMask));
  // Trim to max size
  if (fogHistory.length > FOG_HISTORY_MAX) {
    fogHistory.shift();
  }
  fogHistoryIdx = fogHistory.length - 1;
  updateUndoRedoButtons();
}

function fogUndo() {
  if (fogHistoryIdx <= 0 || !fogMask) return;
  fogHistoryIdx--;
  fogMask = new Uint8Array(fogHistory[fogHistoryIdx]);
  renderGMFog();
  syncToMapDisplay();
  renderPresetThumbnails();
  saveState();
  updateUndoRedoButtons();
}

function fogRedo() {
  if (fogHistoryIdx >= fogHistory.length - 1 || !fogMask) return;
  fogHistoryIdx++;
  fogMask = new Uint8Array(fogHistory[fogHistoryIdx]);
  renderGMFog();
  syncToMapDisplay();
  renderPresetThumbnails();
  saveState();
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  const undoBtn = document.getElementById('btn-fog-undo');
  const redoBtn = document.getElementById('btn-fog-redo');
  if (undoBtn) undoBtn.disabled = fogHistoryIdx <= 0;
  if (redoBtn) redoBtn.disabled = fogHistoryIdx >= fogHistory.length - 1;
}
