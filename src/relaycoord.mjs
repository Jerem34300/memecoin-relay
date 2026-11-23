// Coordination logic between the box bot and the GitHub Actions relay (see coord.mjs for the store).
//
// Invariants (never two traders at once):
//  - The box only swaps while its last successful heartbeat write is < BOX_FRESH_MS (5 min) old and no
//    relay lease is known. It writes a heartbeat every ~60 s in the background.
//  - The relay only starts when the box heartbeat is > BOX_STALE_MS (8 min) old and takes a lease with a
//    compare-and-swap write. 8 min > 5 min, so a box that is still trading always blocks the relay.
//  - A box that wakes up (heartbeat too old) first syncs: if a relay lease is active it stops trading,
//    tells the relay it is back, and waits; then it adopts the relay's state and trades before trading again.
import fs from 'node:fs';
import {
  BOX_FRESH_MS,
  BOX_PUBLISH_EVERY_MS,
  BOX_STALE_MS,
  MAX_RELAY_TRADES,
  RELAY_LEASE_MS,
  readCoord,
  relayLeaseActive,
  updateCoord,
  withTimeout,
} from './coord.mjs';
import { exportPriceHistory, importPriceHistory } from './dip.mjs';
import { SNAPSHOTS_FILE, STATE_FILE, TRADES_FILE, loadState, loadTrades, saveState } from './state.mjs';
import { sendTelegram } from './telegram.mjs';
import { appendJsonl, logLine, num, parisIso } from './util.mjs';

export const RELAY = process.env.RELAY_MODE === '1';
export const COORD_ENABLED = RELAY || process.env.COORD_DISABLED !== '1';

function readJsonlFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function newCoord() {
  return {
    version: 1,
    boxHeartbeatAt: 0,
    lease: null,
    stateWriter: null,
    stateRev: 0,
    state: null,
    relayTrades: [],
    relaySnapshots: [],
  };
}

function snapKey(s) {
  return `${s.kind}|${s.dayKey}|${s.at}`;
}

function mergeCooldowns(a = {}, b = {}) {
  const out = { ...a };
  for (const [mint, c] of Object.entries(b || {})) {
    const cur = out[mint];
    if (!cur || Date.parse(c?.until || 0) > Date.parse(cur?.until || 0)) out[mint] = c;
  }
  return out;
}

// Relay state is authoritative for trading (positions, counters, stats); deposits are box-only.
function mergeRelayState(local, relay) {
  const m = structuredClone(relay);
  if (local) {
    m.recordedDepositTxs = [...new Set([...(relay.recordedDepositTxs || []), ...(local.recordedDepositTxs || [])])];
    m.depositsUsd = Math.max(num(relay.depositsUsd, 0), num(local.depositsUsd, 0));
    m.depositsEur = Math.max(num(relay.depositsEur, 0), num(local.depositsEur, 0));
    m.cooldowns = mergeCooldowns(local.cooldowns, relay.cooldowns);
  }
  return m;
}

