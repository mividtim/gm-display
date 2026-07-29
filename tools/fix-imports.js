#!/usr/bin/env node
/**
 * Rewrites the import block at the top of every module in js/ so that it names
 * exactly what the module actually uses, and nothing it does not.
 *
 * Run after anything that moves code between modules.
 *   node tools/fix-imports.js
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const eslintScope = require('eslint-scope');

const JS = path.join(__dirname, '..', 'js');
const FILES = fs.readdirSync(JS).filter(f => f.endsWith('.js'));
const read = f => fs.readFileSync(path.join(JS, f), 'utf8');
const parse = (src) => acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module', ranges: true });

// who exports what
const exportedBy = {};
for (const f of FILES) {
  for (const n of parse(read(f)).body) {
    if (n.type !== 'ExportNamedDeclaration' || !n.declaration) continue;
    const d = n.declaration;
    (d.id ? [d.id.name] : (d.declarations || []).map(x => x.id.name))
      .forEach(name => { exportedBy[name] = f; });
  }
}

let changed = 0, missing = new Set();
for (const f of FILES) {
  const src = read(f);
  const ast = parse(src);
  const sm = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'module' });
  const ms = sm.scopes.find(s => s.type === 'module') || sm.globalScope;

  // strip existing imports, then recompute from what is left unresolved
  const imports = ast.body.filter(n => n.type === 'ImportDeclaration');
  const bodyStart = imports.length ? imports[imports.length - 1].range[1] : null;
  const headerEnd = src.split('\n').findIndex(l => !l.startsWith('//'));
  const header = src.split('\n').slice(0, headerEnd).join('\n');
  const rest = bodyStart !== null ? src.slice(bodyStart).replace(/^\n+/, '\n')
                                  : src.split('\n').slice(headerEnd).join('\n');

  const stripped = header + '\n' + rest;
  const sm2 = eslintScope.analyze(parse(stripped), { ecmaVersion: 2022, sourceType: 'module' });
  const ms2 = sm2.scopes.find(s => s.type === 'module') || sm2.globalScope;
  const freeNames = new Set([...ms2.through, ...sm2.globalScope.through].map(r => r.identifier.name));

  const need = {};
  for (const name of freeNames) {
    const owner = exportedBy[name];
    if (!owner || owner === f) continue;
    (need[owner] = need[owner] || new Set()).add(name);
  }
  if (freeNames.has('S') && f !== 'store.js') (need['store.js'] = need['store.js'] || new Set()).add('S');

  const lines = [];
  for (const owner of Object.keys(need).sort()) {
    lines.push(`import { ${[...need[owner]].sort().join(', ')} } from './${owner}';`);
  }
  const out = header + '\n' + (lines.length ? lines.join('\n') + '\n' : '') + rest.replace(/^\n/, '');
  if (out !== src) { fs.writeFileSync(path.join(JS, f), out); changed++; }

  // anything still free and not a browser global is a real problem
  const BROWSER = new Set(['window','document','console','localStorage','location','navigator','fetch',
    'Math','JSON','Object','Array','Number','String','Boolean','Date','Promise','Set','Map','Image',
    'Uint8Array','URLSearchParams','BroadcastChannel','setTimeout','setInterval','clearTimeout',
    'clearInterval','requestAnimationFrame','cancelAnimationFrame','parseInt','parseFloat','isNaN',
    'alert','confirm','prompt','FileReader','Blob','URL','performance','screen','history','Response',
    'devicePixelRatio','getComputedStyle','structuredClone','Event','CustomEvent','DOMParser','atob','btoa',
    'isFinite','decodeURI','encodeURI','decodeURIComponent','encodeURIComponent',
    'undefined','NaN','Infinity','Intl','RegExp','Error']);
  for (const name of freeNames) {
    if (!exportedBy[name] && !BROWSER.has(name)) missing.add(`${f}: ${name}`);
  }
}
console.log(`import blocks rewritten: ${changed}/${FILES.length}`);
if (missing.size) {
  console.log('unresolved identifiers:');
  [...missing].sort().forEach(m => console.log('   ' + m));
  process.exitCode = 1;
} else {
  console.log('every module resolves');
}
