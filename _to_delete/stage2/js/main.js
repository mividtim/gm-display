// GM Display — main.js
// Entry point. Imports every module, publishes the compatibility surface that
// the markup and the test harness still reach by bare name, then boots.
//
// Those window bindings exist for exactly two reasons: the 107 inline
// onclick/oninput attributes in gm_display.html, and tests/regress.py, which
// probes internals by name. Both go away in the next stage, and this block with
// them — no application module depends on a global any more.

import { S } from './store.js';
import { campaignKey, ensurePathfinderSocietyModules, gameKey, loadCampaignsIndex, loadGamesIndex, migrateLegacyKeysToDefault, modulesInCampaign, saveCampaignsIndex, saveGamesIndex, slugify } from './state.js';
import { deleteActiveGame, loadShowFogForSrc, moveModulePrompt, newCampaignPrompt, newGamePrompt, onCampaignSelectChange, onGameSelectChange, renameActiveGame, renderCampaignSelector, renderGameSelector, restoreState, rlDecode, rlEncode, saveState, sendShowContent } from './games.js';
import { activeFogChannel, addArtFromVault, addToImageLibrary, addToMapLibrary, applySavedBgForSrc, applySavedCropForSrc, fogStoragePrefix, initArtUploadInput, loadImageLibrary, loadMapLibrary, loadPerMapFog, refreshArtVaultOptions, renderImageLibrary, renderMapLibrary, saveBgForSrc, saveCropForCurrentImage, savePerMapFog, setFogContext } from './per-map-store.js';
import { init, openDisplay, updateMapThumbnail, updateShowThumbnail } from './init.js';
import { renderGMImage, startFogMode, startImageFogMode, startImageMode, switchToMapFog } from './fog.js';
import { attachFogCanvasHandlers, fitCanvasToView, fogRedo, fogUndo, hideAll, initImageNameRename, initSidebarResize, renderGMFog, revealAll, toggleSidebarCollapsed, updateUndoRedoButtons } from './sidebar.js';
import { copyPreset, ensureDefaultPreset, forceSyncToMapDisplay, markPendingSync, newPreset, renderPresetThumbnails, setTool, syncNow, syncToMapDisplay, toggleLiveSync, updateBrushPreview } from './fog-presets.js';
import { activeBg, initCornerDrag, initPanDrag, nudgeCorner, resetCorner, resetProjection, rotateBy, sendProjectionSettings, sendShowSettings, setBg, setGridColor, setRotation, toggleGrid, toggleTestPattern, updateBgUI, updateGridOpacity, updateGridSize, updateRotationUI, updateScale } from './projection.js';
import { applyCropToSliders, computeViewportCrop, cropFill, cropFit, hideTextOnPlayer, sendCropUpdate, setZoomPercent, showTextOnPlayer, toggleCropPanel, toggleProjectionPanel, toggleTextPanel, updateCrop, updateViewportOutline, zoomBy } from './crop.js';
import { goHome, parseHexColor, setMainView, setupPlayerChannel } from './navigation.js';
import { applyProjectionTransform, computeCropOverlap, drawGrid, renderPlayerFogDoubleBuffered, renderPlayerImage, renderTestPattern } from './player-view.js';
import { setStatus } from './keyboard.js';
import { addRosterTokenFromSelect, applyPlayerAction, approveMove, broadcastTokens, cellAtMapPx, cellCenterMapPx, createTokenFromForm, drawAllMarkers, drawProjectorOverlay, duplicateToken, gridWirePayload, initTokensGM, kStepX, kStepY, loadTokens, mapKeyStorageKey, mapTokensKey, nudgeKeyCell, nudgeKeyCellY, nudgeKeyOrigin, projectorHandleMessage, pushPlayerStateToServer, pushTokensToServer, refreshTokenImageOptions, relMapSrc, remoteChangeCharacter, remoteToggleMarker, renderGMTokens, renderTokenList, resetMapKey, setKeyAcross, setKeyCell, setKeyCellY, setKeyOx, setKeyOy, setKeyShape, setTokenGridColor, setTokenMap, setupRemoteView, snapNorm, toggleKeyLink, toggleMarkerMode, toggleTokenGrid, tokenDisplayName } from './tokens.js';

