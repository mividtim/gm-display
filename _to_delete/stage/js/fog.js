// GM Display — fog.js
// Image display mode, fog-of-war mode, the GM image mirror.
// Classic script: load order matters (see gm_display.html).
// === Image Display Mode (-> sidecar) ===
function startImageMode(filename) {
  setMainView('image');
  renderGMImage();
  // Ensure map dimensions are set for crop calculations
  mapWidth = loadedImage.width;
  mapHeight = loadedImage.height;

  const shortName = (filename || 'file').split('/').pop().replace(/%20/g, ' ');
  document.getElementById('img-filename').textContent = decodeURIComponent(shortName);
  document.getElementById('img-dest-label').textContent = 'Showing on sidecar';
  setStatus(`Image -> Sidecar: ${decodeURIComponent(shortName)}`);

  updateShowThumbnail(loadedImage.src, filename || '');
  addToImageLibrary(loadedImage.src, filename || '');
  sendShowContent(loadedImage.src, viewportCrop);
  saveState();
}

function resumeImageMode() {
  if (!lastShowSrc) return;
  setMainView('image');

  // Re-anchor loadedImage to the sidecar image — a stray gm://map/... click
  // can leave loadedImage pointing at a map, which then bleeds into actions
  // that take place from image-display (like Edit Fog).
  if (!loadedImage || loadedImage.src !== lastShowSrc) {
    const img = new Image();
    img.onload = () => {
      loadedImage = img;
      mapWidth = img.width;
      mapHeight = img.height;
      renderGMImage();
    };
    img.src = lastShowSrc;
  } else {
    mapWidth = loadedImage.width;
    mapHeight = loadedImage.height;
    renderGMImage();
  }

  document.getElementById('img-filename').textContent = lastShowName || '';
  document.getElementById('img-dest-label').textContent = 'Showing on sidecar';
  setStatus(`Previewing: ${lastShowName}`);
  saveState();
}

