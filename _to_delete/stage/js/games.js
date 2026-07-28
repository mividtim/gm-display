// GM Display — games.js
// Game / campaign switcher and its namespacing helpers.
// Classic script: load order matters (see gm_display.html).
// === Game switcher ===
function renderCampaignSelector() {
  const sel = document.getElementById('campaign-select');
  if (!sel) return;
  sel.innerHTML = '';
  campaigns.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.slug;
    opt.textContent = c.name;
    if (c.slug === activeCampaign) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderGameSelector() {
  const sel = document.getElementById('game-select');
  if (!sel) return;
  sel.innerHTML = '';
  modulesInCampaign(activeCampaign).forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.slug;
    opt.textContent = g.name;
    if (g.slug === activeGame) opt.selected = true;
    sel.appendChild(opt);
  });
}

function onGameSelectChange(slug) {
  if (slug === activeGame) return;
  switchGame(slug);
}

function onCampaignSelectChange(slug) {
  if (slug === activeCampaign) return;
  const mods = modulesInCampaign(slug);
  activeCampaign = slug;
  saveCampaignsIndex();
  if (mods.length) {
    switchGame(mods[0].slug);
  } else {
    // Empty campaign — prompt to create its first module.
    renderCampaignSelector();
    renderGameSelector();
    newGamePrompt();
  }
}

function newCampaignPrompt() {
  const name = prompt('Name for the new campaign:');
  if (!name || !name.trim()) return;
  const slug = slugify(name);
  if (campaigns.some(c => c.slug === slug)) { alert('A campaign with that name already exists.'); return; }
  campaigns.push({ slug, name: name.trim() });
  activeCampaign = slug;
  saveCampaignsIndex();
  // Every campaign needs at least one module.
  const modName = (prompt('Name its first module:', 'Module 1') || 'Module 1').trim() || 'Module 1';
  let mslug = slugify(modName);
  while (games.some(g => g.slug === mslug)) mslug += '-1';
  games.push({ slug: mslug, name: modName, campaign: slug });
  saveGamesIndex();
  switchGame(mslug);
}

// Reassign the current module to a different (or new) campaign.
function moveModulePrompt() {
  const g = games.find(x => x.slug === activeGame);
  if (!g) return;
  const list = campaigns.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
  const ans = prompt(`Move "${g.name}" to which campaign? Enter a number, or type a new campaign name:\n\n${list}`, '');
  if (ans === null || !ans.trim()) return;
  const t = ans.trim();
  let target;
  const idx = parseInt(t, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= campaigns.length) {
    target = campaigns[idx - 1].slug;
  } else {
    let cslug = slugify(t);
    if (!campaigns.some(c => c.slug === cslug)) campaigns.push({ slug: cslug, name: t });
    target = cslug;
  }
  g.campaign = target;
  activeCampaign = target;
  saveGamesIndex();
  saveCampaignsIndex();
  // Reload tokens for the new campaign context.
  loadTokens(); renderTokenList(); renderGMTokens(); broadcastTokens(); pushTokensToServer();
  renderCampaignSelector(); renderGameSelector();
  setStatus(`Moved "${g.name}" to campaign: ${campaigns.find(c => c.slug === target).name}`);
}

// Switch active game: flush current state, swap, clear in-memory, load new.
function switchGame(slug) {
  const g = games.find(x => x.slug === slug);
  if (!g) return;
  saveState();
  activeGame = slug;
  activeCampaign = g.campaign || activeCampaign;
  saveGamesIndex();
  saveCampaignsIndex();
  resetInMemoryStateForGameSwitch();
  loadImageLibrary();
  restoreState();
  // Load this game's tokens, re-render the GM overlay/list, and push the new
  // set to the projector and the server so remote players' options follow the
  // game the GM has selected.
  loadTokens();
  renderTokenList();
  renderGMTokens();
  broadcastTokens();
  pushTokensToServer();
  renderCampaignSelector();
  renderGameSelector();
  renderMapLibrary();
  renderImageLibrary();
  setStatus(`Switched to module: ${g.name}`);
}

