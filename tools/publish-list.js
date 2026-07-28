#!/usr/bin/env node
/**
 * Regenerates the `const PUBLIC = { ... }` line in js/gm.js from what the
 * modules actually export.
 *
 * The list is only a debug/test handle (window.GMD), but keeping it by hand
 * means a new export is invisible to tests/regress.py until someone remembers
 * to add it — which is exactly how party notes went missing. Run this after
 * adding exports, then `node tools/fix-imports.js` to pull in the imports.
 *
 *   node tools/publish-list.js
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const JS = path.join(__dirname, '..', 'js');
// Entry points are never imported by another module; bindings.js is excluded
// deliberately — publishing attachPlayerBindings/attachRemoteBindings from the
// GM page pulls the other pages' wiring into it and kills the page on load.
const SKIP = new Set(['gm.js', 'display.js', 'remote.js', 'bindings.js', 'store.js']);

const exportsOf = (file) => {
  const src = fs.readFileSync(path.join(JS, file), 'utf8');
  const names = [];
  for (const n of acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module' }).body) {
    if (n.type !== 'ExportNamedDeclaration' || !n.declaration) continue;
    const d = n.declaration;
    (d.id ? [d.id.name] : (d.declarations || []).map(x => x.id.name)).forEach(x => names.push(x));
  }
  return names;
};

const names = new Set(['S']);
for (const f of fs.readdirSync(JS).filter(f => f.endsWith('.js') && !SKIP.has(f))) {
  exportsOf(f).forEach(n => names.add(n));
}
// bindings.js: only the two diagnostics the harness asks for
['boundCount', 'unboundSelectors'].forEach(n => names.add(n));

const sorted = [...names].sort((a, b) =>
  a === 'S' ? -1 : b === 'S' ? 1 : a.localeCompare(b, 'en'));
const line = 'const PUBLIC = { ' + sorted.join(', ') + ' };';

const gmPath = path.join(JS, 'gm.js');
const gm = fs.readFileSync(gmPath, 'utf8');
const RE = /^const PUBLIC = \{[\s\S]*?\};$/m;
if (!RE.test(gm)) {
  console.error('could not find the PUBLIC line in js/gm.js');
  process.exitCode = 1;
} else {
  const out = gm.replace(RE, line);
  if (out !== gm) fs.writeFileSync(gmPath, out);
  console.log(`published ${sorted.length} names on window.GMD`
    + (out === gm ? ' (already current)' : ''));
  console.log('now run: node tools/fix-imports.js');
}
