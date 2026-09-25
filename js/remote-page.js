// GM Display — remote-page.js
// The remote player page.
import { rlDecode } from './games.js';
import { REMOTE_COLORS, TOKEN_FRAC, cellAtMapPx, cellCenterMapPx, cellFromLabel, cellLabel, clamp01, drawMapGrid, isParty, kTokenDiam, snapNorm, tokenClass, tokenDisplayName, tokenFrac, uid } from './geometry.js';
import { legendCount, legendHTML, onLegendChanged, setLegendMap, startLegendPolling } from './legend.js';
import { drawAllMarkers, ensureMarkerLoop } from './markers.js';
import { addPartyNote, editPartyNote, onPartyNotesChanged, partyLogHTML, partyNotes, partyNotesFor, removePartyNote, setPartyNotesMap, startPartyNotesPolling } from './party-notes.js';
import { slugify } from './state.js';
import { boardDoc, mountBoard, onBoard, startBoardSync } from './board.js';
import { S } from './store.js';
import { applyGridWire, initialsOf, tokenFillOpacity } from './tokens.js';
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
  attachRemoteNoteHandler();
  attachRemoteHover();
  attachJoinHandlers();
  if (S.previewMode) { enterPreview(); }
  // A refresh while waiting should still be waiting, not back at square one.
  if (localStorage.getItem(JOIN_ID_KEY)) { showWaiting(''); startJoinPolling(); }
  startPartyNotesPolling(4000);
  onPartyNotesChanged(() => { drawRemoteNotePips(); renderRemoteNotePanel(); renderRemoteLog(); });
  startLegendPolling(6000);
  onLegendChanged(() => renderRemoteLegend());
  window.addEventListener('resize', () => { if (S.remoteScreen === 'play') remoteRelayout(); });
  // The bulletin board syncs from the start, so the Board button can say
  // "something new was pinned" while the player is still on the map.
  startBoardSync();
  onBoard(updateBoardBadge);
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

// --- Asking to be let in ---------------------------------------------------
// A player used to be stuck until the GM had typed their name into a token.
// Now they introduce themselves. Everything they submit — the character, and
// the portrait above all — waits in the GM's queue: it is not on the table, not
// on the projector, and not on any other player's screen until it is let in.
// The server holds a pending portrait in memory and never gives it a URL, so
// "waiting" is a fact about where the bytes are, not a disabled button.
let joinPortrait = '';       // data URL the player picked, not yet sent
let joinPollTimer = null;

const JOIN_ID_KEY = 'gm-display:remote:join';
const el = (id) => document.getElementById(id);

function setJoinStatus(t, bad) {
  const s = el('remote-join-status');
  if (!s) return;
  s.textContent = t || '';
  s.classList.toggle('bad', !!bad);
}

function attachJoinHandlers() {
  const pick = el('remote-portrait-btn'), file = el('remote-portrait');
  if (pick && file && !pick._wired) {
    pick._wired = true;
    pick.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      // Say no here rather than after the upload: the server caps this too,
      // but a phone photo is often over it and a local answer is instant.
      if (f.size > 2 * 1024 * 1024) {
        setJoinStatus('That portrait is over 2MB — pick a smaller one.', true);
        file.value = ''; joinPortrait = '';
        el('remote-portrait-name').textContent = '';
        return;
      }
      const r = new FileReader();
      r.onload = () => {
        joinPortrait = r.result;
        el('remote-portrait-name').textContent = f.name;
        setJoinStatus('The GM sees your portrait before anyone else does.');
      };
      r.readAsDataURL(f);
    });
  }
  const btn = el('remote-join-btn');
  if (btn && !btn._wired) { btn._wired = true; btn.addEventListener('click', askToJoin); }
}

async function askToJoin() {
  const nameEl = el('remote-name'), charEl = el('remote-character');
  const name = (nameEl.value || '').trim();
  const character = (charEl.value || '').trim();
  if (!name) { nameEl.focus(); nameEl.style.borderColor = '#c0392b'; return; }
  if (!character) { charEl.focus(); charEl.style.borderColor = '#c0392b'; return; }
  setJoinStatus('asking…');
  try {
    const r = await fetch('/api/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, character, color: S.remotePlayerColor, img: joinPortrait }),
    });
    const d = await r.json();
    if (!r.ok) { setJoinStatus(d.error || 'could not ask just now', true); return; }
    localStorage.setItem('gm-display:remote:name', name);
    localStorage.setItem('gm-display:remote:color', S.remotePlayerColor);
    localStorage.setItem(JOIN_ID_KEY, d.id);
    showWaiting(character);
    startJoinPolling();
  } catch (e) {
    setJoinStatus('could not reach the GM’s server', true);
  }
}

