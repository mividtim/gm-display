// GM Display — per-map-store.js
// Fog context, per-image crop and background, map and image libraries.
// Classic script: load order matters (see gm_display.html).
// === Fog Context (map vs show) ===
// Returns the storage prefix for the active fog context's per-image entry,
// namespaced under the current game.
function fogStoragePrefix() {
  return gameKey(fogContext === 'show' ? 'fog:show:' : 'fog:');
}

// Snapshot the live fog globals so we can restore them when the user comes
// back to this context.
function snapshotCurrentFog() {
  return {
    mask: fogMask,
    image: fogImage,
    w: mapWidth,
    h: mapHeight,
    presets: fogPresets,
    activeIdx: activePresetIdx,
    history: fogHistory,
    historyIdx: fogHistoryIdx,
    initialized: fogInitialized,
    initializedSrc: lastInitializedFogSrc,
  };
}

function applyFogSnapshot(s) {
  if (s) {
    fogMask = s.mask;
    fogImage = s.image;
    mapWidth = s.w;
    mapHeight = s.h;
    fogPresets = s.presets || [];
    activePresetIdx = s.activeIdx || 0;
    fogHistory = s.history || [];
    fogHistoryIdx = (s.historyIdx == null ? -1 : s.historyIdx);
    fogInitialized = !!s.initialized;
    lastInitializedFogSrc = s.initializedSrc || null;
  } else {
    // Empty context — caller should load fresh state from storage if a src is known.
    fogMask = null;
    fogImage = null;
    mapWidth = 0;
    mapHeight = 0;
    fogPresets = [];
    activePresetIdx = 0;
    fogHistory = [];
    fogHistoryIdx = -1;
    fogInitialized = false;
    lastInitializedFogSrc = null;
  }
}

// Switch the active fog context. Stashes the current globals into the outgoing
// context's slot and restores the incoming context's stash (if any).
function setFogContext(target) {
  if (target !== 'map' && target !== 'show') return;
  if (target === fogContext) return;
  const snap = snapshotCurrentFog();
  if (fogContext === 'map') stashedMapFog = snap;
  else stashedShowFog = snap;
  fogContext = target;
  applyFogSnapshot(target === 'map' ? stashedMapFog : stashedShowFog);
  updateUndoRedoButtons();
  // Token overlay is map-only; redraw so it appears/disappears on context switch.
  if (typeof renderGMTokens === 'function') renderGMTokens();
}

// Channel the active fog context syncs to.
function activeFogChannel() {
  return fogContext === 'show' ? showChannel : mapChannel;
}

// Per-map fog persistence — now supports multiple presets per map
const FOG_KEY_PREFIX = 'gm-display-fog:';

function savePerMapFog(mapSrc) {
  if (!mapSrc || mapSrc.startsWith('data:')) return;
  try {
    // Save active preset's current fogMask into the presets array
    if (fogMask && fogPresets[activePresetIdx]) {
      fogPresets[activePresetIdx].rle = rlEncode(fogMask);
      fogPresets[activePresetIdx].w = mapWidth;
      fogPresets[activePresetIdx].h = mapHeight;
    }
    // Persist entire presets array under the active context's key
    const data = { presets: fogPresets, activeIdx: activePresetIdx };
    localStorage.setItem(fogStoragePrefix() + mapSrc, JSON.stringify(data));
  } catch (e) {
    console.warn('[GM Display] Failed to save per-map fog:', e);
  }
}

