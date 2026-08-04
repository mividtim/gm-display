// GM Display — fog.js
// Image display mode, fog-of-war mode, the GM image mirror.
// Classic script: load order matters (see gm_display.html).
// === Image Display Mode (-> sidecar) ===
import { applyCropToSliders, computeViewportCrop, updateViewportOutline } from './crop.js';
import { ensureDefaultPreset, forceSyncToMapDisplay, markPendingSync, renderPresetThumbnails } from './fog-presets.js';
import { loadShowFogForSrc, saveState, sendShowContent } from './games.js';
import { updateMapThumbnail, updateShowThumbnail } from './init.js';
import { setStatus } from './keyboard.js';
import { parseHexColor, setMainView } from './navigation.js';
import { activeFogChannel, addToImageLibrary, addToMapLibrary, applySavedBgForSrc, applySavedCropForSrc, fogStoragePrefix, loadPerMapFog, saveCropForCurrentImage, setFogContext } from './per-map-store.js';
import { computeCropOverlap } from './player-view.js';
import { sendProjectionSettings, sendShowSettings, updateBgUI, updateRotationUI } from './projection.js';
import { attachFogCanvasHandlers, fitCanvasToView, renderGMFog, updateUndoRedoButtons } from './sidebar.js';
import { S } from './store.js';
import { playerFacingMapSrc } from './tokens.js';
export function startImageMode(filename) {
  setMainView('image');
  renderGMImage();
  // Ensure map dimensions are set for crop calculations
  S.mapWidth = S.loadedImage.width;
  S.mapHeight = S.loadedImage.height;

  const shortName = (filename || 'file').split('/').pop().replace(/%20/g, ' ');
  document.getElementById('img-filename').textContent = decodeURIComponent(shortName);
  document.getElementById('img-dest-label').textContent = 'Showing on sidecar';
  setStatus(`Image -> Sidecar: ${decodeURIComponent(shortName)}`);

  updateShowThumbnail(S.loadedImage.src, filename || '');
  addToImageLibrary(S.loadedImage.src, filename || '');
  sendShowContent(S.loadedImage.src, S.viewportCrop);
  saveState();
}

function resumeImageMode() {
  if (!S.lastShowSrc) return;
  setMainView('image');

  // Re-anchor loadedImage to the sidecar image — a stray gm://map/... click
  // can leave loadedImage pointing at a map, which then bleeds into actions
  // that take place from image-display (like Edit Fog).
  if (!S.loadedImage || S.loadedImage.src !== S.lastShowSrc) {
    const img = new Image();
    img.onload = () => {
      S.loadedImage = img;
      S.mapWidth = img.width;
      S.mapHeight = img.height;
      renderGMImage();
    };
    img.src = S.lastShowSrc;
  } else {
    S.mapWidth = S.loadedImage.width;
    S.mapHeight = S.loadedImage.height;
    renderGMImage();
  }

  document.getElementById('img-filename').textContent = S.lastShowName || '';
  document.getElementById('img-dest-label').textContent = 'Showing on sidecar';
  setStatus(`Previewing: ${S.lastShowName}`);
  saveState();
}

