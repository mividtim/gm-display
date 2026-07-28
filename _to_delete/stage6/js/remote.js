// GM Display — remote.js
// Entry point for remote.html: the page players open over ngrok or the LAN.
//
// It carries only the remote markup. The GM control page is never served to a
// remote visitor, and none of it is loaded here either.
import { attachRemoteBindings, boundCount, unboundSelectors } from './bindings.js';
import { init } from './init.js';
import { S } from './store.js';
// A small debug/test handle, mirroring gm.js. The regression harness reads
// role state through it; nothing in the app depends on a global.
window.GMD = { S, init, unboundSelectors, boundCount };

attachRemoteBindings();
init('remote');
