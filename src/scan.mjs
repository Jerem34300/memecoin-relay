import {
  ALLOWED_DEX,
  BASE_MINTS,
  CASH_MINT,
  DEXSCREENER,
  MAX_AGE_BOOSTED_MS,
  MAX_AGE_MS,
  MAX_MCAP,
  MAX_RUG_SCORE,
  MAX_TOP10_PCT,
  MAX_TOP_HOLDER_PCT,
  MIN_AGE_MS,
  MIN_ENTRY_SCORE,
  MIN_H1_CHANGE,
  MIN_LIQ_USD,
  MIN_M5_CHANGE,
  MIN_MCAP,
  MIN_VOL_H1,
  MIN_VOL_H24,
  MAX_H6_DUMP,
  DIP_MIN_H1_CHANGE,
  DIP_MIN_H6_CHANGE,
  DIP_MIN_LIQ_USD,
  DIP_MIN_VOL_H1,
  DIP_MIN_VOL_H24,
  QUOTE_MINTS,
  RUGCHECK,
  RUGCHECK_CACHE_MS,
  SOL_MINT,
  USDC_MINT,
} from './config.mjs';
import { fetchJson, logLine, num, sleep } from './util.mjs';

const rugCache = new Map();

async function getJsonSafe(url) {
  try {
    return await fetchJson(url, { timeoutMs: 12_000, retries: 1 });
  } catch (err) {
    logLine(`scan fetch failed ${url}: ${err.message}`);
    return null;
  }
}

async function collectCandidateMints() {
  const mints = new Set();
  const boosted = new Set();

  const sources = [
    `${DEXSCREENER}/token-boosts/latest/v1`,
    `${DEXSCREENER}/token-boosts/top/v1`,
    `${DEXSCREENER}/token-profiles/latest/v1`,
    `${DEXSCREENER}/token-profiles/recent-updates/v1`,
  ];
  for (const url of sources) {
    const data = await getJsonSafe(url);
    const items = Array.isArray(data) ? data : [];
    for (const item of items) {
      if (String(item.chainId || '').toLowerCase() !== 'solana') continue;
      const mint = item.tokenAddress;
      if (!mint || BASE_MINTS.has(mint)) continue;
      mints.add(mint);
      if (url.includes('boosts')) boosted.add(mint);
    }
  }

  const searches = ['pumpswap', 'pump.fun', 'meteora SOL', 'raydium SOL'];
  for (const q of searches) {
    const data = await getJsonSafe(`${DEXSCREENER}/latest/dex/search?q=${encodeURIComponent(q)}`);
    const pairs = data?.pairs || [];
    for (const p of pairs) {
      if (String(p.chainId || '').toLowerCase() !== 'solana') continue;
      const base = p.baseToken?.address;
      const quote = p.quoteToken?.address;
      const mint = BASE_MINTS.has(base) ? quote : base;
      if (!mint || BASE_MINTS.has(mint)) continue;
      mints.add(mint);
    }
  }

  return { mints: [...mints], boosted };
}

async function fetchPairs(mints) {
  const pairsByMint = new Map();
  const chunkSize = 25;
  for (let i = 0; i < mints.length; i += chunkSize) {
    const chunk = mints.slice(i, i + chunkSize);
    const data = await getJsonSafe(`${DEXSCREENER}/tokens/v1/solana/${chunk.join(',')}`);
    const list = Array.isArray(data) ? data : data?.pairs || [];
    for (const p of list) {
      const base = p.baseToken?.address;
      const quote = p.quoteToken?.address;
      if (!base || !quote) continue;
      const mint = BASE_MINTS.has(base) && !BASE_MINTS.has(quote) ? quote : base;
      if (BASE_MINTS.has(mint)) continue;
      if (!pairsByMint.has(mint)) pairsByMint.set(mint, []);
      pairsByMint.get(mint).push(p);
    }
  }
  return pairsByMint;
}

function bestPair(pairs) {
  const usable = pairs.filter((p) => {
    if (String(p.chainId || '').toLowerCase() !== 'solana') return false;
    const dex = String(p.dexId || '').toLowerCase();
    if (!ALLOWED_DEX.has(dex)) return false;
    const quote = p.quoteToken?.address;
    const base = p.baseToken?.address;
    const quoteIsBase = QUOTE_MINTS.has(quote) || quote === USDC_MINT || quote === SOL_MINT;
    const baseIsQuote = QUOTE_MINTS.has(base);
    return quoteIsBase || baseIsQuote;
  });
  usable.sort((a, b) => num(b.liquidity?.usd, 0) - num(a.liquidity?.usd, 0));
  return usable[0] || null;
}

function tradableMint(pair) {
  const base = pair.baseToken?.address;
  const quote = pair.quoteToken?.address;
  if (BASE_MINTS.has(base) && !BASE_MINTS.has(quote)) return quote;
  return base;
}

