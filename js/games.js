// GM Display — games.js
// Game / campaign switcher and its namespacing helpers.
// Classic script: load order matters (see gm_display.html).
// === Game switcher ===
import { applyCropToSliders, computeViewportCrop, sendCropUpdate } from './crop.js';
import { ensureDefaultPreset, setTool, updateBrushPreview } from './fog-presets.js';
import { startFogMode, startImageFogMode, startImageMode } from './fog.js';
import { updateMapThumbnail, updateShowThumbnail } from './init.js';
import { setStatus } from './keyboard.js';
import { setMainView } from './navigation.js';
import { applySavedBgForSrc, applySavedCropForSrc, loadImageLibrary, loadMapLibrary, loadPerMapFog, renderImageLibrary, renderMapLibrary, savePerMapFog } from './per-map-store.js';
import { sendProjectionSettings, updateBgUI, updateRotationUI } from './projection.js';
import { updateUndoRedoButtons } from './sidebar.js';
import { gameKey, modulesInCampaign, saveCampaignsIndex, saveGamesIndex, slugify } from './state.js';
import { S } from './store.js';
import { announceCampaign } from './board-gm.js';
import { broadcastTokens, loadTokens, pushTokensToServer, renderGMTokens, renderTokenList } from './tokens.js';
export function renderCampaignSelector() {
  const sel = document.getElementById('campaign-select');
  if (!sel) return;
  sel.innerHTML = '';
  S.campaigns.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.slug;
    opt.textContent = c.name;
    if (c.slug === S.activeCampaign) opt.selected = true;
    sel.appendChild(opt);
  });
}

export function renderGameSelector() {
  const sel = document.getElementById('game-select');
  if (!sel) return;
  sel.innerHTML = '';
  modulesInCampaign(S.activeCampaign).forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.slug;
    opt.textContent = g.name;
    if (g.slug === S.activeGame) opt.selected = true;
    sel.appendChild(opt);
  });
}

export function onGameSelectChange(slug) {
  if (slug === S.activeGame) return;
  switchGame(slug);
}

