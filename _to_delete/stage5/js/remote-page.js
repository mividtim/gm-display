// GM Display — remote-page.js
// The remote player page.
import { rlDecode } from './games.js';
import { REMOTE_COLORS, TOKEN_FRAC, clamp01, drawMapGrid, kTokenDiam, snapNorm, tokenDisplayName, uid } from './geometry.js';
import { drawAllMarkers, ensureMarkerLoop } from './markers.js';
import { slugify } from './state.js';
import { S } from './store.js';
import { applyGridWire, initialsOf } from './tokens.js';
// ===================================================================
// REMOTE PLAYER PAGE  (remote.html)
// ===================================================================
export function setupRemoteView() {
  S.isRemoteView = true;
  // remote.html carries only the remote markup, so the GM shell is simply
  // absent; on the legacy ?mode=remote URL it is present and has to be hidden.
  const app = document.getElementById('app'); if (app) app.style.display = 'none';
  const sb = document.getElementById('status-bar'); if (sb) sb.style.display = 'none';
  const rv = document.getElementById('remote-view'); if (rv) rv.style.display = 'block';
  // Prefill the player's name + color from last time (remembered per device).
  const savedName = localStorage.getItem('gm-display:remote:name');
  if (savedName) document.getElementById('remote-name').value = savedName;
  const savedColor = localStorage.getItem('gm-display:remote:color');
  if (savedColor) S.remotePlayerColor = savedColor;
  renderColorSwatches();
  attachRemoteMarkerHandlers();
  window.addEventListener('resize', () => { if (S.remoteScreen === 'play') remoteRelayout(); });
  // Poll from the start so the roster fills in (and stays current) on the
  // selection screen, then keeps the map live once a character is chosen.
  setInterval(remoteSyncTick, 300);
  remoteSyncTick();
}

function renderColorSwatches() {
  const wrap = document.getElementById('remote-color-swatches');
  if (!wrap) return;
  wrap.innerHTML = '';
  REMOTE_COLORS.forEach(col => {
    const s = document.createElement('div');
    s.className = 'color-swatch' + (col === S.remotePlayerColor ? ' selected' : '');
    s.style.background = col;
    s.onclick = () => {
      S.remotePlayerColor = col;
      renderColorSwatches();
      const dot = document.getElementById('remote-color-dot'); if (dot) dot.style.background = col;
    };
    wrap.appendChild(s);
  });
}

// Pick a character profile (+ the chosen color) and enter the play screen.
function selectCharacter(t) {
  const savedName = localStorage.getItem('gm-display:remote:name');
  if (t.owner && t.owner !== savedName && t.id !== S.remoteClaimId) return; // someone else's
  const nameEl = document.getElementById('remote-name');
  const name = (nameEl.value || '').trim();
  if (!name) { nameEl.focus(); nameEl.style.borderColor = '#c0392b'; return; }
  enterPlayWith(t, name, S.remotePlayerColor);
}

// Shared "join the map controlling token t" used by manual select and by the
// auto-restore after a page refresh.
function enterPlayWith(t, name, color) {
  S.myActorName = name;
  S.myActorId = 'pl-' + slugify(name);
  S.remotePlayerColor = color;
  S.remoteClaimId = t.id;
  // Remember everything so a refresh drops us straight back in.
  localStorage.setItem('gm-display:remote:name', name);
  localStorage.setItem('gm-display:remote:color', color);
  localStorage.setItem('gm-display:remote:claim', t.id);
  S._remoteRestoreDone = true;
  sendAction({ kind: 'claim', tokenId: t.id, player: name, color: color });
  S.remoteScreen = 'play';
  document.getElementById('remote-select').style.display = 'none';
  document.getElementById('remote-stage').style.display = 'flex';
  document.getElementById('remote-bar').style.display = 'flex';
  document.getElementById('remote-who').textContent = name;
  const dot = document.getElementById('remote-color-dot'); if (dot) dot.style.background = color;
  // Render after the stage is laid out so the canvas has real dimensions.
  requestAnimationFrame(() => { renderRemoteFrame(); renderRemoteTokens(); });
}

