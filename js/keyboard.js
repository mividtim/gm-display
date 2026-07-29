// GM Display — keyboard.js
// Keyboard shortcuts.
// Classic script: load order matters (see gm_display.html).
// === Keyboard Shortcuts ===
import { closeNotePop, notePopOpen } from './cell-notes.js';
import { cropFill, cropFit, toggleCropPanel, toggleProjectionPanel, toggleTextPanel } from './crop.js';
import { syncNow, toggleLiveSync, updateBrushPreview } from './fog-presets.js';
import { renderGMImage } from './fog.js';
import { goHome } from './navigation.js';
import { rotateBy, toggleGrid } from './projection.js';
import { fogRedo, fogUndo } from './sidebar.js';
import { S } from './store.js';
import { setActiveTool } from './tools.js';
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  // Undo/Redo: Cmd+Z / Cmd+Shift+Z (Mac) or Ctrl+Z / Ctrl+Shift+Z
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey && S.currentMode === 'fog') {
    e.preventDefault(); fogUndo(); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey && S.currentMode === 'fog') {
    e.preventDefault(); fogRedo(); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'y' && S.currentMode === 'fog') {
    e.preventDefault(); fogRedo(); return;
  }
  // Escape gets you out of whatever you are in, one step at a time: close an
  // open note, then drop to the None tool, and only then leave the map.
  if (e.key === 'Escape') {
    if (notePopOpen()) { closeNotePop(); return; }
    if (S.activeTool !== 'none') { setActiveTool('none'); return; }
    goHome();
    return;
  }
  if (e.key === 't') toggleTextPanel();
  if (e.key === 'p') toggleProjectionPanel();
  if (e.key === 'c' && (S.currentMode === 'fog' || S.currentMode === 'image')) toggleCropPanel();
  if (e.key === '1' && (S.currentMode === 'fog' || S.currentMode === 'image')) cropFit();
  if (e.key === '2' && (S.currentMode === 'fog' || S.currentMode === 'image')) cropFill();
  if (e.key === 'g' && S.currentMode === 'fog') toggleGrid();
  if (e.key === 'l' && S.currentMode === 'fog') toggleLiveSync();
  if (e.key === 's' && S.currentMode === 'fog' && !S.liveSync) syncNow();
  if (e.key === 'q' && (S.currentMode === 'fog' || S.currentMode === 'image')) { rotateBy(-90); }
  if (e.key === 'e' && (S.currentMode === 'fog' || S.currentMode === 'image')) { rotateBy(90); }
  if (e.key === '[') { S.brushSize = Math.max(5, S.brushSize-10); const el=document.getElementById('brush-size'); if(el) el.value=S.brushSize; updateBrushPreview(); }
  if (e.key === ']') { S.brushSize = Math.min(200, S.brushSize+10); const el=document.getElementById('brush-size'); if(el) el.value=S.brushSize; updateBrushPreview(); }
});

window.addEventListener('resize', () => {
  if (S.isPlayerView && S.playerChannel) {
    S.playerChannel.postMessage({
      type: 'request-sync',
      screenW: window.innerWidth,
      screenH: window.innerHeight
    });
  } else if (S.currentMode === 'image') {
    // Re-render the GM mirror so it fits the new viewport size (e.g., after
    // collapsing/resizing the sidebar).
    renderGMImage();
  }
});

export function setStatus(msg) { const el = document.getElementById('status-left'); if (el) el.textContent = msg; }

// ===================================================================