const PUBLIC = { S, activeBg, activeFogChannel, addArtFromVault, addRosterTokenFromSelect, addToImageLibrary, addToMapLibrary, applyCropToSliders, applyPlayerAction, applyProjectionTransform, applySavedBgForSrc, applySavedCropForSrc, approveMove, attachFogCanvasHandlers, broadcastTokens, campaignKey, cellAtMapPx, cellCenterMapPx, computeCropOverlap, computeViewportCrop, copyPreset, createTokenFromForm, cropFill, cropFit, deleteActiveGame, drawAllMarkers, drawGrid, drawProjectorOverlay, duplicateToken, ensureDefaultPreset, ensurePathfinderSocietyModules, fitCanvasToView, fogRedo, fogStoragePrefix, fogUndo, forceSyncToMapDisplay, gameKey, goHome, gridWirePayload, hideAll, hideTextOnPlayer, init, initArtUploadInput, initCornerDrag, initImageNameRename, initPanDrag, initSidebarResize, initTokensGM, kStepX, kStepY, loadCampaignsIndex, loadGamesIndex, loadImageLibrary, loadMapLibrary, loadPerMapFog, loadShowFogForSrc, loadTokens, mapKeyStorageKey, mapTokensKey, markPendingSync, migrateLegacyKeysToDefault, modulesInCampaign, moveModulePrompt, newCampaignPrompt, newGamePrompt, newPreset, nudgeCorner, nudgeKeyCell, nudgeKeyCellY, nudgeKeyOrigin, onCampaignSelectChange, onGameSelectChange, openDisplay, parseHexColor, projectorHandleMessage, pushPlayerStateToServer, pushTokensToServer, refreshArtVaultOptions, refreshTokenImageOptions, relMapSrc, remoteChangeCharacter, remoteToggleMarker, renameActiveGame, renderCampaignSelector, renderGMFog, renderGMImage, renderGMTokens, renderGameSelector, renderImageLibrary, renderMapLibrary, renderPlayerFogDoubleBuffered, renderPlayerImage, renderPresetThumbnails, renderTestPattern, renderTokenList, resetCorner, resetMapKey, resetProjection, restoreState, revealAll, rlDecode, rlEncode, rotateBy, saveBgForSrc, saveCampaignsIndex, saveCropForCurrentImage, saveGamesIndex, savePerMapFog, saveState, sendCropUpdate, sendProjectionSettings, sendShowContent, sendShowSettings, setBg, setFogContext, setGridColor, setKeyAcross, setKeyCell, setKeyCellY, setKeyOx, setKeyOy, setKeyShape, setMainView, setRotation, setStatus, setTokenGridColor, setTokenMap, setTool, setZoomPercent, setupPlayerChannel, setupRemoteView, showTextOnPlayer, slugify, snapNorm, startFogMode, startImageFogMode, startImageMode, switchToMapFog, syncNow, syncToMapDisplay, toggleCropPanel, toggleGrid, toggleKeyLink, toggleLiveSync, toggleMarkerMode, toggleProjectionPanel, toggleSidebarCollapsed, toggleTestPattern, toggleTextPanel, toggleTokenGrid, tokenDisplayName, updateBgUI, updateBrushPreview, updateCrop, updateGridOpacity, updateGridSize, updateMapThumbnail, updateRotationUI, updateScale, updateShowThumbnail, updateUndoRedoButtons, updateViewportOutline, zoomBy };
window.GMD = PUBLIC;
Object.assign(window, PUBLIC);

// Shared state is an object now, but markup and harness still say `mapWidth`
// rather than `S.mapWidth`, so proxy each key across.
for (const k of Object.keys(S)) {
  if (k in window) continue;
  Object.defineProperty(window, k, { get: () => S[k], set: (v) => { S[k] = v; }, configurable: true });
}

init();