// Append relay trades/snapshots to the box files (idempotent: dedupe by tx / key).
function importRelayRecords(coord) {
  const have = new Set(loadTrades().map((t) => t.tx).filter(Boolean));
  let trades = 0;
  const incoming = [...(coord.relayTrades || [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const t of incoming) {
    if (!t?.tx || have.has(t.tx)) continue;
    appendJsonl(TRADES_FILE, t);
    have.add(t.tx);
    trades += 1;
  }
  const haveSnaps = new Set(readJsonlFile(SNAPSHOTS_FILE).map(snapKey));
  let snaps = 0;
  for (const s of coord.relaySnapshots || []) {
    if (!s || haveSnaps.has(snapKey(s))) continue;
    appendJsonl(SNAPSHOTS_FILE, s);
    haveSnaps.add(snapKey(s));
    snaps += 1;
  }
  return { trades, snaps };
}

// ---------------------------------------------------------------- box side
const box = { lastOk: 0, lastAttempt: 0, relayUntil: 0, bg: null, mode: 'full', staleSince: 0, announcedWait: false };

async function boxPublish(blocking) {
  const startedAt = Date.now();
  let outcome = 'full';
  let adopted = null;
  let imported = { trades: 0, snaps: 0 };
  await updateCoord((coord) => {
    const now = Date.now();
    coord = coord || newCoord();
    coord.boxHeartbeatAt = now;
    coord.boxHeartbeatIso = parisIso();
    if (relayLeaseActive(coord, now)) {
      coord.boxBackAt = now; // asks the relay to wrap up early
      outcome = 'skip';
      box.relayUntil = Number(coord.lease.expiresAt);
      return { coord };
    }
    box.relayUntil = 0;
    let local = loadState();
    if (coord.stateWriter === 'relay' && coord.state) {
      if (!blocking) {
        outcome = 'needs-sync';
        return null;
      }
      // Adopt locally first (idempotent), then publish the merged state.
      const merged = mergeRelayState(local, coord.state);
      saveState(merged);
      imported = importRelayRecords(coord);
      adopted = { trades: (coord.relayTrades || []).length, lastRun: coord.lastRelayRun || null };
      local = merged;
      coord.relayTrades = [];
      coord.relaySnapshots = [];
    }
    if (local) {
      coord.state = local;
      coord.stateWriter = 'box';
      coord.stateAt = now;
      coord.stateRev = num(coord.stateRev, 0) + 1;
    }
    if (coord.lease && !relayLeaseActive(coord, now)) coord.lease = null;
    return { coord };
  }, { message: blocking ? 'box sync' : 'box heartbeat' });
  if (outcome === 'full') box.lastOk = startedAt;
  if (outcome === 'needs-sync') box.lastOk = 0;
  if (adopted) {
    logLine('[coord] adopted relay state', { importedTrades: imported.trades, importedSnapshots: imported.snaps });
    const st = loadState();
    const n = imported.trades;
    sendTelegram([
      '🖥️ <b>Mon ordi est de retour</b> et reprend la main.',
      n > 0 ? `Le relais GitHub a fait ${n} achat(s)/vente(s) pendant que l’ordi dormait (détails dans les messages ☁️ au-dessus).` : 'Le relais GitHub a surveillé pendant que l’ordi dormait, sans faire d’échange.',
      st?.positions?.length ? `Jetons en cours repris par l’ordi : ${st.positions.map((p) => p.symbol).join(', ')}.` : 'Aucun jeton en cours.',
    ].join('\n')).catch(() => {});
  }
  return outcome;
}

// Called before every box tick. Returns { mode: 'full' | 'exits-only' | 'skip', reason }.
export async function boxGate() {
  if (!COORD_ENABLED) return { mode: 'full' };
  const now = Date.now();
  const fresh = box.lastOk && now - box.lastOk < BOX_FRESH_MS && box.relayUntil <= now;
  if (fresh) {
    box.staleSince = 0;
    if (!box.bg && now - box.lastAttempt >= BOX_PUBLISH_EVERY_MS) {
      box.lastAttempt = now;
      box.bg = withTimeout(boxPublish(false), 45_000, 'coord heartbeat')
        .catch((err) => logLine(`[coord] heartbeat failed: ${err.message}`))
        .finally(() => { box.bg = null; });
    }
    box.mode = 'full';
    return { mode: 'full' };
  }
  if (!box.staleSince) box.staleSince = now;
  if (box.bg) await box.bg.catch(() => {});
  box.lastAttempt = Date.now();
  try {
    const outcome = await withTimeout(boxPublish(true), 60_000, 'coord sync');
    if (outcome === 'skip') {
      if (!box.announcedWait) {
        logLine('[coord] relay holds the lease, box waits until it hands back', { until: new Date(box.relayUntil).toISOString() });
        box.announcedWait = true;
      }
      box.mode = 'skip';
      return { mode: 'skip', reason: 'relay active' };
    }
    box.announcedWait = false;
    if (Date.now() - box.lastOk < BOX_FRESH_MS) {
      logLine('[coord] box holds the trading role');
      box.mode = 'full';
      return { mode: 'full' };
    }
    box.mode = 'exits-only';
    return { mode: 'exits-only', reason: 'sync incomplete' };
  } catch (err) {
    logLine(`[coord] sync failed: ${err.message}`);
    box.mode = box.relayUntil > Date.now() ? 'skip' : 'exits-only';
    return { mode: box.mode, reason: 'github unreachable' };
  }
}

// ---------------------------------------------------------------- relay side
let session = null;

export function relaySessionMs() {
  return Number(process.env.RELAY_SESSION_MS || 270_000);
}

// Take the lease. Returns { go, reason }.
export async function relayStart() {
  const runId = `${process.env.GITHUB_RUN_ID || 'local'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}-${Math.random().toString(36).slice(2, 8)}`;
  let reason = 'ok';
  let prevWriter = null;
  let acquiredAt = 0;
  const res = await updateCoord((coord) => {
    const now = Date.now();
    if (!coord?.state) { reason = 'no shared state yet'; return null; }
    if (coord.relayDisabled) { reason = 'relay disabled'; return null; }
    if (relayLeaseActive(coord, now)) { reason = 'another relay holds the lease'; return null; }
    const age = now - num(coord.boxHeartbeatAt, 0);
    if (age < BOX_STALE_MS) { reason = `box alive (heartbeat ${(age / 60000).toFixed(1)} min ago)`; return null; }
    prevWriter = coord.stateWriter;
    acquiredAt = now;
    coord.lease = { owner: 'relay', id: runId, since: now, expiresAt: now + RELAY_LEASE_MS };
    return { coord };
  }, { message: 'relay lease' });
  if (!res.written) return { go: false, reason };
  const coord = res.coord;
  saveState(coord.state);
  for (const f of [TRADES_FILE, SNAPSHOTS_FILE]) { try { fs.rmSync(f); } catch { /* none */ } }
  importPriceHistory(res.base?.prices || {});
  session = {
    runId,
    start: acquiredAt,
    deadline: acquiredAt + relaySessionMs(),
    swapUntil: acquiredAt + RELAY_LEASE_MS - 4 * 60_000,
    lastPush: acquiredAt,
    lost: false,
    stopReason: null,
    ticks: 0,
  };
  logLine(`[relay] lease taken (box heartbeat stale), session ${Math.round(relaySessionMs() / 1000)} s`);
  if (prevWriter === 'box') {
    await sendTelegram([
      '💤 <b>Mon ordi s’est mis en veille</b> : le relais GitHub prend le relais.',
      'Il applique exactement les mêmes règles et surveille tes jetons en cours. Il rend la main dès que l’ordi se réveille.',
    ].join('\n')).catch(() => {});
  }
  return { go: true };
}

function relayRecords() {
  const trades = readJsonlFile(TRADES_FILE).map((t) => ({ ...t, via: 'relay', relayRun: session?.runId }));
  const snaps = readJsonlFile(SNAPSHOTS_FILE).map((s) => ({ ...s, via: 'relay' }));
  return { trades, snaps };
}

function mergeRecords(coord) {
  const { trades, snaps } = relayRecords();
  const tx = new Set((coord.relayTrades || []).map((t) => t.tx));
  coord.relayTrades = [...(coord.relayTrades || []), ...trades.filter((t) => t.tx && !tx.has(t.tx))].slice(-MAX_RELAY_TRADES);
  const sk = new Set((coord.relaySnapshots || []).map(snapKey));
  coord.relaySnapshots = [...(coord.relaySnapshots || []), ...snaps.filter((s) => !sk.has(snapKey(s)))].slice(-100);
}

// Before each relay tick: returns { stop: bool }.
export async function relayBeforeTick() {
  if (!session) return { stop: true };
  const now = Date.now();
  if (now >= session.deadline) { session.stopReason = 'session time over'; return { stop: true }; }
  try {
    if (now - session.lastPush >= 60_000) {
      // Progress push: state + trades so far, lease must still be ours.
      let lost = false;
      let boxBack = false;
      await withTimeout(updateCoord((coord) => {
        if (!coord || coord.lease?.id !== session.runId) { lost = true; return null; }
        boxBack = num(coord.boxHeartbeatAt, 0) > session.start;
        coord.state = loadState();
        coord.stateWriter = 'relay';
        coord.stateAt = Date.now();
        coord.stateRev = num(coord.stateRev, 0) + 1;
        mergeRecords(coord);
        return { coord };
      }, { message: 'relay progress' }), 45_000, 'relay progress');
      session.lastPush = Date.now();
      if (lost) { session.lost = true; session.stopReason = 'lease lost'; return { stop: true }; }
      if (boxBack) { session.stopReason = 'box is back'; return { stop: true }; }
    } else {
      const { coord } = await withTimeout(readCoord(), 30_000, 'relay read');
      if (!coord || coord.lease?.id !== session.runId) { session.lost = true; session.stopReason = 'lease lost'; return { stop: true }; }
      if (num(coord.boxHeartbeatAt, 0) > session.start) { session.stopReason = 'box is back'; return { stop: true }; }
    }
  } catch (err) {
    logLine(`[relay] coord check failed: ${err.message}`);
    // Cannot confirm we still hold the lease: stop trading rather than risk a double trader.
    session.stopReason = 'coord unreachable';
    return { stop: true };
  }
  session.ticks += 1;
  return { stop: false };
}

export async function relayFinish() {
  if (!session) return;
  const { trades } = relayRecords();
  const buys = trades.filter((t) => t.side === 'buy').length;
  const sells = trades.filter((t) => t.side === 'sell').length;
  try {
    await withTimeout(updateCoord((coord) => {
      if (!coord) return null;
      mergeRecords(coord);
      if (coord.lease?.id === session.runId) {
        coord.state = loadState();
        coord.stateWriter = 'relay';
        coord.stateAt = Date.now();
        coord.stateRev = num(coord.stateRev, 0) + 1;
        coord.lease = null;
      }
      coord.lastRelayRun = { id: session.runId, start: session.start, end: Date.now(), ticks: session.ticks, buys, sells, stop: session.stopReason };
      return { coord, prices: { savedAt: Date.now(), history: exportPriceHistory() } };
    }, { message: 'relay release' }), 60_000, 'relay release');
    logLine(`[relay] released lease: ticks=${session.ticks} buys=${buys} sells=${sells} stop=${session.stopReason || 'n/a'}`);
  } catch (err) {
    logLine(`[relay] release failed (lease will expire on its own): ${err.message}`);
  }
}

// Swap guard used right before any on-chain swap.
export function swapAllowed(kind) {
  if (!COORD_ENABLED) return true;
  const now = Date.now();
  if (RELAY) return Boolean(session && !session.lost && now < session.swapUntil);
  if (box.mode === 'skip') return false;
  if (box.mode === 'exits-only') return kind === 'exit' && box.relayUntil <= now;
  return Boolean(box.lastOk && now - box.lastOk < BOX_FRESH_MS && box.relayUntil <= now);
}

export function entriesAllowed() {
  return !COORD_ENABLED || RELAY || box.mode === 'full';
}

export function coordMode() {
  return RELAY ? 'relay' : box.mode;
}
