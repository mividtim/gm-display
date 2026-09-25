// GM Display — update-check.js
// When a new version of the pages lands on disk, say so.
//
// The server answers /api/build with a hash of the pages' file timestamps.
// A page remembers the one it loaded with; when it changes, the GM page and
// the player page show a small "updated — reload" bar (a reload mid-scene is
// the user's call), and the projector/sidecar windows, which hold no state of
// their own, simply reload.
let loadedWith = '';

export function startUpdateCheck(opts) {
  opts = opts || {};
  const tick = async () => {
    if (document.hidden) return;
    let b = '';
    try { b = (await (await fetch('/api/build', { cache: 'no-store' })).json()).build || ''; }
    catch (e) { return; }                         // server restarting; ask again later
    if (!b) return;
    if (!loadedWith) { loadedWith = b; return; }
    if (b === loadedWith) return;
    if (opts.auto) { location.reload(); return; }
    showBar();
  };
  tick();
  setInterval(tick, opts.every || 8000);
}

function showBar() {
  if (document.getElementById('gmd-update-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'gmd-update-bar';
  bar.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:100000;'
    + 'background:#1f2d1f;color:#d8f5d0;border:1px solid #5a9a4a;border-radius:8px;padding:7px 10px 7px 14px;'
    + 'font:13px system-ui,sans-serif;box-shadow:0 4px 16px #000a;display:flex;gap:10px;align-items:center;';
  bar.innerHTML = '<span>GM Display was updated.</span>';
  const go = document.createElement('button');
  go.textContent = 'Reload';
  go.style.cssText = 'background:#3c6a32;color:#fff;border:1px solid #6fb35c;border-radius:6px;padding:4px 12px;cursor:pointer;';
  go.onclick = () => location.reload();
  const later = document.createElement('button');
  later.textContent = '✕';
  later.title = 'Later';
  later.style.cssText = 'background:none;color:#9ab;border:none;cursor:pointer;font-size:14px;';
  later.onclick = () => bar.remove();
  bar.append(go, later);
  document.body.appendChild(bar);
}
