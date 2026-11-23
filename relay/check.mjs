// Read-only pre-check (no keys needed beyond the state-repo deploy key): should this run trade?
// The real decision is taken again atomically (compare-and-swap) when the relay takes the lease.
import fs from 'node:fs';
import { BOX_STALE_MS, readCoord, relayLeaseActive } from '../src/coord.mjs';

let go = false;
let why = '';
try {
  const { coord } = await readCoord();
  const now = Date.now();
  const age = now - Number(coord?.boxHeartbeatAt || 0);
  if (!coord?.state) why = 'no shared state yet';
  else if (coord.relayDisabled) why = 'relay disabled';
  else if (relayLeaseActive(coord, now)) why = 'another relay run holds the lease';
  else if (age < BOX_STALE_MS) why = `box is alive (heartbeat ${(age / 60000).toFixed(1)} min ago) -> nothing to do`;
  else { go = true; why = `box heartbeat ${(age / 60000).toFixed(1)} min old -> relay should take over`; }
} catch (err) {
  why = `coordination store unreachable: ${String(err.message).slice(0, 160)}`;
}
console.log(`[relay-check] ${why}`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `go=${go}\n`);