function showWaiting(character) {
  const box = el('remote-new');
  if (box) box.classList.add('waiting');
  ['remote-character', 'remote-portrait-btn', 'remote-join-btn']
    .forEach(id => { const e2 = el(id); if (e2) e2.disabled = true; });
  setJoinStatus('Waiting for the GM to let ' + (character || 'you') + ' in…');
}

function clearWaiting() {
  const box = el('remote-new');
  if (box) box.classList.remove('waiting');
  ['remote-character', 'remote-portrait-btn', 'remote-join-btn']
    .forEach(id => { const e2 = el(id); if (e2) e2.disabled = false; });
}

export function startJoinPolling() {
  clearInterval(joinPollTimer);
  joinPollTimer = setInterval(checkJoinStatus, 2000);
  checkJoinStatus();
}

async function checkJoinStatus() {
  const id = localStorage.getItem(JOIN_ID_KEY);
  if (!id || S.remoteScreen === 'play') { clearInterval(joinPollTimer); return; }
  let state = 'unknown';
  try {
    const r = await fetch('/api/join_status?id=' + encodeURIComponent(id), { cache: 'no-store' });
    state = (await r.json()).state;
  } catch (e) { return; }            // server down; keep waiting rather than lie
  if (state === 'pending') return;
  if (state === 'rejected') {
    clearInterval(joinPollTimer);
    localStorage.removeItem(JOIN_ID_KEY);
    clearWaiting();
    setJoinStatus('The GM did not let that one in. You can change it and ask again.', true);
    return;
  }
  if (state === 'approved') {
    // The token exists now; the next sync tick brings it. Wait for it rather
    // than guessing, then walk in through the same door as a manual claim.
    const myName = localStorage.getItem('gm-display:remote:name') || '';
    const t = S.tokens.find(x => x.owner && x.owner === myName);
    if (!t) { setJoinStatus('You’re in — fetching your character…'); return; }
    clearInterval(joinPollTimer);
    localStorage.removeItem(JOIN_ID_KEY);
    clearWaiting();
    setJoinStatus('');
    enterPlayWith(t, myName, localStorage.getItem('gm-display:remote:color') || S.remotePlayerColor);
    return;
  }
  // 'unknown' — the server restarted and forgot. Let them ask again.
  clearInterval(joinPollTimer);
  localStorage.removeItem(JOIN_ID_KEY);
  clearWaiting();
  setJoinStatus('');
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
  setRemoteTool(savedTool());
}

// The GM's way onto the play screen: no name, no claim, no proposal queue.
// Everything they drag here commits, because the server already established
// that this request came from the machine the roster lives on.
function enterAsGM() {
  S.myActorName = 'GM';
  S.myActorId = 'gm-remote';
  S.remoteClaimId = null;
  S.remoteScreen = 'play';
  document.getElementById('remote-select').style.display = 'none';
  document.getElementById('remote-stage').style.display = 'flex';
  document.getElementById('remote-bar').style.display = 'flex';
  document.getElementById('remote-who').textContent = 'GM';
  const dot = document.getElementById('remote-color-dot');
  if (dot) dot.style.background = S.markerColor || '#ffcf5c';
  requestAnimationFrame(() => { renderRemoteFrame(); renderRemoteTokens(); });
  setRemoteTool(savedTool());
}

// --- Map | Board ------------------------------------------------------------
// The map is one tool among several now. The other is the campaign's bulletin
// board: every handout the GM has shared, from any module, pinned on one
// corkboard that the whole table works together.
let board = null;
const TOOL_KEY = 'gm-display:remote:tool';
const SEEN_KEY = 'gm-display:remote:board-seen';
function savedTool() { try { return localStorage.getItem(TOOL_KEY) === 'board' ? 'board' : 'map'; } catch (e) { return 'map'; } }

function claimedCharacter() {
  const t = S.tokens.find(x => x.id === S.remoteClaimId);
  return t ? tokenDisplayName(t) : '';
}

