// GM Display — keyboard.js
// Keyboard shortcuts.
// Classic script: load order matters (see gm_display.html).
// === Keyboard Shortcuts ===
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  // Undo/Redo: Cmd+Z / Cmd+Shift+Z (Mac) or Ctrl+Z / Ctrl+Shift+Z
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey && currentMode === 'fog') {
    e.preventDefault(); fogUndo(); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey && currentMode === 'fog') {
    e.preventDefault(); fogRedo(); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'y' && currentMode === 'fog') {
    e.preventDefault(); fogRedo(); return;
  }
  if (e.key === 'Escape') goHome();
  if (e.key === 'r') setTool('reveal');
  if (e.key === 'h') setTool('hide');
  if (e.key === 't') toggleTextPanel();
  if (e.key === 'p') toggleProjectionPanel();
  if (e.key === 'c' && (currentMode === 'fog' || currentMode === 'image')) toggleCropPanel();
  if (e.key === '1' && (currentMode === 'fog' || currentMode === 'image')) cropFit();
  if (e.key === '2' && (currentMode === 'fog' || currentMode === 'image')) cropFill();
  if (e.key === 'g' && currentMode === 'fog') toggleGrid();
  if (e.key === 'l' && currentMode === 'fog') toggleLiveSync();
  if (e.key === 's' && currentMode === 'fog' && !liveSync) syncNow();
  if (e.key === 'q' && (currentMode === 'fog' || currentMode === 'image')) { rotateBy(-90); }
  if (e.key === 'e' && (currentMode === 'fog' || currentMode === 'image')) { rotateBy(90); }
  if (e.key === '[') { brushSize = Math.max(5, brushSize-10); const el=document.getElementById('brush-size'); if(el) el.value=brushSize; updateBrushPreview(); }
  if (e.key === ']') { brushSize = Math.min(200, brushSize+10); const el=document.getElementById('brush-size'); if(el) el.value=brushSize; updateBrushPreview(); }
});

window.addEventListener('resize', () => {
  if (isPlayerView && playerChannel) {
    playerChannel.postMessage({
      type: 'request-sync',
      screenW: window.innerWidth,
      screenH: window.innerHeight
    });
  } else if (currentMode === 'image') {
    // Re-render the GM mirror so it fits the new viewport size (e.g., after
    // collapsing/resizing the sidebar).
    renderGMImage();
  }
});

function setStatus(msg) { const el = document.getElementById('status-left'); if (el) el.textContent = msg; }

// ===================================================================
