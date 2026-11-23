import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, EXPECTED_ADDRESS, RPC_URL, SOL_MINT } from './config.mjs';
import { getTokenPricesUsd, getUsdEurRate } from './holdings.mjs';
import { loadTrades } from './state.mjs';
import { appendJsonl, num, parisIso, parisParts } from './util.mjs';

export const DEPOSITS_FILE = path.join(DATA_DIR, 'deposits.jsonl');
const MIN_SOL_DEPOSIT = 0.001;

export function loadDeposits() {
  try {
    return fs
      .readFileSync(DEPOSITS_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function knownDepositTxs(deposits = loadDeposits()) {
  const set = new Set(deposits.map((d) => d.tx).filter(Boolean));
  for (const t of loadTrades()) {
    if (t.tx) set.add(t.tx);
  }
  // Wallet <-> Perps moves are internal, never external deposits.
  try {
    for (const line of fs.readFileSync(path.join(DATA_DIR, 'internal_transfers.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const t = JSON.parse(line);
      if (t.tx) set.add(t.tx);
      if (t.swapTx) set.add(t.swapTx);
    }
  } catch {
    /* no internal transfers yet */
  }
  // Internal SOL->CASH conversions are never deposits either.
  try {
    for (const line of fs.readFileSync(path.join(DATA_DIR, 'conversions.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const t = JSON.parse(line);
      if (t.tx) set.add(t.tx);
    }
  } catch {
    /* none */
  }
  return set;
}

export function depositTotals(deposits = loadDeposits()) {
  return {
    usd: deposits.reduce((s, d) => s + num(d.usd, 0), 0),
    eur: deposits.reduce((s, d) => s + num(d.eur, 0), 0),
    count: deposits.length,
  };
}

export function totalInvested(baselineUsd, baselineEur, deposits = loadDeposits()) {
  const t = depositTotals(deposits);
  return {
    usd: num(baselineUsd, 0) + t.usd,
    eur: num(baselineEur, 0) + t.eur,
    depositsUsd: t.usd,
    depositsEur: t.eur,
    count: t.count,
  };
}

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json();
  if (json?.error) {
    const err = new Error(json.error.message || 'RPC error');
    err.code = json.error.code;
    throw err;
  }
  return json.result;
}

function accountKeys(tx) {
  const msg = tx?.transaction?.message || {};
  const keys = [];
  for (const k of msg.accountKeys || []) {
    if (typeof k === 'string') keys.push({ pubkey: k, signer: false });
    else {
      keys.push({
        pubkey: k.pubkey || k.address,
        signer: Boolean(k.signer),
      });
    }
  }
  return keys;
}

function parisIsoFromUnix(ts) {
  if (!ts) return parisIso();
  const d = new Date(ts * 1000);
  const p = parisParts(d);
  const offset = (p.timeZoneName || 'GMT+01:00').replace('GMT', '').replace('UTC', '') || '+01:00';
  const off = offset.includes(':') ? offset : `${offset}:00`;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}

export function inspectParsedTx(tx, owner = EXPECTED_ADDRESS) {
  if (!tx) return null;
  const keys = accountKeys(tx);
  const ours = keys.find((k) => k.pubkey === owner);
  if (ours?.signer) return null;
  const idx = keys.findIndex((k) => k.pubkey === owner);
  if (idx < 0) return null;
  const pre = tx.meta?.preBalances || [];
  const post = tx.meta?.postBalances || [];
  const delta = (post[idx] ?? 0) - (pre[idx] ?? 0);
  const instructions = [];
  const msg = tx.transaction?.message || {};
  for (const ix of msg.instructions || []) {
    if (ix?.parsed) instructions.push(ix.parsed);
  }
  for (const inner of tx.meta?.innerInstructions || []) {
    for (const ix of inner.instructions || []) {
      if (ix?.parsed) instructions.push(ix.parsed);
    }
  }
  let from = null;
  let lamports = 0;
  for (const p of instructions) {
    if (p?.type !== 'transfer') continue;
    const info = p.info || {};
    if (info.destination === owner && num(info.lamports, 0) > 0) {
      lamports += num(info.lamports, 0);
      from = info.source || from;
    }
  }
  if (lamports <= 0 && delta >= MIN_SOL_DEPOSIT * 1e9) {
    lamports = delta;
  }
  const amount = lamports / 1e9;
  if (amount < MIN_SOL_DEPOSIT) return null;
  return {
    from,
    lamports,
    amount,
    solDelta: delta / 1e9,
    slot: tx.slot,
    blockTime: tx.blockTime,
  };
}

export function appendDeposit(entry) {
  const existing = loadDeposits();
  if (existing.some((d) => d.tx === entry.tx)) return { recorded: false, entry: existing.find((d) => d.tx === entry.tx) };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  appendJsonl(DEPOSITS_FILE, entry);
  return { recorded: true, entry };
}

export function applyDepositToState(state, entry) {
  if (!state || !entry?.tx) return state;
  const seen = new Set(state.recordedDepositTxs || []);
  if (seen.has(entry.tx)) return state;
  seen.add(entry.tx);
  state.recordedDepositTxs = [...seen];
  state.depositsUsd = num(state.depositsUsd, 0) + num(entry.usd, 0);
  state.depositsEur = num(state.depositsEur, 0) + num(entry.eur, 0);
  const depDay = String(entry.at || '').slice(0, 10);
  if (depDay && depDay === state.dayKey) {
    state.dayStartUsd = num(state.dayStartUsd, 0) + num(entry.usd, 0);
  }
  return state;
}

export function applyPendingDepositsToState(state, deposits = loadDeposits()) {
  if (!state) return state;
  for (const entry of deposits) applyDepositToState(state, entry);
  return state;
}

export async function priceDeposit(amountSol, { solUsd, usdEur, solEur } = {}) {
  let usdPrice = num(solUsd, 0);
  let fx = num(usdEur, 0);
  let eurPrice = num(solEur, 0);
  if (!(usdPrice > 0) || !(fx > 0)) {
    const [prices, liveFx] = await Promise.all([getTokenPricesUsd([SOL_MINT]), getUsdEurRate()]);
    usdPrice = usdPrice || num(prices[SOL_MINT]?.usdPrice, 0);
    fx = fx || num(liveFx, 0);
  }
  if (!(eurPrice > 0)) eurPrice = usdPrice * fx;
  return {
    solUsd: usdPrice,
    usdEur: fx,
    solEur: eurPrice,
    usd: amountSol * usdPrice,
    eur: amountSol * eurPrice,
  };
}

export async function scanForDeposits(owner = EXPECTED_ADDRESS) {
  const known = knownDepositTxs();
  const sigs = (await rpc('getSignaturesForAddress', [owner, { limit: 30 }])) || [];
  const found = [];
  for (const s of sigs) {
    if (s.err || !s.signature || known.has(s.signature)) continue;
    const tx = await rpc('getTransaction', [
      s.signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ]);
    const parsed = inspectParsedTx(tx, owner);
    if (!parsed) continue;
    const priced = await priceDeposit(parsed.amount);
    found.push({
      at: parisIsoFromUnix(parsed.blockTime),
      blockTime: parsed.blockTime,
      slot: parsed.slot,
      tx: s.signature,
      kind: 'deposit',
      asset: 'SOL',
      mint: SOL_MINT,
      amount: parsed.amount,
      amountRaw: String(parsed.lamports),
      from: parsed.from,
      ...priced,
    });
  }
  return found;
}

export async function syncDeposits(state = null) {
  const found = await scanForDeposits();
  const recorded = [];
  for (const entry of found) {
    const res = appendDeposit(entry);
    if (res.recorded) {
      recorded.push(res.entry);
      if (state) applyDepositToState(state, res.entry);
    }
  }
  return recorded;
}