export function setRemoteTool(tool) {
  const onBoardTool = tool === 'board';
  try { localStorage.setItem(TOOL_KEY, onBoardTool ? 'board' : 'map'); } catch (e) {}
  const rv = document.getElementById('remote-view');
  if (rv) rv.classList.toggle('board-mode', onBoardTool);
  const bm = document.getElementById('remote-tool-map'), bb = document.getElementById('remote-tool-board');
  if (bm) bm.classList.toggle('on', !onBoardTool);
  if (bb) bb.classList.toggle('on', onBoardTool);
  const host = document.getElementById('remote-board');
  if (onBoardTool) {
    // Map-only modes would otherwise still be armed when the player comes back.
    if (S.remoteMarkerMode) remoteToggleMarker();
    if (remoteNotesMode) remoteToggleNotes();
    if (!board) {
      board = mountBoard(host, {
        identity: () => (remoteIsGM() && !S.remoteClaimId)
          ? { name: 'GM', character: '', gm: true }
          : { name: S.myActorName || 'a player', character: claimedCharacter(), gm: false },
        colorFor: playerColor,
      });
    }
    host.style.display = 'block';
    board.show();
    markBoardSeen();
  } else {
    if (board) board.hide();
    if (host) host.style.display = 'none';
    if (S.remoteScreen === 'play') requestAnimationFrame(() => remoteRelayout());
  }
  updateBoardBadge();
}

function sharedIds() { const d = boardDoc(); return d ? d.handouts.map(h => h.id) : []; }
function markBoardSeen() {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(sharedIds())); } catch (e) {}
}
// A red dot on the Board button when something new has been pinned (or a
// handout has been opened full-screen) while this player was on the map.
function updateBoardBadge() {
  const badge = document.querySelector('#remote-tool-board .rt-badge');
  if (!badge) return;
  if (board && board.isShown()) { markBoardSeen(); badge.classList.remove('on'); return; }
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); } catch (e) {}
  const d = boardDoc();
  const fresh = sharedIds().some(id => !seen.includes(id)) || !!(d && d.focus && d.focus.length);
  badge.classList.toggle('on', fresh);
}

