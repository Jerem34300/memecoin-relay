import {
  DEXSCREENER,
  DIP_BOUNCE_MIN,
  DIP_KNIFE_MAX,
  DIP_MIN_SAMPLES,
  DIP_ROOM_BELOW_HIGH,
  DIP_LOOKBACK_MS,
  DIP_PULLBACK_MAX,
  JUPITER_PRICE_URL,
  PRICE_HISTORY_MS,
} from './config.mjs';
import { fetchJson, logLine, num } from './util.mjs';

const history = new Map();

function prune(mint, now = Date.now()) {
  const rows = history.get(mint) || [];
  const kept = rows.filter((s) => now - s.t <= PRICE_HISTORY_MS);
  history.set(mint, kept);
  return kept;
}

// Relay sessions persist the recent price history between runs (stored in the private state repo).
export function exportPriceHistory(maxPerMint = 100) {
  const out = {};
  const now = Date.now();
  for (const mint of history.keys()) {
    const rows = prune(mint, now);
    if (rows.length) out[mint] = rows.slice(-maxPerMint);
  }
  return out;
}

export function importPriceHistory(obj) {
  const now = Date.now();
  for (const [mint, rows] of Object.entries(obj || {})) {
    if (!Array.isArray(rows)) continue;
    const clean = rows.filter((r) => r && Number(r.t) > 0 && Number(r.price) > 0).map((r) => ({ t: Number(r.t), price: Number(r.price) }));
    const merged = [...clean, ...(history.get(mint) || [])].sort((a, b) => a.t - b.t);
    history.set(mint, merged);
    prune(mint, now);
  }
}

export function recordPrice(mint, price, now = Date.now()) {
  if (!(price > 0)) return prune(mint, now);
  const rows = prune(mint, now);
  const last = rows[rows.length - 1];
  if (last && now - last.t < 8_000 && last.price === price) return rows;
  rows.push({ t: now, price });
  history.set(mint, rows);
  return rows;
}

// Keep samples at least `gapMs` apart so two polls in the same tick never count as a "rise".
function spaced(rows, gapMs = 12_000) {
  const out = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (!last || r.t - last.t >= gapMs) out.push(r);
    else out[out.length - 1] = r; // keep the freshest price in that slot
  }
  return out;
}

export function dipSignal(token, now = Date.now()) {
  const price = num(token.priceUsd, 0);
  if (!(price > 0)) return null;
  const rows = spaced(prune(token.mint, now).filter((s) => now - s.t <= DIP_LOOKBACK_MS));
  // We must have watched the drop ourselves (no buying on the first prints).
  if (rows.length < DIP_MIN_SAMPLES) return null;
  const prices = rows.map((s) => s.price);
  const high = Math.max(...prices);
  const highIdx = prices.lastIndexOf(high);
  const after = prices.slice(highIdx);
  const low = Math.min(...after);
  const lowIdx = highIdx + after.lastIndexOf(low);
  const lowDrop = (low - high) / high;
  // Depth of the dip, measured at its bottom: 5-12 %. Deeper = falling knife.
  if (lowDrop > DIP_PULLBACK_MAX) return null;
  if (lowDrop < DIP_KNIFE_MAX) return null;
  // Rebound confirmation: the bottom is behind us, price is back up >=1.5 %,
  // and the last two spaced samples are each higher than the one before.
  if (lowIdx >= prices.length - 2) return null;
  const n = prices.length;
  const rising = prices[n - 1] > prices[n - 2] && prices[n - 2] > prices[n - 3];
  if (!rising) return null;
  if (price < low * (1 + DIP_BOUNCE_MIN)) return null;
  // Still enough room under the old high for the rebound target.
  const drop = (price - high) / high;
  if (drop > -DIP_ROOM_BELOW_HIGH) return null;
  // Do not buy if the 5-minute candle is in free fall (beyond the knife floor).
  const m5 = num(token.m5, 0) / 100;
  if (m5 < DIP_KNIFE_MAX) return null;
  return {
    drop,
    dropPct: drop * 100,
    lowDropPct: lowDrop * 100,
    bouncePct: (price / low - 1) * 100,
    high,
    low,
    price,
    samples: rows.length,
  };
}

