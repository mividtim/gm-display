// GM Display — init.js
// Entry point, display status, thumbnails, command polling, drag-drop.
// Classic script: load order matters (see gm_display.html).
// === Init ===
import { computeViewportCrop, sendCropUpdate, updateViewportOutline } from './crop.js';
import { syncToMapDisplay, updateBrushPreview } from './fog-presets.js';
import { startFogMode, startImageMode } from './fog.js';
import { renderCampaignSelector, renderGameSelector, restoreState, saveState, sendShowContent } from './games.js';
import { setStatus } from './keyboard.js';
import { setupPlayerChannel } from './navigation.js';
import { addToImageLibrary, uploadArtFiles, applySavedBgForSrc, initArtUploadInput, loadImageLibrary, loadMapLibrary, refreshArtVaultOptions, renderImageLibrary, renderMapLibrary, setFogContext } from './per-map-store.js';
import { initCornerDrag, initPanDrag, sendProjectionSettings, sendShowSettings } from './projection.js';
import { attachProjectorTokenDrag } from './projector.js';
import { setupRemoteView } from './remote-page.js';
import { initImageNameRename, initSidebarResize } from './sidebar.js';
import { ensurePathfinderSocietyModules, loadCampaignsIndex, loadGamesIndex, migrateLegacyKeysToDefault } from './state.js';
import { S } from './store.js';
import { initBoardGM } from './board-gm.js';
import { applyPlayerAction, initTokensGM, onTokensChanged, setTokenMap } from './tokens.js';
// `role` is passed by the entry module (gm.js / display.js / remote.js). The
// URL fallback keeps the old single-page ?mode= URLs working for anything still
// pointing at them.
export function init(role, display) {
  const params = new URLSearchParams(window.location.search);
  role = role || (params.get('mode') === 'remote' ? 'remote'
                : params.get('mode') === 'player' ? 'player' : 'gm');

  if (role === 'remote') {
    setupRemoteView();
    return;
  }

  if (role === 'player') {
    S.isPlayerView = true;
    S.playerDisplay = display || params.get('display') || 'map';
    // On the dedicated display page there is no GM shell to hide; on the legacy
    // single-page URL there is.
    const app = document.getElementById('app');
    if (app) app.style.display = 'none';
    const pv = document.getElementById('player-view');
    if (pv) pv.style.display = 'flex';
    const sb = document.getElementById('status-bar');
    if (sb) sb.style.display = 'none';
    document.title = S.playerDisplay === 'map' ? 'Projector (Maps)' : 'Sidecar (Images)';
    setupPlayerChannel();
    // The map on the table is a thing you point at. Let it be a thing you can
    // move a token on, too, instead of walking back to the laptop for every
    // step. Sidecar handouts have no tokens, so this is the map window only.
    if (S.playerDisplay === 'map') attachProjectorTokenDrag();
    return;
  }

  // --- GM control page ---
  // Set up game namespacing first so all subsequent storage I/O routes through
  // the active game's keys. Migration only fires once (on first run after the
  // game-switcher feature shipped) and is a no-op afterwards.
  migrateLegacyKeysToDefault();
  loadGamesIndex();
  loadCampaignsIndex();
  ensurePathfinderSocietyModules();
  renderCampaignSelector();
  renderGameSelector();

  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  // Any number of images: each is saved into the vault and added to the
  // library (as handouts, unless "Add artwork" is set to Map).
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault(); dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) uploadArtFiles(e.dataTransfer.files);
  });
  fileInput.multiple = true;
  fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) uploadArtFiles(files);
  });

  const brushEl = document.getElementById('brush-size');
  if (brushEl) brushEl.addEventListener('input', (e) => { S.brushSize = parseInt(e.target.value); updateBrushPreview(); saveState(); });
  updateBrushPreview();
  initCornerDrag();
  initPanDrag();
  initImageNameRename();
  initSidebarResize();

  S.mapChannel = new BroadcastChannel('gm-display-map');
  S.showChannel = new BroadcastChannel('gm-display-show');

  // Track whether we've synced to each display since GM page load
  let mapSynced = false;
  let showSynced = false;
  // Track whether we've received an authoritative screen size for each display.
  // Until we have, accept any size; afterwards, ignore tiny flickers via hysteresis.
  let mapSizeKnown = false;
  let showSizeKnown = false;

  // Hysteresis: ignore tiny size changes on heartbeat so scrollbar/layout
  // transients don't cause the viewport-outline to flicker. Any genuine
  // user-driven window resize will easily exceed this threshold.
  const SIZE_FLICKER_PX = 32;
  const sizeChangedSignificantly = (oldW, oldH, newW, newH) =>
    Math.abs(oldW - newW) >= SIZE_FLICKER_PX || Math.abs(oldH - newH) >= SIZE_FLICKER_PX;

  // Process a screen-size update from a player. Returns true if a recompute fired.
  const applyScreenInfo = (channel, screenW, screenH) => {
    if (!screenW || !screenH) return false;
    if (channel === 'map') {
      const changed = !mapSizeKnown ||
        sizeChangedSignificantly(S.projectorW, S.projectorH, screenW, screenH);
      if (!changed) return false;
      S.projectorW = screenW; S.projectorH = screenH; mapSizeKnown = true;
      if (S.currentMode === 'fog' && S.cropZoom > 1.01) {
        computeViewportCrop();
        updateViewportOutline();
        sendCropUpdate();
      }
    } else {
      const changed = !showSizeKnown ||
        sizeChangedSignificantly(S.sidecarW, S.sidecarH, screenW, screenH);
      if (!changed) return false;
      S.sidecarW = screenW; S.sidecarH = screenH; showSizeKnown = true;
      if (S.currentMode === 'image' && Math.abs(S.cropZoom - 1.0) > 0.01) {
        computeViewportCrop();
        updateViewportOutline();
        sendCropUpdate();
      }
    }
    return true;
  };

  S.mapChannel.onmessage = (e) => {
    if (e.data.type === 'heartbeat') {
      updateDisplayStatus('map', true);
      applyScreenInfo('map', e.data.screenW, e.data.screenH);
      // Push full state on every heartbeat until we've successfully sent at
      // least one fog-update. Previously mapSynced was set unconditionally,
      // which meant if fog wasn't initialized yet on first heartbeat, the
      // projector window never received its initial map+fog data even after
      // the user later entered fog mode.
      if (!mapSynced && S.fogInitialized && S.fogMask && S.fogImage) {
        mapSynced = true;
        syncToMapDisplay();
        sendProjectionSettings();
      }
    }
    if (e.data.type === 'request-sync') {
      applyScreenInfo('map', e.data.screenW, e.data.screenH);
      syncToMapDisplay();
      sendProjectionSettings();
    }
    // The GM dragged a token on the projector window. That window is a mirror
    // and holds no roster, so it asks; this page is where tokens actually
    // live, so it commits — down the same path a drag on this page takes, and
    // straight back out to the projector and to every remote player.
    //
    // local:true is safe to assert here: a BroadcastChannel is same-origin and
    // reaches only pages this browser opened. Nothing off this machine can
    // post to it.
    if (e.data.type === 'token-move') {
      const moved = applyPlayerAction({
        kind: 'gmmove', local: true,
        tokenId: e.data.id, tx: e.data.tx, ty: e.data.ty,
      });
      if (moved) onTokensChanged();
    }
  };
  S.showChannel.onmessage = (e) => {
    if (e.data.type === 'heartbeat') {
      updateDisplayStatus('show', true);
      applyScreenInfo('show', e.data.screenW, e.data.screenH);
      // On first heartbeat after GM refresh, push image (with stored fog if any) and rotation
      if (!showSynced) {
        showSynced = true;
        if (S.lastShowSrc) sendShowContent(S.lastShowSrc, S.viewportCrop);
        sendShowSettings();
      }
    }
    if (e.data.type === 'request-sync') {
      applyScreenInfo('show', e.data.screenW, e.data.screenH);
      // Re-send current sidecar image with crop, plus sidecar rotation
      if (S.lastShowSrc) sendShowContent(S.lastShowSrc, S.viewportCrop);
      sendShowSettings();
    }
  };

  startPolling();
  loadMapLibrary();
  loadImageLibrary();
  renderImageLibrary();
  refreshArtVaultOptions();
  initArtUploadInput();

  const action = params.get('action');
  const filePath = params.get('file');
  if (filePath) {
    handleCommand({ action: action || 'show', file: filePath });
    renderMapLibrary();
    renderImageLibrary();
  } else {
    // No incoming command — restore previous session
    restoreState();
  }

  // Tokens / markers / remote-player sync (GM side).
  initTokensGM();
  initBoardGM();
}