// The GM looking through a player's eyes without making a token for it. The
// server treats every request from this page as a tunnel visitor's, so hidden
// NPCs, GM-only legend groups and un-shared handouts are simply not here.
function enterPreview() {
  S.myActorName = 'GM (preview)';
  S.myActorId = 'gm-preview';
  S.remoteClaimId = null;
  S._remoteRestoreDone = true;
  S.remoteScreen = 'play';
  document.title = 'GM Display — Player preview';
  document.getElementById('remote-select').style.display = 'none';
  document.getElementById('remote-stage').style.display = 'flex';
  document.getElementById('remote-bar').style.display = 'flex';
  document.getElementById('remote-who').textContent = '👁 Player preview';
  const dot = document.getElementById('remote-color-dot'); if (dot) dot.style.display = 'none';
  const ch = document.getElementById('remote-change-btn'); if (ch) ch.style.display = 'none';
  requestAnimationFrame(() => { renderRemoteFrame(); renderRemoteTokens(); });
  setRemoteTool(savedTool());
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
  if (board) board.hide();
  const rb = document.getElementById('remote-board'); if (rb) rb.style.display = 'none';
  const rv = document.getElementById('remote-view'); if (rv) rv.classList.remove('board-mode');
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
  if (!pcs.length && !remoteIsGM()) { wrap.innerHTML = '<div class="remote-empty">No characters yet — the GM hasn\'t added any.</div>'; return; }
  wrap.innerHTML = '';
  // On the GM's own machine this page is a second pair of hands, not a seat at
  // the table: a way to work the map from a tablet or a phone while standing
  // up. So there is a way in that claims nobody.
  if (remoteIsGM()) {
    // ...and a way to see exactly what the players see, without a token.
    const pv = document.createElement('div');
    pv.className = 'remote-card gm';
    pv.innerHTML = '<div class="rc-portrait" style="background:#2a2a30;border-color:#5fd0ff;">👁</div>'
      + '<div class="rc-name">Preview as a player</div>'
      + '<div class="rc-status">What the table sees · no token needed</div>';
    pv.onclick = () => { location.href = 'remote.html?preview=1'; };
    wrap.appendChild(pv);
    const card = document.createElement('div');
    card.className = 'remote-card gm';
    const por = document.createElement('div');
    por.className = 'rc-portrait';
    por.style.background = '#2a2a30'; por.textContent = 'GM';
    por.style.borderColor = '#ffcf5c';
    const name = document.createElement('div');
    name.className = 'rc-name'; name.textContent = 'Open as GM';
    const status = document.createElement('div');
    status.className = 'rc-status';
    status.textContent = 'Move any token · double-tap to hide or reveal';
    card.append(por, name, status);
    card.onclick = enterAsGM;
    wrap.appendChild(card);
  }
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

// Whoever is drawing should be obvious without asking. The line is the colour
// of the token you are playing — resolved now, not at join time, so it follows
// the token if the GM recolours it.
export function myMarkerColor() {
  const t = S.tokens.find(x => x.id === S.remoteClaimId);
  return (t && (t.ownerColor || t.color)) || S.remotePlayerColor;
}

export function remoteToggleMarker() {
  S.remoteMarkerMode = !S.remoteMarkerMode;
  document.getElementById('remote-marker-btn').classList.toggle('active', S.remoteMarkerMode);
  if (S.remoteMarkerMode && remoteNotesMode) remoteToggleNotes();
}
// Is this the GM's own browser looking at the player page? The server answers
// that from the socket the request came in on — it is not something this page
// can decide about itself, and not something a visitor can claim. When it is
// true the page stops being a petitioner: drags commit instead of proposing,
// and hidden tokens are drawn (faded) because the server sent them.
function remoteIsGM() { return !!S.remoteIsGM; }

// --- GM login from any device ------------------------------------------------
// On the GM's own Mac this page already knows it is the GM. Anywhere else —
// a tablet on the wifi, a laptop through the tunnel — the GM types the code
// shown in the GM page's Displays panel and the server remembers this browser.
function updateGmLoginUI() {
  const b = document.getElementById('remote-gm-login');
  if (!b) return;
  if (S.previewMode || (S.remoteIsGM && !S.remoteGmLogin)) { b.parentElement.style.display = 'none'; return; }
  b.parentElement.style.display = '';
  b.textContent = S.remoteGmLogin ? 'GM log out' : 'GM login';
}

export async function remoteGmLoginClick() {
  const st = document.getElementById('remote-gm-status');
  const say = (t) => { if (st) st.textContent = t || ''; };
  if (S.remoteGmLogin) {
    await fetch('/api/gm-logout', { method: 'POST' }).catch(() => {});
    say('logged out');
    remoteSyncTick();
    return;
  }
  const code = prompt('GM code (shown in the Displays panel of the GM page):');
  if (!code) return;
  say('checking…');
  try {
    const r = await fetch('/api/gm-login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ code }) });
    const d = await r.json();
    if (!r.ok) { say(d.error || 'no'); return; }
    say('');
    remoteSyncTick();
  } catch (e) { say('could not reach the GM’s server'); }
}

function remoteSyncTick() {
  fetch('/api/sync').then(r => r.json()).then(s => {
    const wasGM = S.remoteIsGM;
    S.remoteIsGM = !!s.local;
    S.remoteGmLogin = !!s.gmLogin;
    if (wasGM !== S.remoteIsGM && S.remoteScreen === 'select') renderRemoteRoster();
    updateGmLoginUI();
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
// --- party notes on the player's own copy of the map -----------------------
let remoteNotesMode = false;
let remoteCell = null;
let remoteNoteStatus = '';
let remoteNoteDraft = null;   // what the player has typed but not saved

export function remoteToggleNotes() {
  remoteNotesMode = !remoteNotesMode;
  const b = document.getElementById('remote-notes-btn');
  if (b) b.classList.toggle('active', remoteNotesMode);
  const panel = document.getElementById('remote-note-panel');
  if (panel) panel.style.display = remoteNotesMode ? 'block' : 'none';
  // The note canvas covers the tokens, so it only accepts taps while armed.
  const c = document.getElementById('remote-note-canvas');
  if (c) c.classList.toggle('armed', remoteNotesMode);
  // Marker mode and notes mode both want the tap; last one on wins.
  if (remoteNotesMode && S.remoteMarkerMode) remoteToggleMarker();
  if (remoteNotesMode && remoteLegendOpen) remoteToggleLegend();  // one sheet at a time
  if (remoteNotesMode && remoteLogOpen) remoteToggleLog();
  if (!remoteNotesMode) { remoteCell = null; remoteNoteDraft = null; remoteNoteStatus = ''; }
  renderRemoteNotePanel();
  drawRemoteNotePips();
}

// --- the party's log, on the player's own screen -----------------------------
// What everyone has written on this map, oldest first. The players have the
// same right to re-read their own notes as the GM does, and at the table the
// question is usually "when did we see that" rather than "which hex was it".
let remoteLogOpen = false;

export function remoteToggleLog() {
  remoteLogOpen = !remoteLogOpen;
  const b = document.getElementById('remote-log-btn');
  if (b) b.classList.toggle('active', remoteLogOpen);
  if (remoteLogOpen && remoteNotesMode) remoteToggleNotes();    // one sheet at a time
  if (remoteLogOpen && remoteLegendOpen) remoteToggleLegend();
  renderRemoteLog();
}

// Each name in the log wears that player's own colour, the same one their ink
// and their token already carry, so you can tell at a glance whose line it is.
function playerColor(name) {
  if (name === S.myActorName) return S.remotePlayerColor;
  const t = (S.tokens || []).find(x => x.owner === name);
  return (t && (t.ownerColor || t.color)) || '';
}

function renderRemoteLog() {
  const panel = document.getElementById('remote-log-panel');
  if (!panel) return;
  panel.style.display = remoteLogOpen ? 'block' : 'none';
  if (!remoteLogOpen) { panel.innerHTML = ''; return; }
  panel.innerHTML = '<div class="party-log">' + partyLogHTML(playerColor) + '</div>';
}

// --- the legend, on the player's own screen ---------------------------------
// The map's caption, not the GM's prep, so nobody has to ask what a glyph is
// while their turn goes past.
let remoteLegendOpen = false;

export function remoteToggleLegend() {
  remoteLegendOpen = !remoteLegendOpen;
  const b = document.getElementById('remote-legend-btn');
  if (b) b.classList.toggle('active', remoteLegendOpen);
  if (remoteLegendOpen && remoteNotesMode) remoteToggleNotes();  // one sheet at a time
  if (remoteLegendOpen && remoteLogOpen) remoteToggleLog();
  renderRemoteLegend();
}

function renderRemoteLegend() {
  const panel = document.getElementById('remote-legend-panel');
  if (!panel) return;
  panel.style.display = remoteLegendOpen ? 'block' : 'none';
  if (!remoteLegendOpen) { panel.innerHTML = ''; return; }
  panel.innerHTML = legendCount()
    ? legendHTML()
    : '<div class="remote-empty">The GM has not written a legend for this map.</div>';
}

// Inverse of remoteMapToCanvas: canvas px back to map px.
function remoteCanvasToMap(x, y) {
  return { x: x / S.remoteScale + S.remoteCrop.x, y: y / S.remoteScale + S.remoteCrop.y };
}

// Reading what the party has written about a hex should not require tapping it
// and opening a panel — same reasoning as the GM's peek. Party notes ONLY: the
// GM's prep is never sent to this page, so there is nothing here to leak.
let remoteHoverRaf = 0;

function remoteHideTip() {
  const tip = document.getElementById('remote-note-tip');
  if (tip) tip.style.display = 'none';
  if (remoteHoverRaf) { cancelAnimationFrame(remoteHoverRaf); remoteHoverRaf = 0; }
}

function remoteCellAtClient(cx, cy) {
  const c = document.getElementById('remote-note-canvas');
  // remoteCanvasToMap reads S.remoteCrop, so a mousemove that lands before
  // the first frame arrives must not get that far.
  if (!c || !S.remoteFrame || !S.remoteCrop || !S.remoteScale || !S.tokenGridEnabled) return '';
  const r = c.getBoundingClientRect();
  if (!r.width || cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return '';
  const m = remoteCanvasToMap(cx - r.left, cy - r.top);
  return cellLabel(cellAtMapPx(m.x, m.y, S.remoteFrame.width, S.remoteFrame.height));
}

function remoteShowTip(label, cx, cy) {
  const tip = document.getElementById('remote-note-tip');
  if (!tip) return;
  const list = partyNotesFor(label);
  if (!list.length) { remoteHideTip(); return; }
  const esc = (t) => String(t == null ? '' : t).replace(/[<>&"]/g,
    ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
  tip.innerHTML = '<div class="nt-cell">' + esc(label) + '</div>'
    + list.map(e => '<div class="nt-party"><b>' + esc(e.by || 'a player') + '</b> '
        + esc(e.text || '') + '</div>').join('');
  tip.style.display = 'block';
  const r = tip.getBoundingClientRect();
  let x = cx + 14, y = cy + 14;
  if (x + r.width > window.innerWidth - 8) x = cx - r.width - 14;
  if (y + r.height > window.innerHeight - 8) y = cy - r.height - 14;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}

function attachRemoteHover() {
  const stage = document.getElementById('remote-stage');
  if (!stage || stage._noteHoverWired) return;
  stage._noteHoverWired = true;
  stage.addEventListener('mousemove', (e) => {
    if (e.buttons) { remoteHideTip(); return; }   // not mid-drag
    if (remoteHoverRaf) return;
    remoteHoverRaf = requestAnimationFrame(() => {
      remoteHoverRaf = 0;
      const label = remoteCellAtClient(e.clientX, e.clientY);
      if (!label) { remoteHideTip(); return; }
      remoteShowTip(label, e.clientX, e.clientY);
    });
  });
  stage.addEventListener('mouseleave', remoteHideTip);
  stage.addEventListener('pointerdown', remoteHideTip);
}

function attachRemoteNoteHandler() {
  const c = document.getElementById('remote-note-canvas');
  if (!c || c._wired) return;
  c._wired = true;
  c.addEventListener('click', (e) => {
    if (!remoteNotesMode || !S.remoteFrame) return;
    const r = c.getBoundingClientRect();
    const m = remoteCanvasToMap(e.clientX - r.left, e.clientY - r.top);
    const label = cellLabel(cellAtMapPx(m.x, m.y, S.remoteFrame.width, S.remoteFrame.height));
    if (label !== remoteCell) { remoteNoteDraft = null; remoteNoteStatus = ''; remoteEditAt = null; }
    remoteCell = label;
    renderRemoteNotePanel(true);
    drawRemoteNotePips();
  });
}

// Which of your own entries the box is currently editing. Null means the box
// is for a NEW note — which is the normal state, because coming back to a hex
// usually means you have something to add, not something to take back.
let remoteEditAt = null;

function renderRemoteNotePanel(focusIt) {
  const panel = document.getElementById('remote-note-panel');
  if (!panel) return;
  if (!remoteNotesMode) { panel.innerHTML = ''; return; }
  if (!remoteCell) {
    panel.innerHTML = '<div class="remote-empty">Tap a hex or square to write on it.</div>';
    return;
  }
  const all = partyNotesFor(remoteCell);
  // The entry being edited may have been removed by the poll underneath us.
  if (remoteEditAt && !all.some(e => e.by === S.myActorName && e.at === remoteEditAt)) {
    remoteEditAt = null; remoteNoteDraft = null;
  }
  const editing = remoteEditAt
    ? all.find(e => e.by === S.myActorName && e.at === remoteEditAt) : null;

  // The 4s poll re-renders this panel. Remember where the caret was so a
  // re-render never yanks it out of the box mid-sentence.
  const prevTa = document.getElementById('remote-note-text');
  const wasFocused = prevTa && document.activeElement === prevTa;
  const caret = prevTa ? prevTa.selectionStart : 0;

  const esc = (t) => String(t == null ? '' : t).replace(/[<>&"]/g,
    ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
  const hhmm = (at) => {
    const m = /\d{4}-\d{2}-\d{2} (\d{2}:\d{2})/.exec(at || '');
    return m ? m[1] : '';
  };

  // Everything already on this hex, oldest first, yours and everyone else's.
  // Yours carry the two buttons; theirs are not yours to touch.
  const written = all.length
    ? '<div class="rn-list">' + all.map(e => {
        const mine = e.by === S.myActorName;
        return '<div class="rn-entry' + (mine ? ' mine' : '')
          + (remoteEditAt && mine && e.at === remoteEditAt ? ' editing' : '') + '">'
          + '<div class="rn-meta"><b>' + esc(e.by || 'a player') + '</b>'
          + (hhmm(e.at) ? '<span class="rn-when">' + esc(hhmm(e.at)) + '</span>' : '')
          + (e.edited ? '<span class="rn-when">edited</span>' : '')
          + (mine ? '<span class="rn-acts">'
              + '<button class="rn-mini" data-edit="' + esc(e.at || '') + '" title="Change this note">✎</button>'
              + '<button class="rn-mini" data-del="' + esc(e.at || '') + '" title="Remove this note">🗑</button>'
              + '</span>' : '')
          + '</div><div class="rn-text">' + esc(e.text || '') + '</div></div>';
      }).join('') + '</div>'
    : '';

  panel.innerHTML =
    '<div style="font-weight:600;margin-bottom:4px;">Cell ' + remoteCell + '</div>'
    + written
    + '<textarea id="remote-note-text" rows="3" placeholder="'
    + (editing ? 'Change your note…' : 'What did you notice here?') + '"></textarea>'
    + '<div style="display:flex;gap:6px;margin-top:4px;">'
    + '<button id="remote-note-save">' + (editing ? 'Save change' : 'Add note') + '</button>'
    + (editing ? '<button id="remote-note-cancel">Cancel</button>' : '')
    + '<span id="remote-note-status" style="font-size:11px;opacity:.7;align-self:center;">'
    + remoteNoteStatus + '</span></div>';

  const ta = document.getElementById('remote-note-text');
  // A draft beats the server copy, so the 4-second poll cannot wipe out what
  // the player is halfway through typing.
  ta.value = remoteNoteDraft !== null ? remoteNoteDraft : (editing ? editing.text : '');
  ta.addEventListener('input', () => { remoteNoteDraft = ta.value; });
  // Tapping a hex means "I want to write here", so put the cursor in the box —
  // on a phone that is also what raises the keyboard. Re-renders from the poll
  // pass no flag, so they restore the caret instead of stealing it.
  if (focusIt) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  else if (wasFocused) { ta.focus(); ta.setSelectionRange(caret, caret); }

  const say = (t) => {
    remoteNoteStatus = t;
    const st = document.getElementById('remote-note-status');
    if (st) st.textContent = t;
  };

  document.getElementById('remote-note-save').addEventListener('click', async () => {
    const text = ta.value;
    if (!text.trim() && !remoteEditAt) { say('nothing to add'); return; }
    say('saving…');
    const ok = remoteEditAt
      ? await editPartyNote(remoteCell, remoteEditAt, text, S.myActorName)
      : await addPartyNote(remoteCell, text, S.myActorName);
    say(ok ? 'saved' : 'could not save — is the GM’s server up?');
    if (ok) { remoteNoteDraft = null; remoteEditAt = null; }
    renderRemoteNotePanel();
    drawRemoteNotePips();
  });

  const cancel = document.getElementById('remote-note-cancel');
  if (cancel) cancel.addEventListener('click', () => {
    remoteEditAt = null; remoteNoteDraft = null; say('');
    renderRemoteNotePanel(true);
  });

  panel.querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => {
      remoteEditAt = b.dataset.edit; remoteNoteDraft = null; say('');
      renderRemoteNotePanel(true);
    }));
  panel.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', async () => {
      say('removing…');
      const ok = await removePartyNote(remoteCell, b.dataset.del, S.myActorName);
      say(ok ? 'removed' : 'could not remove — is the GM’s server up?');
      if (ok && remoteEditAt === b.dataset.del) { remoteEditAt = null; remoteNoteDraft = null; }
      renderRemoteNotePanel();
      drawRemoteNotePips();
    }));
}

// A pip on every cell the party has written on, so players can see their own
// annotations on the map rather than only in a list.
function drawRemoteNotePips() {
  const c = document.getElementById('remote-note-canvas');
  if (!c || !S.remoteFit || !S.remoteFrame) return;
  c.width = S.remoteFit.w; c.height = S.remoteFit.h;
  c.style.width = S.remoteFit.w + 'px'; c.style.height = S.remoteFit.h + 'px';
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const mw = S.remoteFrame.width, mh = S.remoteFrame.height;
  const all = partyNotes();
  for (const label of Object.keys(all)) {
    const cell = cellFromLabel(label);
    if (!cell) continue;
    const m = cellCenterMapPx(cell, mw, mh);
    const p = remoteMapToCanvas(m.x, m.y);
    ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(96,165,250,0.95)'; ctx.strokeStyle = '#0d1117';
    ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
  }
  if (remoteCell) {
    const cell = cellFromLabel(remoteCell);
    if (cell) {
      const m = cellCenterMapPx(cell, mw, mh);
      const p = remoteMapToCanvas(m.x, m.y);
      ctx.beginPath(); ctx.arc(p.x, p.y, 18, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffcf5c'; ctx.lineWidth = 3; ctx.stroke();
    }
  }
}

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
  ['remote-canvas', 'remote-grid-canvas', 'remote-marker-canvas', 'remote-note-canvas'].forEach(id => {
    if (!document.getElementById(id)) return;
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
  img.onload = () => {
    S.remoteImg = img; paintRemoteFog(img); renderRemoteTokens(); drawAllMarkers();
    // Key the notes and the legend on the map's IDENTITY, not on the image in
    // front of us. On a split map those differ: the table is looking at the
    // players' copy while every sidecar file is named after the GM's. Filing
    // by the image would put what the players write into a second party-notes
    // file the GM never opens.
    const key = S.remoteFrame.mapKey || S.remoteFrame.imageSrc;
    setPartyNotesMap(key);
    setLegendMap(key);
    drawRemoteNotePips();
  };
  img.src = S.remoteFrame.imageSrc;
}
// Repaint after a resize without re-fetching the image.
function remoteRelayout() {
  layoutRemote();
  if (S.remoteImg) paintRemoteFog(S.remoteImg);
  renderRemoteTokens();
  drawAllMarkers();
  drawRemoteNotePips();
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
  // Everything here is in the MAP's pixels — the GM image's, which is what the
  // fog mask, the crop and the grid are all measured in. On a split map we are
  // drawing a different file, so convert into its pixels on the way into
  // drawImage. Same framing at a different export size then still registers.
  const k = (img.naturalWidth && mw) ? img.naturalWidth / mw : 1;
  const ky = (img.naturalHeight && mh) ? img.naturalHeight / mh : 1;
  if (ex > sx && ey > sy) {
    ctx.drawImage(img, sx * k, sy * ky, (ex - sx) * k, (ey - sy) * ky,
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
  const dot = document.getElementById('remote-color-dot');
  if (dot) dot.style.background = myMarkerColor();
  const company = S.tokens.find(t => isParty(t) && t.onMap);
  const gm = remoteIsGM() && !S.remoteClaimId;
  document.getElementById('remote-token-info').textContent = S.previewMode
    ? 'Previewing what the players see — hidden tokens are not sent to this page'
    : gm
    ? 'GM — drag any token, double-tap to hide or reveal'
    : (mine ? ('Playing ' + tokenDisplayName(mine)
            + (company ? ' — drag ' + tokenDisplayName(company) + ' to move the party'
                       : ' — drag to move'))
         : '');
  // Players only ever see what the GM has revealed on this map — and for an
  // NPC that is not a filter, it is all the server sent them. The GM's own
  // browser gets the hidden ones too, faded, to place and walk around.
  S.tokens.filter(t => t.onMap || gm).forEach(t => {
    // The Company belongs to the whole table, so anyone who has joined may
    // propose its move — it is not one player's piece to hold.
    const canControl = !S.previewMode && (gm || (t.id === S.remoteClaimId) || (isParty(t) && !!S.myActorName));
    const el = makeRemoteTokenEl(t, t.tx, t.ty, diamPx * tokenFrac(t) / TOKEN_FRAC,
                                 false, canControl);
    if (!t.onMap) el.classList.add('unseen');
    layer.appendChild(el);
    if (t.pending) layer.appendChild(makeRemoteTokenEl(t, t.pending.tx, t.pending.ty,
                                        diamPx * tokenFrac(t) / TOKEN_FRAC, true, false));
  });
}
function makeRemoteTokenEl(t, tx, ty, diamPx, isGhost, canControl) {
  const el = document.createElement('div');
  el.className = 'token ' + tokenClass(t) + (isGhost ? ' ghost' : '') + (canControl ? ' draggable' : '');
  const mw = S.remoteFrame.width, mh = S.remoteFrame.height;
  const p = remoteMapToCanvas(tx * mw, ty * mh);
  el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
  el.style.width = diamPx + 'px'; el.style.height = diamPx + 'px';
  const fill = document.createElement('span');
  fill.className = 'tok-fill';
  fill.style.opacity = tokenFillOpacity(t);
  if (t.img) { fill.style.backgroundImage = 'url("' + t.img + '")'; }
  else { fill.style.background = t.color; }
  el.appendChild(fill);
  if (!t.img) { const ini = document.createElement('span');
                ini.className = 'tok-ini'; ini.textContent = initialsOf(t.base);
                el.appendChild(ini); }
  if (!isGhost && t.ownerColor) el.style.borderColor = t.ownerColor;
  const lab = document.createElement('span'); lab.className = 'tok-label'; lab.textContent = tokenDisplayName(t);
  el.appendChild(lab);
  if (t.num > 0) { const n = document.createElement('span'); n.className = 'tok-num'; n.textContent = t.num; el.appendChild(n); }
  if (canControl && !isGhost) attachRemoteTokenDrag(el, t);
  // Reveal is the beat the whole ambush turns on, and it happens mid-round with
  // the GM's hands nowhere near the laptop. Double-tap flips it.
  if (!isGhost && remoteIsGM() && !S.remoteClaimId) {
    el.title = (t.onMap ? 'Visible' : 'Hidden — only you see this')
      + ' · double-tap to ' + (t.onMap ? 'hide' : 'reveal');
    el.addEventListener('dblclick', (e) => {
      e.preventDefault(); e.stopPropagation();
      t.onMap = !t.onMap;                    // optimistic; the GM page confirms
      sendAction({ kind: 'gmvis', tokenId: t.id, onMap: t.onMap });
      renderRemoteTokens();
    });
  }
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
      // A player proposes and waits for a ✓. The GM, on their own machine, is
      // the person who would be ticking it — so the move just happens.
      sendAction(remoteIsGM() && !S.remoteClaimId
        ? { kind: 'gmmove', tokenId: t.id, tx: s.tx, ty: s.ty }
        : { kind: 'propose', tokenId: t.id, player: S.myActorName, tx: s.tx, ty: s.ty });
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
    S._markerStroke = { id: uid('m'), by: S.myActorName, color: myMarkerColor(), points: [] };
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
