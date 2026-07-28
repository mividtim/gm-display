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
