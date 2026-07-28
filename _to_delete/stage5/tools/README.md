# tools

`to-modules.js` is the one-shot codemod that converted the ordered classic
scripts into ES modules. It is kept for the record — it documents exactly how
the 75 shared globals and 101 cross-file functions were identified and rewritten,
using acorn plus eslint-scope rather than regex, so that shadowed parameters,
property names and string contents were left alone.

It needs `npm i acorn acorn-walk eslint-scope` to run, which is why it lives
here and not in the app: the app itself still has zero dependencies and no
build step.

`unwire-inline.js` moved the 107 inline `on*=` attributes into `js/bindings.js`,
parsing each handler expression with acorn and rewriting `this` to the bound
element rather than retyping 107 handlers by hand. Controls without an id were
given a `data-act` hook. It has already been run and is kept for the record.

`split-tokens.js` broke the 1537-line tokens.js into geometry / tokens /
projector / markers / remote-page. Splitting a module turns some of its locals
into cross-module state and some of its private functions into cross-module
calls; the tool finds both with scope analysis. `let`/`var` that crossed a
boundary moved into `S`; `const` — including arrow helpers and lookup tables —
was exported instead, since immutable things do not belong in mutable state.

`fix-imports.js` rewrites every module's import block from what it actually
references, and fails loudly on any identifier that resolves to nothing. Run it
after moving code between modules.