export function onCampaignSelectChange(slug) {
  if (slug === S.activeCampaign) return;
  const mods = modulesInCampaign(slug);
  S.activeCampaign = slug;
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

export function newCampaignPrompt() {
  const name = prompt('Name for the new campaign:');
  if (!name || !name.trim()) return;
  const slug = slugify(name);
  if (S.campaigns.some(c => c.slug === slug)) { alert('A campaign with that name already exists.'); return; }
  S.campaigns.push({ slug, name: name.trim() });
  S.activeCampaign = slug;
  saveCampaignsIndex();
  // Every campaign needs at least one module.
  const modName = (prompt('Name its first module:', 'Module 1') || 'Module 1').trim() || 'Module 1';
  let mslug = slugify(modName);
  while (S.games.some(g => g.slug === mslug)) mslug += '-1';
  S.games.push({ slug: mslug, name: modName, campaign: slug });
  saveGamesIndex();
  switchGame(mslug);
}

// Reassign the current module to a different (or new) campaign.
export function moveModulePrompt() {
  const g = S.games.find(x => x.slug === S.activeGame);
  if (!g) return;
  const list = S.campaigns.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
  const ans = prompt(`Move "${g.name}" to which campaign? Enter a number, or type a new campaign name:\n\n${list}`, '');
  if (ans === null || !ans.trim()) return;
  const t = ans.trim();
  let target;
  const idx = parseInt(t, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= S.campaigns.length) {
    target = S.campaigns[idx - 1].slug;
  } else {
    let cslug = slugify(t);
    if (!S.campaigns.some(c => c.slug === cslug)) S.campaigns.push({ slug: cslug, name: t });
    target = cslug;
  }
  g.campaign = target;
  S.activeCampaign = target;
  saveGamesIndex();
  saveCampaignsIndex();
  // Reload tokens for the new campaign context.
  loadTokens(); renderTokenList(); renderGMTokens(); broadcastTokens(); pushTokensToServer();
  renderCampaignSelector(); renderGameSelector();
  announceCampaign();
  setStatus(`Moved "${g.name}" to campaign: ${S.campaigns.find(c => c.slug === target).name}`);
}

// Switch active game: flush current state, swap, clear in-memory, load new.
function switchGame(slug) {
  const g = S.games.find(x => x.slug === slug);
  if (!g) return;
  saveState();
  S.activeGame = slug;
  S.activeCampaign = g.campaign || S.activeCampaign;
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
  announceCampaign();                 // the players' board follows the campaign
  setStatus(`Switched to module: ${g.name}`);
}

// Reset in-memory state and tell the player windows to clear.
// Does NOT touch localStorage — the new game's keys will be read by restoreState.
function resetInMemoryStateForGameSwitch() {
  S.loadedImage = null;
  S.fogImage = null;
  S.fogMask = null;
  S.fogPresets = [];
  S.activePresetIdx = 0;
  S.fogInitialized = false;
  S.fogHistory = [];
  S.fogHistoryIdx = -1;
  S.lastInitializedFogSrc = null;
  S.stashedMapFog = null;
  S.stashedShowFog = null;
  S.fogContext = 'map';
  S.mapLibrary = [];
  S.imageLibrary = [];
  S.lastMapSrc = null; S.lastMapName = null;
  S.lastShowSrc = null; S.lastShowName = null;
  S.mapWidth = 0; S.mapHeight = 0;

  S.corners = { tl:{x:0,y:0}, tr:{x:0,y:0}, bl:{x:0,y:0}, br:{x:0,y:0} };
  S.projScale = 100;
  S.mapRotation = 0; S.showRotation = 0;
  S.mapBg = '#000000'; S.showBg = '#000000';
  S.gridEnabled = false; S.gridPx = 50; S.gridOpacity = 0.4;
  S.gridColorTemplate = 'rgba(255,255,255,__A__)';
  S.cropZoom = 1; S.cropHPos = 0.5; S.cropVPos = 0.5;
  S.viewportCrop = null;

  // Tokens are per-campaign (roster) + per-map (placements); clear both here
  // so the previous game's tokens don't linger before switchGame() reloads.
  // tokensReady=false blocks setTokenMap/saveTokens from writing a stale
  // roster under the NEW campaign's keys while state is restored.
  S.tokens = [];
  S.roster = [];
  S.tokenMapSrc = null;
  S.tokensReady = false;

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
  if (S.mapChannel) S.mapChannel.postMessage({ type: 'clear' });
  if (S.showChannel) S.showChannel.postMessage({ type: 'clear' });

  setMainView('idle');
}

export function newGamePrompt() {
  const name = prompt('Name for the new module (in campaign "' + (S.campaigns.find(c => c.slug === S.activeCampaign) || {}).name + '"):');
  if (!name || !name.trim()) return;
  const slug = slugify(name);
  if (S.games.some(g => g.slug === slug)) {
    alert('A module with that name already exists.');
    return;
  }
  S.games.push({ slug, name: name.trim(), campaign: S.activeCampaign });
  saveGamesIndex();
  switchGame(slug);
}

export function renameActiveGame() {
  const current = S.games.find(g => g.slug === S.activeGame);
  if (!current) return;
  const newName = prompt('Rename game:', current.name);
  if (!newName || !newName.trim()) return;
  current.name = newName.trim();
  saveGamesIndex();
  renderGameSelector();
}

export function deleteActiveGame() {
  if (S.games.length <= 1) {
    alert('Cannot delete the only module. Create another first.');
    return;
  }
  const current = S.games.find(g => g.slug === S.activeGame);
  if (!current) return;
  if (!confirm(`Delete module "${current.name}" and its maps, fog, and settings? Campaign tokens are kept. This cannot be undone.`)) return;

  // Only the module's own keys are removed; campaign tokens (gm-display:camp:*)
  // are shared and left intact.
  const prefix = `gm-display:${S.activeGame}:`;
  const keysToDelete = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) keysToDelete.push(k);
  }
  for (const k of keysToDelete) {
    try { localStorage.removeItem(k); } catch (e) {}
  }
  const deletedCampaign = current.campaign;
  S.games = S.games.filter(g => g.slug !== S.activeGame);
  saveGamesIndex();
  // Prefer a sibling module in the same campaign; otherwise any module.
  const sibling = S.games.find(g => g.campaign === deletedCampaign) || S.games[0];
  switchGame(sibling.slug);
}

// Run-length encode a Uint8Array for compact storage.
// Fog masks are mostly 0s or 255s, so RLE compresses extremely well.
// Format: array of [value, count] pairs.
export function rlEncode(arr) {
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

export function rlDecode(runs, len) {
  const arr = new Uint8Array(len);
  let pos = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const val = runs[i], count = runs[i + 1];
    arr.fill(val, pos, pos + count);
    pos += count;
  }
  return arr;
}