// After a refresh the player lands on the roster; if they still hold their
// token (per the server), put them straight back on the map. Runs once.
function attemptRemoteRestore() {
  if (S._remoteRestoreDone || S.remoteScreen === 'play') return;
  const savedName = localStorage.getItem('gm-display:remote:name');
  const savedClaim = localStorage.getItem('gm-display:remote:claim');
  const savedColor = localStorage.getItem('gm-display:remote:color') || S.remotePlayerColor;
  if (!savedName || !savedClaim) return;
  const t = S.tokens.find(x => x.id === savedClaim);
  if (!t) return;                                  // token gone — keep trying until it loads
  if (t.owner && t.owner !== savedName) { S._remoteRestoreDone = true; return; } // taken by another
  enterPlayWith(t, savedName, savedColor);
}

export function remoteChangeCharacter() {
  if (S.remoteClaimId) sendAction({ kind: 'release', tokenId: S.remoteClaimId, player: S.myActorName });
  S.remoteClaimId = null;
  // Intentional change: forget the saved claim so a later refresh stays on the roster.
  localStorage.removeItem('gm-display:remote:claim');
  S.remoteScreen = 'select';
  S.remoteMarkerMode = false;
  document.getElementById('remote-marker-btn').classList.remove('active');
  document.getElementById('remote-stage').style.display = 'none';
  document.getElementById('remote-bar').style.display = 'none';
  document.getElementById('remote-select').style.display = 'flex';
  renderColorSwatches();
  renderRemoteRoster();
}

// The selection screen: one big card per character (portrait + name).
function renderRemoteRoster() {
  const wrap = document.getElementById('remote-roster');
  if (!wrap) return;
  // Players only choose from player characters; NPCs are never claimable.
  const pcs = S.tokens.filter(t => t.side === 'pc');
  if (!pcs.length) { wrap.innerHTML = '<div class="remote-empty">No characters yet — the GM hasn\'t added any.</div>'; return; }
  wrap.innerHTML = '';
  const savedName = localStorage.getItem('gm-display:remote:name');
  pcs.forEach(t => {
    const mine = !!t.owner && t.owner === savedName;       // your own (after a refresh)
    const taken = !!t.owner && !mine;                      // someone else's
    const card = document.createElement('div');
    card.className = 'remote-card ' + (t.side === 'pc' ? 'pc' : 'npc') + (taken ? ' taken' : '');
    const por = document.createElement('div');
    por.className = 'rc-portrait';
    if (t.img) por.style.backgroundImage = 'url("' + t.img + '")';
    else { por.style.background = t.color; por.textContent = initialsOf(t.base); }
    if (t.ownerColor && t.owner) por.style.borderColor = t.ownerColor;
    const name = document.createElement('div');
    name.className = 'rc-name'; name.textContent = tokenDisplayName(t);
    const status = document.createElement('div');
    status.className = 'rc-status';
    status.textContent = mine ? 'You — tap to resume' : (taken ? ('Taken by ' + t.owner) : 'Available');
    card.append(por, name, status);
    if (!taken) card.onclick = () => selectCharacter(t);
    wrap.appendChild(card);
  });
}

