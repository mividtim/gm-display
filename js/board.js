// GM Display — board.js
// The campaign bulletin board: a corkboard of every handout the GM has shared
// with the table, across every module in the campaign.
//
// Everything on it is shared. Where each handout sits, which one is on top,
// the yarn strung between pins, the notes, the board's own pan and zoom, and
// which handout is open full-screen — one person changes it and every screen
// follows. The server holds the board (board_api.py); this module keeps a
// long poll open against it and sends small operations back.
//
// Used by the player page (remote.html) and by the GM page, where the GM works
// the same board as a player would and signs their notes as "The Handler".
//
// Interaction, in one place because it is easy to get wrong:
//   drag a PIN            moves that handout (and brings it to the top)
//   drag anywhere else    pans the board — including over a handout
//   click a handout       (press AND release, without moving) brings it to the top
//   double-click          opens it full-screen, for everyone
//   ⤓ on a handout        sends it to the bottom of the pile
//   ◢ corner              resizes it
//   drag a pin's yarn TAIL onto another handout (or its pin) to string yarn
//   click a string        offers ✂ to cut it
//   the post-it stack     shows how many notes a handout has; click to read them
//   wheel / pinch         zoom
import { S } from './store.js';

// ------------------------------------------------------------------ sync ---
let doc = null;             // the board as last merged (server + our own live edits)
let serverDoc = null;       // the board exactly as the server last sent it
let token = '';             // "epoch:version" of serverDoc
let isLocal = false;        // the server says this browser is the GM's machine
let campaign = '';
let syncing = false;
const listeners = [];

export function onBoard(fn) { listeners.push(fn); }
export function boardDoc() { return doc; }
export function boardCampaign() { return campaign; }
export function boardIsLocal() { return isLocal; }
function announce() { listeners.forEach(fn => { try { fn(doc); } catch (e) { console.warn(e); } }); }

const verOf = (t) => { const m = /^(\d+):(\d+)$/.exec(t || ''); return m ? [+m[1], +m[2]] : [0, 0]; };
const newer = (a, b) => { const x = verOf(a), y = verOf(b); return x[0] !== y[0] ? x[0] > y[0] : x[1] >= y[1]; };

export function startBoardSync() {
  if (syncing) return;
  syncing = true;
  (async function loop() {
    let backoff = 500;
    for (;;) {
      try {
        const r = await fetch('/api/board' + (token ? '?since=' + encodeURIComponent(token) : ''),
                              { cache: 'no-store' });
        const d = await r.json();
        backoff = 500;
        acceptServer(d);
      } catch (e) {
        await new Promise(res => setTimeout(res, backoff));
        backoff = Math.min(8000, backoff * 2);
      }
      if (document.hidden) await new Promise(res => setTimeout(res, 1000));
    }
  })();
}

// Ask for the board right now rather than waiting on the poll (after an op
// the poll will bring it anyway; this is for first paint).
export async function refreshBoard() {
  try {
    const r = await fetch('/api/board', { cache: 'no-store' });
    acceptServer(await r.json());
  } catch (e) {}
}

function acceptServer(d) {
  if (!d || !d.version) return;
  // A response can overtake the answer to our own op. Never step backwards.
  if (token && verOf(d.version)[0] === verOf(token)[0] && !newer(d.version, token)) return;
  token = d.version;
  isLocal = !!d.local;
  campaign = d.campaign || '';
  serverDoc = d.board;
  remerge();
}

// Our own live edits win over the server for as long as they are live: the
// handout under our finger, the view while we pan, and anything we have sent
// that the server has not yet answered.
const holds = new Map();    // key -> expiry ms (Infinity while a gesture is active)
function held(key) { const t = holds.get(key); return t !== undefined && t > performance.now(); }
function hold(key, ms) { holds.set(key, ms === Infinity ? Infinity : performance.now() + (ms || 0)); }
function release(key, ms) { holds.set(key, performance.now() + (ms == null ? 600 : ms)); }

function remerge() {
  const prev = doc;
  if (!serverDoc) { doc = null; announce(); return; }
  const next = JSON.parse(JSON.stringify(serverDoc));
  // The GM's copy also lists handouts that were shared once and taken back
  // (so their notes and strings survive a re-share). The board shows what the
  // players see — the GM works it as one of them.
  next.handouts = (next.handouts || []).filter(h => h.shared !== false);
  const live = new Set(next.handouts.map(h => h.id));
  next.yarn = (next.yarn || []).filter(y => live.has(y.a) && live.has(y.b));
  next.focus = (next.focus || []).filter(id => live.has(id));
  if (prev && prev.campaign === next.campaign) {
    if (held('view') && prev.view) next.view = prev.view;
    next.handouts.forEach(h => {
      if (!held('h:' + h.id)) return;
      const p = (prev.handouts || []).find(x => x.id === h.id);
      if (p) { h.x = p.x; h.y = p.y; h.w = p.w; h.h = p.h; h.z = p.z; }
    });
  }
  doc = next;
  announce();
}

// --- outgoing ops: one request in flight, ops of the same key coalesce -------
const pending = new Map();  // key -> op
let inflight = false;
let seq = 0;

export function sendOp(op, key) {
  pending.set(key || ('u' + (++seq)), op);
  pump();
}

async function pump() {
  if (inflight || !pending.size) return;
  inflight = true;
  const ops = Array.from(pending.values());
  pending.clear();
  try {
    const r = await fetch('/api/board/op', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops }),
    });
    const d = await r.json();
    if (d && d.results) {
      const bad = d.results.find(x => !x.ok);
      if (bad && bad.error) flash(bad.error);
    }
  } catch (e) {
    flash('could not reach the GM’s server');
  }
  inflight = false;
  if (pending.size) pump();
}

let flashFn = null;
function flash(t) { if (flashFn) flashFn(t); }