export async function pollTokenPrices(tokens) {
  const mints = tokens.map((t) => t.mint).filter(Boolean);
  if (!mints.length) return tokens;
  const byMint = new Map(tokens.map((t) => [t.mint, { ...t }]));

  const chunkSize = 25;
  for (let i = 0; i < mints.length; i += chunkSize) {
    const chunk = mints.slice(i, i + chunkSize);
    try {
      const data = await fetchJson(`${DEXSCREENER}/tokens/v1/solana/${chunk.join(',')}`, { timeoutMs: 12_000, retries: 1 });
      const list = Array.isArray(data) ? data : data?.pairs || [];
      const best = new Map();
      for (const p of list) {
        const base = p.baseToken?.address;
        const mint = byMint.has(base) ? base : p.quoteToken?.address;
        if (!byMint.has(mint)) continue;
        const prev = best.get(mint);
        const liq = num(p.liquidity?.usd, 0);
        if (!prev || liq > num(prev.liquidity?.usd, 0)) best.set(mint, p);
      }
      for (const [mint, p] of best.entries()) {
        const t = byMint.get(mint);
        t.priceUsd = num(p.priceUsd, t.priceUsd);
        t.pairAddress = p.pairAddress || t.pairAddress;
        t.dexId = p.dexId || t.dexId;
        t.m5 = num(p.priceChange?.m5, t.m5);
        t.h1 = num(p.priceChange?.h1, t.h1);
        t.h6 = num(p.priceChange?.h6, t.h6);
        t.liq = num(p.liquidity?.usd, t.liq);
        t.vol1 = num(p.volume?.h1, t.vol1);
        t.buys = num(p.txns?.h1?.buys, t.buys);
        t.sells = num(p.txns?.h1?.sells, t.sells);
      }
    } catch (err) {
      logLine(`dip dex poll failed: ${err.message}`);
    }
  }

  try {
    const prices = await fetchJson(`${JUPITER_PRICE_URL}?ids=${mints.join(',')}`, { timeoutMs: 12_000, retries: 1 });
    for (const mint of mints) {
      const px = num(prices?.[mint]?.usdPrice, 0);
      if (px > 0) {
        const t = byMint.get(mint);
        t.priceUsd = px;
        t.priceSource = 'jupiter';
      }
    }
  } catch (err) {
    logLine(`dip jupiter price poll failed: ${err.message}`);
  }

  const now = Date.now();
  const out = [];
  for (const mint of mints) {
    const t = byMint.get(mint);
    recordPrice(mint, t.priceUsd, now);
    out.push(t);
  }
  return out;
}

export function findDipSetups(tokens) {
  const setups = [];
  for (const token of tokens) {
    const signal = dipSignal(token);
    if (!signal) continue;
    setups.push({ ...token, signal, mode: 'dip' });
  }
  setups.sort((a, b) => a.signal.drop - b.signal.drop);
  return setups;
}

// 24 h high of a pool from GeckoTerminal hourly candles (cached 10 min). null if unknown.
const highCache = new Map();
export async function high24h(pairAddress) {
  if (!pairAddress) return null;
  const hit = highCache.get(pairAddress);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.high;
  try {
    const data = await fetchJson(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}/ohlcv/hour?aggregate=1&limit=25&currency=usd`,
      { timeoutMs: 12_000, retries: 1 },
    );
    const list = data?.data?.attributes?.ohlcv_list || [];
    const cutoff = Date.now() / 1000 - 24 * 3600;
    const highs = list.filter((c) => c[0] >= cutoff - 3600).map((c) => num(c[2], 0)).filter((v) => v > 0);
    const high = highs.length ? Math.max(...highs) : null;
    highCache.set(pairAddress, { t: Date.now(), high });
    return high;
  } catch (err) {
    logLine(`24h high lookup failed: ${err.message}`);
    return null;
  }
}