function tradableMeta(pair) {
  const mint = tradableMint(pair);
  if (mint === pair.baseToken?.address) {
    return { mint, symbol: pair.baseToken?.symbol || 'UNK', name: pair.baseToken?.name || '' };
  }
  return { mint, symbol: pair.quoteToken?.symbol || 'UNK', name: pair.quoteToken?.name || '' };
}

function prefilter(pair, isBoosted) {
  const reasons = [];
  const liq = num(pair.liquidity?.usd, 0);
  const vol24 = num(pair.volume?.h24, 0);
  const vol1 = num(pair.volume?.h1, 0);
  const mcap = num(pair.marketCap, num(pair.fdv, 0));
  const created = num(pair.pairCreatedAt, 0);
  const age = created ? Date.now() - created : 0;
  const chg = pair.priceChange || {};
  const m5 = num(chg.m5, 0);
  const h1 = num(chg.h1, 0);
  const h6 = num(chg.h6, 0);
  const tx1 = pair.txns?.h1 || {};
  const buys = num(tx1.buys, 0);
  const sells = num(tx1.sells, 0);

  if (liq < MIN_LIQ_USD) reasons.push(`liq ${liq.toFixed(0)}`);
  if (vol24 < MIN_VOL_H24 && vol1 < MIN_VOL_H1) reasons.push('volume too low');
  if (mcap && (mcap < MIN_MCAP || mcap > MAX_MCAP)) reasons.push(`mcap ${mcap.toFixed(0)}`);
  const maxAge = isBoosted ? MAX_AGE_BOOSTED_MS : MAX_AGE_MS;
  if (created && age < MIN_AGE_MS) reasons.push('too new');
  if (created && age > maxAge) reasons.push('too old');
  if (h1 < MIN_H1_CHANGE) reasons.push(`h1 ${h1.toFixed(1)}%`);
  if (m5 < MIN_M5_CHANGE) reasons.push(`m5 ${m5.toFixed(1)}% dumping`);
  if (h6 < MAX_H6_DUMP && h1 < 15) reasons.push(`h6 dump ${h6.toFixed(1)}%`);
  if (buys + sells >= 20 && buys < sells * 0.85) reasons.push('sell pressure');

  let score = 0;
  score += Math.min(h1, 80) * 0.5;
  score += Math.min(Math.max(m5, -20), 30) * 0.35;
  if (m5 < 0) score += m5 * 1.5;
  const turnover = liq > 0 ? Math.min(vol1 / liq, 2) : 0;
  score += turnover * 15;
  const flow = (buys - sells) / (buys + sells + 1);
  score += flow * 18;
  if (isBoosted) score += 4;
  if (h6 < 0) score -= 4;
  if (liq >= 80_000) score += 3;

  return {
    ok: reasons.length === 0 && score >= MIN_ENTRY_SCORE,
    reasons,
    score,
    liq,
    vol24,
    vol1,
    mcap,
    age,
    m5,
    h1,
    h6,
    buys,
    sells,
  };
}

function authorityOf(report, field) {
  return report?.[field] ?? report?.token?.[field] ?? null;
}

function holderRisk(report) {
  const holders = Array.isArray(report?.topHolders) ? report.topHolders : [];
  const dangerous = [];
  const nonLp = [];
  for (const h of holders) {
    const pct = num(h.pct, 0);
    const addr = String(h.address || h.owner || '');
    const insider = Boolean(h.insider);
    const label = `${addr}`.toLowerCase();
    const likelyLp =
      label.includes('pool') ||
      Boolean(h.pool) ||
      (h.owner && String(h.owner).toLowerCase().includes('raydium')) ||
      Boolean(h.isPool);
    if (likelyLp) continue;
    nonLp.push({ pct, insider, addr });
    if (pct >= MAX_TOP_HOLDER_PCT) dangerous.push({ pct, insider, addr });
  }
  nonLp.sort((a, b) => b.pct - a.pct);
  const top10 = nonLp.slice(0, 10).reduce((s, h) => s + h.pct, 0);
  return { dangerous, top10, top: nonLp[0] || null };
}

export async function rugReport(mint) {
  const cached = rugCache.get(mint);
  if (cached && Date.now() - cached.at < RUGCHECK_CACHE_MS) return cached.data;
  const data = await fetchJson(`${RUGCHECK}/tokens/${mint}/report`, { timeoutMs: 18_000, retries: 1 });
  rugCache.set(mint, { at: Date.now(), data });
  return data;
}