// Apply an op to our local copy immediately, so the gesture feels instant.
function applyLocal(op) {
  if (!doc) return;
  const h = op.id ? doc.handouts.find(x => x.id === op.id) : null;
  if (op.op === 'move' && h) {
    h.x = op.x; h.y = op.y;
    if (op.w != null) { const r = h.h / h.w; h.w = op.w; h.h = op.w * r; }
  } else if (op.op === 'view') {
    doc.view = { cx: op.cx, cy: op.cy, z: op.z };
  } else if ((op.op === 'raise' || op.op === 'lower') && h) {
    const zs = doc.handouts.map(x => x.z || 0);
    h.z = op.op === 'raise' ? Math.max(...zs) + 1 : Math.min(...zs) - 1;
  } else if (op.op === 'retitle' && h) {
    if (op.title) h.title = op.title; else delete h.title;
  } else if (op.op === 'style' && h) {
    h.cutout = !!op.cutout;
  } else if (op.op === 'focus') {
    doc.focus = (op.ids || []).slice(0, 2);
  } else if (op.op === 'yarn_del') {
    doc.yarn = doc.yarn.filter(y => y.id !== op.id);
  }
  announce();
}

function doOp(op, key, holdKey) {
  if (holdKey) release(holdKey);
  applyLocal(op);
  sendOp(op, key);
}

