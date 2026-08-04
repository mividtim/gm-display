// GM Display — state.js
// Globals and localStorage persistence.
// Classic script: load order matters (see gm_display.html).
// GM Display — application code.
// Loaded as a classic script, exactly as it was when inlined: top-level
// function declarations remain global, so the inline handlers in the markup
// keep resolving. Split into ES modules from here.
// === State ===
import { S } from './store.js';
S.loadedImage = null;
S.fogMask = null;
S.fogImage = null;
S.mapWidth = 0; S.mapHeight = 0;
S.currentTool = 'reveal';   // fog brush polarity, driven by the reveal/hide tools
// Which tool a click on the map runs. The single source of truth for that —
// see js/tools.js. Tokens is the safe default: it edits nothing on its own.
S.activeTool = 'none';
S.brushSize = 40;
S.painting = false;
S.currentMode = 'landing';
S.pollTimer = null;

// Live sync: when false, fog/map changes are staged but not pushed to projector
S.liveSync = true;
S.hasPendingSync = false; // true when GM state differs from what projector shows

// Fog undo/redo history (per current map, in-memory)
S.FOG_HISTORY_MAX = 10;
S.fogHistory = [];    // array of Uint8Array snapshots, oldest first
S.fogHistoryIdx = -1; // points to current state in fogHistory
S.fogInitialized = false;

// Fog presets: multiple fog masks per map
// Each preset: { name: string, rle: number[] (RLE-encoded), w: number, h: number }
S.fogPresets = [];       // array of preset objects for current map
S.activePresetIdx = 0;   // index into fogPresets

// Fog context: which display the current fog state targets.
// 'map' = projector (fog on the map), 'show' = sidecar (fog on a handout).
// Only one context is "active in the globals" (fogMask, fogImage, fogPresets, etc.)
// at a time. The inactive context's state is held in a stash and swapped in
// when the user switches contexts.
S.fogContext = 'map';
S.stashedMapFog = null;
S.stashedShowFog = null;
// Source of the image fogMask/fogPresets currently match. Used to detect
// "user switched to a different map" since callers pre-set lastMapSrc/fogImage
// before startFogMode runs, making the obvious in-function comparisons useless.
S.lastInitializedFogSrc = null;

// Map library: persisted list of all loaded maps
// Each entry: { src: string, name: string }
const MAP_LIBRARY_KEY = 'gm-display-map-library';
S.mapLibrary = [];  // loaded from localStorage
S.imageLibrary = []; // sidecar-handout history, mirrors mapLibrary

// Track what's currently on each display (for thumbnails)
S.lastMapSrc = null;
S.lastMapName = null;
S.lastShowSrc = null;
S.lastShowName = null;

// Is the map's legend showing on the projector? Deliberately not persisted —
// a legend left up from last session would sit over the next map's art.
S.legendOnProjector = false;

// Projection settings (sent to player)
// 4-corner keystone: pixel offsets for each corner {x, y}
S.corners = { tl: {x:0,y:0}, tr: {x:0,y:0}, bl: {x:0,y:0}, br: {x:0,y:0} };
S.projScale = 100;     // scale percent
// Per-display rotation (0-359°). The two displays rotate independently.
S.mapRotation = 0;     // rotation applied to projector output
S.showRotation = 0;    // rotation applied to sidecar output
// Per-display background color (around any letterboxing or smaller-than-screen content).
S.mapBg = '#000000';
S.showBg = '#000000';
S.gridEnabled = false;
S.gridPx = 50;         // grid spacing in pixels
S.gridOpacity = 0.4;
S.gridColorTemplate = 'rgba(255,255,255,__A__)'; // __A__ replaced with opacity

// Two separate channels: one per display
S.mapChannel = null;
S.showChannel = null;

// Player view state (when this window IS a display)
S.isPlayerView = false;
S.playerDisplay = null;
S.playerChannel = null;

// Crop state (what portion of the map the projector shows)
S.cropZoom = 1;     // 1 = full map, 2 = half size shown, etc.
S.cropHPos = 0.5;   // 0-1, center of crop horizontally
S.cropVPos = 0.5;   // 0-1, center of crop vertically
S.viewportCrop = null;  // computed {x,y,w,h} in map pixels, or null
S.projectorW = 1920;  // projector screen dimensions (updated by heartbeat)
S.projectorH = 1080;
S.sidecarW = 1920;    // sidecar screen dimensions (updated by heartbeat)
S.sidecarH = 1080;

// Player-side: offscreen buffer for flicker-free rendering
S.offscreenCanvas = null;
S.offscreenCtx = null;
S.cachedMapImage = null;   // pre-loaded map image on player side
S.cachedMapSrc = null;