export function saveState() {
  if (S.isPlayerView) return;
  try {
    // Skip data URIs for image sources (too large for localStorage).
    // Only persist server-relative paths (start with /).
    const mapSrc = (S.lastMapSrc && !S.lastMapSrc.startsWith('data:')) ? S.lastMapSrc : null;
    const showSrc = (S.lastShowSrc && !S.lastShowSrc.startsWith('data:')) ? S.lastShowSrc : null;

    const state = {
      // Projection
      corners: S.corners,
      projScale: S.projScale,
      mapRotation: S.mapRotation,
      showRotation: S.showRotation,
      mapBg: S.mapBg,
      showBg: S.showBg,
      gridEnabled: S.gridEnabled,
      gridPx: S.gridPx,
      gridOpacity: S.gridOpacity,
      gridColorTemplate: S.gridColorTemplate,
      // Crop
      cropZoom: S.cropZoom,
      cropHPos: S.cropHPos,
      cropVPos: S.cropVPos,
      // Images (server-relative paths only)
      lastMapSrc: mapSrc,
      lastMapName: S.lastMapName,
      lastShowSrc: showSrc,
      lastShowName: S.lastShowName,
      // Fog (RLE-compressed) — only the active context's mask is in main state.
      // Per-image storage is the source of truth; this is just a fast path for the
      // initial restore.
      fogContext: S.fogContext,
      fogRLE: (S.fogMask && (S.fogContext === 'show' ? showSrc : mapSrc)) ? rlEncode(S.fogMask) : null,
      mapWidth: S.mapWidth,
      mapHeight: S.mapHeight,
      fogInitialized: S.fogInitialized && (S.fogContext === 'show' ? !!showSrc : !!mapSrc),
      // Mode & tool
      currentMode: S.currentMode,
      currentTool: S.currentTool,
      brushSize: S.brushSize,
      // Test pattern
      testPatternActive: S.testPatternActive,
      liveSync: S.liveSync,
      // Fog presets
      activePresetIdx: S.activePresetIdx,
    };
    localStorage.setItem(gameKey('state'), JSON.stringify(state));
    // Save per-image fog under the active context's storage key.
    if (S.fogMask) {
      const activeSrc = S.fogContext === 'show' ? showSrc : mapSrc;
      if (activeSrc) savePerMapFog(activeSrc);
    }
  } catch (e) {
    console.warn('[GM Display] Failed to save state:', e);
  }
}