export function remoteToggleMarker() {
  S.remoteMarkerMode = !S.remoteMarkerMode;
  document.getElementById('remote-marker-btn').classList.toggle('active', S.remoteMarkerMode);
}
function remoteSyncTick() {
  fetch('/api/sync').then(r => r.json()).then(s => {
    // markers from everyone else
    (s.markers || []).forEach(m => { if (m.by !== S.myActorName) S.activeMarkers[m.id] = { ...m, t: Date.now() }; });
    ensureMarkerLoop();
    if (s.tokensVersion !== S.remoteTokVer) {
      S.remoteTokVer = s.tokensVersion;
      const doc = s.tokens || {};
      S.tokens = doc.tokens || [];
      if (doc.grid) applyGridWire(doc.grid);
      attemptRemoteRestore();
      if (S.remoteScreen === 'select') renderRemoteRoster();
      else renderRemoteTokens();
    }
    if (s.frameVersion !== S.remoteFrameVer) {
      S.remoteFrameVer = s.frameVersion;
      fetch('/api/player_state').then(r => r.json()).then(ps => {
        S.remoteFrame = ps.payload; if (S.remoteScreen === 'play') renderRemoteFrame();
      }).catch(() => {});
    }
  }).catch(() => {});
}
// The remote view mirrors the GM's current crop (pan/zoom). Everything is
// computed in MAP pixels, so the grid hexes/squares stay fixed on the map and
// tokens remain snapped as the GM pans and zooms.
export function remoteMapToCanvas(mx, my) {
  return { x: (mx - S.remoteCrop.x) * S.remoteScale, y: (my - S.remoteCrop.y) * S.remoteScale };
}
function layoutRemote() {
  const stage = document.getElementById('remote-stage');
  if (!stage || !S.remoteFrame) return;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const mw = S.remoteFrame.width, mh = S.remoteFrame.height;
  const crop = S.remoteFrame.crop || { x: 0, y: 0, w: mw, h: mh };
  S.remoteCrop = crop;
  S.remoteScale = Math.min(sw / crop.w, sh / crop.h);
  S.remoteFit = { w: Math.max(1, Math.round(crop.w * S.remoteScale)), h: Math.max(1, Math.round(crop.h * S.remoteScale)) };
  ['remote-canvas', 'remote-grid-canvas', 'remote-marker-canvas'].forEach(id => {
    const c = document.getElementById(id);
    c.width = S.remoteFit.w; c.height = S.remoteFit.h;
    c.style.width = S.remoteFit.w + 'px'; c.style.height = S.remoteFit.h + 'px';
  });
  const layer = document.getElementById('remote-token-layer');
  layer.style.width = S.remoteFit.w + 'px'; layer.style.height = S.remoteFit.h + 'px';
}
function renderRemoteFrame() {
  if (!S.remoteFrame) return;
  layoutRemote();
  const img = new Image();
  img.onload = () => { S.remoteImg = img; paintRemoteFog(img); renderRemoteTokens(); drawAllMarkers(); };
  img.src = S.remoteFrame.imageSrc;
}
// Repaint after a resize without re-fetching the image.
function remoteRelayout() {
  layoutRemote();
  if (S.remoteImg) paintRemoteFog(S.remoteImg);
  renderRemoteTokens();
  drawAllMarkers();
}
function paintRemoteFog(img) {
  if (!S.remoteFit) layoutRemote();
  const c = document.getElementById('remote-canvas');
  const ctx = c.getContext('2d');
  const W = S.remoteFit.w, H = S.remoteFit.h;
  const mw = S.remoteFrame.width, mh = S.remoteFrame.height;
  const crop = S.remoteCrop, scale = S.remoteScale;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  // Draw only the cropped region of the map (the part outside the map stays black).
  const sx = Math.max(0, crop.x), sy = Math.max(0, crop.y);
  const ex = Math.min(mw, crop.x + crop.w), ey = Math.min(mh, crop.y + crop.h);
  if (ex > sx && ey > sy) {
    ctx.drawImage(img, sx, sy, ex - sx, ey - sy,
      (sx - crop.x) * scale, (sy - crop.y) * scale, (ex - sx) * scale, (ey - sy) * scale);
  }
  // Fog: hidden cells -> solid black (players never see unrevealed art).
  // Guarded so a (hypothetical) tainted canvas can't also kill the grid below.
  const fog = S.remoteFrame.fogRLE ? rlDecode(S.remoteFrame.fogRLE, mw * mh) : null;
  if (fog) {
    try {
      const id = ctx.getImageData(0, 0, W, H);
      const px = id.data;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const mx = Math.floor(crop.x + x / scale), my = Math.floor(crop.y + y / scale);
          let black = false;
          if (mx < 0 || mx >= mw || my < 0 || my >= mh) black = true;
          else if (fog[my * mw + mx] === 0) black = true;
          if (black) { const i = (y * W + x) * 4; px[i] = px[i + 1] = px[i + 2] = 0; px[i + 3] = 255; }
        }
      }
      ctx.putImageData(id, 0, 0);
    } catch (e) { console.warn('fog apply failed', e); }
  }
  // Grid over fog (so players can place tokens in the dark), locked to the map.
  const gc = document.getElementById('remote-grid-canvas');
  const gx = gc.getContext('2d'); gx.clearRect(0, 0, W, H);
  drawMapGrid(gx, remoteMapToCanvas, mw, mh, S.tokenGridColor);
}
function renderRemoteTokens() {
  const layer = document.getElementById('remote-token-layer');
  if (!layer || !S.remoteFrame || !S.remoteCrop) return;
  layer.innerHTML = '';
  const mw = S.remoteFrame.width;
  const diamPx = kTokenDiam(mw) * S.remoteScale * TOKEN_FRAC;
  const mine = S.tokens.find(t => t.id === S.remoteClaimId);
  document.getElementById('remote-token-info').textContent =
    mine ? ('Playing ' + tokenDisplayName(mine) + ' — drag to move') : '';
  // Draw only tokens the GM has made visible on this map (onMap is per-map).
  S.tokens.filter(t => t.onMap).forEach(t => {
    const canControl = (t.id === S.remoteClaimId);
    layer.appendChild(makeRemoteTokenEl(t, t.tx, t.ty, diamPx, false, canControl));
    if (t.pending) layer.appendChild(makeRemoteTokenEl(t, t.pending.tx, t.pending.ty, diamPx, true, false));
  });
}
function makeRemoteTokenEl(t, tx, ty, diamPx, isGhost, canControl) {
  const el = document.createElement('div');
  el.className = 'token ' + (t.side === 'pc' ? 'pc' : 'npc') + (isGhost ? ' ghost' : '') + (canControl ? ' draggable' : '');
  const mw = S.remoteFrame.width, mh = S.remoteFrame.height;
  const p = remoteMapToCanvas(tx * mw, ty * mh);
  el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
  el.style.width = diamPx + 'px'; el.style.height = diamPx + 'px';
  if (t.img) el.style.backgroundImage = 'url("' + t.img + '")';
  else { el.style.background = t.color; el.textContent = initialsOf(t.base); }
  if (!isGhost && t.ownerColor) el.style.borderColor = t.ownerColor;
  const lab = document.createElement('span'); lab.className = 'tok-label'; lab.textContent = tokenDisplayName(t);
  el.appendChild(lab);
  if (t.num > 0) { const n = document.createElement('span'); n.className = 'tok-num'; n.textContent = t.num; el.appendChild(n); }
  if (canControl && !isGhost) attachRemoteTokenDrag(el, t);
  return el;
}
function attachRemoteTokenDrag(el, t) {
  el.addEventListener('pointerdown', (e) => {
    if (S.remoteMarkerMode) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const layer = document.getElementById('remote-token-layer');
    const box = layer.getBoundingClientRect();
    const mw = S.remoteFrame.width, mh = S.remoteFrame.height;
    let last = { tx: t.tx, ty: t.ty };
    const move = (ev) => {
      const mx = S.remoteCrop.x + (ev.clientX - box.left) / S.remoteScale;
      const my = S.remoteCrop.y + (ev.clientY - box.top) / S.remoteScale;
      last.tx = clamp01(mx / mw); last.ty = clamp01(my / mh);
      const s = snapNorm(last.tx, last.ty);
      const p = remoteMapToCanvas(s.tx * mw, s.ty * mh);
      el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
    };
    const up = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
      const s = snapNorm(last.tx, last.ty);
      sendAction({ kind: 'propose', tokenId: t.id, player: S.myActorName, tx: s.tx, ty: s.ty });
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  });
}
function sendAction(a) { fetch('/api/action', { method: 'POST', body: JSON.stringify(a) }).catch(() => {}); }

