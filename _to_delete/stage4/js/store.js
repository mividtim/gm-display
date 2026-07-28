// GM Display — store.js
// The shared mutable state object, and nothing else.
//
// It lives alone, with no imports, deliberately: the module graph has cycles
// (state.js needs fog.js, fog.js needs state.js), and a module holding `const S`
// alongside other imports would still be in its temporal dead zone when a
// cyclic dependency first touched S. With no dependencies of its own this module
// always finishes evaluating before anything that imports it.
//
// Everything here is state used by more than one module. Single-module state
// stayed a plain `let` in the module that owns it.
export const S = {};