// === Fog of War Mode (works for both projector and sidecar via fogContext) ===
function startFogMode() {
  setMainView('fog');

  const img = fogImage || loadedImage;
  if (!img) return;

  // Detect new image for this context. Track the last fully-initialized src
  // separately because callers pre-set fogImage/lastMapSrc before we run.
  const incomingDifferent = (img.src !== lastInitializedFogSrc);
  if (incomingDifferent) fogInitialized = false;

  // Resolve which "last src" to compare against (per active context).
  const lastSrcForCtx = fogContext === 'show' ? lastShowSrc : lastMapSrc;

  const mapCanvas = document.getElementById('gm-map-canvas');
  const isNewMap = incomingDifferent || !fogInitialized || !mapCanvas.width;

  if (isNewMap) {
    // Save current fog for the previous image (in this context) before switching
    if (lastInitializedFogSrc && fogMask && lastInitializedFogSrc !== img.src) {
      // Temporarily restore fogMask/presets back to the previous src so save uses
      // the right key. Easiest: just write under the previous src directly.
      try {
        const prevData = { presets: fogPresets, activeIdx: activePresetIdx };
        localStorage.setItem(fogStoragePrefix() + lastInitializedFogSrc, JSON.stringify(prevData));
      } catch(e) {}
    }

    fogImage = img;
    mapWidth = img.width;
    mapHeight = img.height;

    // Try to restore saved fog (and presets) for this image, in the active context.
    // Defaults if no saved fog:
    //   - Maps (fogContext === 'map')   → all hidden (Uint8Array fills with 0)
    //   - Images (fogContext === 'show') → all revealed (fill with 255)
    // Rationale: a newly-loaded battle map starts fogged so the GM reveals as
    // exploration progresses. A newly-loaded handout starts fully visible
    // because handouts are usually shown whole; the GM applies fog only when
    // they want to mask part of it.
    const savedFog = loadPerMapFog(img.src, mapWidth * mapHeight);
    if (savedFog) {
      fogMask = savedFog;
    } else {
      fogMask = new Uint8Array(mapWidth * mapHeight);
      if (fogContext === 'show') fogMask.fill(255);
    }
    fogInitialized = true;
    lastInitializedFogSrc = img.src;

    // Ensure at least one preset exists
    ensureDefaultPreset();

    // Add to map library only when editing fog on the projector (maps).
    if (fogContext === 'map') {
      addToMapLibrary(img.src, lastMapName);
    }

    // Reset fog history for the new image
    fogHistory = [new Uint8Array(fogMask)];
    fogHistoryIdx = 0;
    updateUndoRedoButtons();

    // Apply per-image saved crop (zoom + pan) — falls back to defaults if no
    // saved crop exists for this src. This used to be an unconditional
    // resetCrop(), which clobbered the just-restored zoom/pan on every entry
    // to fog mode (including reload, library click, and context switch).
    applySavedCropForSrc(img.src);
    applyCropToSliders();
    // Apply per-image saved background color — leaves the global bg untouched
    // if nothing was saved for this src.
    applySavedBgForSrc(img.src, fogContext === 'show' ? 'show' : 'map');

    const ch = activeFogChannel();
    if (ch) {
      if (fogContext === 'map' && !liveSync) {
        markPendingSync();
      } else {
        ch.postMessage({ type: 'fog-init', imageSrc: img.src, width: mapWidth, height: mapHeight });
        setTimeout(() => {
          forceSyncToMapDisplay();
          if (fogContext === 'map') sendProjectionSettings();
          else sendShowSettings();
        }, 100);
      }
    }

    if (fogContext === 'map') {
      updateMapThumbnail(img.src, lastMapName);
    } else {
      updateShowThumbnail(img.src, lastShowName);
    }
  }

  // Always sync canvas dims to current image and redraw the map. This is cheap
  // and protects against stale dims from a previous fog session in the other
  // context (e.g., switching from a map back to a sidecar handout).
  const fogCanvas = document.getElementById('gm-fog-canvas');
  if (mapCanvas.width !== mapWidth || mapCanvas.height !== mapHeight) {
    mapCanvas.width = mapWidth; mapCanvas.height = mapHeight;
    fogCanvas.width = mapWidth; fogCanvas.height = mapHeight;
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
  setStatus(fogContext === 'show'
    ? 'Editing fog on sidecar handout. R/H = reveal/hide, C = crop. Esc to exit.'
    : 'Fog of War -> Projector. R/H = reveal/hide, C = crop, P = projection/grid');
  saveState();
}

// Entry point: edit fog over the currently-shown sidecar image.
// Always reload from lastShowSrc rather than trusting loadedImage — a
// gm://map/... click can overwrite loadedImage while the user sits on
// image-display, and we'd otherwise end up editing fog for the map.
function startImageFogMode() {
  if (!lastShowSrc) {
    setStatus('Load an image on the sidecar first.');
    return;
  }
  saveCropForCurrentImage();
  setFogContext('show');
  const img = new Image();
  img.onload = () => {
    loadedImage = img;
    fogImage = img;
    mapWidth = img.width;
    mapHeight = img.height;
    applySavedCropForSrc(img.src);
    startFogMode();
    applyCropToSliders();
    updateFogTargetButtons();
  };
  img.onerror = () => setStatus('Failed to load sidecar image: ' + lastShowSrc);
  img.src = lastShowSrc;
}

// Symmetric to startImageFogMode: returns the user to map fog mode after
// they've been in image fog mode. Always reloads the map image fresh rather
// than relying on the stash/restore in setFogContext, which has been a source
// of bugs in the past (loadedImage globals leaking across contexts).
function switchToMapFog() {
  if (!lastMapSrc) {
    setStatus('No map loaded — drop one in or pick from the Maps library.');
    return;
  }
  saveCropForCurrentImage();
  setFogContext('map');
  const img = new Image();
  img.onload = () => {
    loadedImage = img;
    fogImage = img;
    mapWidth = img.width;
    mapHeight = img.height;
    applySavedCropForSrc(img.src);
    startFogMode();
    applyCropToSliders();
    updateFogTargetButtons();
  };
  img.onerror = () => setStatus('Failed to load map: ' + lastMapSrc);
  img.src = lastMapSrc;
}

// Reflects the active fog context on the Map Fog / Image Fog toolbar buttons.
// Call this whenever fogContext changes or after entering fog mode.
function updateFogTargetButtons() {
  const mapBtn = document.getElementById('btn-fog-target-map');
  const showBtn = document.getElementById('btn-fog-target-show');
  if (mapBtn) mapBtn.classList.toggle('active', fogContext === 'map');
  if (showBtn) showBtn.classList.toggle('active', fogContext === 'show');
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
  if (!fogInitialized || !fogImage) return;
  setMainView('fog');

  // Restore map dimensions (image mode may have changed them)
  mapWidth = fogImage.width;
  mapHeight = fogImage.height;

  // Ensure canvases match fog image dimensions and redraw the map
  const mapCanvas = document.getElementById('gm-map-canvas');
  const fogCanvas = document.getElementById('gm-fog-canvas');
  if (mapCanvas.width !== mapWidth || mapCanvas.height !== mapHeight) {
    mapCanvas.width = mapWidth;
    mapCanvas.height = mapHeight;
    fogCanvas.width = mapWidth;
    fogCanvas.height = mapHeight;
  }
  mapCanvas.getContext('2d').drawImage(fogImage, 0, 0);
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
function renderGMImage() {
  if (!loadedImage) return;
  const view = document.getElementById('view-image');
  const wrap = document.getElementById('image-canvas-wrap-gm');
  const rotWrap = document.getElementById('image-rotation-wrap-gm');
  const canvas = document.getElementById('image-canvas-gm');
  const img = document.getElementById('display-image');
  if (!view || !wrap || !canvas || !img) return;

  // Rotation is applied around center to both the rotation wrap (canvas mode)
  // and the img (no-crop, no-fog fallback).
  const rotCss = showRotation ? `rotate(${showRotation}deg)` : '';
  if (rotWrap) rotWrap.style.transform = rotCss || 'none';
  img.style.transform = rotCss;

  const crop = (currentMode === 'image') ? viewportCrop : null;
  const isRot90 = (showRotation === 90 || showRotation === 270);

  // Pull stored sidecar fog for this image (if any).
  const fogData = loadShowFogForSrc(loadedImage.src);
  const hasFog = !!(fogData && fogData.mask && fogData.mask.length);

  // Fast path: no crop and no fog — just show the <img>.
  if (!crop && !hasFog) {
    wrap.style.display = 'none';
    img.style.display = 'block';
    if (img.src !== loadedImage.src) img.src = loadedImage.src;
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

  const srcW = crop ? crop.w : loadedImage.width;
  const srcH = crop ? crop.h : loadedImage.height;
  const srcX = crop ? crop.x : 0;
  const srcY = crop ? crop.y : 0;
  const scale = Math.min(targetW / srcW, targetH / srcH);
  const cW = Math.max(1, Math.floor(srcW * scale));
  const cH = Math.max(1, Math.floor(srcH * scale));

  canvas.width = cW;
  canvas.height = cH;
  const ctx = canvas.getContext('2d');
  const [bgR, bgG, bgB] = parseHexColor(showBg);
  ctx.fillStyle = showBg || '#000';
  ctx.fillRect(0, 0, cW, cH);

  // Draw the cropped (or full) region of the image.
  if (crop) {
    const ol = computeCropOverlap(crop, loadedImage.width, loadedImage.height);
    if (ol) {
      ctx.drawImage(loadedImage,
        ol.srcX, ol.srcY, ol.srcW, ol.srcH,
        ol.dstX * scale, ol.dstY * scale, ol.srcW * scale, ol.srcH * scale);
    }
  } else {
    ctx.drawImage(loadedImage, 0, 0, loadedImage.width, loadedImage.height, 0, 0, cW, cH);
  }

  // Apply the fog mask if dims match the loaded image.
  if (hasFog && fogData.w === loadedImage.width && fogData.h === loadedImage.height) {
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
