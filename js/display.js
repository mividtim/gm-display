// GM Display — display.js
// Entry point for display.html: the projector and sidecar windows.
//
// This page carries only the player-view markup, so none of the GM sidebar is
// parsed or rendered here. Which of the two displays it is comes from the
// ?display= parameter, as before.
import { attachPlayerBindings, boundCount, unboundSelectors } from './bindings.js';
import { init } from './init.js';
import { S } from './store.js';
// A small debug/test handle, mirroring gm.js. The regression harness reads
// role state through it; nothing in the app depends on a global.
window.GMD = { S, init, unboundSelectors, boundCount };

attachPlayerBindings();
init('player', new URLSearchParams(location.search).get('display') || 'map');
