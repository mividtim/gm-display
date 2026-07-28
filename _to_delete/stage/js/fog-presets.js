// GM Display — fog-presets.js
// Fog presets and syncing the active display.
// Classic script: load order matters (see gm_display.html).
// === Fog Presets ===
function ensureDefaultPreset() {
  if (fogPresets.length === 0) {
    fogPresets = [{ name: 'Default', rle: fogMask ? rlEncode(fogMask) : [], w: mapWidth, h: mapHeight }];
    activePresetIdx = 0;
  }
}

function newPreset(type) {
  if (!mapWidth || !mapHeight) return;
  const len = mapWidth * mapHeight;
  const mask = new Uint8Array(len);
  if (type === 'full') mask.fill(255);
  const name = (type === 'full' ? 'Revealed' : 'Hidden') + ' ' + (fogPresets.length + 1);
  const rle = rlEncode(mask);
  fogPresets.push({ name, rle, w: mapWidth, h: mapHeight });
  switchToPreset(fogPresets.length - 1);
  savePerMapFog(lastMapSrc);
}

function copyPreset() {
  if (!fogPresets[activePresetIdx]) return;
  // Save current mask to active preset first
  if (fogMask) fogPresets[activePresetIdx].rle = rlEncode(fogMask);
  const src = fogPresets[activePresetIdx];
  fogPresets.push({ name: src.name + ' copy', rle: [...src.rle], w: src.w, h: src.h });
  switchToPreset(fogPresets.length - 1);
  savePerMapFog(lastMapSrc);
}

function deletePreset(idx) {
  if (fogPresets.length <= 1) return; // keep at least one
  const wasActive = (idx === activePresetIdx);
  fogPresets.splice(idx, 1);

  if (wasActive) {
    // Deleted the active preset — load the nearest one without saving old mask
    activePresetIdx = Math.min(idx, fogPresets.length - 1);
    const p = fogPresets[activePresetIdx];
    const len = mapWidth * mapHeight;
    fogMask = p.rle && p.rle.length > 0 ? rlDecode(p.rle, len) : new Uint8Array(len);
    fogHistory = [new Uint8Array(fogMask)];
    fogHistoryIdx = 0;
    updateUndoRedoButtons();
    renderGMFog();
    syncToMapDisplay();
  } else if (idx < activePresetIdx) {
    activePresetIdx--;
  }
  renderPresetThumbnails();
  savePerMapFog(lastMapSrc);
}

function switchToPreset(idx) {
  if (idx < 0 || idx >= fogPresets.length) return;
  // Save current fog to outgoing preset
  if (fogMask && fogPresets[activePresetIdx]) {
    fogPresets[activePresetIdx].rle = rlEncode(fogMask);
  }
  activePresetIdx = idx;
  const p = fogPresets[idx];
  const len = mapWidth * mapHeight;
  fogMask = p.rle && p.rle.length > 0 ? rlDecode(p.rle, len) : new Uint8Array(len);
  // Reset undo history for new preset
  fogHistory = [new Uint8Array(fogMask)];
  fogHistoryIdx = 0;
  updateUndoRedoButtons();
  renderGMFog();
  syncToMapDisplay();
  renderPresetThumbnails();
  // Persist the new activeIdx in the per-image fog data so it sticks across
  // image switches (saveState alone only writes global state, not per-image).
  const src = fogImage ? fogImage.src : (fogContext === 'show' ? lastShowSrc : lastMapSrc);
  if (src) savePerMapFog(src);
  saveState();
}

function reorderPreset(fromIdx, toIdx) {
  if (fromIdx < 0 || fromIdx >= fogPresets.length) return;
  if (toIdx < 0 || toIdx >= fogPresets.length) return;
  if (fromIdx === toIdx) return;

  // Snapshot current fogMask into the source preset before moving — otherwise
  // unsaved paint would be lost on the move.
  if (fogMask && fogPresets[activePresetIdx]) {
    fogPresets[activePresetIdx].rle = rlEncode(fogMask);
    fogPresets[activePresetIdx].w = mapWidth;
    fogPresets[activePresetIdx].h = mapHeight;
  }

  // Track the active preset's identity through the reorder.
  const activePreset = fogPresets[activePresetIdx];
  const item = fogPresets.splice(fromIdx, 1)[0];
  fogPresets.splice(toIdx, 0, item);
  activePresetIdx = fogPresets.indexOf(activePreset);

  savePerMapFog(fogImage ? fogImage.src : (lastInitializedFogSrc || ''));
  renderPresetThumbnails();
}