export function restoreState() {
  try {
    const raw = localStorage.getItem(gameKey('state'));
    if (!raw) return;
    const s = JSON.parse(raw);

    // Projection
    if (s.corners) {
      S.corners = s.corners;
      ['tl','tr','bl','br'].forEach(c =>
        document.getElementById('corner-' + c + '-val').textContent = S.corners[c].x + ',' + S.corners[c].y);
    }
    if (s.projScale != null) {
      S.projScale = s.projScale;
      document.getElementById('scale-slider').value = S.projScale;
      document.getElementById('scale-val').textContent = S.projScale + '%';
    }
    // Backward-compat: legacy `rotation` was a single global value
    if (s.mapRotation != null) {
      S.mapRotation = ((s.mapRotation % 360) + 360) % 360;
    } else if (s.rotation != null) {
      S.mapRotation = ((s.rotation % 360) + 360) % 360;
    }
    if (s.showRotation != null) {
      S.showRotation = ((s.showRotation % 360) + 360) % 360;
    } else if (s.rotation != null) {
      S.showRotation = ((s.rotation % 360) + 360) % 360;
    }
    if (typeof s.mapBg === 'string') S.mapBg = s.mapBg;
    if (typeof s.showBg === 'string') S.showBg = s.showBg;
    updateRotationUI();
    updateBgUI();
    if (s.gridEnabled != null) {
      S.gridEnabled = s.gridEnabled;
      document.getElementById('grid-status').textContent = S.gridEnabled ? 'ON' : 'OFF';
      document.getElementById('btn-grid').classList.toggle('active', S.gridEnabled);
    }
    if (s.gridPx != null) {
      S.gridPx = s.gridPx;
      document.getElementById('grid-px-slider').value = S.gridPx;
      document.getElementById('grid-px-val').textContent = S.gridPx + 'px';
    }
    if (s.gridOpacity != null) {
      S.gridOpacity = s.gridOpacity;
      document.getElementById('grid-opacity-slider').value = Math.round(S.gridOpacity * 100);
      document.getElementById('grid-opacity-val').textContent = Math.round(S.gridOpacity * 100) + '%';
    }
    if (s.gridColorTemplate) S.gridColorTemplate = s.gridColorTemplate;

    // Crop
    if (s.cropZoom != null) S.cropZoom = s.cropZoom;
    if (s.cropHPos != null) S.cropHPos = s.cropHPos;
    if (s.cropVPos != null) S.cropVPos = s.cropVPos;
    applyCropToSliders();

    // Tool & brush
    if (s.currentTool) setTool(s.currentTool);
    if (s.brushSize != null) {
      S.brushSize = s.brushSize;
      const bel = document.getElementById('brush-size');
      if (bel) bel.value = S.brushSize;
      updateBrushPreview();
    }
    if (s.liveSync != null && !s.liveSync) {
      S.liveSync = false;
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
    if (s.activePresetIdx != null) S.activePresetIdx = s.activePresetIdx;

    // Restore active fog context (defaults to map for legacy state).
    if (s.fogContext === 'show' || s.fogContext === 'map') {
      S.fogContext = s.fogContext;
    }

    // Always restore the src/name globals if state has them, regardless of
    // savedMode. The library renders, the Sidecar Handout filename UI, and
    // the Map Fog / Image Fog buttons all depend on these globals to know
    // what's currently loaded — without them the UI shows "(no image)" even
    // though the data is in localStorage. Must happen BEFORE library renders
    // so the active-entry highlight works.
    if (s.lastMapSrc) {
      S.lastMapSrc = s.lastMapSrc;
      S.lastMapName = s.lastMapName || '';
    }
    if (s.lastShowSrc) {
      S.lastShowSrc = s.lastShowSrc;
      S.lastShowName = s.lastShowName || '';
      // Reflect in the Sidecar Handout filename UI immediately.
      const fnEl = document.getElementById('img-filename');
      if (fnEl) fnEl.textContent = decodeURIComponent((S.lastShowName || S.lastShowSrc).split('/').pop());
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
    if (s.lastMapSrc && s.fogInitialized && S.fogContext === 'map') {
      const img = new Image();
      img.onload = () => {
        S.fogImage = img;
        S.loadedImage = img;
        S.mapWidth = savedMapW || img.width;
        S.mapHeight = savedMapH || img.height;
        const perMapFog = loadPerMapFog(s.lastMapSrc, S.mapWidth * S.mapHeight);
        S.fogMask = perMapFog || (s.fogRLE ? rlDecode(s.fogRLE, S.mapWidth * S.mapHeight) : new Uint8Array(S.mapWidth * S.mapHeight));
        S.fogInitialized = true;
        ensureDefaultPreset();
        S.fogHistory = [new Uint8Array(S.fogMask)];
        S.fogHistoryIdx = 0;
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
          S.loadedImage = img;
          S.mapWidth = img.width;
          S.mapHeight = img.height;
          applySavedCropForSrc(img.src);
          applyCropToSliders();
          applySavedBgForSrc(img.src, 'show');
          startImageMode(s.lastShowName || '');
          setTimeout(() => {
            computeViewportCrop();
            sendCropUpdate();
          }, 200);
        } else if (savedMode === 'fog' && S.fogContext === 'show') {
          // Resume show-fog editing — needs the sidecar image loaded first.
          S.loadedImage = img;
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
const HANDOUT_FOG_DISABLED = true;
export function loadShowFogForSrc(src) {
  // Handouts no longer carry fog: they go to the sidecar and to the players'
  // bulletin board whole. Any mask painted before that change stays in
  // localStorage untouched, but nothing reads it.
  if (HANDOUT_FOG_DISABLED) return null;
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
export function sendShowContent(src, crop) {
  if (!S.showChannel || !src) return;
  const fog = loadShowFogForSrc(src);
  if (fog) {
    S.showChannel.postMessage({ type: 'fog-init', imageSrc: src, width: fog.w, height: fog.h });
    setTimeout(() => {
      S.showChannel.postMessage({
        type: 'fog-update',
        imageSrc: src,
        fogMask: Array.from(fog.mask),
        width: fog.w,
        height: fog.h,
        crop: crop
      });
    }, 50);
  } else {
    S.showChannel.postMessage({ type: 'show-image', imageSrc: src, crop: crop });
  }
}