// Reset in-memory state and tell the player windows to clear.
// Does NOT touch localStorage — the new game's keys will be read by restoreState.
function resetInMemoryStateForGameSwitch() {
  loadedImage = null;
  fogImage = null;
  fogMask = null;
  fogPresets = [];
  activePresetIdx = 0;
  fogInitialized = false;
  fogHistory = [];
  fogHistoryIdx = -1;
  lastInitializedFogSrc = null;
  stashedMapFog = null;
  stashedShowFog = null;
  fogContext = 'map';
  mapLibrary = [];
  imageLibrary = [];
  lastMapSrc = null; lastMapName = null;
  lastShowSrc = null; lastShowName = null;
  mapWidth = 0; mapHeight = 0;

  corners = { tl:{x:0,y:0}, tr:{x:0,y:0}, bl:{x:0,y:0}, br:{x:0,y:0} };
  projScale = 100;
  mapRotation = 0; showRotation = 0;
  mapBg = '#000000'; showBg = '#000000';
  gridEnabled = false; gridPx = 50; gridOpacity = 0.4;
  gridColorTemplate = 'rgba(255,255,255,__A__)';
  cropZoom = 1; cropHPos = 0.5; cropVPos = 0.5;
  viewportCrop = null;

  // Tokens are per-campaign (roster) + per-map (placements); clear both here
  // so the previous game's tokens don't linger before switchGame() reloads.
  // tokensReady=false blocks setTokenMap/saveTokens from writing a stale
  // roster under the NEW campaign's keys while state is restored.
  tokens = [];
  roster = [];
  tokenMapSrc = null;
  tokensReady = false;

  // Clear thumbs
  const setThumb = (imgId, emptyId, labelId) => {
    const img = document.getElementById(imgId);
    if (img) { img.style.display = 'none'; img.src = ''; }
    const empty = document.getElementById(emptyId);
    if (empty) empty.style.display = '';
    const label = document.getElementById(labelId);
    if (label) { label.style.display = 'none'; label.textContent = ''; }
  };
  setThumb('map-thumb', 'map-thumb-empty', 'map-thumb-label');
  setThumb('show-thumb', 'show-thumb-empty', 'show-thumb-label');
  const fn = document.getElementById('img-filename');
  if (fn) fn.textContent = '(no image)';
  const mb = document.getElementById('mode-buttons');
  if (mb) mb.style.display = 'none';

  // Sync UI
  updateRotationUI();
  updateBgUI();
  updateUndoRedoButtons();

  // Tell both displays to clear
  if (mapChannel) mapChannel.postMessage({ type: 'clear' });
  if (showChannel) showChannel.postMessage({ type: 'clear' });

  setMainView('idle');
}

function newGamePrompt() {
  const name = prompt('Name for the new module (in campaign "' + (campaigns.find(c => c.slug === activeCampaign) || {}).name + '"):');
  if (!name || !name.trim()) return;
  const slug = slugify(name);
  if (games.some(g => g.slug === slug)) {
    alert('A module with that name already exists.');
    return;
  }
  games.push({ slug, name: name.trim(), campaign: activeCampaign });
  saveGamesIndex();
  switchGame(slug);
}

function renameActiveGame() {
  const current = games.find(g => g.slug === activeGame);
  if (!current) return;
  const newName = prompt('Rename game:', current.name);
  if (!newName || !newName.trim()) return;
  current.name = newName.trim();
  saveGamesIndex();
  renderGameSelector();
}

function deleteActiveGame() {
  if (games.length <= 1) {
    alert('Cannot delete the only module. Create another first.');
    return;
  }
  const current = games.find(g => g.slug === activeGame);
  if (!current) return;
  if (!confirm(`Delete module "${current.name}" and its maps, fog, and settings? Campaign tokens are kept. This cannot be undone.`)) return;

  // Only the module's own keys are removed; campaign tokens (gm-display:camp:*)
  // are shared and left intact.
  const prefix = `gm-display:${activeGame}:`;
  const keysToDelete = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) keysToDelete.push(k);
  }
  for (const k of keysToDelete) {
    try { localStorage.removeItem(k); } catch (e) {}
  }
  const deletedCampaign = current.campaign;
  games = games.filter(g => g.slug !== activeGame);
  saveGamesIndex();
  // Prefer a sibling module in the same campaign; otherwise any module.
  const sibling = games.find(g => g.campaign === deletedCampaign) || games[0];
  switchGame(sibling.slug);
}