// Player-side: projection state
S.pCorners = { tl: {x:0,y:0}, tr: {x:0,y:0}, bl: {x:0,y:0}, br: {x:0,y:0} };
S.pScale = 100;
S.pRotation = 0;
S.pBg = '#000000';
S.pGridEnabled = false;
S.pGridPx = 50;
S.pGridOpacity = 0.4;
S.pGridColor = 'rgba(255,255,255,0.4)';
// Player-side: cached fog data for crop-only updates
S.cachedFogData = null;
// Player-side: test pattern state
S.pTestPattern = false;

// === State Persistence (localStorage) ===
// Per-game namespacing. Each game (e.g. "Pathfinder", "Delta Green") keeps
// its own maps, fog, and settings under `gm-display:<slug>:<key>`. The list
// of games and the currently-active slug are tracked at the top level.
const GAMES_INDEX_KEY = 'gm-display:games';
const ACTIVE_GAME_KEY = 'gm-display:active-game';
S.games = [];           // array of { slug, name, campaign }
S.activeGame = 'default';

// Campaigns group modules (games). Maps/fog/crop stay per-module; TOKENS are
// stored per-CAMPAIGN so the same agents are shared across every module in a
// campaign. campaignKey() routes token storage to the active game's campaign.
const CAMPAIGNS_INDEX_KEY = 'gm-display:campaigns';
const ACTIVE_CAMPAIGN_KEY = 'gm-display:active-campaign';
S.campaigns = [];       // array of { slug, name }
S.activeCampaign = 'default';

export function campaignKey(suffix) {
  return `gm-display:camp:${S.activeCampaign}:${suffix}`;
}

