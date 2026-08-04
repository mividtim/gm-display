// GM Display — fog-presets.js
// Fog presets and syncing the active display.
// Classic script: load order matters (see gm_display.html).
// === Fog Presets ===
import { rlDecode, rlEncode, saveState } from './games.js';
import { setStatus } from './keyboard.js';
import { activeFogChannel, savePerMapFog } from './per-map-store.js';
import { sendProjectionSettings, sendShowSettings } from './projection.js';
import { renderGMFog, updateUndoRedoButtons } from './sidebar.js';
import { S } from './store.js';
import { pushPlayerStateToServer } from './tokens.js';
import { setActiveTool } from './tools.js';
export function ensureDefaultPreset() {
  if (S.fogPresets.length === 0) {
    S.fogPresets = [{ name: 'Default', rle: S.fogMask ? rlEncode(S.fogMask) : [], w: S.mapWidth, h: S.mapHeight }];
    S.activePresetIdx = 0;
  }
}

export function newPreset(type) {
  if (!S.mapWidth || !S.mapHeight) return;
  const len = S.mapWidth * S.mapHeight;
  const mask = new Uint8Array(len);
  if (type === 'full') mask.fill(255);
  const name = (type === 'full' ? 'Revealed' : 'Hidden') + ' ' + (S.fogPresets.length + 1);
  const rle = rlEncode(mask);
  S.fogPresets.push({ name, rle, w: S.mapWidth, h: S.mapHeight });
  switchToPreset(S.fogPresets.length - 1);
  savePerMapFog(S.lastMapSrc);
}

export function copyPreset() {
  if (!S.fogPresets[S.activePresetIdx]) return;
  // Save current mask to active preset first
  if (S.fogMask) S.fogPresets[S.activePresetIdx].rle = rlEncode(S.fogMask);
  const src = S.fogPresets[S.activePresetIdx];
  S.fogPresets.push({ name: src.name + ' copy', rle: [...src.rle], w: src.w, h: src.h });
  switchToPreset(S.fogPresets.length - 1);
  savePerMapFog(S.lastMapSrc);
}

function deletePreset(idx) {
  if (S.fogPresets.length <= 1) return; // keep at least one
  const wasActive = (idx === S.activePresetIdx);
  S.fogPresets.splice(idx, 1);

  if (wasActive) {
    // Deleted the active preset — load the nearest one without saving old mask
    S.activePresetIdx = Math.min(idx, S.fogPresets.length - 1);
    const p = S.fogPresets[S.activePresetIdx];
    const len = S.mapWidth * S.mapHeight;
    S.fogMask = p.rle && p.rle.length > 0 ? rlDecode(p.rle, len) : new Uint8Array(len);
    S.fogHistory = [new Uint8Array(S.fogMask)];
    S.fogHistoryIdx = 0;
    updateUndoRedoButtons();
    renderGMFog();
    syncToMapDisplay();
  } else if (idx < S.activePresetIdx) {
    S.activePresetIdx--;
  }
  renderPresetThumbnails();
  savePerMapFog(S.lastMapSrc);
}

function switchToPreset(idx) {
  if (idx < 0 || idx >= S.fogPresets.length) return;
  // Save current fog to outgoing preset
  if (S.fogMask && S.fogPresets[S.activePresetIdx]) {
    S.fogPresets[S.activePresetIdx].rle = rlEncode(S.fogMask);
  }
  S.activePresetIdx = idx;
  const p = S.fogPresets[idx];
  const len = S.mapWidth * S.mapHeight;
  S.fogMask = p.rle && p.rle.length > 0 ? rlDecode(p.rle, len) : new Uint8Array(len);
  // Reset undo history for new preset
  S.fogHistory = [new Uint8Array(S.fogMask)];
  S.fogHistoryIdx = 0;
  updateUndoRedoButtons();
  renderGMFog();
  syncToMapDisplay();
  renderPresetThumbnails();
  // Persist the new activeIdx in the per-image fog data so it sticks across
  // image switches (saveState alone only writes global state, not per-image).
  const src = S.fogImage ? S.fogImage.src : (S.fogContext === 'show' ? S.lastShowSrc : S.lastMapSrc);
  if (src) savePerMapFog(src);
  saveState();
}

function reorderPreset(fromIdx, toIdx) {
  if (fromIdx < 0 || fromIdx >= S.fogPresets.length) return;
  if (toIdx < 0 || toIdx >= S.fogPresets.length) return;
  if (fromIdx === toIdx) return;

  // Snapshot current fogMask into the source preset before moving — otherwise
  // unsaved paint would be lost on the move.
  if (S.fogMask && S.fogPresets[S.activePresetIdx]) {
    S.fogPresets[S.activePresetIdx].rle = rlEncode(S.fogMask);
    S.fogPresets[S.activePresetIdx].w = S.mapWidth;
    S.fogPresets[S.activePresetIdx].h = S.mapHeight;
  }

  // Track the active preset's identity through the reorder.
  const activePreset = S.fogPresets[S.activePresetIdx];
  const item = S.fogPresets.splice(fromIdx, 1)[0];
  S.fogPresets.splice(toIdx, 0, item);
  S.activePresetIdx = S.fogPresets.indexOf(activePreset);

  savePerMapFog(S.fogImage ? S.fogImage.src : (S.lastInitializedFogSrc || ''));
  renderPresetThumbnails();
}