// Run-length encode a Uint8Array for compact storage.
// Fog masks are mostly 0s or 255s, so RLE compresses extremely well.
// Format: array of [value, count] pairs.
function rlEncode(arr) {
  if (!arr || arr.length === 0) return [];
  const runs = [];
  let val = arr[0], count = 1;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === val && count < 65535) {
      count++;
    } else {
      runs.push(val, count);
      val = arr[i]; count = 1;
    }
  }
  runs.push(val, count);
  return runs;
}

function rlDecode(runs, len) {
  const arr = new Uint8Array(len);
  let pos = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const val = runs[i], count = runs[i + 1];
    arr.fill(val, pos, pos + count);
    pos += count;
  }
  return arr;
}

function saveState() {
  if (isPlayerView) return;
  try {
    // Skip data URIs for image sources (too large for localStorage).
    // Only persist server-relative paths (start with /).
    const mapSrc = (lastMapSrc && !lastMapSrc.startsWith('data:')) ? lastMapSrc : null;
    const showSrc = (lastShowSrc && !lastShowSrc.startsWith('data:')) ? lastShowSrc : null;

    const state = {
      // Projection
      corners: corners,
      projScale: projScale,
      mapRotation: mapRotation,
      showRotation: showRotation,
      mapBg: mapBg,
      showBg: showBg,
      gridEnabled: gridEnabled,
      gridPx: gridPx,
      gridOpacity: gridOpacity,
      gridColorTemplate: gridColorTemplate,
      // Crop
      cropZoom: cropZoom,
      cropHPos: cropHPos,
      cropVPos: cropVPos,
      // Images (server-relative paths only)
      lastMapSrc: mapSrc,
      lastMapName: lastMapName,
      lastShowSrc: showSrc,
      lastShowName: lastShowName,
      // Fog (RLE-compressed) — only the active context's mask is in main state.
      // Per-image storage is the source of truth; this is just a fast path for the
      // initial restore.
      fogContext: fogContext,
      fogRLE: (fogMask && (fogContext === 'show' ? showSrc : mapSrc)) ? rlEncode(fogMask) : null,
      mapWidth: mapWidth,
      mapHeight: mapHeight,
      fogInitialized: fogInitialized && (fogContext === 'show' ? !!showSrc : !!mapSrc),
      // Mode & tool
      currentMode: currentMode,
      currentTool: currentTool,
      brushSize: brushSize,
      // Test pattern
      testPatternActive: testPatternActive,
      liveSync: liveSync,
      // Fog presets
      activePresetIdx: activePresetIdx,
    };
    localStorage.setItem(gameKey('state'), JSON.stringify(state));
    // Save per-image fog under the active context's storage key.
    if (fogMask) {
      const activeSrc = fogContext === 'show' ? showSrc : mapSrc;
      if (activeSrc) savePerMapFog(activeSrc);
    }
  } catch (e) {
    console.warn('[GM Display] Failed to save state:', e);
  }
}