function loadPerMapFog(mapSrc, expectedLen) {
  if (!mapSrc || mapSrc.startsWith('data:')) return null;
  try {
    const raw = localStorage.getItem(fogStoragePrefix() + mapSrc);
    if (!raw) return null;
    const data = JSON.parse(raw);

    // New format: { presets: [...], activeIdx: N }
    if (data.presets && Array.isArray(data.presets)) {
      fogPresets = data.presets;
      activePresetIdx = data.activeIdx || 0;
      if (activePresetIdx >= fogPresets.length) activePresetIdx = 0;
      const p = fogPresets[activePresetIdx];
      if (p && p.rle) return rlDecode(p.rle, expectedLen);
      return null;
    }

    // Legacy format: { rle: [...], w, h } — migrate to single preset
    if (data.rle) {
      const mask = rlDecode(data.rle, expectedLen);
      fogPresets = [{ name: 'Default', rle: data.rle, w: data.w, h: data.h }];
      activePresetIdx = 0;
      return mask;
    }
  } catch (e) {
    console.warn('[GM Display] Failed to load per-map fog:', e);
  }
  return null;
}

function deletePerMapFog(mapSrc) {
  if (!mapSrc || mapSrc.startsWith('data:')) return;
  // Always delete the MAP-context fog (this is only called from the map
  // library). Don't touch any sidecar fog stored under the same image src.
  try { localStorage.removeItem(gameKey('fog:' + mapSrc)); } catch(e) {}
}

// === Per-image crop (zoom + pan) persistence ===
// One last-used setting per image src, saved on every change, restored on
// image switch. Independent of fog, which already persists per-image via the
// fog-presets system.
function cropStorageKey(src) {
  return gameKey('crop:' + src);
}

function saveCropForSrc(src) {
  if (!src || src.startsWith('data:')) return;
  try {
    localStorage.setItem(cropStorageKey(src), JSON.stringify({
      cropZoom: cropZoom,
      cropHPos: cropHPos,
      cropVPos: cropVPos,
    }));
  } catch (e) {
    console.warn('[GM Display] Failed to save crop:', e);
  }
}

