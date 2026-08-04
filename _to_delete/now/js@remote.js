// GM Display — remote.js
// Entry point for remote.html: the page players open over ngrok or the LAN.
//
// It carries only the remote markup. The GM control page is never served to a
// remote visitor, and none of it is loaded here either.
import { attachRemoteBindings, boundCount, unboundSelectors } from './bindings.js';
import { cellAtMapPx, cellCenterMapPx, cellFromLabel, cellLabel, snapNorm, tokenDisplayName } from './geometry.js';
import { init } from './init.js';
import { partyNotes, partyNotesFor } from './party-notes.js';
import { remoteMapToCanvas } from './remote-page.js';
import { S } from './store.js';
// A small debug/test handle, mirroring gm.js. The regression harness reads
// role state through it; nothing in the app depends on a global. The geometry
// helpers are here so a test can address a cell on this page the same way it
// does on the GM page — a player-side snap bug is otherwise invisible.
window.GMD = { S, init, unboundSelectors, boundCount,
  cellAtMapPx, cellCenterMapPx, cellFromLabel, cellLabel, snapNorm,
  remoteMapToCanvas, tokenDisplayName, partyNotes, partyNotesFor };

attachRemoteBindings();
init('remote');