// ------------------------------------------------------------------ view ---
// `opts.identity()` -> { name, character, gm } — who is writing notes.
// `opts.colorFor(name)` -> a CSS colour for an author's name, or ''.
// `opts.canUnshare(h)` — the GM gets a ✕ on each handout to take it off the board.
export function mountBoard(root, opts) {
  opts = opts || {};
  const identity = opts.identity || (() => ({ name: S.myActorName || 'a player', character: '', gm: false }));
  root.classList.add('bb-root');
  root.innerHTML = `
    <div class="bb-viewport" tabindex="0">
      <div class="bb-world">
        <div class="bb-handouts"></div>
        <svg class="bb-yarn" width="1" height="1"></svg>
        <div class="bb-pins"></div>
        <div class="bb-snips"></div>
      </div>
      <div class="bb-empty">Nothing on the board yet.<br><span>Handouts the GM shares will be pinned here.</span></div>
    </div>
    <div class="bb-toolbar">
      <button class="bb-tb" data-bb="zoom-out" title="Zoom out">−</button>
      <span class="bb-zoom" title="Everyone shares this view">100%</span>
      <button class="bb-tb" data-bb="zoom-in" title="Zoom in">+</button>
      <button class="bb-tb" data-bb="fit" title="Fit every handout on screen">Fit</button>
      <span class="bb-hint"></span>
    </div>
    <div class="bb-toast"></div>
    <div class="bb-modal" style="display:none;"></div>`;
  const vp = root.querySelector('.bb-viewport');
  const world = root.querySelector('.bb-world');
  const hLayer = root.querySelector('.bb-handouts');
  const pinLayer = root.querySelector('.bb-pins');
  const svg = root.querySelector('.bb-yarn');
  const modal = root.querySelector('.bb-modal');
  const toast = root.querySelector('.bb-toast');
  const hint = root.querySelector('.bb-hint');
  const empty = root.querySelector('.bb-empty');
  let visible = false;
  let selected = null;           // id of the handout whose buttons are showing
  let yarnDrag = null;           // {from, x, y, to} while dragging a new string
  // Scissors at both ends of every string. They show when you are near the
  // string: hovering it or either handout it ties, or with either handout
  // selected (a tap, on a phone), or after clicking the string itself.
  const snipLayer = root.querySelector('.bb-snips');
  let hoverId = null;            // handout under the pointer
  let hoverYarn = null;          // string under the pointer
  let pickedYarn = null;         // string last clicked
  const hideCut = () => { if (pickedYarn) { pickedYarn = null; updateSnips(); } };
  snipLayer.addEventListener('pointerdown', ev => { if (ev.target.closest('.bb-snip')) ev.stopPropagation(); });
  snipLayer.addEventListener('click', ev => {
    const b = ev.target.closest('.bb-snip'); if (!b) return;
    ev.stopPropagation();
    doOp({ op: 'yarn_del', id: b.dataset.yarn });
    pickedYarn = null;
  });
  function snipShown(y) {
    return y.id === hoverYarn || y.id === pickedYarn
      || [y.a, y.b].some(id => id === hoverId || id === selected);
  }
  function updateSnips() {
    snipLayer.querySelectorAll('.bb-snip').forEach(s => {
      const y = doc && doc.yarn.find(v => v.id === s.dataset.yarn);
      s.classList.toggle('on', !!(y && snipShown(y)));
    });
  }
  const els = new Map();         // id -> {card, pin}

  let toastTimer = 0;
  flashFn = (t) => {
    toast.textContent = t; toast.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('on'), 2600);
  };

  const size = () => ({ W: vp.clientWidth || 1, H: vp.clientHeight || 1 });
  const view = () => (doc && doc.view) || { cx: 0, cy: 0, z: 1 };
  const toWorld = (sx, sy) => {
    const v = view(), { W, H } = size();
    return { x: (sx - W / 2) / v.z + v.cx, y: (sy - H / 2) / v.z + v.cy };
  };
  const clientToVp = (e) => { const r = vp.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  // The pin goes through the top of the paper — and on a cut-out image, the
  // top of the picture rather than the empty corner of its bounding box.
  const pinPos = (h) => {
    const e = els.get(h.id);
    const top = (e && e.cut && h.cutout !== false) ? e.cut.top * h.h : 0;
    return { x: h.x + h.w / 2, y: h.y + top + PIN_INSET };
  };
  const byId = (id) => doc && doc.handouts.find(h => h.id === id);

  function setView(v, gestureActive) {
    v = { cx: v.cx, cy: v.cy, z: Math.max(0.05, Math.min(8, v.z)) };
    hold('view', gestureActive ? Infinity : 0);
    doOp({ op: 'view', cx: v.cx, cy: v.cy, z: v.z }, 'view', gestureActive ? null : 'view');
  }
  function zoomAt(sx, sy, factor, gestureActive) {
    const v = view(), p = toWorld(sx, sy), { W, H } = size();
    const z = Math.max(0.05, Math.min(8, v.z * factor));
    setView({ cx: p.x - (sx - W / 2) / z, cy: p.y - (sy - H / 2) / z, z }, gestureActive);
  }
  function fitAll() {
    if (!doc || !doc.handouts.length) { setView({ cx: 0, cy: 0, z: 1 }); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    doc.handouts.forEach(h => { x0 = Math.min(x0, h.x); y0 = Math.min(y0, h.y);
                                 x1 = Math.max(x1, h.x + h.w); y1 = Math.max(y1, h.y + h.h); });
    const { W, H } = size(), pad = 60;
    const z = Math.min((W - pad * 2) / (x1 - x0), (H - pad * 2) / (y1 - y0), 2);
    setView({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, z });
  }

  // ---------------------------------------------------------------- render
  function render() {
    if (!visible) return;
    const d = doc;
    const hs = d ? d.handouts.slice().sort((a, b) => (a.z || 0) - (b.z || 0)) : [];
    empty.style.display = hs.length ? 'none' : '';
    const v = view(), { W, H } = size();
    world.style.transform = `translate(${W / 2 - v.cx * v.z}px, ${H / 2 - v.cy * v.z}px) scale(${v.z})`;
    root.querySelector('.bb-zoom').textContent = Math.round(v.z * 100) + '%';
    root.style.setProperty('--bb-inv', String(1 / v.z));
    root.style.setProperty('--bb-yarn', (d && d.yarnColor) || '#c0392b');

    const seen = new Set();
    hs.forEach((h, i) => {
      seen.add(h.id);
      let e = els.get(h.id);
      if (!e) { e = buildHandout(h); els.set(h.id, e); }
      const c = e.card;
      if (c.parentNode !== hLayer || c !== hLayer.children[i]) hLayer.insertBefore(c, hLayer.children[i] || null);
      c.style.left = h.x + 'px'; c.style.top = h.y + 'px';
      c.style.width = h.w + 'px'; c.style.height = h.h + 'px';
      c.style.zIndex = i + 1;
      c.classList.toggle('selected', selected === h.id);
      c.classList.toggle('top', i === hs.length - 1);
      // Background removal happens in each browser, once per image, and lands
      // the same everywhere because the same pixels go in.
      if (e.cutFor !== h.src) {
        e.cutFor = h.src; e.cut = null;
        cutoutFor(h.src).then(cut => { if (e.cutFor === h.src) { e.cut = cut; render(); } });
      }
      const useCut = !!(e.cut && h.cutout !== false);
      const want = useCut ? e.cut.url : h.src;
      if (e.img.getAttribute('src') !== want) e.img.src = want;
      c.classList.toggle('cutout', useCut);
      e.bgBtn.style.display = e.cut && e.cut.removed ? '' : 'none';
      e.bgBtn.title = useCut ? 'Put the background back' : 'Remove the background';
      // Players are never sent a handout's filename, only a title the GM chose
      // to give it. The GM's own copy has the filename, shown faintly so the GM
      // knows the players cannot see it.
      e.cap.textContent = h.title || (h.name ? h.name : '');
      e.cap.classList.toggle('gm-only', !h.title && !!h.name);
      e.cap.title = (!h.title && h.name) ? 'Only you see this name — players see no caption until you give it a title (✎)' : '';
      const n = ((d.notes || {})[h.id] || []).length;
      if (e.stack._n !== n) {
        e.stack._n = n;
        e.stack.style.display = n ? '' : 'none';
        // A little pile of post-its: one sheet per note, up to three, with
        // the count written on the top one.
        const sheets = Math.min(3, n);
        e.stack.innerHTML = Array.from({ length: sheets }, (_, k) =>
          `<span class="bb-postit" style="--k:${sheets - 1 - k}"></span>`).join('')
          + `<span class="bb-postit-n">${n}</span>`;
        e.stack.title = n + (n === 1 ? ' note' : ' notes') + ' — click to read';
      }
      const p = pinPos(h);
      e.pin.style.left = p.x + 'px'; e.pin.style.top = p.y + 'px';
      e.tail.style.left = p.x + 'px'; e.tail.style.top = p.y + 'px';
      e.tail.style.visibility = (yarnDrag && yarnDrag.from === h.id) ? 'hidden' : '';
      e.card.classList.toggle('bb-yarn-target', !!(yarnDrag && yarnDrag.to === h.id));
      if (e.tail.parentNode !== pinLayer) pinLayer.appendChild(e.tail);
      if (e.pin.parentNode !== pinLayer) pinLayer.appendChild(e.pin);
    });
    for (const [id, e] of els) {
      if (!seen.has(id)) { e.card.remove(); e.pin.remove(); e.tail.remove(); els.delete(id); if (selected === id) selected = null; }
    }
    renderYarn();
    renderModal();
    hint.textContent = yarnDrag
      ? 'Drop the yarn on another handout'
      : 'Drag a pin to move · drag its yarn to connect · double-click to enlarge';
  }

  function buildHandout(h) {
    const card = document.createElement('div');
    card.className = 'bb-handout';
    card.dataset.id = h.id;
    // A little tilt, the same every time for the same handout, so the board
    // looks pinned-up rather than tiled.
    let hash = 0; for (const ch of h.id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    card.style.setProperty('--tilt', (((hash % 500) / 500) * 3.2 - 1.6).toFixed(2) + 'deg');
    const img = document.createElement('img');
    img.draggable = false; img.alt = '';
    const cap = document.createElement('div'); cap.className = 'bb-cap';
    const stack = document.createElement('button'); stack.className = 'bb-notes-stack';
    stack.style.display = 'none';
    stack.addEventListener('pointerdown', ev => ev.stopPropagation());
    stack.addEventListener('click', ev => { ev.stopPropagation(); openFocus([h.id]); });
    const acts = document.createElement('div'); acts.className = 'bb-acts';
    const mk = (label, title, fn) => {
      const b = document.createElement('button'); b.className = 'bb-act'; b.textContent = label; b.title = title;
      b.addEventListener('pointerdown', ev => ev.stopPropagation());
      b.addEventListener('click', ev => { ev.stopPropagation(); fn(); });
      acts.appendChild(b);
      return b;
    };
    const e2 = {};   // filled in below; the ◐ button reads it
    mk('⤢', 'Open full-screen for everyone', () => openFocus([h.id]));
    mk('⤓', 'Send to the bottom of the pile', () => { doOp({ op: 'lower', id: h.id }, null, 'h:' + h.id); });
    // Cut the background away (or put it back) — only offered when the
    // image has one to cut.
    const bgBtn = mk('◐', 'Remove the background', () => {
      const cur = byId(h.id) || h;
      doOp({ op: 'style', id: h.id, cutout: cur.cutout === false }, 'style:' + h.id);
    });
    bgBtn.style.display = 'none';
    // The GM's alone: the title players see, and taking it off the board.
    if (opts.canRetitle) mk('✎', 'Title the players see (they never see the filename)', () => opts.canRetitle(byId(h.id) || h));
    if (opts.canUnshare) mk('✕', 'Take this off the players’ board', () => opts.canUnshare(byId(h.id) || h));
    const rs = document.createElement('div'); rs.className = 'bb-resize'; rs.title = 'Drag to resize';
    card.append(img, cap, stack, acts, rs);
    const pin = document.createElement('div');
    pin.className = 'bb-pin'; pin.dataset.id = h.id;
    pin.title = 'Drag to move this handout';
    // A loose end of yarn hanging off the pin. Drag it to another handout to
    // string the two together — no mode to switch into.
    const tail = document.createElement('div');
    tail.className = 'bb-tail'; tail.dataset.id = h.id;
    tail.title = 'Drag onto another handout to connect them with yarn';
    tail.innerHTML = '<svg width="34" height="46" viewBox="0 0 34 46">'
      + '<path class="bb-tail-yarn" d="M2,2 C10,10 2,18 12,24 C22,30 14,36 24,40"/>'
      + '<path class="bb-tail-fray" d="M24,40 l5,1 M24,40 l3,4 M24,40 l6,-2"/>'
      + '<circle class="bb-tail-grab" cx="24" cy="40" r="9"/></svg>';
    Object.assign(e2, { card, img, cap, stack, pin, tail, bgBtn, cut: null, cutFor: '' });
    return e2;
  }

  function renderYarn() {
    const d = doc;
    const lines = [];
    const inv = 1 / view().z;
    const curve = (a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      const sag = Math.min(120, len * 0.12);      // string hangs a little
      return `M${a.x},${a.y} Q${(a.x + b.x) / 2},${(a.y + b.y) / 2 + sag} ${b.x},${b.y}`;
    };
    const snips = [];
    (d ? d.yarn : []).forEach(y => {
      const a = byId(y.a), b = byId(y.b);
      if (!a || !b) return;
      const pa = pinPos(a), pb = pinPos(b);
      const path = curve(pa, pb);
      lines.push(`<path class="bb-string-hit" data-yarn="${y.id}" d="${path}" stroke-width="${10 * inv}"/>`
               + `<path class="bb-string" d="${path}" stroke-width="${3 * inv}"/>`);
      // A snip a little way along the string from each pin.
      const len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
      const sag = Math.min(120, len * 0.12);
      const c = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 + sag };
      const at = (t) => ({ x: (1 - t) * (1 - t) * pa.x + 2 * (1 - t) * t * c.x + t * t * pb.x,
                           y: (1 - t) * (1 - t) * pa.y + 2 * (1 - t) * t * c.y + t * t * pb.y });
      const t = Math.min(0.4, (34 * inv) / len);
      [at(t), at(1 - t)].forEach(q => snips.push(
        `<button class="bb-snip${snipShown(y) ? ' on' : ''}" data-yarn="${y.id}" title="Cut this string"`
        + ` style="left:${q.x}px;top:${q.y}px">✂</button>`));
    });
    snipLayer.innerHTML = snips.join('');
    if (yarnDrag) {
      const a = byId(yarnDrag.from);
      if (a) lines.push(`<path class="bb-string live" d="${curve(pinPos(a), yarnDrag)}" stroke-width="${3 * inv}"/>`);
    }
    svg.innerHTML = lines.join('');
  }

  // ---------------------------------------------------------------- input
  const pointers = new Map();     // pointerId -> {x, y}
  let gesture = null;
  let lastClick = { id: null, t: 0 };

  vp.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button > 0) return;
    const pt = clientToVp(e);
    pointers.set(e.pointerId, pt);
    try { vp.setPointerCapture(e.pointerId); } catch (err) {}
    if (pointers.size === 2) { startPinch(); return; }
    if (pointers.size > 2) return;
    hideCut();
    const pinEl = e.target.closest('.bb-pin');
    const tailEl = e.target.closest('.bb-tail');
    const rsEl = e.target.closest('.bb-resize');
    const cardEl = e.target.closest('.bb-handout');
    const yarnEl = e.target.closest('[data-yarn]');
    if (tailEl) {
      const h = byId(tailEl.dataset.id); if (!h) return;
      e.preventDefault();
      gesture = { kind: 'yarn', from: h.id };
      const w = toWorld(pt.x, pt.y);
      yarnDrag = { from: h.id, x: w.x, y: w.y, to: null };
      render();
      return;
    }
    if (pinEl) {
      const h = byId(pinEl.dataset.id); if (!h) return;
      e.preventDefault();
      selected = h.id;
      hold('h:' + h.id, Infinity);
      doOp({ op: 'raise', id: h.id }, 'raise:' + h.id);
      const w = toWorld(pt.x, pt.y);
      gesture = { kind: 'move', id: h.id, dx: w.x - h.x, dy: w.y - h.y };
      vp.classList.add('grabbing');
      return;
    }
    if (rsEl && cardEl) {
      const h = byId(cardEl.dataset.id); if (!h) return;
      e.preventDefault();
      selected = h.id;
      hold('h:' + h.id, Infinity);
      gesture = { kind: 'resize', id: h.id };
      return;
    }
    // Anything else is the start of a pan — or, if nothing moves before the
    // release, a click. Only a full click raises a handout, so a drag that
    // happens to start on one still just pans the board.
    const v = view();
    gesture = { kind: 'pan', sx: pt.x, sy: pt.y, cx: v.cx, cy: v.cy, moved: false,
                card: cardEl ? cardEl.dataset.id : null, yarn: yarnEl ? yarnEl.dataset.yarn : null };
  });

  vp.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const pt = clientToVp(e);
    pointers.set(e.pointerId, pt);
    if (!gesture) return;
    if (gesture.kind === 'pinch') { movePinch(); return; }
    if (gesture.kind === 'move') {
      const w = toWorld(pt.x, pt.y), h = byId(gesture.id); if (!h) return;
      doOp({ op: 'move', id: h.id, x: w.x - gesture.dx, y: w.y - gesture.dy }, 'move:' + h.id);
    } else if (gesture.kind === 'resize') {
      const w = toWorld(pt.x, pt.y), h = byId(gesture.id); if (!h) return;
      const nw = Math.max(60, Math.min(4000, w.x - h.x));
      doOp({ op: 'move', id: h.id, x: h.x, y: h.y, w: nw }, 'move:' + h.id);
    } else if (gesture.kind === 'yarn') {
      const w = toWorld(pt.x, pt.y);
      const to = targetAt(e.clientX, e.clientY, gesture.from);
      const changed = !yarnDrag || yarnDrag.to !== to;
      yarnDrag = { from: gesture.from, x: w.x, y: w.y, to };
      if (changed) render(); else renderYarn();
    } else if (gesture.kind === 'pan') {
      if (!gesture.moved && Math.hypot(pt.x - gesture.sx, pt.y - gesture.sy) < 5) return;
      if (!gesture.moved) { gesture.moved = true; vp.classList.add('grabbing'); }
      const z = view().z;
      setView({ cx: gesture.cx - (pt.x - gesture.sx) / z, cy: gesture.cy - (pt.y - gesture.sy) / z, z }, true);
    }
  });

  const endPointer = (e) => {
    if (!pointers.has(e.pointerId)) return;
    const pt = clientToVp(e);
    pointers.delete(e.pointerId);
    const g = gesture;
    if (g && g.kind === 'pinch') {
      if (pointers.size === 0) { gesture = null; release('view'); sendView(); }
      return;
    }
    gesture = null;
    vp.classList.remove('grabbing');
    if (!g) return;
    if (g.kind === 'move' || g.kind === 'resize') { release('h:' + g.id); render(); return; }
    if (g.kind === 'yarn') {
      const to = targetAt(e.clientX, e.clientY, g.from);
      yarnDrag = null;
      if (to) connect(g.from, to);
      render();
      return;
    }
    if (g.kind === 'pan') {
      if (g.moved) { release('view'); sendView(); return; }
      // A click.
      if (g.yarn) {
        // A click on a string shows its scissors (the touch-screen way in).
        pickedYarn = g.yarn;
        updateSnips();
        return;
      }
      if (g.card) {
        const h = byId(g.card);
        // Our own double-click: raising the handout reorders the DOM between
        // the two clicks, and the browser's dblclick does not survive that.
        const now = performance.now();
        if (lastClick.id === g.card && now - lastClick.t < 400) {
          lastClick = { id: null, t: 0 };
          openFocus([g.card]);
          return;
        }
        lastClick = { id: g.card, t: now };
        selected = g.card;
        if (h) doOp({ op: 'raise', id: h.id }, 'raise:' + h.id, 'h:' + h.id);
      } else {
        selected = null;
      }
      render();
    }
  };
  vp.addEventListener('pointerup', endPointer);
  // What is under the pointer decides which strings show their scissors.
  vp.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const y = e.target.closest && e.target.closest('[data-yarn]');
    const h = e.target.closest && e.target.closest('.bb-handout, .bb-pin, .bb-tail');
    const ny = y ? y.dataset.yarn : null, nh = h ? h.dataset.id : null;
    if (ny === hoverYarn && nh === hoverId) return;
    hoverYarn = ny; hoverId = nh;
    updateSnips();
  });
  vp.addEventListener('pointerleave', () => { hoverYarn = null; hoverId = null; updateSnips(); });
  vp.addEventListener('pointercancel', endPointer);

  function sendView() { const v = view(); sendOp({ op: 'view', cx: v.cx, cy: v.cy, z: v.z }, 'view'); }

  function startPinch() {
    const [a, b] = Array.from(pointers.values());
    const v = view();
    if (gesture && (gesture.kind === 'move' || gesture.kind === 'resize')) release('h:' + gesture.id);
    gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
                m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: { ...v } };
  }
  function movePinch() {
    const pts = Array.from(pointers.values()); if (pts.length < 2) return;
    const [a, b] = pts, g = gesture, { W, H } = size();
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const z = Math.max(0.05, Math.min(8, g.v0.z * d / g.d0));
    // The world point that was under the first midpoint stays under the finger.
    const px = (g.m0.x - W / 2) / g.v0.z + g.v0.cx, py = (g.m0.y - H / 2) / g.v0.z + g.v0.cy;
    setView({ cx: px - (m.x - W / 2) / z, cy: py - (m.y - H / 2) / z, z }, true);
  }

  let wheelTimer = 0;
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    const pt = clientToVp(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(pt.x, pt.y, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), true);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { release('view'); sendView(); }, 180);
  }, { passive: false });


  // Which handout a dragged yarn end is over: its pin, its tail or any part of
  // the handout itself. Never the one the yarn starts from.
  function targetAt(cx, cy, from) {
    const under = document.elementsFromPoint(cx, cy);
    for (const el of under) {
      const hit = el.closest && el.closest('.bb-pin, .bb-tail, .bb-handout');
      if (!hit || !root.contains(hit)) continue;
      const id = hit.dataset.id;
      if (id && id !== from) return id;
    }
    return null;
  }

  function connect(a, b) {
    if (!a || !b || a === b) return;
    sendOp({ op: 'yarn_add', a, b });
  }

  root.querySelector('.bb-toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bb]'); if (!b) return;
    const { W, H } = size();
    if (b.dataset.bb === 'zoom-in') zoomAt(W / 2, H / 2, 1.25);
    else if (b.dataset.bb === 'zoom-out') zoomAt(W / 2, H / 2, 0.8);
    else if (b.dataset.bb === 'fit') fitAll();

  });

  // --------------------------------------------------------- full-screen
  // Shared, like everything else: whoever opens a handout opens it on every
  // screen, and whoever closes it closes it for everyone.
  let modalKey = '';
  let picking = false;
  const drafts = {};              // handout id -> text being typed
  const editing = {};             // handout id -> note id being edited
  const openFocus = (ids) => { picking = false; doOp({ op: 'focus', ids }, 'focus'); };
  const closeFocus = () => { picking = false; doOp({ op: 'focus', ids: [] }, 'focus'); };

  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.classList.contains('bb-modal-inner')) closeFocus();
  });
  document.addEventListener('keydown', (e) => {
    if (!visible || e.key !== 'Escape') return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') return;
    if (doc && doc.focus && doc.focus.length) { e.preventDefault(); closeFocus(); }

  });

  function renderModal() {
    const ids = ((doc && doc.focus) || []).filter(id => byId(id));
    if (!ids.length) { modal.style.display = 'none'; modalKey = ''; return; }
    modal.style.display = '';
    const key = ids.join('|') + (picking ? '|pick' : '');
    if (key !== modalKey) {
      modalKey = key;
      modal.innerHTML = '<div class="bb-modal-inner bb-n' + ids.length + '">'
        + ids.map(id => paneHTML(byId(id), ids.length)).join('')
        + '</div><button class="bb-modal-close" title="Close for everyone (Esc)">✕</button>'
        + (ids.length === 1
          ? '<button class="bb-modal-side" title="Put a second handout beside this one">⧉ Side by side…</button>'
          : '')
        + (picking ? pickerHTML(ids[0]) : '');
      modal.querySelector('.bb-modal-close').onclick = closeFocus;
      const side = modal.querySelector('.bb-modal-side');
      if (side) side.onclick = () => { picking = !picking; renderModal(); };
      modal.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => openFocus([ids[0], b.dataset.pick]));
      modal.querySelectorAll('[data-drop]').forEach(b => b.onclick = () => openFocus(ids.filter(x => x !== b.dataset.drop)));
      ids.forEach(id => wirePane(id));
    }
    ids.forEach(id => renderNotes(id));
  }

  const esc = (t) => String(t == null ? '' : t).replace(/[<>&"]/g,
    ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));

  function paneHTML(h, n) {
    return `<div class="bb-pane" data-pane="${h.id}">
      <div class="bb-pane-head"><span class="bb-pane-title${!h.title && h.name ? ' gm-only' : ''}">${esc(h.title || h.name || '')}</span>
        ${n > 1 ? `<button class="bb-pane-x" data-drop="${h.id}" title="Close this one">✕</button>` : ''}</div>
      <div class="bb-pane-body">
        <div class="bb-pane-img"><img src="${esc(h.src)}" alt="" draggable="false"></div>
        <div class="bb-notes">
          <div class="bb-notes-head">Notes</div>
          <div class="bb-notes-list"></div>
          <div class="bb-compose">
            <textarea rows="3" placeholder="Add a note everyone can see…"></textarea>
            <div class="bb-compose-row"><button class="bb-note-save">Add note</button>
              <button class="bb-note-cancel" style="display:none;">Cancel</button>
              <span class="bb-note-status"></span></div>
          </div>
        </div>
      </div></div>`;
  }

  function pickerHTML(current) {
    const others = doc.handouts.filter(h => h.id !== current);
    return '<div class="bb-picker"><div class="bb-picker-head">Pick one to put beside it</div><div class="bb-picker-row">'
      + (others.length ? others.map(h => `<button class="bb-pick" data-pick="${h.id}">`
          + `<img src="${esc(h.src)}" alt=""><span>${esc(h.title || h.name || '')}</span></button>`).join('')
        : '<div class="bb-picker-none">Nothing else is on the board yet.</div>')
      + '</div></div>';
  }

  function wirePane(id) {
    const pane = modal.querySelector(`[data-pane="${id}"]`); if (!pane) return;
    const ta = pane.querySelector('textarea');
    const status = pane.querySelector('.bb-note-status');
    const save = pane.querySelector('.bb-note-save');
    const cancel = pane.querySelector('.bb-note-cancel');
    ta.value = drafts[id] || '';
    ta.addEventListener('input', () => { drafts[id] = ta.value; });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save.click(); });
    const syncButtons = () => {
      save.textContent = editing[id] ? 'Save change' : 'Add note';
      cancel.style.display = editing[id] ? '' : 'none';
    };
    syncButtons();
    save.onclick = async () => {
      const text = ta.value.trim();
      if (!text) { status.textContent = 'nothing to add'; return; }
      const me = identity();
      status.textContent = 'saving…';
      const op = editing[id]
        ? { op: 'note_edit', hid: id, nid: editing[id], text, by: me.name, gm: !!me.gm }
        : { op: 'note_add', hid: id, text, by: me.name, character: me.character || '', gm: !!me.gm };
      const ok = await postNow(op);
      status.textContent = ok ? '' : 'could not save — is the GM’s server up?';
      if (ok) { drafts[id] = ''; ta.value = ''; editing[id] = null; syncButtons(); }
    };
    cancel.onclick = () => { editing[id] = null; drafts[id] = ''; ta.value = ''; syncButtons(); };
    pane._syncButtons = syncButtons;
    pane._ta = ta;
  }

  async function postNow(op) {
    try {
      const r = await fetch('/api/board/op', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                               body: JSON.stringify({ ops: [op] }) });
      const d = await r.json();
      if (!r.ok) { flash((d.results && d.results[0] && d.results[0].error) || 'refused'); return false; }
      if (d.version) { /* the poll brings the note back */ }
      return true;
    } catch (e) { return false; }
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function sessionOf(at) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(at || '');
    if (!m) return { day: 'an earlier session', time: '' };
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return { day: DAYS[d.getDay()] + ' ' + (+m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1], time: m[4] + ':' + m[5] };
  }

  let bubbleFor = null;
  function showBubble(i) {
    let b = root.querySelector('.bb-bubble-float');
    if (!b) { b = document.createElement('div'); b.className = 'bb-bubble-float'; root.appendChild(b); }
    b.innerHTML = i.querySelector('.bb-bubble').innerHTML;
    b.style.display = 'block';
    const r = i.getBoundingClientRect(), rr = root.getBoundingClientRect(), bw = b.offsetWidth, bh = b.offsetHeight;
    let x = r.right - rr.left - bw + 8, y = r.top - rr.top - bh - 8;
    if (y < 4) y = r.bottom - rr.top + 8;
    b.style.left = Math.max(4, x) + 'px'; b.style.top = y + 'px';
    bubbleFor = i;
  }
  function hideBubble() {
    const b = root.querySelector('.bb-bubble-float'); if (b) b.style.display = 'none';
    bubbleFor = null;
  }

  function renderNotes(id) {
    const pane = modal.querySelector(`[data-pane="${id}"]`); if (!pane) return;
    const list = pane.querySelector('.bb-notes-list');
    const notes = ((doc.notes || {})[id] || []);
    const me = identity();
    const sig = JSON.stringify(notes) + '|' + me.name + '|' + !!me.gm + '|' + (editing[id] || '');
    if (list._sig === sig) return;
    list._sig = sig;
    if (!notes.length) { list.innerHTML = '<div class="bb-notes-empty">No notes yet. Be the first.</div>'; return; }
    list.innerHTML = notes.map(n => {
      const s = sessionOf(n.at);
      const who = n.gm ? esc(n.by || (doc.gmName || 'The Handler'))
        : esc(n.by || 'a player') + (n.character ? ' <span class="bb-as">as</span> ' + esc(n.character) : '');
      const mine = n.gm ? !!me.gm : (!me.gm && n.by === me.name);
      const canTouch = mine || !!me.gm;
      const tint = !n.gm && opts.colorFor ? opts.colorFor(n.by) : '';
      const info = `Session of ${s.day}${s.time ? ', ' + s.time : ''}\n`
        + (n.gm ? (n.by || 'The Handler') : (n.by || 'a player') + (n.character ? ' — playing ' + n.character : ''))
        + (n.edited ? '\nEdited ' + n.edited : '');
      return `<div class="bb-note${n.gm ? ' gm' : ''}${editing[id] === n.id ? ' editing' : ''}">
        <div class="bb-note-text">${esc(n.text)}</div>
        <div class="bb-note-foot"><span class="bb-note-by"${tint ? ` style="color:${esc(tint)}"` : ''}>${who}</span>
          <span class="bb-info" tabindex="0" aria-label="${esc(info)}">ⓘ
            <span class="bb-bubble"><b>Session of ${esc(s.day)}</b>${s.time ? ' · ' + esc(s.time) : ''}<br>
              ${n.gm ? esc(n.by || 'The Handler') : esc(n.by || 'a player') + (n.character ? ' — playing <b>' + esc(n.character) + '</b>' : '')}
              ${n.edited ? '<br><i>edited ' + esc(n.edited.slice(0, 16)) + '</i>' : ''}</span></span>
          ${canTouch ? `<span class="bb-note-acts">${mine ? `<button data-nedit="${n.id}" title="Change your note">✎</button>` : ''}`
            + `<button data-ndel="${n.id}" title="Remove this note">🗑</button></span>` : ''}
        </div></div>`;
    }).join('');
    list.querySelectorAll('[data-nedit]').forEach(b => b.onclick = () => {
      const n = notes.find(x => x.id === b.dataset.nedit); if (!n) return;
      editing[id] = n.id; drafts[id] = n.text;
      pane._ta.value = n.text; pane._ta.focus(); pane._syncButtons(); list._sig = ''; renderNotes(id);
    });
    list.querySelectorAll('[data-ndel]').forEach(b => b.onclick = () => {
      if (!confirm('Remove this note for everyone?')) return;
      const me2 = identity();
      postNow({ op: 'note_del', hid: id, nid: b.dataset.ndel, by: me2.name, gm: !!me2.gm });
    });
    // The bubble floats over everything (the list scrolls, and would clip it).
    // Hover shows it; on a phone there is no hover, so a tap toggles it.
    list.querySelectorAll('.bb-info').forEach(i => {
      i.onmouseenter = () => showBubble(i);
      i.onmouseleave = hideBubble;
      i.onfocus = () => showBubble(i);
      i.onblur = hideBubble;
      i.onclick = (e) => { e.stopPropagation(); if (bubbleFor === i) hideBubble(); else showBubble(i); };
    });
  }

  // ------------------------------------------------------------ lifecycle
  onBoard(() => render());
  window.addEventListener('resize', () => render());
  return {
    show() { visible = true; root.style.display = 'block'; startBoardSync(); refreshBoard(); requestAnimationFrame(render); },
    hide() { visible = false; root.style.display = 'none'; },
    isShown: () => visible,
    render,
  };
}