function loadCropForSrc(src) {
  if (!src || src.startsWith('data:')) return null;
  try {
    const raw = localStorage.getItem(cropStorageKey(src));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// Returns the src currently in use by whichever target the crop applies to.
function currentCropSrc() {
  if (currentMode === 'image') return lastShowSrc;
  if (currentMode === 'fog') return fogContext === 'show' ? lastShowSrc : lastMapSrc;
  return null;
}

function saveCropForCurrentImage() {
  const src = currentCropSrc();
  if (src) saveCropForSrc(src);
}

// Apply saved crop for src if any; otherwise reset to defaults. Called from
// image-load paths so each image opens at its last-used zoom/pan.
function applySavedCropForSrc(src) {
  const saved = loadCropForSrc(src);
  if (saved && saved.cropZoom != null) {
    cropZoom = saved.cropZoom;
    cropHPos = saved.cropHPos != null ? saved.cropHPos : 0.5;
    cropVPos = saved.cropVPos != null ? saved.cropVPos : 0.5;
  } else {
    cropZoom = 1;
    cropHPos = 0.5;
    cropVPos = 0.5;
  }
}

// === Per-image background color persistence ===
// Each image (handout or map) can carry its own preferred background color
// — useful for transparent PNGs, where the bg shows through. When no per-src
// bg has been saved we leave the global bg untouched (so the user's manual
// global pick still wins on first show). Once a bg is set while an image is
// loaded, it's remembered and auto-applied on subsequent loads.
function bgStorageKey(src) {
  return gameKey('bg:' + src);
}

function saveBgForSrc(src, color) {
  if (!src || src.startsWith('data:')) return;
  if (!color) return;
  try { localStorage.setItem(bgStorageKey(src), color); }
  catch (e) { console.warn('[GM Display] Failed to save bg:', e); }
}

function loadBgForSrc(src) {
  if (!src || src.startsWith('data:')) return null;
  try { return localStorage.getItem(bgStorageKey(src)); }
  catch (e) { return null; }
}

// Save the current active bg under the active image's src.
function saveBgForCurrentImage() {
  const src = currentCropSrc();  // same src logic as crop
  if (!src) return;
  const color = activeBg();
  saveBgForSrc(src, color);
}

// On image load: if a per-src bg is saved, apply it; otherwise leave the
// active bg untouched. Routes to map or show based on which target this src
// belongs to.
function applySavedBgForSrc(src, target /* 'map' | 'show' */) {
  const saved = loadBgForSrc(src);
  if (!saved) return;
  if (target === 'show') {
    showBg = saved;
  } else {
    mapBg = saved;
  }
  updateBgUI();
}

// === Map Library (persisted list of all loaded maps) ===
function loadMapLibrary() {
  try {
    const raw = localStorage.getItem(gameKey('library'));
    mapLibrary = raw ? JSON.parse(raw) : [];
  } catch (e) {
    mapLibrary = [];
  }
}

function saveMapLibrary() {
  try {
    localStorage.setItem(gameKey('library'), JSON.stringify(mapLibrary));
  } catch (e) {
    console.warn('[GM Display] Failed to save map library:', e);
  }
}

function addToMapLibrary(src, name) {
  if (!src || src.startsWith('data:')) return;
  // Don't duplicate
  const existing = mapLibrary.findIndex(m => m.src === src);
  if (existing >= 0) {
    // Update name if changed
    if (name) mapLibrary[existing].name = name;
  } else {
    mapLibrary.push({ src, name: name || src.split('/').pop() });
  }
  saveMapLibrary();
  renderMapLibrary();
}

function removeFromMapLibrary(idx) {
  if (idx < 0 || idx >= mapLibrary.length) return;
  const entry = mapLibrary[idx];
  deletePerMapFog(entry.src);
  mapLibrary.splice(idx, 1);
  saveMapLibrary();
  renderMapLibrary();
}

function renameMapInLibrary(idx, newName) {
  if (idx < 0 || idx >= mapLibrary.length) return;
  const entry = mapLibrary[idx];
  entry.name = newName;
  saveMapLibrary();
  // If this is the currently-loaded map, update the live label/state too
  if (entry.src === lastMapSrc) {
    lastMapName = newName;
    updateMapThumbnail(entry.src, newName);
    saveState();
  }
  renderMapLibrary();
}

// Renders both libraries into the unified #library-list with target badges.
// renderMapLibrary() and renderImageLibrary() both delegate here so any code
// that calls either still works.
function renderLibrary() {
  const container = document.getElementById('library-list');
  const wrapper = document.getElementById('library-wrap');
  if (!container || !wrapper) return;

  const total = mapLibrary.length + imageLibrary.length;
  if (total === 0) { wrapper.style.display = 'none'; container.innerHTML = ''; return; }
  wrapper.style.display = '';

  container.innerHTML = '';
  mapLibrary.forEach((entry, idx) => {
    container.appendChild(buildLibraryCard(entry, idx, 'projector'));
  });
  imageLibrary.forEach((entry, idx) => {
    container.appendChild(buildLibraryCard(entry, idx, 'sidecar'));
  });
}

function buildLibraryCard(entry, idx, target) {
  const isProjector = target === 'projector';
  const activeSrc = isProjector ? lastMapSrc : lastShowSrc;
  const lib = isProjector ? mapLibrary : imageLibrary;
  const saveLib = isProjector ? saveMapLibrary : saveImageLibrary;
  const renameFn = isProjector ? renameMapInLibrary : renameImageInLibrary;
  const removeFn = isProjector ? removeFromMapLibrary : removeFromImageLibrary;
  const loadFn   = isProjector ? loadMapFromLibrary : loadImageFromLibrary;

  const card = document.createElement('div');
  card.className = 'map-lib-card' + (entry.src === activeSrc ? ' active' : '');
  card.draggable = true;
  card.dataset.idx = idx;
  card.dataset.target = target;
  card.title = decodeURIComponent(entry.name || '');

  // Target badge (PROJ / SIDE) — positions absolute in upper-left.
  // The `.live` class brightens the badge when this entry is currently shown
  // on its target display (per lastMapSrc / lastShowSrc).
  const isLive = (entry.src === activeSrc);
  const badge = document.createElement('div');
  badge.className = 'lib-target ' +
    (isProjector ? 'target-projector' : 'target-sidecar') +
    (isLive ? ' live' : '');
  badge.textContent = isProjector ? 'PROJ' : 'SIDE';
  badge.title = isLive
    ? (isProjector ? 'Live on Projector' : 'Live on Sidecar')
    : (isProjector ? 'Will display on Projector' : 'Will display on Sidecar');
  card.appendChild(badge);

  const img = document.createElement('img');
  img.src = entry.src;
  img.onerror = () => { img.style.display = 'none'; };
  card.appendChild(img);

  const label = document.createElement('div');
  label.className = 'lib-label';
  label.textContent = decodeURIComponent((entry.name || '').split('/').pop());
  label.title = 'Double-click to rename';
  label.ondblclick = (e) => {
    e.stopPropagation();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = decodeURIComponent(entry.name || '');
    input.style.cssText = 'width:100%;background:#222;color:#eee;border:1px solid #6a4;font-size:10px;padding:1px 4px;text-align:center;box-sizing:border-box;';
    const commit = () => {
      const v = (input.value || '').trim();
      if (v) renameFn(idx, v);
      else renderLibrary();
    };
    input.onblur = commit;
    input.onkeydown = (ke) => {
      if (ke.key === 'Enter') input.blur();
      else if (ke.key === 'Escape') { input.value = entry.name; input.blur(); }
    };
    label.replaceWith(input);
    input.focus();
    input.select();
  };
  card.appendChild(label);

  const del = document.createElement('button');
  del.className = 'lib-delete';
  del.textContent = '×';
  del.title = 'Remove from library';
  del.onclick = (e) => { e.stopPropagation(); removeFn(idx); };
  card.appendChild(del);

  card.onclick = (e) => {
    if (e.target.tagName === 'INPUT') return;
    loadFn(idx);
  };

  // Drag-to-reorder (within the same target only)
  card.ondragstart = (e) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ target, idx }));
    card.style.opacity = '0.5';
  };
  card.ondragend = () => { card.style.opacity = '1'; };
  card.ondragover = (e) => { e.preventDefault(); card.classList.add('drag-over'); };
  card.ondragleave = () => { card.classList.remove('drag-over'); };
  card.ondrop = (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
    if (!payload || payload.target !== target) return;  // no cross-target reorders
    const fromIdx = payload.idx;
    if (fromIdx === idx) return;
    const item = lib.splice(fromIdx, 1)[0];
    lib.splice(idx, 0, item);
    saveLib();
    renderLibrary();
  };

  return card;
}