// === Fog of War Mode (works for both projector and sidecar via fogContext) ===
export function startFogMode() {
  setMainView('fog');

  const img = S.fogImage || S.loadedImage;
  if (!img) return;

  // Detect new image for this context. Track the last fully-initialized src
  // separately because callers pre-set fogImage/lastMapSrc before we run.
  const incomingDifferent = (img.src !== S.lastInitializedFogSrc);
  if (incomingDifferent) S.fogInitialized = false;

  // Resolve which "last src" to compare against (per active context).
  const lastSrcForCtx = S.fogContext === 'show' ? S.lastShowSrc : S.lastMapSrc;

  const mapCanvas = document.getElementById('gm-map-canvas');
  const isNewMap = incomingDifferent || !S.fogInitialized || !mapCanvas.width;

  if (isNewMap) {
    // Save current fog for the previous image (in this context) before switching
    if (S.lastInitializedFogSrc && S.fogMask && S.lastInitializedFogSrc !== img.src) {
      // Temporarily restore fogMask/presets back to the previous src so save uses
      // the right key. Easiest: just write under the previous src directly.
      try {
        const prevData = { presets: S.fogPresets, activeIdx: S.activePresetIdx };
        localStorage.setItem(fogStoragePrefix() + S.lastInitializedFogSrc, JSON.stringify(prevData));
      } catch(e) {}
    }

    S.fogImage = img;
    S.mapWidth = img.width;
    S.mapHeight = img.height;

    // Try to restore saved fog (and presets) for this image, in the active context.
    // Defaults if no saved fog:
    //   - Maps (fogContext === 'map')   → all hidden (Uint8Array fills with 0)
    //   - Images (fogContext === 'show') → all revealed (fill with 255)
    // Rationale: a newly-loaded battle map starts fogged so the GM reveals as
    // exploration progresses. A newly-loaded handout starts fully visible
    // because handouts are usually shown whole; the GM applies fog only when
    // they want to mask part of it.
    const savedFog = loadPerMapFog(img.src, S.mapWidth * S.mapHeight);
    if (savedFog) {
      S.fogMask = savedFog;
    } else {
      S.fogMask = new Uint8Array(S.mapWidth * S.mapHeight);
      if (S.fogContext === 'show') S.fogMask.fill(255);
    }
    S.fogInitialized = true;
    S.lastInitializedFogSrc = img.src;

    // Ensure at least one preset exists
    ensureDefaultPreset();

    // Add to map library only when editing fog on the projector (maps).
    if (S.fogContext === 'map') {
      addToMapLibrary(img.src, S.lastMapName);
    }

    // Reset fog history for the new image
    S.fogHistory = [new Uint8Array(S.fogMask)];
    S.fogHistoryIdx = 0;
    updateUndoRedoButtons();

    // Apply per-image saved crop (zoom + pan) — falls back to defaults if no
    // saved crop exists for this src. This used to be an unconditional
    // resetCrop(), which clobbered the just-restored zoom/pan on every entry
    // to fog mode (including reload, library click, and context switch).
    applySavedCropForSrc(img.src);
    applyCropToSliders();
    // Apply per-image saved background color — leaves the global bg untouched
    // if nothing was saved for this src.
    applySavedBgForSrc(img.src, S.fogContext === 'show' ? 'show' : 'map');

    const ch = activeFogChannel();
    if (ch) {
      if (S.fogContext === 'map' && !S.liveSync) {
        markPendingSync();
      } else {
        // The projector is a player-facing surface, so on a split map it gets
        // the players' copy. The dimensions stay the GM image's: they are the
        // coordinate space the fog mask, the crop and the grid all live in.
        ch.postMessage({ type: 'fog-init', imageSrc: playerFacingMapSrc() || img.src,
                         width: S.mapWidth, height: S.mapHeight });
        setTimeout(() => {
          forceSyncToMapDisplay();
          if (S.fogContext === 'map') sendProjectionSettings();
          else sendShowSettings();
        }, 100);
      }
    }

    if (S.fogContext === 'map') {
      updateMapThumbnail(img.src, S.lastMapName);
    } else {
      updateShowThumbnail(img.src, S.lastShowName);
    }
  }

  // Always sync canvas dims to current image and redraw the map. This is cheap
  // and protects against stale dims from a previous fog session in the other
  // context (e.g., switching from a map back to a sidecar handout).
  const fogCanvas = document.getElementById('gm-fog-canvas');
  if (mapCanvas.width !== S.mapWidth || mapCanvas.height !== S.mapHeight) {
    mapCanvas.width = S.mapWidth; mapCanvas.height = S.mapHeight;
    fogCanvas.width = S.mapWidth; fogCanvas.height = S.mapHeight;
  }
  mapCanvas.getContext('2d').drawImage(img, 0, 0);

  // Scale canvas display size to fit the available main-view area.
  fitCanvasToView();

  // Always (re)attach fog painting handlers when entering fog mode — defensive
  // against any case where the canvas previously lost them.
  attachFogCanvasHandlers();
  // Reflect target in the toolbar's home button + status line
  updateFogModeChrome();

  renderGMFog();
  renderPresetThumbnails();
  updateFogTargetButtons();
  setStatus(S.fogContext === 'show'
    ? 'Editing fog on sidecar handout. R/H = reveal/hide, C = crop. Esc to exit.'
    : 'Fog of War -> Projector. R/H = reveal/hide, C = crop, P = projection/grid');
  saveState();
}