function rugFilter(report) {
  const reasons = [];
  if (!report) return { ok: false, reasons: ['no rugcheck'] };
  if (report.rugged === true) reasons.push('marked rugged');
  const mintAuth = authorityOf(report, 'mintAuthority');
  const freezeAuth = authorityOf(report, 'freezeAuthority');
  if (mintAuth) reasons.push('mint authority active');
  if (freezeAuth) reasons.push('freeze authority active');
  const scoreN = num(report.score_normalised, num(report.scoreNormalized, 99));
  if (scoreN > MAX_RUG_SCORE) reasons.push(`rug score ${scoreN}`);
  const risks = Array.isArray(report.risks) ? report.risks : [];
  const danger = risks.filter((r) => String(r.level || '').toLowerCase() === 'danger');
  const blocked = danger.filter((r) => {
    const n = `${r.name || ''} ${r.description || ''}`.toLowerCase();
    return /honeypot|rug|freeze|mint authority|scam|steal|blocked/.test(n);
  });
  if (blocked.length) reasons.push(`danger: ${blocked.map((r) => r.name).join(', ')}`);
  const { dangerous, top10, top } = holderRisk(report);
  if (dangerous.length) reasons.push(`top holder ${dangerous[0].pct.toFixed(1)}%`);
  if (top10 > MAX_TOP10_PCT) reasons.push(`top10 ${top10.toFixed(1)}%`);
  const lpLocked = num(report.lpLockedPct, 0);
  return {
    ok: reasons.length === 0,
    reasons,
    scoreN,
    lpLocked,
    topHolderPct: top?.pct || 0,
    mintAuth,
    freezeAuth,
  };
}

export async function findEntries({ excludeMints = new Set(), maxReports = 6 } = {}) {
  const { mints, boosted } = await collectCandidateMints();
  logLine(`scan universe mints=${mints.length} boosted=${boosted.size}`);
  const pairsByMint = await fetchPairs(mints.slice(0, 80));
  const prelim = [];
  for (const [mint, pairs] of pairsByMint.entries()) {
    if (excludeMints.has(mint) || mint === CASH_MINT) continue;
    const pair = bestPair(pairs);
    if (!pair) continue;
    const isBoosted = boosted.has(mint);
    const pf = prefilter(pair, isBoosted);
    const meta = tradableMeta(pair);
    if (meta.mint !== mint) continue;
    if (!pf.ok) continue;
    prelim.push({ mint, pair, meta, pf, isBoosted });
  }
  prelim.sort((a, b) => b.pf.score - a.pf.score);
  const shortlist = prelim.slice(0, maxReports);
  logLine(`scan prefilter passed=${prelim.length} shortlist=${shortlist.length}`);

  const passed = [];
  for (const item of shortlist) {
    let report = null;
    try {
      report = await rugReport(item.mint);
    } catch (err) {
      logLine(`rugcheck failed ${item.meta.symbol}: ${err.message}`);
      await sleep(400);
      continue;
    }
    const rf = rugFilter(report);
    if (!rf.ok) {
      logLine(`reject ${item.meta.symbol} rug`, rf.reasons);
      await sleep(300);
      continue;
    }
    passed.push({
      mint: item.mint,
      symbol: item.meta.symbol,
      name: item.meta.name,
      pairAddress: item.pair.pairAddress,
      dexId: item.pair.dexId,
      priceUsd: num(item.pair.priceUsd, 0),
      url: item.pair.url,
      isBoosted: item.isBoosted,
      score: item.pf.score + (rf.scoreN < 15 ? 8 : 0) + (rf.lpLocked >= 80 ? 6 : 0),
      market: item.pf,
      rug: rf,
    });
    await sleep(300);
  }
  passed.sort((a, b) => b.score - a.score);
  if (passed[0]) logLine('scan best candidate', { symbol: passed[0].symbol, mint: passed[0].mint, score: Number(passed[0].score.toFixed(1)) });
  return passed;
}

export async function pairForMint(mint) {
  const data = await getJsonSafe(`${DEXSCREENER}/tokens/v1/solana/${mint}`);
  const list = Array.isArray(data) ? data : data?.pairs || [];
  return bestPair(list);
}


function tokenFromPair(pair, mint, extra = {}) {
  const meta = tradableMeta(pair);
  const chg = pair.priceChange || {};
  const tx1 = pair.txns?.h1 || {};
  return {
    mint,
    symbol: meta.symbol,
    name: meta.name,
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    priceUsd: num(pair.priceUsd, 0),
    url: pair.url,
    liq: num(pair.liquidity?.usd, 0),
    vol24: num(pair.volume?.h24, 0),
    vol1: num(pair.volume?.h1, 0),
    mcap: num(pair.marketCap, num(pair.fdv, 0)),
    m5: num(chg.m5, 0),
    h1: num(chg.h1, 0),
    h6: num(chg.h6, 0),
    buys: num(tx1.buys, 0),
    sells: num(tx1.sells, 0),
    ...extra,
  };
}

