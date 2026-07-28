#!/usr/bin/env node
/**
 * Converts the ordered classic scripts in js/ into real ES modules.
 *
 * Two things have to happen and both need real scope analysis, not regex:
 *
 *  1. Shared mutable state. 74 of the 133 globals are touched by more than one
 *     file. ES module bindings are read-only for importers, so those move into
 *     a single mutable object `S` exported by js/state.js, and every reference
 *     that actually resolves to the global (not a shadowing parameter, not a
 *     property name, not text inside a string) is rewritten to `S.x`.
 *     Globals used by only one file are left alone — they simply become
 *     module-local, which is the whole point.
 *
 *  2. Cross-file functions. 104 of the 288 functions are called from another
 *     file, so they get `export` and the callers get generated imports.
 *
 * Run from the gm-display directory:  node tools/to-modules.js
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const eslintScope = require('eslint-scope');

const JS = path.join(__dirname, '..', 'js');
const ORDER = ['state.js', 'games.js', 'per-map-store.js', 'init.js', 'fog.js',
               'sidebar.js', 'fog-presets.js', 'projection.js', 'crop.js',
               'navigation.js', 'player-view.js', 'keyboard.js', 'tokens.js'];

// Read the files and record where each one sits in the concatenated program,
// so a range from the whole-program parse can be mapped back to a file.
const src = {}, span = [];
let offset = 0, whole = '';
for (const f of ORDER) {
  const text = fs.readFileSync(path.join(JS, f), 'utf8');
  src[f] = text;
  span.push({ file: f, start: offset, end: offset + text.length });
  whole += text;
  offset += text.length;
}
const fileAt = (pos) => span.find(s => pos >= s.start && pos < s.end);

const ast = acorn.parse(whole, { ecmaVersion: 2022, sourceType: 'script', ranges: true });
const sm = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'script' });
const g = sm.globalScope;

// Parent map, so shorthand properties (`{ tokens }`) can be spotted.
const parentOf = new Map();
walk.ancestor(ast, {
  Identifier(node, _st, ancestors) { parentOf.set(node, ancestors[ancestors.length - 2]); },
  Property(node, _st, ancestors) { parentOf.set(node, ancestors[ancestors.length - 2]); },
});

const isFn = v => v.defs.some(d => d.type === 'FunctionName');
const filesTouching = (v) => new Set(
  [...v.references.map(r => r.identifier), ...v.defs.map(d => d.name)]
    .map(id => fileAt(id.range[0]).file));

const vars = g.variables.filter(v => v.defs.length && !isFn(v));
const fns = g.variables.filter(v => isFn(v));

const sharedVars = vars.filter(v => filesTouching(v).size > 1);
const sharedFns = fns.filter(v => filesTouching(v).size > 1);
const sharedNames = new Set(sharedVars.map(v => v.name));

// ---- collect edits over the whole program, then apply right-to-left --------
const edits = [];   // {start, end, text}

for (const v of sharedVars) {
  // every read/write that resolves to this global
  for (const ref of v.references) {
    const id = ref.identifier;
    const p = parentOf.get(id);
    // acorn-walk visits a shorthand property's VALUE node, so `p.key === id`
    // is false there — check the value side, or `{ tokens }` silently becomes
    // the syntax error `{ S.tokens }`.
    if (p && p.type === 'Property' && p.shorthand && p.value === id) {
      const gp = parentOf.get(p);
      if (gp && (gp.type === 'ObjectPattern' || gp.type === 'AssignmentPattern')) {
        console.warn(`  ! destructured shorthand for ${v.name} — left alone, check by hand`);
        continue;
      }
      edits.push({ start: id.range[0], end: id.range[1], text: `${v.name}: S.${v.name}` });
    } else {
      edits.push({ start: id.range[0], end: id.range[1], text: `S.${v.name}` });
    }
  }
  // the declaration itself: `let x = 1, y;`  ->  `S.x = 1; S.y = undefined;`
  for (const d of v.defs) {
    const decl = d.parent;                       // VariableDeclaration
    if (!decl || decl.__done) continue;
    decl.__done = true;
    const parts = decl.declarations.map(dd => {
      const name = dd.id.name;
      const init = dd.init ? whole.slice(dd.init.range[0], dd.init.range[1]) : 'undefined';
      // a declarator in this statement might not itself be shared
      return sharedNames.has(name) ? `S.${name} = ${init}` : `let ${name} = ${init}`;
    });
    edits.push({ start: decl.range[0], end: decl.range[1], text: parts.join('; ') + ';' });
  }
}

// exports for cross-file functions
for (const v of sharedFns) {
  const d = v.defs[0].node;                      // FunctionDeclaration
  edits.push({ start: d.range[0], end: d.range[0], text: 'export ' });
}

// Declaration edits overlap their own references; drop references that sit
// inside a declaration rewrite (the declaration text already names them).
const declEdits = edits.filter(e => e.text.includes(';'));
const covered = (e) => declEdits.some(d => d !== e && e.start >= d.start && e.end <= d.end);
const finalEdits = edits.filter(e => !(e.text.startsWith('S.') && !e.text.includes(';') && covered(e))
                                  && !(e.text.includes(': S.') && covered(e)));

finalEdits.sort((a, b) => b.start - a.start || b.end - a.end);
let out = whole;
let last = Infinity;
for (const e of finalEdits) {
  if (e.end > last) continue;                    // skip anything overlapping a later edit
  out = out.slice(0, e.start) + e.text + out.slice(e.end);
  last = e.start;
}

// ---- split back into files, then work out the imports each one needs -------
// Recompute boundaries by locating each file's header comment in the output.
const pieces = {};
{
  let rest = out;
  for (let i = ORDER.length - 1; i >= 0; i--) {
    const f = ORDER[i];
    const marker = `// GM Display — ${f}\n`;
    const at = rest.lastIndexOf(marker);
    if (at < 0) throw new Error('lost the header for ' + f);
    pieces[f] = rest.slice(at);
    rest = rest.slice(0, at);
  }
}

const declaredIn = {};
for (const v of sharedFns) declaredIn[v.name] = fileAt(v.defs[0].name.range[0]).file;
const localFns = {};
for (const v of fns) if (!sharedFns.includes(v)) localFns[v.name] = fileAt(v.defs[0].name.range[0]).file;

for (const f of ORDER) {
  let body = pieces[f];
  const needs = {};
  for (const [name, owner] of Object.entries(declaredIn)) {
    if (owner === f) continue;
    const re = new RegExp(`(?<![\\w$.])${name}(?![\\w$])`);
    if (re.test(body)) (needs[owner] = needs[owner] || []).push(name);
  }
  const imports = [];
  if (f !== 'state.js' && /(?<![\w$.])S\./.test(body)) imports.push(`import { S } from './state.js';`);
  for (const owner of Object.keys(needs).sort()) {
    imports.push(`import { ${needs[owner].sort().join(', ')} } from './${owner}';`);
  }
  // keep the header comment on top, imports directly beneath it
  const lines = body.split('\n');
  let h = 0;
  while (h < lines.length && lines[h].startsWith('//')) h++;
  const header = lines.slice(0, h).join('\n');
  const rest = lines.slice(h).join('\n');
  const stateDecl = f === 'state.js'
    ? '\n// Shared mutable state. Anything touched by more than one module lives\n'
      + '// here; single-module state stayed where it was used.\nexport const S = {};\n'
    : '';
  fs.writeFileSync(path.join(JS, f),
    header + '\n' + imports.join('\n') + (imports.length ? '\n' : '') + stateDecl + rest);
}

console.log(`shared state moved to S: ${sharedVars.length}`);
console.log(`functions exported      : ${sharedFns.length}`);
console.log(`edits applied           : ${finalEdits.length}`);
console.log('exported names by file  :');
const byFile = {};
for (const [n, f] of Object.entries(declaredIn)) (byFile[f] = byFile[f] || []).push(n);
for (const f of ORDER) if (byFile[f]) console.log(`   ${f.padEnd(20)} ${byFile[f].length}`);
fs.writeFileSync('/tmp/shared-names.json', JSON.stringify({
  vars: sharedVars.map(v => v.name).sort(), fns: Object.keys(declaredIn).sort() }, null, 1));
