import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { appendJsonl, parisDayKey, parisIso, readJson, writeJson } from './util.mjs';

export const STATE_FILE = path.join(DATA_DIR, 'state.json');
export const TRADES_FILE = path.join(DATA_DIR, 'trades.jsonl');
export const SNAPSHOTS_FILE = path.join(DATA_DIR, 'daily-snapshots.jsonl');
export const HEALTH_FILE = path.join(DATA_DIR, 'health.json');
export const PID_FILE = path.join(DATA_DIR, 'bot.pid');

export function loadState() {
  return readJson(STATE_FILE, null);
}

export function saveState(state) {
  writeJson(STATE_FILE, state);
  return state;
}

export function initState(snapshot) {
  const now = parisIso();
  const state = {
    startedAt: now,
    baselineUsd: snapshot.equityUsd,
    baselineEur: snapshot.equityEur,
    baselineHoldings: snapshot.holdings.map((h) => ({
      symbol: h.symbol,
      mint: h.mint,
      amount: h.amount,
      usd: h.usd,
    })),
    pricesAtBaseline: {
      solUsd: snapshot.solUsd,
      cashUsd: snapshot.cashUsd,
      usdEur: snapshot.usdEur,
    },
    dayKey: parisDayKey(),
    dayStartUsd: snapshot.equityUsd,
    dayEntries: 0,
    dayMomentumEntries: 0,
    strategyMode: "dip-rebound",
    pausedUntil: null,
    pauseReason: null,
    positions: [],
    cooldowns: {},
    lastCycleAt: null,
    cycleCount: 0,
    stats: {
      trades: 0,
      buys: 0,
      sells: 0,
      wins: 0,
      losses: 0,
      realizedPnlUsd: 0,
    },
  };
  saveState(state);
  appendJsonl(SNAPSHOTS_FILE, {
    at: now,
    kind: 'baseline',
    dayKey: state.dayKey,
    equityUsd: snapshot.equityUsd,
    equityEur: snapshot.equityEur,
    sol: snapshot.sol,
    holdings: state.baselineHoldings,
  });
  return state;
}

export function maybeRolloverDay(state, snapshot) {
  const today = parisDayKey();
  if (state.dayKey === today) return state;
  appendJsonl(SNAPSHOTS_FILE, {
    at: parisIso(),
    kind: 'day-close',
    dayKey: state.dayKey,
    equityUsd: snapshot.equityUsd,
    equityEur: snapshot.equityEur,
    realizedPnlUsd: state.stats.realizedPnlUsd,
  });
  state.dayKey = today;
  state.dayStartUsd = snapshot.equityUsd;
  state.dayEntries = 0;
  state.dayMomentumEntries = 0;
  if (state.pausedUntil && Date.parse(state.pausedUntil) <= Date.now()) {
    state.pausedUntil = null;
    state.pauseReason = null;
  }
  appendJsonl(SNAPSHOTS_FILE, {
    at: parisIso(),
    kind: 'day-open',
    dayKey: today,
    equityUsd: snapshot.equityUsd,
    equityEur: snapshot.equityEur,
  });
  return state;
}

export function recordTrade(trade) {
  appendJsonl(TRADES_FILE, process.env.RELAY_MODE === '1' ? { ...trade, via: 'relay' } : trade);
}

export function loadTrades() {
  try {
    const raw = fs.readFileSync(TRADES_FILE, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function writeHealth(health) {
  writeJson(HEALTH_FILE, health);
}
