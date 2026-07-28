// GM Display — navigation.js
// Navigation and the player-view entry.
// Classic script: load order matters (see gm_display.html).
// === Navigation ===
// Switch which "view" is shown in the main content area. The sidebar is
// always visible; only the main canvas/preview/welcome swaps.
import { S } from './store.js';
import { saveState } from './games.js';
import { init } from './init.js';
import { renderImageLibrary, renderMapLibrary, savePerMapFog } from './per-map-store.js';
import { applyProjectionTransform, drawGrid, renderPlayerFogDoubleBuffered, renderPlayerImage, renderTestPattern } from './player-view.js';
import { projectorHandleMessage } from './tokens.js';
export function setMainView(view) {
  S.currentMode = (view === 'idle') ? 'landing' : view;
  document.querySelectorAll('#main-content > .main-view').forEach(el => el.classList.remove('active'));
  const target = document.getElementById('view-' + view);
  if (target) target.classList.add('active');
  // Fog-presets bar lives at the bottom of main content; only visible while
  // editing fog.
  const presets = document.getElementById('fog-presets-bar');
  if (presets) presets.style.display = (view === 'fog') ? '' : 'none';
}

export function goHome() {
  // Save current fog state before navigating away (per active context)
  if (S.currentMode === 'fog' && S.fogInitialized && S.fogImage) {
    savePerMapFog(S.fogImage.src);
  }
  setMainView('idle');
  const mb = document.getElementById('mode-buttons');
  if (mb) mb.style.display = S.loadedImage ? 'flex' : 'none';
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
export function setupPlayerChannel() {
  const channelName = S.playerDisplay === 'map' ? 'gm-display-map' : 'gm-display-show';
  S.playerChannel = new BroadcastChannel(channelName);

  // Send full request-sync (with current screen dimensions) on initial load.
  setTimeout(() => S.playerChannel.postMessage({
    type: 'request-sync',
    screenW: window.innerWidth,
    screenH: window.innerHeight
  }), 500);

  // Heartbeat carries the player's current viewport dimensions so the GM can
  // pick them up even if it (re)loaded after the player did. The GM applies
  // hysteresis so harmless layout transients don't cause flicker.
  setInterval(() => S.playerChannel.postMessage({
    type: 'heartbeat',
    screenW: window.innerWidth,
    screenH: window.innerHeight
  }), 2000);

  S.playerChannel.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'heartbeat') return;

    // Token / marker overlays (projector only — sidecar ignores them).
    if (d.type === 'tokens' || d.type === 'markers') {
      if (S.playerDisplay === 'map') projectorHandleMessage(d);
      return;
    }

    // --- Image display (sidecar, no fog) ---
    if (d.type === 'show-image') {
      document.getElementById('player-text-overlay').style.display = 'none';
      // Plain image: clear any cached fog so a stale fog mask doesn't sneak back
      // in via a subsequent crop-update.
      S.cachedFogData = null;
      S.cachedMapSrc = d.imageSrc;
      const tempImg = new Image();
      tempImg.onload = () => {
        S.cachedMapImage = tempImg;
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
      S.cachedMapSrc = d.imageSrc;
      S.cachedMapImage = new Image();
      S.cachedMapImage.src = d.imageSrc;
    }

    if (d.type === 'fog-update') {
      console.log('[Player] fog-update received. Map:', d.width, 'x', d.height,
        'fog entries:', d.fogMask?.length, 'crop:', JSON.stringify(d.crop));
      document.getElementById('player-image').style.display = 'none';
      const wrap = document.getElementById('player-canvas-wrap');
      wrap.style.display = 'inline-block';
      // Cache the fog data so crop-only updates can re-render without re-sending mask
      S.cachedFogData = d;
      renderPlayerFogDoubleBuffered(d);
    }

    // --- Crop-only update (lightweight, no fog mask) ---
    if (d.type === 'crop-update') {
      console.log('[Player] crop-update received:', JSON.stringify(d.crop),
        'cachedFogData:', !!S.cachedFogData, 'cachedMapImage:', !!S.cachedMapImage);
      if (S.cachedFogData) {
        // Fog-of-war mode: re-render with new crop
        S.cachedFogData.crop = d.crop;
        renderPlayerFogDoubleBuffered(S.cachedFogData);
      } else if (S.cachedMapImage && S.cachedMapImage.complete) {
        // Image mode: re-render with new crop
        renderPlayerImage(S.cachedMapImage, d.crop);
      } else {
        console.warn('[Player] crop-update ignored — no cached data. Player needs a full sync.');
        S.playerChannel.postMessage({ type: 'request-sync' });
      }
    }

    // --- Sidecar settings (rotation + background — sidecar doesn't get keystone/scale/grid) ---
    if (d.type === 'show-settings') {
      const prevRotation = S.pRotation;
      const prevBg = S.pBg;
      S.pRotation = ((Math.round(d.rotation || 0) % 360) + 360) % 360;
      if (typeof d.background === 'string') S.pBg = d.background;
      const rotationChanged = (prevRotation !== S.pRotation);
      const bgChanged = (prevBg !== S.pBg);
      if (rotationChanged || bgChanged) {
        if (S.cachedFogData) {
          // Sidecar has fog active — re-render image+fog with new bg/rotation
          renderPlayerFogDoubleBuffered(S.cachedFogData);
        } else if (S.cachedMapImage && S.cachedMapImage.complete) {
          renderPlayerImage(S.cachedMapImage, null);
        }
      }
      applyProjectionTransform();
      applyPlayerBackground();
    }

    // --- Projection settings (4-corner keystone, rotation, scale, grid, background) ---
    if (d.type === 'projection') {
      const prevRotation = S.pRotation;
      const prevBg = S.pBg;
      S.pCorners = d.corners || { tl:{x:0,y:0}, tr:{x:0,y:0}, bl:{x:0,y:0}, br:{x:0,y:0} };
      S.pScale = d.scale || 100;
      S.pRotation = ((Math.round(d.rotation || 0) % 360) + 360) % 360;
      if (typeof d.background === 'string') S.pBg = d.background;
      S.pGridEnabled = d.gridEnabled || false;
      S.pGridPx = d.gridPx || 50;
      S.pGridOpacity = d.gridOpacity || 0.4;
      S.pGridColor = d.gridColor || 'rgba(255,255,255,0.4)';
      applyPlayerBackground();
      const bgChanged = (prevBg !== S.pBg);

      // If rotation crosses the 0/180 ↔ 90/270 boundary, canvas dimensions need
      // to swap, so re-render before applying the transform (which depends on
      // canvas.width/height for the keystone matrix3d).
      const rotationChanged = (prevRotation !== S.pRotation);
      if (S.pTestPattern) {
        renderTestPattern();
      } else if (rotationChanged || bgChanged) {
        if (S.cachedFogData) {
          renderPlayerFogDoubleBuffered(S.cachedFogData);
        } else if (S.cachedMapImage && S.cachedMapImage.complete) {
          // Re-render the image; reuse last crop if any
          renderPlayerImage(S.cachedMapImage, (S.cachedFogData && S.cachedFogData.crop) || null);
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
      S.pTestPattern = d.enabled;
      if (d.enabled) {
        renderTestPattern();
      } else {
        // Re-render normal content
        if (S.cachedFogData) {
          renderPlayerFogDoubleBuffered(S.cachedFogData);
        } else if (S.cachedMapImage && S.cachedMapImage.complete) {
          renderPlayerImage(S.cachedMapImage, null);
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
  if (!S.isPlayerView) return;
  const view = document.getElementById('player-view');
  if (view) view.style.background = S.pBg;
  document.body.style.background = S.pBg;
}

// Parse a CSS hex color like "#ffffff" or "#fff" into [r, g, b] (0-255).
// Returns black for anything we can't parse (defensive default).
export function parseHexColor(hex) {
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