export function slugify(name) {
  const s = (name || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'game';
}

export function gameKey(suffix) {
  return `gm-display:${S.activeGame}:${suffix}`;
}

export function loadGamesIndex() {
  let needsSave = false;
  try {
    const raw = localStorage.getItem(GAMES_INDEX_KEY);
    S.games = raw ? JSON.parse(raw) : [];
    if (!raw) needsSave = true;
  } catch (e) { S.games = []; needsSave = true; }
  if (!Array.isArray(S.games)) { S.games = []; needsSave = true; }
  if (S.games.length === 0) {
    S.games = [{ slug: 'default', name: 'Default' }];
    needsSave = true;
  }
  const stored = localStorage.getItem(ACTIVE_GAME_KEY);
  S.activeGame = (stored && S.games.some(g => g.slug === stored)) ? stored : S.games[0].slug;
  if (needsSave) saveGamesIndex();
}

export function saveGamesIndex() {
  try {
    localStorage.setItem(GAMES_INDEX_KEY, JSON.stringify(S.games));
    localStorage.setItem(ACTIVE_GAME_KEY, S.activeGame);
  } catch (e) {
    console.warn('[GM Display] Failed to save games index:', e);
  }
}

export function saveCampaignsIndex() {
  try {
    localStorage.setItem(CAMPAIGNS_INDEX_KEY, JSON.stringify(S.campaigns));
    localStorage.setItem(ACTIVE_CAMPAIGN_KEY, S.activeCampaign);
  } catch (e) {
    console.warn('[GM Display] Failed to save campaigns index:', e);
  }
}

// Build the campaigns index and ensure every module belongs to a campaign.
// On first run (no campaigns index yet) we migrate: the three Delta Green
// modules are grouped under one "Delta Green" campaign; every other existing
// module becomes its own single-module campaign so nothing is mixed together.
export function loadCampaignsIndex() {
  const hadIndex = !!localStorage.getItem(CAMPAIGNS_INDEX_KEY);
  try { S.campaigns = JSON.parse(localStorage.getItem(CAMPAIGNS_INDEX_KEY) || '[]'); }
  catch (e) { S.campaigns = []; }
  if (!Array.isArray(S.campaigns)) S.campaigns = [];

  if (!hadIndex) migrateGamesIntoCampaigns();
  ensureCampaignIntegrity();

  // Active campaign follows the active module.
  const ag = S.games.find(g => g.slug === S.activeGame);
  const storedC = localStorage.getItem(ACTIVE_CAMPAIGN_KEY);
  S.activeCampaign = (ag && ag.campaign) ? ag.campaign
    : (storedC && S.campaigns.some(c => c.slug === storedC) ? storedC
    : (S.campaigns[0] ? S.campaigns[0].slug : 'default'));
  saveGamesIndex();
  saveCampaignsIndex();
}

function migrateGamesIntoCampaigns() {
  const DG_MODULES = ['sentinels of twilight', 'last things last', 'ex oblivione'];
  const norm = s => (s || '').trim().toLowerCase();
  const DG = 'delta-green';
  let dgCreated = S.campaigns.some(c => c.slug === DG);
  S.games.forEach(g => {
    if (DG_MODULES.includes(norm(g.name))) {
      g.campaign = DG;
      if (!dgCreated) { S.campaigns.push({ slug: DG, name: 'Delta Green' }); dgCreated = true; }
    } else {
      let cslug = (g.slug === DG) ? g.slug + '-campaign' : g.slug;
      if (!S.campaigns.some(c => c.slug === cslug)) S.campaigns.push({ slug: cslug, name: g.name });
      g.campaign = cslug;
    }
  });
  // Move any legacy per-module token store up to its campaign (first one wins).
  S.games.forEach(g => {
    const legacy = localStorage.getItem(`gm-display:${g.slug}:tokens`);
    if (legacy) {
      const ckey = `gm-display:camp:${g.campaign}:tokens`;
      if (!localStorage.getItem(ckey)) localStorage.setItem(ckey, legacy);
    }
  });
}

// Guarantee every game has a valid campaign and at least one campaign exists.
function ensureCampaignIntegrity() {
  S.games.forEach(g => {
    if (!g.campaign || !S.campaigns.some(c => c.slug === g.campaign)) {
      let cslug = g.slug;
      if (!S.campaigns.some(c => c.slug === cslug)) S.campaigns.push({ slug: cslug, name: g.name });
      g.campaign = cslug;
    }
  });
  if (S.campaigns.length === 0) {
    S.campaigns = [{ slug: 'default', name: 'Default' }];
    S.games.forEach(g => { g.campaign = 'default'; });
  }
}

// Keep the two Pathfinder Society scenarios grouped together. This migration
// is intentionally idempotent: it only creates the campaign/module when they
// are missing and never touches either module's saved maps, fog, or settings.
export function ensurePathfinderSocietyModules() {
  const norm = s => (s || '').trim().toLowerCase();
  const silentTide = S.games.find(g => norm(g.name) === 'silent tide');
  let society = S.campaigns.find(c => norm(c.name) === 'pathfinder society');
  let changed = false;

  // Older installs may already have Silent Tide grouped under the desired
  // campaign but with a different campaign slug. Reuse that campaign so its
  // shared tokens remain intact.
  if (!society && silentTide) {
    society = S.campaigns.find(c => c.slug === silentTide.campaign);
    if (society && norm(society.name) !== 'pathfinder society') {
      society.name = 'Pathfinder Society';
      changed = true;
    }
  }

  if (!society) {
    let slug = 'pathfinder-society';
    while (S.campaigns.some(c => c.slug === slug)) slug += '-1';
    society = { slug, name: 'Pathfinder Society' };
    S.campaigns.push(society);
    changed = true;
  }

  if (silentTide && silentTide.campaign !== society.slug) {
    silentTide.campaign = society.slug;
    changed = true;
  }

  let hydrasFang = S.games.find(g => norm(g.name) === "the hydra's fang incident"
    || norm(g.name) === "hydra's fang incident");
  if (!hydrasFang) {
    let slug = 'the-hydras-fang-incident';
    while (S.games.some(g => g.slug === slug)) slug += '-1';
    hydrasFang = { slug, name: "The Hydra's Fang Incident", campaign: society.slug };
    S.games.push(hydrasFang);
    changed = true;
  } else if (hydrasFang.campaign !== society.slug) {
    hydrasFang.campaign = society.slug;
    changed = true;
  }

  if (changed) {
    saveGamesIndex();
    saveCampaignsIndex();
  }
}

export function modulesInCampaign(cslug) {
  return S.games.filter(g => g.campaign === cslug);
}

// On first run after this feature ships, copy any pre-existing un-prefixed
// keys (`gm-display-state`, `gm-display-map-library`, `gm-display-fog:*`)
// under the Default game's prefix and remove the originals. Idempotent: only
// runs when no games index has been written yet.
export function migrateLegacyKeysToDefault() {
  if (localStorage.getItem(GAMES_INDEX_KEY)) return;
  const moves = [];
  const legacyState = localStorage.getItem('gm-display-state');
  if (legacyState) moves.push(['gm-display-state', 'gm-display:default:state', legacyState]);
  const legacyLib = localStorage.getItem('gm-display-map-library');
  if (legacyLib) moves.push(['gm-display-map-library', 'gm-display:default:library', legacyLib]);
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('gm-display-fog:')) {
      const suffix = k.substring('gm-display-fog:'.length);
      moves.push([k, `gm-display:default:fog:${suffix}`, localStorage.getItem(k)]);
    }
  }
  if (moves.length === 0) return;
  for (const [oldKey, newKey, value] of moves) {
    try {
      localStorage.setItem(newKey, value);
      localStorage.removeItem(oldKey);
    } catch (e) {
      console.warn('[GM Display] Migration failed for', oldKey, e);
    }
  }
  console.log(`[GM Display] Migrated ${moves.length} legacy keys to "default" game.`);
}

const STORAGE_KEY = 'gm-display-state'; // legacy constant — no longer used directly