// === Display Status ===
let mapConnected = false, showConnected = false;
function updateDisplayStatus(which, connected) {
  if (which === 'map') {
    mapConnected = connected;
    document.getElementById('map-status').innerHTML = connected
      ? '<span class="status-on">connected</span>'
      : '<span class="status-off">not connected</span>';
  } else {
    showConnected = connected;
    document.getElementById('show-status').innerHTML = connected
      ? '<span class="status-on">connected</span>'
      : '<span class="status-off">not connected</span>';
  }
}

// === Thumbnail Updates ===
export function updateMapThumbnail(src, name) {
  S.lastMapSrc = src;
  S.lastMapName = name || '';
  const thumb = document.getElementById('map-thumb');
  const empty = document.getElementById('map-thumb-empty');
  const label = document.getElementById('map-thumb-label');
  if (src) {
    thumb.src = src;
    thumb.style.display = 'block';
    empty.style.display = 'none';
    label.textContent = decodeURIComponent(name || '');
    label.style.display = name ? 'block' : 'none';
  }
  // The active map changed — swap the token layer to this map's placements.
  setTokenMap(src);
}

export function updateShowThumbnail(src, name) {
  S.lastShowSrc = src;
  S.lastShowName = name || '';
  const thumb = document.getElementById('show-thumb');
  const empty = document.getElementById('show-thumb-empty');
  const label = document.getElementById('show-thumb-label');
  if (src) {
    thumb.src = src;
    thumb.style.display = 'block';
    empty.style.display = 'none';
    label.textContent = decodeURIComponent(name || '');
    label.style.display = name ? 'block' : 'none';
  }
}