function restoreState() {
  try {
    const raw = localStorage.getItem(gameKey('state'));
    if (!raw) return;
    const s = JSON.parse(raw);

    // Projection
    if (s.corners) {
      corners = s.corners;
      ['tl','tr','bl','br'].forEach(c =>
        document.getElementById('corner-' + c + '-val').textContent = corners[c].x + ',' + corners[c].y);
    }
    if (s.projScale != null) {
      projScale = s.projScale;
      document.getElementById('scale-slider').value = projScale;
      document.getElementById('scale-val').textContent = projScale + '%';
    }
    // Backward-compat: legacy `rotation` was a single global value
    if (s.mapRotation != null) {
      mapRotation = ((s.mapRotation % 360) + 360) % 360;
    } else if (s.rotation != null) {
      mapRotation = ((s.rotation % 360) + 360) % 360;
    }
    if (s.showRotation != null) {
      showRotation = ((s.showRotation % 360) + 360) % 360;
    } else if (s.rotation != null) {
      showRotation = ((s.rotation % 360) + 360) % 360;
    }
    if (typeof s.mapBg === 'string') mapBg = s.mapBg;
    if (typeof s.showBg === 'string') showBg = s.showBg;
    updateRotationUI();
    updateBgUI();
    if (s.gridEnabled != null) {
      gridEnabled = s.gridEnabled;
      document.getElementById('grid-status').textContent = gridEnabled ? 'ON' : 'OFF';
      document.getElementById('btn-grid').classList.toggle('active', gridEnabled);
    }
    if (s.gridPx != null) {
      gridPx = s.gridPx;
      document.getElementById('grid-px-slider').value = gridPx;
      document.getElementById('grid-px-val').textContent = gridPx + 'px';
    }
    if (s.gridOpacity != null) {
      gridOpacity = s.gridOpacity;
      document.getElementById('grid-opacity-slider').value = Math.round(gridOpacity * 100);
      document.getElementById('grid-opacity-val').textContent = Math.round(gridOpacity * 100) + '%';
    }
    if (s.gridColorTemplate) gridColorTemplate = s.gridColorTemplate;

    // Crop
    if (s.cropZoom != null) cropZoom = s.cropZoom;
    if (s.cropHPos != null) cropHPos = s.cropHPos;
    if (s.cropVPos != null) cropVPos = s.cropVPos;
    applyCropToSliders();

    // Tool & brush
    if (s.currentTool) setTool(s.currentTool);
    if (s.brushSize != null) {
      brushSize = s.brushSize;
      const bel = document.getElementById('brush-size');
      if (bel) bel.value = brushSize;
      updateBrushPreview();
    }
    if (s.liveSync != null && !s.liveSync) {
      liveSync = false;
      const btn = document.getElementById('btn-live-sync');
      const syncBtn = document.getElementById('btn-sync-now');
      if (btn) { btn.classList.remove('active'); btn.textContent = 'Staged'; }
      if (syncBtn) syncBtn.style.display = '';
    }

    // Restore images and mode
    const savedMode = s.currentMode || 'landing';
    const savedMapW = s.mapWidth || 0;
    const savedMapH = s.mapHeight || 0;

    // Restore activePresetIdx
    if (s.activePresetIdx != null) activePresetIdx = s.activePresetIdx;

    // Restore active fog context (defaults to map for legacy state).
    if (s.fogContext === 'show' || s.fogContext === 'map') {
      fogContext = s.fogContext;
    }

    // Always restore the src/name globals if state has them, regardless of
    // savedMode. The library renders, the Sidecar Handout filename UI, and
    // the Map Fog / Image Fog buttons all depend on these globals to know
    // what's currently loaded — without them the UI shows "(no image)" even
    // though the data is in localStorage. Must happen BEFORE library renders
    // so the active-entry highlight works.
    if (s.lastMapSrc) {
      lastMapSrc = s.lastMapSrc;
      lastMapName = s.lastMapName || '';
    }
    if (s.lastShowSrc) {
      lastShowSrc = s.lastShowSrc;
      lastShowName = s.lastShowName || '';
      // Reflect in the Sidecar Handout filename UI immediately.
      const fnEl = document.getElementById('img-filename');
      if (fnEl) fnEl.textContent = decodeURIComponent((lastShowName || lastShowSrc).split('/').pop());
    }

    // Load map + image libraries (renders with active-entry highlight now
    // that lastMapSrc / lastShowSrc are set).
    loadMapLibrary();
    renderMapLibrary();
    loadImageLibrary();
    renderImageLibrary();

    // Restore map/fog state — only when active context is 'map'.
    // (Show-fog state lives entirely in per-image storage and is reloaded on
    // entry to image-fog mode; we don't auto-resume show-fog mode here because
    // it requires the sidecar image to already be loaded.)
    if (s.lastMapSrc && s.fogInitialized && fogContext === 'map') {
      const img = new Image();
      img.onload = () => {
        fogImage = img;
        loadedImage = img;
        mapWidth = savedMapW || img.width;
        mapHeight = savedMapH || img.height;
        const perMapFog = loadPerMapFog(s.lastMapSrc, mapWidth * mapHeight);
        fogMask = perMapFog || (s.fogRLE ? rlDecode(s.fogRLE, mapWidth * mapHeight) : new Uint8Array(mapWidth * mapHeight));
        fogInitialized = true;
        ensureDefaultPreset();
        fogHistory = [new Uint8Array(fogMask)];
        fogHistoryIdx = 0;
        updateMapThumbnail(img.src, s.lastMapName);
        applySavedCropForSrc(img.src);
        applyCropToSliders();
        applySavedBgForSrc(img.src, 'map');

        if (savedMode === 'fog') {
          startFogMode();
          setTimeout(() => sendProjectionSettings(), 200);
        } else {
          document.getElementById('mode-buttons').style.display = 'flex';
        }
      };
      img.onerror = () => console.warn('[GM Display] Failed to reload map image');
      img.src = s.lastMapSrc;
    }

    // Restore sidecar image — load the JS Image regardless of savedMode so
    // the Sidecar Handout panel reflects what's actually loaded.
    if (s.lastShowSrc) {
      const img = new Image();
      img.onload = () => {
        updateShowThumbnail(img.src, s.lastShowName);
        if (savedMode === 'image') {
          loadedImage = img;
          mapWidth = img.width;
          mapHeight = img.height;
          applySavedCropForSrc(img.src);
          applyCropToSliders();
          applySavedBgForSrc(img.src, 'show');
          startImageMode(s.lastShowName || '');
          setTimeout(() => {
            computeViewportCrop();
            sendCropUpdate();
          }, 200);
        } else if (savedMode === 'fog' && fogContext === 'show') {
          // Resume show-fog editing — needs the sidecar image loaded first.
          loadedImage = img;
          startImageFogMode();
        }
        // Whether we're entering a mode or not, hold the image in memory so
        // subsequent Edit Fog / Preview clicks can use it without reloading.
        // (loadedImage is already set above when entering a mode; if we're
        // staying on landing, leave loadedImage as the most-recently-loaded
        // map image to preserve fog-mode resume behavior.)
      };
      img.onerror = () => console.warn('[GM Display] Failed to reload sidecar image');
      img.src = s.lastShowSrc;
    }

    // If neither fog nor image, stay on landing but show mode buttons if we have an image
    if (savedMode === 'landing' && (s.lastMapSrc || s.lastShowSrc)) {
      document.getElementById('mode-buttons').style.display = 'flex';
    }

    console.log('[GM Display] State restored from localStorage');
  } catch (e) {
    console.warn('[GM Display] Failed to restore state:', e);
  }
}