function attachRemoteMarkerHandlers() {
  const stage = document.getElementById('remote-stage');
  if (!stage) return;
  const box = () => document.getElementById('remote-marker-canvas').getBoundingClientRect();
  stage.addEventListener('pointerdown', (e) => {
    if (!S.remoteMarkerMode) return;
    const b = box();
    S._markerStroke = { id: uid('m'), by: S.myActorName, color: S.remotePlayerColor, points: [] };
    remoteAddMarkerPoint(e, b);
  });
  stage.addEventListener('pointermove', (e) => { if (S._markerStroke && S.remoteMarkerMode) remoteAddMarkerPoint(e, box()); });
  const end = () => { S._markerStroke = null; };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointerleave', end);
}
function remoteAddMarkerPoint(e, box) {
  // Markers are stored in map-normalized coords so they line up on every surface.
  const mw = S.remoteFrame.width, mh = S.remoteFrame.height;
  const mx = S.remoteCrop.x + (e.clientX - box.left) / S.remoteScale;
  const my = S.remoteCrop.y + (e.clientY - box.top) / S.remoteScale;
  const tx = clamp01(mx / mw), ty = clamp01(my / mh);
  S._markerStroke.points.push([tx, ty]);
  S.activeMarkers[S._markerStroke.id] = { ...(S._markerStroke), t: Date.now() };
  fetch('/api/marker', { method: 'POST', body: JSON.stringify(S._markerStroke) }).catch(() => {});
  ensureMarkerLoop();
}

// init() is called by main.js once every module has evaluated.
