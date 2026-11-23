import './net.mjs';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  CASH_MINT,
  COOLDOWN_MS,
  DAILY_DRAWDOWN,
  DIP_COOLDOWN_MS,
  DIP_LOSS_COOLDOWN_MS,
  DIP_MAX_ROUND_TRIP,
  DIP_MAX_TRADE_USD,
  DIP_WATCHLIST_SIZE,
  DIP_MAX_ENTRIES_PER_TICK,
  DIP_STOP,
  DIP_TAKE_PROFIT,
  DIP_TAKE_PROFIT_MAX,
  DIP_TIME_STOP_MIN_PNL,
  DIP_TIME_STOP_MS,
  DIP_TP_BUFFER,
  DIP_TRAIL_ACTIVATE,
  DIP_TRAIL_GIVEBACK,
  EXPECTED_ADDRESS,
  FAST_TICK_MS,
  HARD_STOP,
  LOSS_COOLDOWN_MS,
  MAX_ENTRIES_PER_DAY,
  MAX_MOMENTUM_ENTRIES_PER_DAY,
  MAX_POSITIONS_LARGE,
  MAX_POSITIONS_SMALL,
  MIN_TRADE_USD,
  POSITION_PCT,
  SMALL_EQUITY_USD,
  SOL_MINT,
  SOL_RESERVE,
  SOL_RESERVE_TARGET,
  STRATEGY_MODE,
  TAKE_PROFIT,
  TIME_STOP_MIN_PNL,
  TIME_STOP_MS,
  TRAIL_ACTIVATE,
  TRAIL_GIVEBACK,
  WATCHLIST_REFRESH_MS,
} from './config.mjs';
import { findDipSetups, pollTokenPrices, recordPrice } from './dip.mjs';
import { cashBalance, findTokenAccount, loadHoldings, tokenBalance } from './holdings.mjs';
import { closeEmptyTokenAccount, estimateRoundTrip, executeSwap, getOrder, quoteSellable, validateOrder, walletSelfCheck } from './jupiter.mjs';
import { findDipWatchlist, findEntries, pairForMint } from './scan.mjs';
import { applyPendingDepositsToState, syncDeposits } from './deposits.mjs';
import { notifyCrash, notifyDeposit, notifyPause, notifySpotBuy, notifySpotSell, notifyStartup, startTelegramLoop, stopTelegramLoop } from './telegram.mjs';
import {
  initState,
  loadState,
  maybeRolloverDay,
  PID_FILE,
  recordTrade,
  saveState,
  writeHealth,
} from './state.mjs';
import { logLine, num, parisDayKey, parisIso, sleep } from './util.mjs';
import { RELAY, boxGate, coordMode, entriesAllowed, relayBeforeTick, relayFinish, relayStart, swapAllowed } from './relaycoord.mjs';

fs.writeFileSync(PID_FILE, `${process.pid}\n`, { mode: 0o644 });

let shuttingDown = false;
function shutdown(signal) {
  shuttingDown = true;
  logLine(`received ${signal}, stopping after this tick`);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---- in-process watchdog -------------------------------------------------
// Progress = one main-loop iteration finished (tick_complete or a caught tick error).
// Measured on the monotonic clock, so a box pause does not count as a hang.
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS || 180_000);
const WATCHDOG_SWAP_MS = Number(process.env.WATCHDOG_SWAP_MS || 360_000); // extra room while a swap is in flight
let lastProgress = performance.now();
function markProgress() {
  lastProgress = performance.now();
}
const watchdogTimer = setInterval(() => {
  const idle = performance.now() - lastProgress;
  const swapping = (globalThis.__swapInFlight || 0) > 0;
  const limit = swapping ? WATCHDOG_SWAP_MS : WATCHDOG_MS;
  if (idle > limit) {
    try {
      logLine(`watchdog: no loop progress for ${Math.round(idle / 1000)}s (limit ${limit / 1000}s, swapInFlight=${swapping}), exiting so the supervisor restarts`);
      writeHealth({ ok: false, pid: process.pid, at: parisIso(), mode: STRATEGY_MODE, lastError: 'watchdog: tick hung' });
    } catch {
      /* ignore */
    }
    process.exit(1);
  }
}, 15_000);
watchdogTimer.unref();

async function sleepMaybe(ms) {
  const end = Date.now() + ms;
  while (!shuttingDown && Date.now() < end) {
    await sleep(Math.min(1000, end - Date.now()));
  }
}

