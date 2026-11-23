import {
  BASE_MINTS,
  CASH_MINT,
  EXPECTED_ADDRESS,
  JUPITER_PRICE_URL,
  RPC_URL,
  SOL_MINT,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from './config.mjs';
import { fetchJson, logLine, num } from './util.mjs';

async function rpc(method, params) {
  const json = await fetchJson(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    timeoutMs: 20_000,
  });
  if (json?.error) {
    const err = new Error(json.error.message || 'RPC error');
    err.code = json.error.code;
    throw err;
  }
  return json.result;
}

export async function getUsdEurRate() {
  try {
    const d = await fetchJson('https://api.frankfurter.dev/v1/latest?from=USD&to=EUR', { timeoutMs: 8000, retries: 1 });
    const r = num(d?.rates?.EUR, 0);
    if (r > 0) return r;
  } catch {
    /* fallback */
  }
  const d = await fetchJson('https://open.er-api.com/v6/latest/USD', { timeoutMs: 8000, retries: 1 });
  const r = num(d?.rates?.EUR, 0);
  if (r > 0) return r;
  throw new Error('Unable to fetch USD/EUR rate');
}

let lastPrices = {};

async function dexPrices(mints) {
  const out = {};
  const chunkSize = 25;
  for (let i = 0; i < mints.length; i += chunkSize) {
    const chunk = mints.slice(i, i + chunkSize);
    try {
      const data = await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(',')}`, {
        timeoutMs: 10_000,
        retries: 1,
      });
      const list = Array.isArray(data) ? data : data?.pairs || [];
      const best = new Map();
      for (const p of list) {
        const base = p.baseToken?.address;
        const quote = p.quoteToken?.address;
        const px = num(p.priceUsd, 0);
        if (!(px > 0)) continue;
        for (const mint of [base, quote]) {
          if (!mint || !chunk.includes(mint)) continue;
          const liq = num(p.liquidity?.usd, 0);
          const prev = best.get(mint);
          if (!prev || liq > prev.liq) best.set(mint, { usdPrice: px, liq });
        }
      }
      for (const [mint, row] of best.entries()) out[mint] = { usdPrice: row.usdPrice };
    } catch (err) {
      logLine(`dex price fallback failed: ${err.message}`);
    }
  }
  return out;
}

export async function getTokenPricesUsd(mints) {
  const unique = [...new Set(mints.filter(Boolean))];
  const out = {};
  if (!unique.length) return out;
  const chunkSize = 50;
  let jupiterOk = false;
  try {
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const data = await fetchJson(`${JUPITER_PRICE_URL}?ids=${chunk.join(',')}`, { timeoutMs: 15_000, retries: 3 });
      for (const mint of chunk) {
        const row = data?.[mint];
        const px = num(row?.usdPrice, NaN);
        if (Number.isFinite(px) && px > 0) {
          out[mint] = { usdPrice: px, decimals: row?.decimals };
          jupiterOk = true;
        }
      }
    }
  } catch (err) {
    logLine(`jupiter price failed: ${err.message}`);
  }
  const missing = unique.filter((m) => !out[m]);
  if (missing.length) {
    const dex = await dexPrices(missing);
    for (const mint of missing) {
      if (dex[mint]?.usdPrice > 0) out[mint] = dex[mint];
      else if (lastPrices[mint]?.usdPrice > 0) out[mint] = lastPrices[mint];
    }
  }
  for (const [mint, row] of Object.entries(out)) lastPrices[mint] = row;
  if (!jupiterOk && !Object.keys(out).length) {
    throw new Error('No token prices from Jupiter or DexScreener');
  }
  return out;
}

async function tokenAccounts(owner, programId) {
  const result = await rpc('getTokenAccountsByOwner', [
    owner,
    { programId },
    { encoding: 'jsonParsed' },
  ]);
  return (result?.value || []).map((v) => {
    const info = v?.account?.data?.parsed?.info || {};
    const amt = info.tokenAmount || {};
    return {
      pubkey: v.pubkey,
      mint: info.mint,
      amountRaw: String(amt.amount || '0'),
      decimals: num(amt.decimals, 0),
      uiAmount: num(amt.uiAmount, 0),
      uiAmountString: amt.uiAmountString || '0',
      programId,
    };
  });
}

export async function loadHoldings(owner = EXPECTED_ADDRESS) {
  const [solRes, spl, t22, usdEur] = await Promise.all([
    rpc('getBalance', [owner]),
    tokenAccounts(owner, TOKEN_PROGRAM),
    tokenAccounts(owner, TOKEN_2022_PROGRAM),
    getUsdEurRate(),
  ]);
  const lamports = num(solRes?.value, 0);
  const sol = lamports / 1e9;
  const tokens = [...spl, ...t22].filter((t) => num(t.amountRaw, 0) > 0);
  const mints = [SOL_MINT, CASH_MINT, ...tokens.map((t) => t.mint)];
  const prices = await getTokenPricesUsd(mints);
  const solUsd = prices[SOL_MINT]?.usdPrice || 0;
  const cashUsd = prices[CASH_MINT]?.usdPrice || 0;

  const holdings = [
    {
      symbol: 'SOL',
      mint: SOL_MINT,
      amount: sol,
      amountRaw: String(lamports),
      decimals: 9,
      usdPrice: solUsd,
      usd: sol * solUsd,
      native: true,
    },
  ];
  for (const t of tokens) {
    const px = prices[t.mint]?.usdPrice || 0;
    let symbol = t.mint === CASH_MINT ? 'CASH' : t.mint === SOL_MINT ? 'WSOL' : null;
    if (t.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') symbol = 'USDC';
    if (t.mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') symbol = 'USDT';
    holdings.push({
      symbol: symbol || shortUnknown(t.mint),
      mint: t.mint,
      amount: t.uiAmount,
      amountRaw: t.amountRaw,
      decimals: t.decimals,
      usdPrice: px,
      usd: t.uiAmount * px,
      native: false,
      tokenAccount: t.pubkey,
      programId: t.programId,
    });
  }

  const equityUsd = holdings.reduce((s, h) => s + (h.usd || 0), 0);
  return {
    address: owner,
    at: new Date().toISOString(),
    sol,
    lamports,
    solUsd,
    cashUsd,
    usdEur,
    equityUsd,
    equityEur: equityUsd * usdEur,
    holdings,
    prices,
  };
}

function shortUnknown(mint) {
  return mint.length > 8 ? mint.slice(0, 4) : mint;
}

export function cashBalance(snapshot) {
  const h = snapshot.holdings.find((x) => x.mint === CASH_MINT);
  return h ? h.amount : 0;
}

export function tokenBalance(snapshot, mint) {
  if (mint === SOL_MINT) return snapshot.sol;
  const h = snapshot.holdings.find((x) => x.mint === mint);
  return h ? h.amount : 0;
}

export function isBaseMint(mint) {
  return BASE_MINTS.has(mint);
}

export async function findTokenAccount(mint, owner = EXPECTED_ADDRESS) {
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const accts = await tokenAccounts(owner, programId);
    const hit = accts.find((a) => a.mint === mint);
    if (hit) return hit;
  }
  return null;
}