// Entry point: edit fog over the currently-shown sidecar image.
// Always reload from lastShowSrc rather than trusting loadedImage — a
// gm://map/... click can overwrite loadedImage while the user sits on
// image-display, and we'd otherwise end up editing fog for the map.
export function startImageFogMode() {
  if (!S.lastShowSrc) {
    setStatus('Load an image on the sidecar first.');
    return;
  }
  saveCropForCurrentImage();
  setFogContext('show');
  const img = new Image();
  img.onload = () => {
    S.loadedImage = img;
    S.fogImage = img;
    S.mapWidth = img.width;
    S.mapHeight = img.height;
    applySavedCropForSrc(img.src);
    startFogMode();
    applyCropToSliders();
    updateFogTargetButtons();
  };
  img.onerror = () => setStatus('Failed to load sidecar image: ' + S.lastShowSrc);
  img.src = S.lastShowSrc;
}

// Symmetric to startImageFogMode: returns the user to map fog mode after
// they've been in image fog mode. Always reloads the map image fresh rather
// than relying on the stash/restore in setFogContext, which has been a source
// of bugs in the past (loadedImage globals leaking across contexts).
export function switchToMapFog() {
  if (!S.lastMapSrc) {
    setStatus('No map loaded — drop one in or pick from the Maps library.');
    return;
  }
  saveCropForCurrentImage();
  setFogContext('map');
  const img = new Image();
  img.onload = () => {
    S.loadedImage = img;
    S.fogImage = img;
    S.mapWidth = img.width;
    S.mapHeight = img.height;
    applySavedCropForSrc(img.src);
    startFogMode();
    applyCropToSliders();
    updateFogTargetButtons();
  };
  img.onerror = () => setStatus('Failed to load map: ' + S.lastMapSrc);
  img.src = S.lastMapSrc;
}

// Reflects the active fog context on the Map Fog / Image Fog toolbar buttons.
// Call this whenever fogContext changes or after entering fog mode.
function updateFogTargetButtons() {
  const mapBtn = document.getElementById('btn-fog-target-map');
  const showBtn = document.getElementById('btn-fog-target-show');
  if (mapBtn) mapBtn.classList.toggle('active', S.fogContext === 'map');
  if (showBtn) showBtn.classList.toggle('active', S.fogContext === 'show');
}

// Cosmetic: update visible chrome to indicate which target is being painted.
function updateFogModeChrome() {
  // After the consolidation pass, all controls are universal — they apply to
  // whichever display the active entry targets. The previous version of this
  // function hid keystone and the entire projector-adjustments section when
  // editing a sidecar handout; that was wrong (per user feedback: "Whether
  // it's a projector or not, we can keep the keystone controls"). We now leave
  // every section visible and just refresh the rotation/bg UI to reflect the
  // active target.
  updateRotationUI();
  updateBgUI();
}

function resumeFogMode() {
  if (!S.fogInitialized || !S.fogImage) return;
  setMainView('fog');

  // Restore map dimensions (image mode may have changed them)
  S.mapWidth = S.fogImage.width;
  S.mapHeight = S.fogImage.height;

  // Ensure canvases match fog image dimensions and redraw the map
  const mapCanvas = document.getElementById('gm-map-canvas');
  const fogCanvas = document.getElementById('gm-fog-canvas');
  if (mapCanvas.width !== S.mapWidth || mapCanvas.height !== S.mapHeight) {
    mapCanvas.width = S.mapWidth;
    mapCanvas.height = S.mapHeight;
    fogCanvas.width = S.mapWidth;
    fogCanvas.height = S.mapHeight;
  }
  mapCanvas.getContext('2d').drawImage(S.fogImage, 0, 0);
  fitCanvasToView();

  attachFogCanvasHandlers();

  renderGMFog();
  renderPresetThumbnails();
  computeViewportCrop();
  updateViewportOutline();
  updateFogTargetButtons();
  setStatus('Fog of War -> Projector. R/H = reveal/hide, C = crop, P = projection/grid');
  saveState();
}