// === Open Display Windows ===
export function openDisplay(type) {
  const url = 'display.html?display=' + type;
  const name = type === 'map' ? 'gm-projector' : 'gm-sidecar';
  const w = window.open(url, name, 'popup');
  if (w) setStatus(`${type === 'map' ? 'Projector' : 'Sidecar'} window opened — drag to screen, F11 for fullscreen`);
}

// === Command Polling ===
function startPolling() {
  S.pollTimer = setInterval(async () => {
    try {
      const resp = await fetch('/api/command');
      const cmd = await resp.json();
      if (cmd) handleCommand(cmd);
    } catch(e) {}
  }, 300);
}

function handleCommand(cmd) {
  const action = cmd.action || 'show';
  const filePath = cmd.file;
  if (!filePath) return;

  const shortName = decodeURIComponent(filePath.split('/').pop());
  console.log(`[GM Display] Command: ${action} -> ${filePath}`);
  setStatus(`Received: ${action} ${shortName}`);

  if (action === 'show') {
    const img = new Image();
    img.onload = () => {
      S.loadedImage = img;
      // Store image dimensions for crop calculations
      S.mapWidth = img.width;
      S.mapHeight = img.height;
      applySavedBgForSrc(img.src, 'show');
      sendShowContent(img.src, S.viewportCrop);
      setStatus(`Sidecar: ${shortName}`);
      updateShowThumbnail(img.src, shortName);
      addToImageLibrary(img.src, shortName);
      if (S.currentMode === 'landing') {
        startImageMode(filePath);
      }
    };
    img.onerror = () => setStatus(`Failed to load: ${filePath}`);
    img.src = filePath;

  } else if (action === 'map') {
    setStatus(`Loading map: ${shortName}`);
    const img = new Image();
    img.onload = () => {
      setFogContext('map');
      S.loadedImage = img;
      S.fogImage = img;
      updateMapThumbnail(img.src, shortName);
      startFogMode();
    };
    img.onerror = () => { console.error(`Failed to load map: ${filePath}`); setStatus(`FAILED: ${filePath}`); };
    img.src = filePath;
  }
}

// === File Loading (drag & drop) ===
function loadFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      S.loadedImage = img;
      document.getElementById('mode-buttons').style.display = 'flex';
      document.getElementById('drop-zone').innerHTML = `<span>${file.name}</span><small>${img.width} x ${img.height}</small>`;
      setStatus(`Loaded: ${file.name}`);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}