function renamePreset(idx, newName) {
  if (fogPresets[idx]) {
    fogPresets[idx].name = newName;
    savePerMapFog(lastMapSrc);
    renderPresetThumbnails();
  }
}

function renderPresetThumbnails() {
  const container = document.getElementById('fog-presets-list');
  if (!container) return;
  container.innerHTML = '';

  // Helper: open the rename input for a given preset's wrap element.
  const openRenameInput = (wrap, idx, preset) => {
    const label = wrap.querySelector('.preset-name');
    if (!label) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = preset.name || '';
    input.className = 'preset-name'; // inherits positioning
    input.style.cssText = 'position:absolute;bottom:0;left:0;right:0;background:#222;color:#eee;border:1px solid #6a4;font-size:9px;padding:1px 4px;text-align:center;box-sizing:border-box;z-index:5;';
    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const v = (input.value || '').trim();
      renamePreset(idx, v || `Preset ${idx + 1}`);
    };
    input.onblur = commit;
    input.onkeydown = (ke) => {
      if (ke.key === 'Enter') input.blur();
      else if (ke.key === 'Escape') { committed = true; renderPresetThumbnails(); }
    };
    label.replaceWith(input);
    input.focus();
    input.select();
  };

  fogPresets.forEach((preset, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'fog-preset-thumb' + (idx === activePresetIdx ? ' active' : '');
    wrap.title = 'Click to switch • Double-click to rename • Drag to reorder';
    wrap.draggable = true;
    wrap.dataset.idx = idx;
    wrap.onclick = (e) => {
      // Don't switch when interacting with the rename input or its commit button
      if (e.target.tagName === 'INPUT' || e.target.classList.contains('preset-rename-btn')) return;
      switchToPreset(idx);
    };
    // Double-click anywhere on the thumb opens the rename input. (Putting this
    // on the wrap rather than the tiny label avoids the precision miss and
    // dodges any draggable+child dblclick quirk.)
    wrap.ondblclick = (e) => {
      if (e.target.tagName === 'INPUT') return;
      e.stopPropagation();
      e.preventDefault();
      openRenameInput(wrap, idx, preset);
    };

    // Drag-and-drop reorder
    wrap.ondragstart = (e) => {
      e.dataTransfer.setData('text/plain', String(idx));
      e.dataTransfer.effectAllowed = 'move';
      wrap.style.opacity = '0.5';
    };
    wrap.ondragend = () => { wrap.style.opacity = '1'; };
    wrap.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; wrap.style.outline = '2px solid #fc5'; };
    wrap.ondragleave = () => { wrap.style.outline = ''; };
    wrap.ondrop = (e) => {
      e.preventDefault();
      wrap.style.outline = '';
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (!isNaN(fromIdx) && fromIdx !== idx) reorderPreset(fromIdx, idx);
    };

    // Mini canvas showing fog pattern
    const canvas = document.createElement('canvas');
    const thumbW = 80, thumbH = 50;
    canvas.width = thumbW;
    canvas.height = thumbH;
    const ctx = canvas.getContext('2d');

    // Draw a mini representation of the fog
    const len = (preset.w || mapWidth) * (preset.h || mapHeight);
    let mask;
    if (idx === activePresetIdx && fogMask) {
      mask = fogMask;
    } else if (preset.rle && preset.rle.length > 0) {
      mask = rlDecode(preset.rle, len);
    } else {
      mask = new Uint8Array(len);
    }

    const pw = preset.w || mapWidth || 1;
    const ph = preset.h || mapHeight || 1;
    const imgData = ctx.createImageData(thumbW, thumbH);
    const d = imgData.data;
    for (let ty = 0; ty < thumbH; ty++) {
      for (let tx = 0; tx < thumbW; tx++) {
        const mx = Math.floor(tx / thumbW * pw);
        const my = Math.floor(ty / thumbH * ph);
        const mi = my * pw + mx;
        const pi = (ty * thumbW + tx) * 4;
        if (mi < mask.length && mask[mi] === 0) {
          d[pi] = 0; d[pi+1] = 0; d[pi+2] = 0; d[pi+3] = 200;
        } else {
          d[pi] = 80; d[pi+1] = 130; d[pi+2] = 60; d[pi+3] = 120;
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
    wrap.appendChild(canvas);

    // Name label — dblclick on the whole wrap (above) opens the rename input.
    const label = document.createElement('div');
    label.className = 'preset-name';
    label.textContent = preset.name || `Preset ${idx + 1}`;
    label.title = 'Double-click to rename';
    wrap.appendChild(label);

    // Visible edit affordance (pencil icon) — appears on hover, single-click
    // also opens the rename input for users who'd rather click a button.
    const editBtn = document.createElement('button');
    editBtn.className = 'preset-rename-btn';
    editBtn.textContent = '✎';
    editBtn.title = 'Rename';
    editBtn.onclick = (e) => { e.stopPropagation(); openRenameInput(wrap, idx, preset); };
    wrap.appendChild(editBtn);

    // Delete button (hidden until hover, only if >1 preset)
    if (fogPresets.length > 1) {
      const del = document.createElement('button');
      del.className = 'preset-delete';
      del.textContent = '×';
      del.title = 'Delete this preset';
      del.onclick = (e) => { e.stopPropagation(); deletePreset(idx); };
      wrap.appendChild(del);
    }

    container.appendChild(wrap);
  });
}

function setTool(tool) {
  currentTool = tool;
  document.getElementById('btn-reveal').classList.toggle('active', tool === 'reveal');
  document.getElementById('btn-hide').classList.toggle('active', tool === 'hide');
  saveState();
}

function updateBrushPreview() {
  const el = document.getElementById('brush-preview');
  if (el) { const s = Math.max(8, Math.min(40, brushSize*0.6)); el.style.width=s+'px'; el.style.height=s+'px'; }
}

// === Sync to Active Display (map or show, depending on fogContext) ===
function syncToMapDisplay() {
  const ch = activeFogChannel();
  if (!ch || !fogMask || !fogImage) return;
  // If live sync is off, mark pending but don't push (only honored for projector)
  if (fogContext === 'map' && !liveSync) {
    markPendingSync();
    return;
  }
  forceSyncToMapDisplay();
}

function forceSyncToMapDisplay() {
  const ch = activeFogChannel();
  if (!ch || !fogMask || !fogImage) return;
  const crop = viewportCrop;
  ch.postMessage({
    type: 'fog-update',
    imageSrc: fogImage.src,
    fogMask: Array.from(fogMask),
    width: mapWidth,
    height: mapHeight,
    crop: crop
  });
  if (fogContext === 'map') pushPlayerStateToServer();
}

// --- Live Sync toggle ---
function toggleLiveSync() {
  liveSync = !liveSync;
  const btn = document.getElementById('btn-live-sync');
  const syncBtn = document.getElementById('btn-sync-now');
  btn.classList.toggle('active', liveSync);
  btn.textContent = liveSync ? 'Live' : 'Staged';
  syncBtn.style.display = liveSync ? 'none' : '';
  if (liveSync && hasPendingSync) {
    // Turning live back on — push everything now
    syncNow();
  }
  saveState();
}

function syncNow() {
  const ch = activeFogChannel();
  if (!ch || !fogMask || !fogImage) return;
  // Full sync: fog-init (in case map changed) + fog-update + projection
  ch.postMessage({
    type: 'fog-init',
    imageSrc: fogImage.src,
    width: mapWidth,
    height: mapHeight
  });
  setTimeout(() => {
    forceSyncToMapDisplay();
    if (fogContext === 'map') sendProjectionSettings();
    else sendShowSettings();
  }, 100);
  hasPendingSync = false;
  const syncBtn = document.getElementById('btn-sync-now');
  if (syncBtn) syncBtn.classList.remove('pending');
  setStatus(fogContext === 'show' ? 'Synced to sidecar' : 'Synced to projector');
}

function markPendingSync() {
  hasPendingSync = true;
  const syncBtn = document.getElementById('btn-sync-now');
  if (syncBtn) syncBtn.classList.add('pending');
}
