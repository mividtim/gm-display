// GM Display — navigation.js
// Navigation and the player-view entry.
// Classic script: load order matters (see gm_display.html).
// === Navigation ===
// Switch which "view" is shown in the main content area. The sidebar is
// always visible; only the main canvas/preview/welcome swaps.
function setMainView(view) {
  currentMode = (view === 'idle') ? 'landing' : view;
  document.querySelectorAll('#main-content > .main-view').forEach(el => el.classList.remove('active'));
  const target = document.getElementById('view-' + view);
  if (target) target.classList.add('active');
  // Fog-presets bar lives at the bottom of main content; only visible while
  // editing fog.
  const presets = document.getElementById('fog-presets-bar');
  if (presets) presets.style.display = (view === 'fog') ? '' : 'none';
}

function goHome() {
  // Save current fog state before navigating away (per active context)
  if (currentMode === 'fog' && fogInitialized && fogImage) {
    savePerMapFog(fogImage.src);
  }
  setMainView('idle');
  const mb = document.getElementById('mode-buttons');
  if (mb) mb.style.display = loadedImage ? 'flex' : 'none';
  const btnFog = document.getElementById('btn-crop');
  const btnImg = document.getElementById('btn-crop-img');
  if (btnFog) btnFog.classList.remove('active');
  if (btnImg) btnImg.classList.remove('active');
  renderMapLibrary();
  renderImageLibrary();
  saveState();
}

function goBack() { goHome(); }