function dipWatchPrefilter(pair, isBoosted) {
  const reasons = [];
  const liq = num(pair.liquidity?.usd, 0);
  const vol24 = num(pair.volume?.h24, 0);
  const vol1 = num(pair.volume?.h1, 0);
  const mcap = num(pair.marketCap, num(pair.fdv, 0));
  const created = num(pair.pairCreatedAt, 0);
  const age = created ? Date.now() - created : 0;
  const chg = pair.priceChange || {};
  const h1 = num(chg.h1, 0);
  const h6 = num(chg.h6, 0);
  const tx1 = pair.txns?.h1 || {};
  const buys = num(tx1.buys, 0);
  const sells = num(tx1.sells, 0);

  if (liq < DIP_MIN_LIQ_USD) reasons.push(`liq ${liq.toFixed(0)}`);
  if (vol24 < DIP_MIN_VOL_H24 || vol1 < DIP_MIN_VOL_H1) reasons.push('volume too low');
  if (mcap && (mcap < MIN_MCAP || mcap > MAX_MCAP)) reasons.push(`mcap ${mcap.toFixed(0)}`);
  const maxAge = isBoosted ? MAX_AGE_BOOSTED_MS : MAX_AGE_MS;
  if (created && age < MIN_AGE_MS) reasons.push('too new');
  if (created && age > maxAge) reasons.push('too old');
  if (h1 < DIP_MIN_H1_CHANGE) reasons.push(`h1 ${h1.toFixed(1)}%`);
  if (h6 < DIP_MIN_H6_CHANGE) reasons.push(`h6 ${h6.toFixed(1)}%`);
  // During a real dip, recent sells often outnumber buys; only reject a one-sided dump.
  if (buys + sells >= 30 && buys < sells * 0.8) reasons.push('sell pressure');

  let score = 0;
  score += Math.min(h1, 80) * 0.4;
  score += Math.min(Math.max(h6, 0), 60) * 0.2;
  const turnover = liq > 0 ? Math.min(vol1 / liq, 2) : 0;
  score += turnover * 16;
  score += ((buys - sells) / (buys + sells + 1)) * 16;
  if (liq >= 120_000) score += 4;
  return { ok: reasons.length === 0, reasons, score, liq, vol24, vol1, mcap, age, h1, h6, buys, sells, m5: num(chg.m5, 0) };
}

export async function findDipWatchlist({ excludeMints = new Set(), maxReports = 20 } = {}) {
  const { mints, boosted } = await collectCandidateMints();
  logLine(`dip watch universe mints=${mints.length}`);
  const pairsByMint = await fetchPairs(mints.slice(0, 140));
  const prelim = [];
  const reasonCounts = {};
  for (const [mint, pairs] of pairsByMint.entries()) {
    if (excludeMints.has(mint) || mint === CASH_MINT) continue;
    const pair = bestPair(pairs);
    if (!pair) continue;
    const isBoosted = boosted.has(mint);
    const pf = dipWatchPrefilter(pair, isBoosted);
    const meta = tradableMeta(pair);
    if (meta.mint !== mint) continue;
    if (!pf.ok) {
      const key = (pf.reasons || ['other'])[0] || 'other';
      const bucket = key.replace(/[0-9.].*$/, '').trim() || key;
      reasonCounts[bucket] = (reasonCounts[bucket] || 0) + 1;
      continue;
    }
    prelim.push({ mint, pair, meta, pf, isBoosted });
  }
  prelim.sort((a, b) => b.pf.score - a.pf.score);
  const shortlist = prelim.slice(0, maxReports);
  logLine(`dip watch prefilter passed=${prelim.length} shortlist=${shortlist.length}`, reasonCounts);

  const passed = [];
  for (const item of shortlist) {
    let report = null;
    try {
      report = await rugReport(item.mint);
    } catch (err) {
      logLine(`rugcheck failed ${item.meta.symbol}: ${err.message}`);
      await sleep(400);
      continue;
    }
    const rf = rugFilter(report);
    if (!rf.ok) {
      logLine(`dip watch reject ${item.meta.symbol} rug`, rf.reasons);
      await sleep(300);
      continue;
    }
    passed.push({
      ...tokenFromPair(item.pair, item.mint, {
        isBoosted: item.isBoosted,
        score: item.pf.score + (rf.scoreN < 15 ? 8 : 0) + (rf.lpLocked >= 80 ? 6 : 0),
        market: item.pf,
        rug: rf,
      }),
    });
    await sleep(300);
  }
  passed.sort((a, b) => b.score - a.score);
  if (passed[0]) {
    logLine('dip watchlist ready', {
      n: passed.length,
      top: passed.slice(0, 5).map((t) => t.symbol).join(', '),
    });
  } else {
    logLine('dip watchlist empty after filters');
  }
  return passed;
}
