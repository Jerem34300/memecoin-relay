// Read-only pre-check (no keys needed beyond the state-repo deploy key): should this run trade?
// The real decision is taken again atomically (compare-and-swap) when the relay takes the lease.
// CHECK_WAIT_MS > 0: while the box is alive, keep watching (every CHECK_EVERY_MS) for up to that long,
// so a box that falls asleep is noticed within ~1 min instead of waiting for the next (often late) cron.
import fs from 'node:fs';
import { BOX_STALE_MS, readCoord, relayLeaseActive } from '../src/coord.mjs';

const WAIT_MS = Number(process.env.CHECK_WAIT_MS || 0);
const EVERY_MS = Number(process.env.CHECK_EVERY_MS || 60_000);
const t0 = Date.now();

async function checkOnce() {
  let go = false;
  let why = '';
  let retry = true; // worth checking again later in this run
  try {
    const { coord } = await readCoord();
    const now = Date.now();
    const age = now - Number(coord?.boxHeartbeatAt || 0);
    if (!coord?.state) { why = 'no shared state yet'; retry = false; }
    else if (coord.relayDisabled) { why = 'relay disabled'; retry = false; }
    else if (relayLeaseActive(coord, now)) why = 'another relay run holds the lease';
    else if (age < BOX_STALE_MS) why = `box is alive (heartbeat ${(age / 60000).toFixed(1)} min ago) -> nothing to do`;
    else { go = true; why = `box heartbeat ${(age / 60000).toFixed(1)} min old -> relay should take over`; }
  } catch (err) {
    why = `coordination store unreachable: ${String(err.message).slice(0, 160)}`;
  }
  return { go, why, retry };
}

let res = await checkOnce();
console.log(`[relay-check] ${res.why}`);
while (!res.go && res.retry && Date.now() - t0 + EVERY_MS <= WAIT_MS) {
  await new Promise((r) => setTimeout(r, EVERY_MS));
  const next = await checkOnce();
  if (next.why !== res.why || next.go) console.log(`[relay-check] ${next.why}`);
  res = next;
}
if (!res.go && WAIT_MS > 0) console.log(`[relay-check] watched ${Math.round((Date.now() - t0) / 1000)} s, box still alive`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `go=${res.go}\nchain=${res.go || res.retry}\n`);
