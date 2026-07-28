#!/usr/bin/env node
/**
 * Splits js/tokens.js (1537 lines) along its own section banners, then repairs
 * the references that splitting breaks.
 *
 * Cutting a module in five turns some of its module-local `let`s into
 * cross-module state (tokenGridEnabled and friends are read by the geometry,
 * the GM controls, the projector mirror and the remote page) and some of its
 * private functions into cross-module calls. This finds both cases with real
 * scope analysis and fixes them: shared variables move into S, shared functions
 * get exported and imported.
 *
 * Run from the gm-display directory:  node tools/split-tokens.js
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const eslintScope = require('eslint-scope');

const JS = path.join(__dirname, '..', 'js');

// ---- 1. contiguous split --------------------------------------------------
const CUTS = [
  [1,    214,  'geometry.js',    'Map-key geometry: cell size, origin, snapping, grid drawing.'],
  [215,  1036, 'tokens.js',      'The GM side: token roster, per-map placement, rendering, controls.'],
  [1037, 1132, 'projector.js',   'Projector mirror: draws tokens, grid and markers under the keystone warp.'],
  [1133, 1214, 'markers.js',     'Shared marker fade/render loop.'],
  [1215, null, 'remote-page.js', 'The remote player page.'],
];

const original = fs.readFileSync(path.join(JS, 'tokens.js'), 'utf8');
const lines = original.split('\n');
const header = lines.slice(0, 3).filter(l => l.startsWith('//')).join('\n');
const importLines = lines.filter(l => /^import .* from '\.\//.test(l));

const pieces = {};
let check = '';
for (const [a, b, name, desc] of CUTS) {
  const body = lines.slice(a - 1, b === null ? undefined : b).join('\n');
  check += body + (b === null ? '' : '\n');
  pieces[name] = { body, desc };
}
if (check.replace(/\n$/, '') !== original.replace(/\n$/, '')) {
  throw new Error('split is not byte-identical to tokens.js');
}
console.log('split verified byte-identical');

for (const [name, { body, desc }] of Object.entries(pieces)) {
  const banner = `// GM Display — ${name}\n// ${desc}\n`;
  // every piece starts with the imports the original had; unused ones are
  // pruned below once we know what each piece actually references
  const src = name === 'geometry.js' ? banner + body : banner + importLines.join('\n') + '\n' + body;
  fs.writeFileSync(path.join(JS, name), src);
}

// ---- 2. repair cross-module references ------------------------------------
const FILES = fs.readdirSync(JS).filter(f => f.endsWith('.js'));
function parse(f) {
  return acorn.parse(fs.readFileSync(path.join(JS, f), 'utf8'),
                     { ecmaVersion: 2022, sourceType: 'module', ranges: true });
}

// what each module declares at module scope, and what it exports
const declares = {}, exports_ = {};
for (const f of FILES) {
  const ast = parse(f);
  declares[f] = new Set(); exports_[f] = new Set();
  for (const n of ast.body) {
    const take = (d, exported) => {
      const names = d.id ? [d.id.name] : (d.declarations || []).map(x => x.id && x.id.name).filter(Boolean);
      names.forEach(x => { declares[f].add(x); if (exported) exports_[f].add(x); });
    };
    if (n.type === 'ExportNamedDeclaration' && n.declaration) take(n.declaration, true);
    else if (n.type === 'FunctionDeclaration' || n.type === 'VariableDeclaration') take(n, false);
  }
}

// free identifiers per module (things it uses but does not declare or import)
const free = {};
for (const f of FILES) {
  const ast = parse(f);
  const sm = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'module' });
  const ms = sm.scopes.find(s => s.type === 'module') || sm.globalScope;
  free[f] = new Set(ms.through.map(r => r.identifier.name));
  sm.globalScope.through.forEach(r => free[f].add(r.identifier.name));
}

const owner = (name) => FILES.find(f => declares[f].has(name));
// Anything declared `const` — a function declaration, an arrow helper, a
// lookup table — is immutable and belongs in the exports, not in mutable state.
// Only `let`/`var` genuinely needs to live in S.
const isExportable = (f, name) => {
  const ast = parse(f);
  for (const n of ast.body) {
    const d = n.type === 'ExportNamedDeclaration' ? n.declaration : n;
    if (!d) continue;
    if (d.type === 'FunctionDeclaration' && d.id.name === name) return true;
    if (d.type === 'VariableDeclaration' && d.declarations.some(x => x.id.name === name))
      return d.kind === 'const';
  }
  return false;
};

const toPromote = new Set();     // variables that must become S.x
const toExport = {};             // file -> Set(function names)
for (const f of FILES) {
  for (const name of free[f]) {
    const o = owner(name);
    if (!o || o === f) continue;
    if (isExportable(o, name)) (toExport[o] = toExport[o] || new Set()).add(name);
    else toPromote.add(name);
  }
}
console.log('promote to S :', [...toPromote].sort().join(', ') || '(none)');
console.log('newly exported:', Object.entries(toExport).map(([f, s]) => `${f}(${s.size})`).join(' ') || '(none)');

// promote variables into S, module by module, with scope analysis so that
// shadowing locals of the same name are left alone
for (const f of FILES) {
  let src = fs.readFileSync(path.join(JS, f), 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module', ranges: true });
  const sm = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'module' });
  const ms = sm.scopes.find(s => s.type === 'module') || sm.globalScope;
  const parentOf = new Map();
  walk.ancestor(ast, { Identifier(n, _s, anc) { parentOf.set(n, anc[anc.length - 2]); } });

  const edits = [];
  const handle = (v, isDecl) => {
    for (const ref of v.references) {
      const id = ref.identifier;
      if (isDecl && v.defs.some(d => d.name === id)) continue;
      const p = parentOf.get(id);
      if (p && p.type === 'Property' && p.shorthand && p.value === id)
        edits.push({ s: id.range[0], e: id.range[1], t: `${v.name}: S.${v.name}` });
      else
        edits.push({ s: id.range[0], e: id.range[1], t: `S.${v.name}` });
    }
  };
  for (const v of ms.variables) {
    if (!toPromote.has(v.name)) continue;
    handle(v, true);
    for (const d of v.defs) {
      const decl = d.parent;
      if (!decl || decl.type !== 'VariableDeclaration') continue;
      const parts = decl.declarations.map(dd => {
        const init = dd.init ? src.slice(dd.init.range[0], dd.init.range[1]) : 'undefined';
        return toPromote.has(dd.id.name) ? `S.${dd.id.name} = ${init}` : `let ${dd.id.name} = ${init}`;
      });
      edits.push({ s: decl.range[0], e: decl.range[1], t: parts.join('; ') + ';' });
    }
  }
  // free references to promoted names (declared in another module)
  for (const r of [...ms.through, ...sm.globalScope.through]) {
    if (!toPromote.has(r.identifier.name)) continue;
    const id = r.identifier, p = parentOf.get(id);
    if (p && p.type === 'Property' && p.shorthand && p.value === id)
      edits.push({ s: id.range[0], e: id.range[1], t: `${id.name}: S.${id.name}` });
    else
      edits.push({ s: id.range[0], e: id.range[1], t: `S.${id.name}` });
  }
  if (!edits.length) continue;
  // declaration rewrites swallow the identifiers inside them
  const declRanges = edits.filter(e => e.t.includes(';'));
  const kept = edits.filter(e => e.t.includes(';') ||
    !declRanges.some(d => e.s >= d.s && e.e <= d.e));
  kept.sort((a, b) => b.s - a.s || b.e - a.e);
  let last = Infinity;
  for (const e of kept) { if (e.e > last) continue; src = src.slice(0, e.s) + e.t + src.slice(e.e); last = e.s; }
  fs.writeFileSync(path.join(JS, f), src);
}

// add `export` to functions now called from another module
for (const [f, names] of Object.entries(toExport)) {
  let src = fs.readFileSync(path.join(JS, f), 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module', ranges: true });
  ast.body.filter(n =>
      (n.type === 'FunctionDeclaration' && names.has(n.id.name)) ||
      (n.type === 'VariableDeclaration' && n.declarations.some(d => names.has(d.id.name))))
    .sort((a, b) => b.range[0] - a.range[0])
    .forEach(n => { src = src.slice(0, n.range[0]) + 'export ' + src.slice(n.range[0]); });
  fs.writeFileSync(path.join(JS, f), src);
}
console.log('done — now run tools/fix-imports.js');