// Backward-compat: existing call sites use renderMapLibrary / renderImageLibrary.
// Both delegate to the unified renderer.
function renderMapLibrary() { renderLibrary(); }

function loadMapFromLibrary(idx) {
  const entry = mapLibrary[idx];
  if (!entry) return;
  // Save the outgoing map's crop before we switch.
  saveCropForCurrentImage();
  const img = new Image();
  img.onload = () => {
    setFogContext('map');
    loadedImage = img;
    fogImage = img;
    mapWidth = img.width;
    mapHeight = img.height;
    // Restore last-used crop for this map (or defaults if none saved).
    applySavedCropForSrc(img.src);
    applySavedBgForSrc(img.src, 'map');
    updateMapThumbnail(img.src, entry.name);
    startFogMode();
    applyCropToSliders();
    renderLibrary();  // refresh PROJ badge liveness
  };
  img.onerror = () => setStatus(`Failed to load: ${entry.name}`);
  img.src = entry.src;
}

// === Image (sidecar handout) library — parallels the map library ===
function loadImageLibrary() {
  try {
    const raw = localStorage.getItem(gameKey('image-library'));
    imageLibrary = raw ? JSON.parse(raw) : [];
  } catch (e) {
    imageLibrary = [];
  }
}
function saveImageLibrary() {
  try {
    localStorage.setItem(gameKey('image-library'), JSON.stringify(imageLibrary));
  } catch (e) {
    console.warn('[GM Display] Failed to save image library:', e);
  }
}
function addToImageLibrary(src, name) {
  if (!src || src.startsWith('data:')) return;
  const existing = imageLibrary.findIndex(m => m.src === src);
  if (existing >= 0) {
    if (name) imageLibrary[existing].name = name;
  } else {
    imageLibrary.push({ src, name: name || src.split('/').pop() });
  }
  saveImageLibrary();
  renderImageLibrary();
}
function removeFromImageLibrary(idx) {
  if (idx < 0 || idx >= imageLibrary.length) return;
  const entry = imageLibrary[idx];
  // Also delete any stored sidecar fog for this handout.
  try { localStorage.removeItem(gameKey('fog:show:' + entry.src)); } catch (e) {}
  imageLibrary.splice(idx, 1);
  saveImageLibrary();
  renderImageLibrary();
}
function renameImageInLibrary(idx, newName) {
  if (idx < 0 || idx >= imageLibrary.length) return;
  const entry = imageLibrary[idx];
  entry.name = newName;
  saveImageLibrary();
  if (entry.src === lastShowSrc) {
    lastShowName = newName;
    updateShowThumbnail(entry.src, newName);
    const fnEl = document.getElementById('img-filename');
    if (fnEl) fnEl.textContent = decodeURIComponent(newName);
    saveState();
  }
  renderImageLibrary();
}
function loadImageFromLibrary(idx) {
  const entry = imageLibrary[idx];
  if (!entry) return;
  // Save the outgoing image's crop before we switch.
  saveCropForCurrentImage();
  const img = new Image();
  img.onload = () => {
    setFogContext('show');
    loadedImage = img;
    fogImage = img;                       // unified flow — fog editor uses fogImage
    mapWidth = img.width;
    mapHeight = img.height;
    // Restore last-used crop for this image (or defaults if none saved).
    applySavedCropForSrc(img.src);
    applySavedBgForSrc(img.src, 'show');
    updateShowThumbnail(img.src, entry.name);
    sendShowContent(img.src, viewportCrop);
    // Go straight to fog mode (the unified canvas view) — preview-only mode is
    // a redundant intermediate step now that gestures handle pan/zoom and
    // click handles paint.
    startFogMode();
    applyCropToSliders();
    renderLibrary();  // refresh SIDE badge liveness
  };
  img.onerror = () => setStatus(`Failed to load: ${entry.name}`);
  img.src = entry.src;
}
// Delegated to the unified renderer above. Kept as a stub so existing call
// sites (saveImageLibrary → renderImageLibrary etc.) still work.
function renderImageLibrary() { renderLibrary(); }