const PIN_INSET = 12;   // board units from the top edge of a handout to its pin

// ------------------------------------------------------- background cut-out ---
// A handout with an obvious, flat background (a portrait on a plain backdrop,
// a medallion on a square of parchment) is pinned up as a cut-out: the
// background is flood-filled away from the edges and made transparent.
//
// Deliberately conservative. It only happens when nearly the whole border is
// one colour, and only when that colour is a modest share of the picture — a
// typed letter is white paper to the edges and mostly white, and cutting it
// out would leave loose ink floating on the cork.
//
// Images that are already transparent at the edges are used as they are.
// Resolves to null (keep the image as it is) or
//   { url, top, removed }  — `top` is where the picture starts (0..1 of the
//   height), so the pin can go through it rather than through thin air.
const cutCache = new Map();
export function cutoutFor(src) {
  if (!cutCache.has(src)) cutCache.set(src, new Promise(res => {
    const img = new Image();
    img.onload = () => setTimeout(() => { try { res(analyse(img)); } catch (e) { res(null); } }, 0);
    img.onerror = () => res(null);
    img.src = src;
  }));
  return cutCache.get(src);
}

function analyse(img) {
  const MAX = 1600;
  const k = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.max(1, Math.round(img.naturalWidth * k)), H = Math.max(1, Math.round(img.naturalHeight * k));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const id = ctx.getImageData(0, 0, W, H), px = id.data;

  const border = [];
  for (let x = 0; x < W; x++) { border.push(x, (H - 1) * W + x); }
  for (let y = 1; y < H - 1; y++) { border.push(y * W, y * W + W - 1); }

  const topOf = (isBg) => {
    // First row whose middle third holds picture.
    for (let y = 0; y < H; y++)
      for (let x = Math.floor(W / 3); x < Math.ceil(2 * W / 3); x++)
        if (!isBg(y * W + x)) return y / H;
    return 0;
  };

  // Already transparent round the edges: nothing to cut, but it is a cut-out.
  const clear = border.filter(i => px[i * 4 + 3] < 16).length;
  if (clear / border.length > 0.6) {
    return { url: img.src, top: topOf(i => px[i * 4 + 3] < 16), removed: false };
  }

  // The border's dominant colour, and how much of the border it covers.
  const buckets = new Map();
  for (const i of border) {
    const o = i * 4;
    const key = (px[o] >> 4) << 8 | (px[o + 1] >> 4) << 4 | (px[o + 2] >> 4);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  let best = 0, bestN = 0;
  for (const [key, n] of buckets) if (n > bestN) { best = key; bestN = n; }
  let r = 0, g = 0, b = 0, m = 0;
  for (const i of border) {
    const o = i * 4;
    if (((px[o] >> 4) << 8 | (px[o + 1] >> 4) << 4 | (px[o + 2] >> 4)) === best) { r += px[o]; g += px[o + 1]; b += px[o + 2]; m++; }
  }
  r /= m; g /= m; b /= m;
  const T = 30;
  const dist = (o) => Math.hypot(px[o] - r, px[o + 1] - g, px[o + 2] - b);
  const onBg = border.filter(i => dist(i * 4) < T).length;
  if (onBg / border.length < 0.85) return null;          // no one background colour

  // Flood fill from every background pixel on the border.
  const bg = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let sp = 0;
  for (const i of border) if (!bg[i] && dist(i * 4) < T) { bg[i] = 1; stack[sp++] = i; }
  while (sp) {
    const i = stack[--sp], x = i % W;
    const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
    for (const j of nb) {
      if (j < 0 || j >= W * H || bg[j]) continue;
      if (dist(j * 4) < T) { bg[j] = 1; stack[sp++] = j; }
    }
  }
  let removed = 0;
  for (let i = 0; i < W * H; i++) removed += bg[i];
  const share = removed / (W * H);
  if (share < 0.03 || share > 0.7) return null;          // nothing to cut, or it IS the page

  // A real backdrop lies OUTSIDE the picture. If the fill has leaked into its
  // middle — the white of a map or a letter, reached through a gap in the
  // frame — this is not a background, it is the page. Count background pixels
  // that sit inside the picture's extent along both their row and column.
  const rowA = new Int32Array(H).fill(W), rowB = new Int32Array(H).fill(-1);
  const colA = new Int32Array(W).fill(H), colB = new Int32Array(W).fill(-1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (bg[y * W + x]) continue;
    if (x < rowA[y]) rowA[y] = x; if (x > rowB[y]) rowB[y] = x;
    if (y < colA[x]) colA[x] = y; if (y > colB[x]) colB[x] = y;
  }
  let inside = 0;
  for (let y = 0; y < H; y++) for (let x = rowA[y] + 1; x < rowB[y]; x++) {
    if (bg[y * W + x] && y > colA[x] && y < colB[x]) inside++;
  }
  if (inside / removed > 0.08) return null;

  // Transparent background, with a soft one-pixel edge so the outline is not
  // jagged.
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (bg[i]) { px[o + 3] = 0; continue; }
    const x = i % W;
    const edge = (x > 0 && bg[i - 1]) || (x < W - 1 && bg[i + 1]) || (i >= W && bg[i - W]) || (i + W < W * H && bg[i + W]);
    if (edge) px[o + 3] = Math.min(px[o + 3], Math.max(60, Math.min(255, (dist(o) - T) / T * 255)));
  }
  ctx.putImageData(id, 0, 0);
  const url = c.toDataURL('image/png');
  return { url, top: topOf(i => bg[i] === 1), removed: true };
}
