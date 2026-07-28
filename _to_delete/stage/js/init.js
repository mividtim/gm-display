// GM Display — init.js
// Entry point, display status, thumbnails, command polling, drag-drop.
// Classic script: load order matters (see gm_display.html).
// === Init ===
function init() {
  const params = new URLSearchParams(window.location.search);

  if (params.get('mode') === 'remote') {
    setupRemoteView();
    return;
  }

  if (params.get('mode') === 'player') {
    isPlayerView = true;
    playerDisplay = params.get('display') || 'map';
    // Hide the GM shell entirely; only the player view renders in this window.
    const app = document.getElementById('app');
    if (app) app.style.display = 'none';
    document.getElementById('player-view').style.display = 'flex';
    document.getElementById('status-bar').style.display = 'none';
    document.title = playerDisplay === 'map' ? 'Projector (Maps)' : 'Sidecar (Images)';
    setupPlayerChannel();
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
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault(); dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', (e) => { if (e.target.files.length) loadFile(e.target.files[0]); });

  const brushEl = document.getElementById('brush-size');
  if (brushEl) brushEl.addEventListener('input', (e) => { brushSize = parseInt(e.target.value); updateBrushPreview(); saveState(); });
  updateBrushPreview();
  initCornerDrag();
  initPanDrag();
  initImageNameRename();
  initSidebarResize();

  mapChannel = new BroadcastChannel('gm-display-map');
  showChannel = new BroadcastChannel('gm-display-show');

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
        sizeChangedSignificantly(projectorW, projectorH, screenW, screenH);
      if (!changed) return false;
      projectorW = screenW; projectorH = screenH; mapSizeKnown = true;
      if (currentMode === 'fog' && cropZoom > 1.01) {
        computeViewportCrop();
        updateViewportOutline();
        sendCropUpdate();
      }
    } else {
      const changed = !showSizeKnown ||
        sizeChangedSignificantly(sidecarW, sidecarH, screenW, screenH);
      if (!changed) return false;
      sidecarW = screenW; sidecarH = screenH; showSizeKnown = true;
      if (currentMode === 'image' && Math.abs(cropZoom - 1.0) > 0.01) {
        computeViewportCrop();
        updateViewportOutline();
        sendCropUpdate();
      }
    }
    return true;
  };

  mapChannel.onmessage = (e) => {
    if (e.data.type === 'heartbeat') {
      updateDisplayStatus('map', true);
      applyScreenInfo('map', e.data.screenW, e.data.screenH);
      // Push full state on every heartbeat until we've successfully sent at
      // least one fog-update. Previously mapSynced was set unconditionally,
      // which meant if fog wasn't initialized yet on first heartbeat, the
      // projector window never received its initial map+fog data even after
      // the user later entered fog mode.
      if (!mapSynced && fogInitialized && fogMask && fogImage) {
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
  };
  showChannel.onmessage = (e) => {
    if (e.data.type === 'heartbeat') {
      updateDisplayStatus('show', true);
      applyScreenInfo('show', e.data.screenW, e.data.screenH);
      // On first heartbeat after GM refresh, push image (with stored fog if any) and rotation
      if (!showSynced) {
        showSynced = true;
        if (lastShowSrc) sendShowContent(lastShowSrc, viewportCrop);
        sendShowSettings();
      }
    }
    if (e.data.type === 'request-sync') {
      applyScreenInfo('show', e.data.screenW, e.data.screenH);
      // Re-send current sidecar image with crop, plus sidecar rotation
      if (lastShowSrc) sendShowContent(lastShowSrc, viewportCrop);
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
function updateMapThumbnail(src, name) {
  lastMapSrc = src;
  lastMapName = name || '';
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

function updateShowThumbnail(src, name) {
  lastShowSrc = src;
  lastShowName = name || '';
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
function openDisplay(type) {
  const url = window.location.pathname + '?mode=player&display=' + type;
  const name = type === 'map' ? 'gm-projector' : 'gm-sidecar';
  const w = window.open(url, name, 'popup');
  if (w) setStatus(`${type === 'map' ? 'Projector' : 'Sidecar'} window opened — drag to screen, F11 for fullscreen`);
}

// === Command Polling ===
function startPolling() {
  pollTimer = setInterval(async () => {
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
      loadedImage = img;
      // Store image dimensions for crop calculations
      mapWidth = img.width;
      mapHeight = img.height;
      applySavedBgForSrc(img.src, 'show');
      sendShowContent(img.src, viewportCrop);
      setStatus(`Sidecar: ${shortName}`);
      updateShowThumbnail(img.src, shortName);
      addToImageLibrary(img.src, shortName);
      if (currentMode === 'landing') {
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
      loadedImage = img;
      fogImage = img;
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
      loadedImage = img;
      document.getElementById('mode-buttons').style.display = 'flex';
      document.getElementById('drop-zone').innerHTML = `<span>${file.name}</span><small>${img.width} x ${img.height}</small>`;
      setStatus(`Loaded: ${file.name}`);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}