// === Add-artwork controls (Library section) ===
// Populate the vault picker from /api/maps (every image the server can see).
function refreshArtVaultOptions() {
  fetch('/api/maps').then(r => r.json()).then(list => {
    const sel = document.getElementById('art-vault-select');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">Choose from vault…</option>';
    list.sort((a, b) => a.name.localeCompare(b.name)).forEach(m => {
      const o = document.createElement('option');
      o.value = m.path; o.textContent = m.name;
      sel.appendChild(o);
    });
    sel.value = cur;
  }).catch(() => {});
}

function artTargetLibraryAdd(path, name) {
  const type = (document.getElementById('art-type') || {}).value || 'map';
  if (type === 'image') addToImageLibrary(path, name);
  else addToMapLibrary(path, name);
  setStatus(`Added to library (${type === 'image' ? 'Image → Sidecar' : 'Map → Projector'}): ${decodeURIComponent(name)}`);
}

function addArtFromVault() {
  const sel = document.getElementById('art-vault-select');
  if (!sel || !sel.value) { setStatus('Pick an image from the vault list first.'); return; }
  const name = sel.options[sel.selectedIndex].textContent;
  artTargetLibraryAdd(sel.value, name);
  sel.value = '';
}

// Upload a file from disk into the vault (server saves it under
// .tools/gm-display/uploads/), then add it to the chosen library.
function initArtUploadInput() {
  const inp = document.getElementById('art-file-input');
  if (!inp) return;
  inp.addEventListener('change', () => {
    const file = inp.files && inp.files[0];
    inp.value = '';
    if (!file) return;
    setStatus(`Uploading ${file.name}…`);
    const reader = new FileReader();
    reader.onload = (e) => {
      fetch('/api/upload', {
        method: 'POST',
        body: JSON.stringify({ name: file.name, data: e.target.result })
      }).then(r => r.json()).then(res => {
        if (!res.ok) { setStatus(`Upload failed: ${res.error || 'unknown error'}`); return; }
        artTargetLibraryAdd(res.path, res.name);
        refreshArtVaultOptions();
        refreshTokenImageOptions();
      }).catch(err => setStatus(`Upload failed: ${err}`));
    };
    reader.readAsDataURL(file);
  });
}
// Stub for the original body — never reached; here to keep the inert tail
// of the original function from causing parse errors. We immediately return.
function _legacy_renderImageLibrary_original_body() { return;
  const container = document.getElementById('image-library-list');
  const wrapper = document.getElementById('image-library');
  if (!container || !wrapper) return;
  if (imageLibrary.length === 0) { wrapper.style.display = 'none'; return; }
  wrapper.style.display = '';

  container.innerHTML = '';
  imageLibrary.forEach((entry, idx) => {
    const card = document.createElement('div');
    card.className = 'map-lib-card' + (entry.src === lastShowSrc ? ' active' : '');
    card.draggable = true;
    card.dataset.idx = idx;
    card.title = decodeURIComponent(entry.name || '');

    const img = document.createElement('img');
    img.src = entry.src;
    img.onerror = () => { img.style.display = 'none'; };
    card.appendChild(img);

    const label = document.createElement('div');
    label.className = 'lib-label';
    label.textContent = decodeURIComponent((entry.name || '').split('/').pop());
    label.title = 'Double-click to rename';
    label.ondblclick = (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.value = decodeURIComponent(entry.name || '');
      input.style.cssText = 'width:100%;background:#222;color:#eee;border:1px solid #6a4;font-size:10px;padding:1px 4px;text-align:center;box-sizing:border-box;';
      const commit = () => {
        const v = (input.value || '').trim();
        if (v) renameImageInLibrary(idx, v);
        else renderImageLibrary();
      };
      input.onblur = commit;
      input.onkeydown = (ke) => {
        if (ke.key === 'Enter') input.blur();
        else if (ke.key === 'Escape') { input.value = entry.name; input.blur(); }
      };
      label.replaceWith(input);
      input.focus();
      input.select();
    };
    card.appendChild(label);

    const del = document.createElement('button');
    del.className = 'lib-delete';
    del.textContent = '×';
    del.title = 'Remove from library (and delete its saved fog)';
    del.onclick = (e) => { e.stopPropagation(); removeFromImageLibrary(idx); };
    card.appendChild(del);

    card.onclick = (e) => {
      if (e.target.tagName === 'INPUT') return;
      loadImageFromLibrary(idx);
    };

    card.ondragstart = (e) => { e.dataTransfer.setData('text/plain', idx); card.style.opacity = '0.5'; };
    card.ondragend = () => { card.style.opacity = '1'; };
    card.ondragover = (e) => { e.preventDefault(); card.classList.add('drag-over'); };
    card.ondragleave = () => { card.classList.remove('drag-over'); };
    card.ondrop = (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
      if (fromIdx !== idx) {
        const item = imageLibrary.splice(fromIdx, 1)[0];
        imageLibrary.splice(idx, 0, item);
        saveImageLibrary();
        renderImageLibrary();
      }
    };

    container.appendChild(card);
  });
}