// ============================================================
// === PLAYER VIEW (runs in display windows) ==================
// ============================================================
function setupPlayerChannel() {
  const channelName = playerDisplay === 'map' ? 'gm-display-map' : 'gm-display-show';
  playerChannel = new BroadcastChannel(channelName);

  // Send full request-sync (with current screen dimensions) on initial load.
  setTimeout(() => playerChannel.postMessage({
    type: 'request-sync',
    screenW: window.innerWidth,
    screenH: window.innerHeight
  }), 500);

  // Heartbeat carries the player's current viewport dimensions so the GM can
  // pick them up even if it (re)loaded after the player did. The GM applies
  // hysteresis so harmless layout transients don't cause flicker.
  setInterval(() => playerChannel.postMessage({
    type: 'heartbeat',
    screenW: window.innerWidth,
    screenH: window.innerHeight
  }), 2000);

  playerChannel.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'heartbeat') return;

    // Token / marker overlays (projector only — sidecar ignores them).
    if (d.type === 'tokens' || d.type === 'markers') {
      if (playerDisplay === 'map') projectorHandleMessage(d);
      return;
    }

    // --- Image display (sidecar, no fog) ---
    if (d.type === 'show-image') {
      document.getElementById('player-text-overlay').style.display = 'none';
      // Plain image: clear any cached fog so a stale fog mask doesn't sneak back
      // in via a subsequent crop-update.
      cachedFogData = null;
      cachedMapSrc = d.imageSrc;
      const tempImg = new Image();
      tempImg.onload = () => {
        cachedMapImage = tempImg;
        renderPlayerImage(tempImg, d.crop);
      };
      tempImg.src = d.imageSrc;
    }

    // --- Fog of war (projector) ---
    if (d.type === 'fog-init') {
      document.getElementById('player-image').style.display = 'none';
      const wrap = document.getElementById('player-canvas-wrap');
      wrap.style.display = 'inline-block';
      const canvas = document.getElementById('player-canvas');
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Pre-cache the map image
      cachedMapSrc = d.imageSrc;
      cachedMapImage = new Image();
      cachedMapImage.src = d.imageSrc;
    }

    if (d.type === 'fog-update') {
      console.log('[Player] fog-update received. Map:', d.width, 'x', d.height,
        'fog entries:', d.fogMask?.length, 'crop:', JSON.stringify(d.crop));
      document.getElementById('player-image').style.display = 'none';
      const wrap = document.getElementById('player-canvas-wrap');
      wrap.style.display = 'inline-block';
      // Cache the fog data so crop-only updates can re-render without re-sending mask
      cachedFogData = d;
      renderPlayerFogDoubleBuffered(d);
    }

    // --- Crop-only update (lightweight, no fog mask) ---
    if (d.type === 'crop-update') {
      console.log('[Player] crop-update received:', JSON.stringify(d.crop),
        'cachedFogData:', !!cachedFogData, 'cachedMapImage:', !!cachedMapImage);
      if (cachedFogData) {
        // Fog-of-war mode: re-render with new crop
        cachedFogData.crop = d.crop;
        renderPlayerFogDoubleBuffered(cachedFogData);
      } else if (cachedMapImage && cachedMapImage.complete) {
        // Image mode: re-render with new crop
        renderPlayerImage(cachedMapImage, d.crop);
      } else {
        console.warn('[Player] crop-update ignored — no cached data. Player needs a full sync.');
        playerChannel.postMessage({ type: 'request-sync' });
      }
    }

    // --- Sidecar settings (rotation + background — sidecar doesn't get keystone/scale/grid) ---
    if (d.type === 'show-settings') {
      const prevRotation = pRotation;
      const prevBg = pBg;
      pRotation = ((Math.round(d.rotation || 0) % 360) + 360) % 360;
      if (typeof d.background === 'string') pBg = d.background;
      const rotationChanged = (prevRotation !== pRotation);
      const bgChanged = (prevBg !== pBg);
      if (rotationChanged || bgChanged) {
        if (cachedFogData) {
          // Sidecar has fog active — re-render image+fog with new bg/rotation
          renderPlayerFogDoubleBuffered(cachedFogData);
        } else if (cachedMapImage && cachedMapImage.complete) {
          renderPlayerImage(cachedMapImage, null);
        }
      }
      applyProjectionTransform();
      applyPlayerBackground();
    }

    // --- Projection settings (4-corner keystone, rotation, scale, grid, background) ---
    if (d.type === 'projection') {
      const prevRotation = pRotation;
      const prevBg = pBg;
      pCorners = d.corners || { tl:{x:0,y:0}, tr:{x:0,y:0}, bl:{x:0,y:0}, br:{x:0,y:0} };
      pScale = d.scale || 100;
      pRotation = ((Math.round(d.rotation || 0) % 360) + 360) % 360;
      if (typeof d.background === 'string') pBg = d.background;
      pGridEnabled = d.gridEnabled || false;
      pGridPx = d.gridPx || 50;
      pGridOpacity = d.gridOpacity || 0.4;
      pGridColor = d.gridColor || 'rgba(255,255,255,0.4)';
      applyPlayerBackground();
      const bgChanged = (prevBg !== pBg);

      // If rotation crosses the 0/180 ↔ 90/270 boundary, canvas dimensions need
      // to swap, so re-render before applying the transform (which depends on
      // canvas.width/height for the keystone matrix3d).
      const rotationChanged = (prevRotation !== pRotation);
      if (pTestPattern) {
        renderTestPattern();
      } else if (rotationChanged || bgChanged) {
        if (cachedFogData) {
          renderPlayerFogDoubleBuffered(cachedFogData);
        } else if (cachedMapImage && cachedMapImage.complete) {
          // Re-render the image; reuse last crop if any
          renderPlayerImage(cachedMapImage, (cachedFogData && cachedFogData.crop) || null);
        }
      }
      applyProjectionTransform();
      drawGrid();
    }

    // --- Text overlay ---
    if (d.type === 'show-text') {
      const ov = document.getElementById('player-text-overlay');
      ov.textContent = d.text;
      ov.style.display = 'block';
    }
    if (d.type === 'hide-text') {
      document.getElementById('player-text-overlay').style.display = 'none';
    }

    // --- Test pattern (white + grid for keystone calibration) ---
    if (d.type === 'test-pattern') {
      pTestPattern = d.enabled;
      if (d.enabled) {
        renderTestPattern();
      } else {
        // Re-render normal content
        if (cachedFogData) {
          renderPlayerFogDoubleBuffered(cachedFogData);
        } else if (cachedMapImage && cachedMapImage.complete) {
          renderPlayerImage(cachedMapImage, null);
        }
      }
    }

    if (d.type === 'clear') {
      document.getElementById('player-image').style.display = 'none';
      document.getElementById('player-canvas-wrap').style.display = 'none';
      document.getElementById('player-text-overlay').style.display = 'none';
    }
  };
}

// Apply the player's per-display background color.
function applyPlayerBackground() {
  if (!isPlayerView) return;
  const view = document.getElementById('player-view');
  if (view) view.style.background = pBg;
  document.body.style.background = pBg;
}

// Parse a CSS hex color like "#ffffff" or "#fff" into [r, g, b] (0-255).
// Returns black for anything we can't parse (defensive default).
function parseHexColor(hex) {
  if (typeof hex !== 'string' || hex[0] !== '#') return [0, 0, 0];
  const h = hex.slice(1);
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ];
  }
  if (h.length === 6) {
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  return [0, 0, 0];
}