function renamePreset(idx, newName) {
  if (S.fogPresets[idx]) {
    S.fogPresets[idx].name = newName;
    savePerMapFog(S.lastMapSrc);
    renderPresetThumbnails();
  }
}

export function renderPresetThumbnails() {
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

  S.fogPresets.forEach((preset, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'fog-preset-thumb' + (idx === S.activePresetIdx ? ' active' : '');
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
    const len = (preset.w || S.mapWidth) * (preset.h || S.mapHeight);
    let mask;
    if (idx === S.activePresetIdx && S.fogMask) {
      mask = S.fogMask;
    } else if (preset.rle && preset.rle.length > 0) {
      mask = rlDecode(preset.rle, len);
    } else {
      mask = new Uint8Array(len);
    }

    const pw = preset.w || S.mapWidth || 1;
    const ph = preset.h || S.mapHeight || 1;
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
    if (S.fogPresets.length > 1) {
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

// Kept as the name the rest of the app already calls. Picking a fog brush is
// picking a tool now, so this routes through the one selector rather than
// setting a second piece of mode state beside it.
export function setTool(tool) {
  setActiveTool(tool === 'hide' ? 'hide' : 'reveal');
}


export function updateBrushPreview() {
  const el = document.getElementById('brush-preview');
  if (el) { const s = Math.max(8, Math.min(40, S.brushSize*0.6)); el.style.width=s+'px'; el.style.height=s+'px'; }
}

// === Sync to Active Display (map or show, depending on fogContext) ===
export function syncToMapDisplay() {
  const ch = activeFogChannel();
  if (!ch || !S.fogMask || !S.fogImage) return;
  // If live sync is off, mark pending but don't push (only honored for projector)
  if (S.fogContext === 'map' && !S.liveSync) {
    markPendingSync();
    return;
  }
  forceSyncToMapDisplay();
}

export function forceSyncToMapDisplay() {
  const ch = activeFogChannel();
  if (!ch || !S.fogMask || !S.fogImage) return;
  const crop = S.viewportCrop;
  ch.postMessage({
    type: 'fog-update',
    imageSrc: S.fogImage.src,
    fogMask: Array.from(S.fogMask),
    width: S.mapWidth,
    height: S.mapHeight,
    crop: crop
  });
  if (S.fogContext === 'map') pushPlayerStateToServer();
}

// --- Live Sync toggle ---
export function toggleLiveSync() {
  S.liveSync = !S.liveSync;
  const btn = document.getElementById('btn-live-sync');
  const syncBtn = document.getElementById('btn-sync-now');
  btn.classList.toggle('active', S.liveSync);
  btn.textContent = S.liveSync ? 'Live' : 'Staged';
  syncBtn.style.display = S.liveSync ? 'none' : '';
  if (S.liveSync && S.hasPendingSync) {
    // Turning live back on — push everything now
    syncNow();
  }
  updateStagedBanner();
  saveState();
}

export function syncNow() {
  const ch = activeFogChannel();
  if (!ch || !S.fogMask || !S.fogImage) return;
  // Full sync: fog-init (in case map changed) + fog-update + projection
  ch.postMessage({
    type: 'fog-init',
    imageSrc: S.fogImage.src,
    width: S.mapWidth,
    height: S.mapHeight
  });
  setTimeout(() => {
    forceSyncToMapDisplay();
    if (S.fogContext === 'map') sendProjectionSettings();
    else sendShowSettings();
  }, 100);
  S.hasPendingSync = false;
  const syncBtn = document.getElementById('btn-sync-now');
  if (syncBtn) syncBtn.classList.remove('pending');
  updateStagedBanner();
  setStatus(S.fogContext === 'show' ? 'Synced to sidecar' : 'Synced to projector');
}

export function markPendingSync() {
  S.hasPendingSync = true;
  const syncBtn = document.getElementById('btn-sync-now');
  if (syncBtn) syncBtn.classList.add('pending');
  updateStagedBanner();
}

// Staged mode survives a reload, and the only signs of it were a small button
// reading "Staged" and a pulsing "Sync Now" — both inside Fog Tools, which is
// collapsed by default. So the projector silently stops updating and nothing
// visible says why. This banner sits over the map, where it cannot be
// collapsed away, and only while there is genuinely something unsent.
export function updateStagedBanner() {
  const el = document.getElementById('fog-staged-banner');
  if (!el) return;
  const show = !S.liveSync && S.hasPendingSync && S.currentMode === 'fog';
  el.style.display = show ? 'flex' : 'none';
  if (!show || el._wired) return;
  el._wired = true;
  el.addEventListener('click', () => syncNow());
}