function maxPositions(equityUsd) {
  return equityUsd >= SMALL_EQUITY_USD ? MAX_POSITIONS_LARGE : MAX_POSITIONS_SMALL;
}

function investableUsd(snapshot) {
  const reserved = SOL_RESERVE * snapshot.solUsd;
  return Math.max(0, snapshot.equityUsd - reserved);
}

function availableUsd(snapshot) {
  const cashUsd = cashBalance(snapshot) * snapshot.cashUsd;
  const solUsd = Math.max(0, snapshot.sol - SOL_RESERVE) * snapshot.solUsd;
  return Math.max(0, cashUsd + solUsd);
}

function positionSizeUsd(snapshot, { cap = DIP_MAX_TRADE_USD } = {}) {
  const target = investableUsd(snapshot) * POSITION_PCT;
  const size = Math.min(cap || target, target, availableUsd(snapshot));
  return Math.max(0, size);
}

function isPaused(state) {
  if (!state.pausedUntil) return false;
  const until = Date.parse(state.pausedUntil);
  if (Number.isFinite(until) && until > Date.now()) return true;
  state.pausedUntil = null;
  state.pauseReason = null;
  return false;
}

function parisTomorrowIso() {
  const day = parisDayKey();
  const [y, m, d] = day.split('-').map(Number);
  const utcGuess = Date.parse(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T22:00:00Z`);
  const next = new Date(utcGuess + 12 * 60 * 60 * 1000);
  const key = parisDayKey(next);
  return `${key}T00:00:00+01:00`;
}

function pauseUntilTomorrow(state, reason) {
  state.pausedUntil = parisTomorrowIso();
  state.pauseReason = reason;
  logLine(`PAUSED until ${state.pausedUntil}: ${reason}`);
  notifyPause(reason).catch(() => {});
}

function applyDrawdownGuard(state, snapshot) {
  if (!state.dayStartUsd) return state;
  const dd = (snapshot.equityUsd - state.dayStartUsd) / state.dayStartUsd;
  if (dd <= DAILY_DRAWDOWN && !isPaused(state)) {
    pauseUntilTomorrow(state, `daily drawdown ${(dd * 100).toFixed(1)}%`);
  }
  return state;
}

function rawFromUi(ui, decimals) {
  const s = Number(ui).toFixed(decimals);
  const [w, f = ''] = s.split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(w + frac).toString();
}

function chooseBuyInput(snapshot, sizeUsd) {
  const cash = cashBalance(snapshot);
  const cashUsd = cash * snapshot.cashUsd;
  const solSpendable = Math.max(0, snapshot.sol - SOL_RESERVE);
  const solUsd = solSpendable * snapshot.solUsd;
  if (cashUsd >= Math.min(sizeUsd, MIN_TRADE_USD)) {
    const usd = Math.min(sizeUsd, cashUsd);
    const amount = snapshot.cashUsd > 0 ? usd / snapshot.cashUsd : 0;
    return { mint: CASH_MINT, symbol: 'CASH', usd, amount, decimals: 6 };
  }
  if (solUsd >= MIN_TRADE_USD) {
    const usd = Math.min(sizeUsd, solUsd);
    const amount = snapshot.solUsd > 0 ? usd / snapshot.solUsd : 0;
    return { mint: SOL_MINT, symbol: 'SOL', usd, amount, decimals: 9 };
  }
  return null;
}

function chooseSellOutput(snapshot) {
  if (snapshot.sol < SOL_RESERVE_TARGET) return { mint: SOL_MINT, symbol: 'SOL' };
  return { mint: CASH_MINT, symbol: 'CASH' };
}

function cooldownActive(state, mint) {
  const c = state.cooldowns?.[mint];
  if (!c?.until) return false;
  return Date.parse(c.until) > Date.now();
}

function setCooldown(state, mint, ms, reason) {
  state.cooldowns = state.cooldowns || {};
  state.cooldowns[mint] = { until: new Date(Date.now() + ms).toISOString(), reason };
}

function pruneCooldowns(state) {
  const now = Date.now();
  for (const [mint, c] of Object.entries(state.cooldowns || {})) {
    if (!c?.until || Date.parse(c.until) <= now) delete state.cooldowns[mint];
  }
}

function rulesFor(position) {
  const mode = position.mode || 'momentum';
  if (mode === 'dip') {
    return {
      mode,
      takeProfit: position.takeProfit ?? DIP_TAKE_PROFIT,
      stop: position.stopLoss ?? DIP_STOP,
      trailActivate: position.trailActivate ?? DIP_TRAIL_ACTIVATE,
      trailGiveback: position.trailGiveback ?? DIP_TRAIL_GIVEBACK,
      timeStopMs: position.timeStopMs ?? DIP_TIME_STOP_MS,
      timeStopMinPnl: position.timeStopMinPnl ?? DIP_TIME_STOP_MIN_PNL,
    };
  }
  return {
    mode: 'momentum',
    takeProfit: TAKE_PROFIT,
    stop: HARD_STOP,
    trailActivate: TRAIL_ACTIVATE,
    trailGiveback: TRAIL_GIVEBACK,
    timeStopMs: TIME_STOP_MS,
    timeStopMinPnl: TIME_STOP_MIN_PNL,
  };
}

function capInputAmount(snapshot, input, raw) {
  if (input.mint === SOL_MINT) {
    const maxRaw = BigInt(Math.max(0, snapshot.lamports - Math.ceil(SOL_RESERVE * 1e9)));
    if (BigInt(raw) > maxRaw) return maxRaw.toString();
    return raw;
  }
  const have = snapshot.holdings.find((h) => h.mint === input.mint)?.amountRaw;
  if (have && BigInt(raw) > BigInt(have)) return have;
  return raw;
}

async function enterPosition(state, snapshot, candidate, { mode = 'momentum', takeProfit, stopLoss, costs } = {}) {
  const cap = mode === 'dip' ? DIP_MAX_TRADE_USD : 8;
  const sizeUsd = positionSizeUsd(snapshot, { cap });
  if (sizeUsd < MIN_TRADE_USD) {
    logLine(`skip entry ${candidate.symbol}: size ${sizeUsd.toFixed(2)} below minimum`);
    return state;
  }
  const input = chooseBuyInput(snapshot, sizeUsd);
  if (!input) {
    logLine(`skip entry ${candidate.symbol}: no spendable CASH/SOL above reserve`);
    return state;
  }
  logLine(`entry ${candidate.symbol} paying with ${input.symbol}`, {
    sizeUsd: Number(input.usd.toFixed(2)),
    cashUsd: Number((cashBalance(snapshot) * snapshot.cashUsd).toFixed(2)),
    spendableSolUsd: Number((Math.max(0, snapshot.sol - SOL_RESERVE) * snapshot.solUsd).toFixed(2)),
  });
  let raw = capInputAmount(snapshot, input, rawFromUi(input.amount, input.decimals));
  if (BigInt(raw) <= 0n) {
    logLine(`skip entry ${candidate.symbol}: zero input`);
    return state;
  }

  const preview = await getOrder({
    inputMint: input.mint,
    outputMint: candidate.mint,
    amount: raw,
    taker: EXPECTED_ADDRESS,
  });
  const previewCheck = validateOrder(preview, { isExit: false });
  if (!previewCheck.ok) {
    logLine(`skip entry ${candidate.symbol}: quote rejected`, previewCheck.reasons);
    return state;
  }
  const expectedOut = preview.outAmount;
  if (expectedOut && BigInt(expectedOut) > 0n) {
    const sellCheck = await quoteSellable(candidate.mint, expectedOut);
    if (!sellCheck.ok) {
      logLine(`skip entry ${candidate.symbol}: cannot sell back`, sellCheck.reasons);
      return state;
    }
  }

  if (mode === 'dip' && !costs) {
    costs = await estimateRoundTrip({
      inputMint: input.mint,
      outputMint: candidate.mint,
      amount: raw,
      solUsd: snapshot.solUsd,
      sizeUsd: input.usd,
    });
  }
  if (mode === 'dip' && costs) {
    if (!costs.ok || costs.total > DIP_MAX_ROUND_TRIP) {
      logLine(`skip entry ${candidate.symbol}: round-trip too expensive`, {
        total: costs.ok ? `${(costs.total * 100).toFixed(2)}%` : 'n/a',
        cap: `${(DIP_MAX_ROUND_TRIP * 100).toFixed(1)}%`,
      });
      return state;
    }
    const needed = Math.min(DIP_TAKE_PROFIT_MAX, Math.max(DIP_TAKE_PROFIT, costs.total + DIP_TP_BUFFER));
    if (needed > DIP_TAKE_PROFIT_MAX + 1e-9) {
      logLine(`skip entry ${candidate.symbol}: needed rebound ${(needed * 100).toFixed(1)}% above cap`);
      return state;
    }
    takeProfit = needed;
  }

  if (!swapAllowed('entry')) {
    logLine(`skip entry ${candidate.symbol}: coordination (${coordMode()}) does not allow a buy right now`);
    return state;
  }
  const result = await executeSwap({
    inputMint: input.mint,
    outputMint: candidate.mint,
    amount: raw,
    isExit: false,
    context: `BUY ${candidate.symbol} ${mode}`,
  });
  if (!result.ok) {
    logLine(`buy failed ${candidate.symbol}: ${result.reason || result.exec?.error || 'execute failed'}`);
    return state;
  }

  await sleep(1500);
  const after = await loadHoldings();
  const received = tokenBalance(after, candidate.mint);
  const spentInput = tokenBalance(snapshot, input.mint) - tokenBalance(after, input.mint);
  const inUsd = spentInput * (input.mint === SOL_MINT ? snapshot.solUsd : snapshot.cashUsd);
  const px = received > 0 ? inUsd / received : candidate.priceUsd;

  const trade = {
    at: parisIso(),
    side: 'buy',
    mode,
    symbol: candidate.symbol,
    mint: candidate.mint,
    pairAddress: candidate.pairAddress,
    dexId: candidate.dexId,
    inputMint: input.mint,
    inputSymbol: input.symbol,
    inputAmount: spentInput,
    outputAmount: received,
    priceUsd: px,
    usd: inUsd,
    tx: result.signature,
    score: candidate.score != null ? Number(Number(candidate.score).toFixed(2)) : null,
    market: candidate.market || candidate.signal || null,
    takeProfit: takeProfit ?? null,
    stopLoss: stopLoss ?? null,
    roundTripCost: costs?.total ?? null,
  };
  recordTrade(trade);

  state.positions.push({
    mint: candidate.mint,
    symbol: candidate.symbol,
    pairAddress: candidate.pairAddress,
    dexId: candidate.dexId,
    mode,
    entryTime: trade.at,
    entryUsd: inUsd,
    entryPriceUsd: px,
    amount: received,
    inputMint: input.mint,
    inputSymbol: input.symbol,
    inputAmount: spentInput,
    entryTx: result.signature,
    peakPriceUsd: px,
    peakPnlPct: 0,
    trailActive: false,
    takeProfit: takeProfit ?? (mode === 'dip' ? DIP_TAKE_PROFIT : TAKE_PROFIT),
    stopLoss: stopLoss ?? (mode === 'dip' ? DIP_STOP : HARD_STOP),
    trailActivate: mode === 'dip' ? DIP_TRAIL_ACTIVATE : TRAIL_ACTIVATE,
    trailGiveback: mode === 'dip' ? DIP_TRAIL_GIVEBACK : TRAIL_GIVEBACK,
    timeStopMs: mode === 'dip' ? DIP_TIME_STOP_MS : TIME_STOP_MS,
    timeStopMinPnl: mode === 'dip' ? DIP_TIME_STOP_MIN_PNL : TIME_STOP_MIN_PNL,
    roundTripCost: costs?.total ?? null,
  });
  state.dayEntries = (state.dayEntries || 0) + 1;
  if (mode === 'momentum') state.dayMomentumEntries = (state.dayMomentumEntries || 0) + 1;
  state.stats.trades += 1;
  state.stats.buys += 1;
  logLine(`OPEN ${candidate.symbol} mode=${mode}`, {
    spent: `${spentInput.toFixed(6)} ${input.symbol}`,
    received,
    usd: Number(inUsd.toFixed(3)),
    takeProfit: takeProfit != null ? `${(takeProfit * 100).toFixed(1)}%` : null,
    tx: result.signature,
  });
  const fx = snapshot.usdEur || (snapshot.equityUsd > 0 ? snapshot.equityEur / snapshot.equityUsd : 0.90992);
  notifySpotBuy({
    symbol: candidate.symbol,
    eur: inUsd * fx,
    mode,
    tx: result.signature,
  }).catch(() => {});
  return state;
}

function markToMarket(position, priceUsd) {
  const value = position.amount * priceUsd;
  const pnlUsd = value - position.entryUsd;
  const pnlPct = position.entryUsd > 0 ? pnlUsd / position.entryUsd : 0;
  return { value, pnlUsd, pnlPct, priceUsd };
}

async function maybeCloseSoldAccount(mint, symbol) {
  try {
    const acct = await findTokenAccount(mint);
    if (!acct) return;
    if (BigInt(acct.amountRaw || '0') > 0n) return;
    const closed = await closeEmptyTokenAccount(acct.pubkey, acct.programId);
    if (!closed.ok) logLine(`could not close ${symbol} account: ${closed.reason}`);
  } catch (err) {
    logLine(`close account ${symbol} failed: ${err.message}`);
  }
}

async function exitPosition(state, snapshot, position, reason, priceUsd) {
  const amount = tokenBalance(snapshot, position.mint);
  if (amount <= 0) {
    logLine(`missing balance for ${position.symbol}, closing locally`);
    state.positions = state.positions.filter((p) => p.mint !== position.mint);
    return state;
  }
  const holding = snapshot.holdings.find((h) => h.mint === position.mint);
  const decimals = holding?.decimals ?? 6;
  const raw = holding?.amountRaw || rawFromUi(amount, decimals);
  const out = chooseSellOutput(snapshot);
  if (!swapAllowed('exit')) {
    logLine(`hold ${position.symbol}: coordination (${coordMode()}) does not allow a sell right now`);
    return state;
  }
  const result = await executeSwap({
    inputMint: position.mint,
    outputMint: out.mint,
    amount: raw,
    isExit: true,
    context: `SELL ${position.symbol} ${reason}`,
  });
  if (!result.ok) {
    logLine(`sell failed ${position.symbol}: ${result.reason || result.exec?.error || 'execute failed'}`);
    return state;
  }
  await sleep(1500);
  const after = await loadHoldings();
  const received = tokenBalance(after, out.mint) - tokenBalance(snapshot, out.mint);
  const outPx = out.mint === SOL_MINT ? after.solUsd : after.cashUsd;
  const outUsd = received * outPx;
  const pnlUsd = outUsd - position.entryUsd;
  const pnlPct = position.entryUsd > 0 ? pnlUsd / position.entryUsd : 0;
  const mode = position.mode || 'momentum';

  recordTrade({
    at: parisIso(),
    side: 'sell',
    mode,
    symbol: position.symbol,
    mint: position.mint,
    reason,
    outputMint: out.mint,
    outputSymbol: out.symbol,
    inputAmount: amount,
    outputAmount: received,
    entryUsd: position.entryUsd,
    exitUsd: outUsd,
    priceUsd,
    pnlUsd,
    pnlPct,
    tx: result.signature,
    entryTx: position.entryTx,
  });

  state.stats.trades += 1;
  state.stats.sells += 1;
  state.stats.realizedPnlUsd += pnlUsd;
  if (pnlUsd >= 0) state.stats.wins += 1;
  else state.stats.losses += 1;
  const cool = mode === 'dip'
    ? (pnlUsd < 0 ? DIP_LOSS_COOLDOWN_MS : DIP_COOLDOWN_MS)
    : (pnlUsd < 0 ? LOSS_COOLDOWN_MS : COOLDOWN_MS);
  setCooldown(state, position.mint, cool, pnlUsd < 0 ? 'loss' : 'sold');
  state.positions = state.positions.filter((p) => p.mint !== position.mint);
  logLine(`CLOSE ${position.symbol} ${reason} mode=${mode}`, {
    pnlUsd: Number(pnlUsd.toFixed(3)),
    pnlPct: `${(pnlPct * 100).toFixed(2)}%`,
    tx: result.signature,
  });
  try {
    const { loadDeposits, totalInvested } = await import('./deposits.mjs');
    const { combinedView } = await import('./perps_accounts.mjs');
    const fx = after.usdEur || (after.equityUsd > 0 ? after.equityEur / after.equityUsd : 0.90992);
    const invested = totalInvested(state.baselineUsd, state.baselineEur, loadDeposits());
    const combo = RELAY ? null : combinedView({
      spotEquityUsd: after.equityUsd,
      spotEquityEur: after.equityEur,
      investedEur: invested.eur,
      investedUsd: invested.usd,
      solUsd: after.solUsd,
      usdEur: fx,
    });
    notifySpotSell({
      symbol: position.symbol,
      pnlEur: pnlUsd * fx,
      pnlPct,
      tx: result.signature,
      reason,
      combo,
    }).catch(() => {});
  } catch {
    /* never block a sell on telegram */
  }
  await maybeCloseSoldAccount(position.mint, position.symbol);
  saveState(state);
  return state;
}

async function managePositions(state, snapshot, priceHints = new Map()) {
  const open = [...state.positions];
  for (const position of open) {
    const held = tokenBalance(snapshot, position.mint);
    if (held <= 0) {
      logLine(`missing balance for ${position.symbol}, closing locally`);
      state.positions = state.positions.filter((p) => p.mint !== position.mint);
      saveState(state);
      continue;
    }
    let priceUsd = num(priceHints.get(position.mint), 0);
    if (!(priceUsd > 0)) {
      try {
        const pair = await pairForMint(position.mint);
        priceUsd = num(pair?.priceUsd, 0);
      } catch (err) {
        logLine(`price fail ${position.symbol}: ${err.message}`);
      }
    }
    if (!(priceUsd > 0)) {
      const h = snapshot.holdings.find((x) => x.mint === position.mint);
      priceUsd = h?.usdPrice || position.peakPriceUsd || position.entryPriceUsd;
    }
    if (priceUsd > 0) recordPrice(position.mint, priceUsd);
    const mtm = markToMarket(position, priceUsd);
    if (priceUsd > position.peakPriceUsd) {
      position.peakPriceUsd = priceUsd;
      position.peakPnlPct = mtm.pnlPct;
    }
    const rules = rulesFor(position);
    if (!position.trailActive && mtm.pnlPct >= rules.trailActivate) {
      position.trailActive = true;
      logLine(`trail armed ${position.symbol} (${rules.mode}) at ${(mtm.pnlPct * 100).toFixed(1)}%`);
    }
    let reason = null;
    if (mtm.pnlPct <= rules.stop) reason = 'hard-stop';
    else if (mtm.pnlPct >= rules.takeProfit) reason = 'take-profit';
    else if (position.trailActive && priceUsd <= position.peakPriceUsd * (1 - rules.trailGiveback)) {
      reason = 'trailing-stop';
    } else {
      const age = Date.now() - Date.parse(position.entryTime);
      if (Number.isFinite(age) && age >= rules.timeStopMs) {
        if (rules.mode === 'dip') {
          // Lock in a small gain that still beats costs; never realize a dip loss on the clock.
          if (mtm.pnlPct >= rules.timeStopMinPnl) reason = 'time-stop';
        } else if (mtm.pnlPct < rules.timeStopMinPnl) {
          reason = 'time-stop';
        }
      }
    }
    logLine(`position ${position.symbol}`, {
      mode: rules.mode,
      pnlPct: `${(mtm.pnlPct * 100).toFixed(2)}%`,
      value: Number(mtm.value.toFixed(3)),
      trail: position.trailActive,
    });
    if (reason) {
      state = await exitPosition(state, snapshot, position, reason, priceUsd);
      snapshot = await loadHoldings();
    }
  }
  return { state, snapshot };
}

function canEnter(state, snapshot, { mode }) {
  if (!entriesAllowed()) return `coordination: ${coordMode()} (no new buys)`;
  if (isPaused(state)) return `paused (${state.pauseReason}) until ${state.pausedUntil}`;
  if ((state.dayEntries || 0) >= MAX_ENTRIES_PER_DAY) return 'daily entry cap reached';
  if (mode === 'momentum' && (state.dayMomentumEntries || 0) >= MAX_MOMENTUM_ENTRIES_PER_DAY) {
    return 'daily momentum cap reached';
  }
  if (state.positions.length >= maxPositions(snapshot.equityUsd)) return 'max open positions';
  const cap = mode === 'dip' ? DIP_MAX_TRADE_USD : 8;
  if (positionSizeUsd(snapshot, { cap }) < MIN_TRADE_USD) return 'bankroll too small after SOL reserve';
  return null;
}

async function maybeEnterDip(state, snapshot, watchlist) {
  const blocked = canEnter(state, snapshot, { mode: 'dip' });
  if (blocked) {
    logLine(`skip dip entries: ${blocked}`);
    return { state, entered: false };
  }
  pruneCooldowns(state);
  const exclude = new Set([
    ...state.positions.map((p) => p.mint),
    ...Object.keys(state.cooldowns || {}),
  ]);
  const live = await pollTokenPrices(watchlist.filter((t) => !exclude.has(t.mint)));
  const setups = findDipSetups(live);
  if (!setups.length) {
    logLine(`no dip setups watchlist=${live.length}`);
    return { state, entered: false };
  }

  let snap = snapshot;
  let entered = 0;
  const limit = DIP_MAX_ENTRIES_PER_TICK || 3;
  for (const best of setups) {
    if (entered >= limit) break;
    const reason = canEnter(state, snap, { mode: 'dip' });
    if (reason) {
      if (!entered) logLine(`skip dip entries: ${reason}`);
      break;
    }
    if (state.positions.some((p) => p.mint === best.mint)) continue;
    if (cooldownActive(state, best.mint)) {
      logLine(`dip candidate ${best.symbol} is in cooldown`);
      continue;
    }
    logLine('dip setup', {
      symbol: best.symbol,
      mint: best.mint,
      drop: `${best.signal.dropPct.toFixed(1)}%`,
      lowDrop: `${num(best.signal.lowDropPct, 0).toFixed(1)}%`,
      bounce: `${num(best.signal.bouncePct, 0).toFixed(1)}%`,
      liq: Math.round(num(best.liq, 0)),
      h1: best.h1,
      h6: best.h6,
      price: best.priceUsd,
    });
    const next = await enterPosition(state, snap, best, { mode: 'dip', stopLoss: DIP_STOP });
    if (next === state || (next.dayEntries || 0) <= (state.dayEntries || 0)) continue;
    state = next;
    entered += 1;
    snap = await loadHoldings();
  }
  return { state, entered: entered > 0 };
}

async function maybeEnterMomentum(state, snapshot) {
  const blocked = canEnter(state, snapshot, { mode: 'momentum' });
  if (blocked) {
    logLine(`skip momentum entries: ${blocked}`);
    return state;
  }
  pruneCooldowns(state);
  const exclude = new Set([
    ...state.positions.map((p) => p.mint),
    ...Object.keys(state.cooldowns || {}),
  ]);
  const candidates = await findEntries({ excludeMints: exclude, maxReports: 6 });
  if (!candidates.length) {
    logLine('no momentum candidates passed filters');
    return state;
  }
  const best = candidates[0];
  if (cooldownActive(state, best.mint)) {
    logLine(`momentum candidate ${best.symbol} is in cooldown`);
    return state;
  }
  return enterPosition(state, snapshot, best, { mode: 'momentum' });
}

async function tick(cycleNo, { refreshWatch, watchlist }) {
  let snapshot = await loadHoldings();
  let state = loadState();
  if (!state) {
    state = initState(snapshot);
    logLine('baseline set', {
      usd: Number(snapshot.equityUsd.toFixed(4)),
      eur: Number(snapshot.equityEur.toFixed(4)),
      sol: snapshot.sol,
    });
  } else {
    state = maybeRolloverDay(state, snapshot);
    if (state.dayKey && state.dayMomentumEntries == null) state.dayMomentumEntries = 0;
  }
  state.strategyMode = STRATEGY_MODE;
  if (!RELAY) try {
    applyPendingDepositsToState(state);
    const recorded = await syncDeposits(state);
    for (const d of recorded) {
      logLine('deposit recorded', {
        tx: d.tx,
        sol: d.amount,
        eur: Number(num(d.eur, 0).toFixed(4)),
        usd: Number(num(d.usd, 0).toFixed(4)),
      });
      notifyDeposit({ amount: d.amount, asset: d.asset || 'SOL', eur: d.eur, tx: d.tx }).catch(() => {});
    }
  } catch (err) {
    logLine('deposit scan failed', { error: err.message || String(err) });
  }
  state = applyDrawdownGuard(state, snapshot);

  let list = watchlist;
  let refreshedWatch = false;
  if (refreshWatch) {
    const exclude = new Set(state.positions.map((p) => p.mint));
    list = await findDipWatchlist({ excludeMints: exclude, maxReports: DIP_WATCHLIST_SIZE });
    refreshedWatch = true;
  }

  const hints = new Map();
  const toPoll = [
    ...list,
    ...state.positions.map((p) => ({
      mint: p.mint,
      symbol: p.symbol,
      pairAddress: p.pairAddress,
      priceUsd: p.peakPriceUsd || p.entryPriceUsd,
    })),
  ];
  const unique = [];
  const seen = new Set();
  for (const t of toPoll) {
    if (!t.mint || seen.has(t.mint)) continue;
    seen.add(t.mint);
    unique.push(t);
  }
  if (unique.length) {
    const priced = await pollTokenPrices(unique);
    for (const t of priced) {
      if (t.priceUsd > 0) hints.set(t.mint, t.priceUsd);
    }
    list = list.map((t) => priced.find((x) => x.mint === t.mint) || t);
  }

  const managed = await managePositions(state, snapshot, hints);
  state = managed.state;
  snapshot = managed.snapshot;

  const dip = await maybeEnterDip(state, snapshot, list);
  state = dip.state;
  if (!dip.entered && refreshedWatch) {
    snapshot = await loadHoldings();
    state = await maybeEnterMomentum(state, snapshot);
  }

  snapshot = await loadHoldings();
  state.cycleCount = cycleNo;
  state.lastCycleAt = parisIso();
  state.watchlistSize = list.length;
  saveState(state);
  writeHealth({
    ok: true,
    pid: process.pid,
    cycle: cycleNo,
    at: state.lastCycleAt,
    equityUsd: snapshot.equityUsd,
    equityEur: snapshot.equityEur,
    positions: state.positions.length,
    paused: isPaused(state),
    pauseReason: state.pauseReason,
    mode: STRATEGY_MODE,
    watchlist: list.length,
    lastError: null,
  });
  logLine(`tick_complete cycle=${cycleNo}`, {
    equityUsd: Number(snapshot.equityUsd.toFixed(4)),
    equityEur: Number(snapshot.equityEur.toFixed(4)),
    sol: snapshot.sol,
    cash: cashBalance(snapshot),
    positions: state.positions.length,
    paused: isPaused(state),
    dayEntries: state.dayEntries,
    watchlist: list.length,
    mode: STRATEGY_MODE,
  });
  return { state, snapshot, watchlist: list, refreshedWatch };
}

async function main() {
  logLine(`bot start address=${EXPECTED_ADDRESS} pid=${process.pid} mode=${STRATEGY_MODE}${RELAY ? ' (GitHub relay)' : ''}`);
  if (RELAY) {
    // GitHub relay: take the lease only if the box heartbeat is stale; otherwise exit right away.
    let start;
    try {
      await walletSelfCheck();
    } catch (err) {
      logLine('[relay] skip: wallet secret missing or does not match the trading wallet');
      return;
    }
    try {
      start = await relayStart();
    } catch (err) {
      start = { go: false, reason: `coordination error: ${String(err?.message || err).slice(0, 200)}` };
    }
    if (!start.go) {
      logLine(`[relay] skip: ${start.reason}`);
      return;
    }
  } else {
    startTelegramLoop();
    notifyStartup('spot').catch((err) => logLine(`telegram startup failed: ${err.message}`));
  }
  let cycleNo = (loadState()?.cycleCount || 0) + 1;
  let watchlist = [];
  let lastWatch = 0;
  while (!shuttingDown) {
    if (RELAY) {
      const chk = await relayBeforeTick();
      markProgress();
      if (chk.stop) break;
    } else {
      const gate = await boxGate();
      markProgress();
      if (gate.mode === 'skip') {
        try {
          writeHealth({ ok: true, pid: process.pid, cycle: cycleNo, at: parisIso(), mode: STRATEGY_MODE, coord: 'waiting-for-relay', lastError: null });
        } catch {
          /* ignore */
        }
        await sleepMaybe(FAST_TICK_MS);
        continue;
      }
    }
    try {
      const refreshWatch = Date.now() - lastWatch >= WATCHLIST_REFRESH_MS || watchlist.length === 0;
      const r = await tick(cycleNo, { refreshWatch, watchlist });
      markProgress();
      watchlist = r.watchlist;
      if (r.refreshedWatch) lastWatch = Date.now();
      cycleNo += 1;
    } catch (err) {
      markProgress();
      logLine(`tick error: ${err?.stack || err?.message || err}`);
      try {
        writeHealth({
          ok: false,
          pid: process.pid,
          cycle: cycleNo,
          at: parisIso(),
          mode: STRATEGY_MODE,
          lastError: String(err?.message || err),
        });
      } catch {
        /* ignore */
      }
    }
    if (shuttingDown) break;
    await sleepMaybe(FAST_TICK_MS);
  }
  if (RELAY) {
    await relayFinish();
    await sleep(3000); // let the last Telegram alerts go out
  }
  stopTelegramLoop();
  logLine('bot stopped');
}

main().then(() => {
  if (RELAY) process.exit(0);
}).catch((err) => {
  logLine(`fatal: ${err?.stack || err?.message || err}`);
  Promise.resolve(RELAY ? relayFinish() : null)
    .catch(() => {})
    .then(() => notifyCrash(err?.message || 'erreur inconnue'))
    .catch(() => {})
    .finally(() => process.exit(1));
});