// Read the active sidecar fog (if any) for a given image src. Returns
// { mask, w, h } or null. Used by sendShowContent to auto-apply stored fog
// when a handout is displayed on the sidecar.
function loadShowFogForSrc(src) {
  if (!src || src.startsWith('data:')) return null;
  try {
    const raw = localStorage.getItem(gameKey('fog:show:' + src));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.presets && Array.isArray(data.presets) && data.presets.length > 0) {
      const idx = data.activeIdx || 0;
      const p = data.presets[idx] || data.presets[0];
      if (p && p.rle && p.w && p.h) {
        return { mask: rlDecode(p.rle, p.w * p.h), w: p.w, h: p.h };
      }
    }
  } catch (e) {
    console.warn('[GM Display] Failed to read show fog:', e);
  }
  return null;
}

// Single entry point for "show this image on the sidecar". If the user has
// previously painted fog over this handout, send it via fog-init/fog-update so
// the sidecar renders image+fog. Otherwise send plain show-image.
function sendShowContent(src, crop) {
  if (!showChannel || !src) return;
  const fog = loadShowFogForSrc(src);
  if (fog) {
    showChannel.postMessage({ type: 'fog-init', imageSrc: src, width: fog.w, height: fog.h });
    setTimeout(() => {
      showChannel.postMessage({
        type: 'fog-update',
        imageSrc: src,
        fogMask: Array.from(fog.mask),
        width: fog.w,
        height: fog.h,
        crop: crop
      });
    }, 50);
  } else {
    showChannel.postMessage({ type: 'show-image', imageSrc: src, crop: crop });
  }
}