// === GM image mirror ===
// Renders the sidecar handout in the GM #view-image area, applying the same
// crop + rotation + stored fog as the sidecar player. WYSIWYG: GM sees exactly
// what the sidecar is displaying.
export function renderGMImage() {
  if (!S.loadedImage) return;
  const view = document.getElementById('view-image');
  const wrap = document.getElementById('image-canvas-wrap-gm');
  const rotWrap = document.getElementById('image-rotation-wrap-gm');
  const canvas = document.getElementById('image-canvas-gm');
  const img = document.getElementById('display-image');
  if (!view || !wrap || !canvas || !img) return;

  // Rotation is applied around center to both the rotation wrap (canvas mode)
  // and the img (no-crop, no-fog fallback).
  const rotCss = S.showRotation ? `rotate(${S.showRotation}deg)` : '';
  if (rotWrap) rotWrap.style.transform = rotCss || 'none';
  img.style.transform = rotCss;

  const crop = (S.currentMode === 'image') ? S.viewportCrop : null;
  const isRot90 = (S.showRotation === 90 || S.showRotation === 270);

  // Pull stored sidecar fog for this image (if any).
  const fogData = loadShowFogForSrc(S.loadedImage.src);
  const hasFog = !!(fogData && fogData.mask && fogData.mask.length);

  // Fast path: no crop and no fog — just show the <img>.
  if (!crop && !hasFog) {
    wrap.style.display = 'none';
    img.style.display = 'block';
    if (img.src !== S.loadedImage.src) img.src = S.loadedImage.src;
    if (isRot90) {
      img.style.maxWidth = (view.clientHeight * 0.95) + 'px';
      img.style.maxHeight = (view.clientWidth * 0.95) + 'px';
    } else {
      img.style.maxWidth = '95%';
      img.style.maxHeight = '95%';
    }
    return;
  }

  // Canvas path: crop and/or fog applied.
  img.style.display = 'none';
  wrap.style.display = 'inline-block';

  const availW = view.clientWidth * 0.95;
  const availH = view.clientHeight * 0.95;
  const targetW = isRot90 ? availH : availW;
  const targetH = isRot90 ? availW : availH;
  if (targetW < 1 || targetH < 1) return;

  const srcW = crop ? crop.w : S.loadedImage.width;
  const srcH = crop ? crop.h : S.loadedImage.height;
  const srcX = crop ? crop.x : 0;
  const srcY = crop ? crop.y : 0;
  const scale = Math.min(targetW / srcW, targetH / srcH);
  const cW = Math.max(1, Math.floor(srcW * scale));
  const cH = Math.max(1, Math.floor(srcH * scale));

  canvas.width = cW;
  canvas.height = cH;
  const ctx = canvas.getContext('2d');
  const [bgR, bgG, bgB] = parseHexColor(S.showBg);
  ctx.fillStyle = S.showBg || '#000';
  ctx.fillRect(0, 0, cW, cH);

  // Draw the cropped (or full) region of the image.
  if (crop) {
    const ol = computeCropOverlap(crop, S.loadedImage.width, S.loadedImage.height);
    if (ol) {
      ctx.drawImage(S.loadedImage,
        ol.srcX, ol.srcY, ol.srcW, ol.srcH,
        ol.dstX * scale, ol.dstY * scale, ol.srcW * scale, ol.srcH * scale);
    }
  } else {
    ctx.drawImage(S.loadedImage, 0, 0, S.loadedImage.width, S.loadedImage.height, 0, 0, cW, cH);
  }

  // Apply the fog mask if dims match the loaded image.
  if (hasFog && fogData.w === S.loadedImage.width && fogData.h === S.loadedImage.height) {
    const imgData = ctx.getImageData(0, 0, cW, cH);
    const px = imgData.data;
    const mask = fogData.mask;
    const fw = fogData.w, fh = fogData.h;
    for (let y = 0; y < cH; y++) {
      for (let x = 0; x < cW; x++) {
        const mapX = srcX + Math.floor(x / scale);
        const mapY = srcY + Math.floor(y / scale);
        if (mapX < 0 || mapX >= fw || mapY < 0 || mapY >= fh) {
          const i = (y * cW + x) * 4;
          px[i] = bgR; px[i+1] = bgG; px[i+2] = bgB; px[i+3] = 255;
        } else if (mask[mapY * fw + mapX] === 0) {
          const i = (y * cW + x) * 4;
          px[i] = bgR; px[i+1] = bgG; px[i+2] = bgB; px[i+3] = 255;
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }
}
