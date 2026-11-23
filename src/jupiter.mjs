import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import {
  EXPECTED_ADDRESS,
  JUPITER_EXECUTE_URL,
  JUPITER_ORDER_URL,
  MAX_ENTRY_FRICTION,
  MAX_EXIT_FRICTION,
  MAX_PRICE_IMPACT_FRAC,
  MAX_SLIPPAGE_BPS_RESP,
  MAX_SLIPPAGE_FRAC,
  NET_FEE_LAMPORTS_PER_TX,
  RPC_URL,
  SOL_MINT,
  WALLET_PATH,
} from './config.mjs';
import { fetchJson, logLine, num } from './util.mjs';
import { timedFetch } from './net.mjs';

let cachedKeypair = null;

async function loadKeypair() {
  if (cachedKeypair) return cachedKeypair;
  const secret = Uint8Array.from(JSON.parse(readFileSync(WALLET_PATH, 'utf8')));
  const keypair = await Keypair.fromSecretKey(secret);
  const pubkey = keypair.publicKey.toBase58();
  if (pubkey !== EXPECTED_ADDRESS) {
    throw new Error(`Wallet public key mismatch: got ${pubkey}`);
  }
  cachedKeypair = keypair;
  return keypair;
}

function summarizeOrder(order) {
  const tx = order?.transaction;
  return {
    inAmount: order?.inAmount,
    outAmount: order?.outAmount,
    otherAmountThreshold: order?.otherAmountThreshold,
    inUsdValue: order?.inUsdValue,
    outUsdValue: order?.outUsdValue,
    feeBps: order?.feeBps,
    router: order?.router,
    gasless: order?.gasless,
    slippageBps: order?.slippageBps,
    priceImpactPct: order?.priceImpactPct,
    priceImpact: order?.priceImpact,
    errorCode: order?.errorCode,
    errorMessage: order?.errorMessage,
    transactionPresent: Boolean(tx),
    signatureFeePayer: order?.signatureFeePayer || null,
  };
}

function impactFraction(order) {
  const inUsd = num(order?.inUsdValue, 0);
  const outUsd = num(order?.outUsdValue, 0);
  if (inUsd > 0 && outUsd > 0) {
    return Math.max(0, (inUsd - outUsd) / inUsd);
  }
  const rawPct = num(order?.priceImpactPct, NaN);
  const raw = num(order?.priceImpact, NaN);
  const vals = [rawPct, raw].filter((v) => Number.isFinite(v)).map((v) => Math.abs(v));
  if (vals.length >= 2) {
    const hi = Math.max(...vals);
    const lo = Math.min(...vals);
    // Fields often differ by 100x (0.00278 vs 0.278). The smaller is the fraction.
    if (lo > 0 && hi / lo > 50 && hi / lo < 150) return lo > 1 ? lo / 100 : lo;
  }
  if (!vals.length) return 0;
  const v = vals[0];
  return v > 1 ? v / 100 : v;
}

export function validateOrder(order, { isExit = false } = {}) {
  const reasons = [];
  if (!order) reasons.push('no order');
  if (order?.errorCode) reasons.push(`error ${order.errorCode}: ${order.errorMessage || ''}`.trim());
  if (!order?.transaction) reasons.push('no transaction');
  const out = num(order?.outAmount, 0);
  const threshold = num(order?.otherAmountThreshold, out);
  if (out <= 0) reasons.push('outAmount is 0');
  const slip = out > 0 ? 1 - threshold / out : 1;
  if (slip > MAX_SLIPPAGE_FRAC) reasons.push(`slippage ${(slip * 100).toFixed(2)}% > cap`);
  if (num(order?.slippageBps, 0) > MAX_SLIPPAGE_BPS_RESP) {
    reasons.push(`response slippageBps ${order.slippageBps} too high`);
  }
  const impact = impactFraction(order);
  if (impact > MAX_PRICE_IMPACT_FRAC) reasons.push(`price impact ${(impact * 100).toFixed(2)}% too high`);
  const inUsd = num(order?.inUsdValue, 0);
  const outUsd = num(order?.outUsdValue, 0);
  if (inUsd > 0 && outUsd > 0) {
    const friction = (inUsd - outUsd) / inUsd;
    const cap = isExit ? MAX_EXIT_FRICTION : MAX_ENTRY_FRICTION;
    if (friction > cap) reasons.push(`all-in friction ${(friction * 100).toFixed(2)}% > ${(cap * 100).toFixed(0)}%`);
  }
  return { ok: reasons.length === 0, reasons, impact, slip, summary: summarizeOrder(order) };
}

export async function getOrder({ inputMint, outputMint, amount, taker = EXPECTED_ADDRESS }) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
  });
  if (taker) params.set('taker', taker);
  const order = await fetchJson(`${JUPITER_ORDER_URL}?${params}`, { timeoutMs: 20_000 });
  return order;
}

const SWAP_MARKER = new URL('../data/swap.inflight', import.meta.url);

export async function executeSwap(args) {
  // Flag read by the watchdog: gives a swap in flight more time before a forced restart.
  // The marker file tells the external supervisor (supervise.sh) the same thing.
  globalThis.__swapInFlight = (globalThis.__swapInFlight || 0) + 1;
  try {
    writeFileSync(SWAP_MARKER, `${process.pid}\n`);
  } catch {
    /* ignore */
  }
  try {
    return await executeSwapInner(args);
  } finally {
    globalThis.__swapInFlight -= 1;
    if (globalThis.__swapInFlight <= 0) {
      try {
        rmSync(SWAP_MARKER, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

async function executeSwapInner({ inputMint, outputMint, amount, isExit = false, context = '' }) {
  const order = await getOrder({ inputMint, outputMint, amount, taker: EXPECTED_ADDRESS });
  const check = validateOrder(order, { isExit });
  logLine(`jupiter order ${context}`.trim(), check.summary);
  if (!check.ok) {
    return { ok: false, reason: check.reasons.join('; '), check, order: check.summary };
  }

  const keypair = await loadKeypair();
  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
  await tx.sign([keypair]);
  const signedTxBase64 = Buffer.from(tx.serialize()).toString('base64');

  const exec = await fetchJson(JUPITER_EXECUTE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      signedTransaction: signedTxBase64,
      requestId: order.requestId,
    }),
    timeoutMs: 60_000,
    retries: 0,
  });

  const ok = exec?.status === 'Success';
  logLine(`jupiter execute ${context}`.trim(), {
    ok,
    status: exec?.status,
    code: exec?.code,
    signature: exec?.signature || null,
    error: exec?.error || null,
    totalInputAmount: exec?.totalInputAmount,
    totalOutputAmount: exec?.totalOutputAmount,
  });
  return {
    ok,
    signature: exec?.signature || null,
    exec,
    check,
    inAmount: exec?.totalInputAmount || order.inAmount,
    outAmount: exec?.totalOutputAmount || order.outAmount,
    inUsdValue: order.inUsdValue,
    outUsdValue: order.outUsdValue,
  };
}

export async function quoteSellable(mint, amountRaw) {
  try {
    const { SOL_MINT } = await import('./config.mjs');
    // Quote only (no taker): we do not hold the token yet, so a taker-bound
    // transaction would fail with insufficient funds even if the pool is fine.
    const order = await getOrder({
      inputMint: mint,
      outputMint: SOL_MINT,
      amount: amountRaw,
      taker: null,
    });
    const out = num(order?.outAmount, 0);
    if (out <= 0 || (order?.errorCode && out <= 0)) {
      return {
        ok: false,
        reasons: [order?.errorMessage || order?.errorCode || 'no sell route'],
        summary: summarizeOrder(order),
      };
    }
    const impact = impactFraction(order);
    if (impact > MAX_PRICE_IMPACT_FRAC) {
      return {
        ok: false,
        reasons: [`sell impact ${(impact * 100).toFixed(2)}%`],
        summary: summarizeOrder(order),
      };
    }
    return { ok: true, reasons: [], summary: summarizeOrder(order) };
  } catch (err) {
    return { ok: false, reasons: [err.message], summary: null };
  }
}


export function orderFriction(order) {
  const inUsd = num(order?.inUsdValue, 0);
  const outUsd = num(order?.outUsdValue, 0);
  if (inUsd > 0 && outUsd > 0) return (inUsd - outUsd) / inUsd;
  return null;
}

export async function estimateRoundTrip({ inputMint, outputMint, amount, solUsd, sizeUsd }) {
  const buy = await getOrder({ inputMint, outputMint, amount, taker: null });
  const buyOut = num(buy?.outAmount, 0);
  const buyFric = orderFriction(buy);
  let sell = null;
  let sellFric = null;
  if (buyOut > 0) {
    sell = await getOrder({
      inputMint: outputMint,
      outputMint: inputMint || SOL_MINT,
      amount: buy.outAmount,
      taker: null,
    });
    sellFric = orderFriction(sell);
  }
  const netUsd = ((2 * NET_FEE_LAMPORTS_PER_TX) / 1e9) * num(solUsd, 0);
  const networkFrac = sizeUsd > 0 ? netUsd / sizeUsd : 0;
  const total =
    (buyFric == null || sellFric == null) ? 1 : buyFric + sellFric + networkFrac;
  return {
    ok: buyOut > 0 && num(sell?.outAmount, 0) > 0 && buyFric != null && sellFric != null,
    buyFriction: buyFric,
    sellFriction: sellFric,
    networkFrac,
    networkUsd: netUsd,
    total,
    totalUsd: sizeUsd > 0 ? total * sizeUsd : null,
    buy: summarizeOrder(buy),
    sell: summarizeOrder(sell),
  };
}

export async function closeEmptyTokenAccount(tokenAccount, programId) {
  if (!tokenAccount || !programId) return { ok: false, reason: 'missing account' };
  const keypair = await loadKeypair();
  const connection = new Connection(RPC_URL, { commitment: 'confirmed', fetch: timedFetch });
  const ix = new TransactionInstruction({
    programId: new PublicKey(programId),
    keys: [
      { pubkey: new PublicKey(tokenAccount), isSigner: false, isWritable: true },
      { pubkey: keypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = keypair.publicKey;
  const latest = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = latest.blockhash;
  if (typeof tx.sign === 'function') {
    const signed = tx.sign([keypair]);
    if (signed && typeof signed.then === 'function') await signed;
  }
  const raw = typeof tx.serialize === 'function' ? tx.serialize() : null;
  if (!raw) return { ok: false, reason: 'cannot serialize close tx' };
  const sig = await connection.sendRawTransaction(raw, { skipPreflight: false });
  const conf = await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
  if (conf?.value?.err) {
    return { ok: false, reason: JSON.stringify(conf.value.err), signature: sig };
  }
  logLine('closed empty token account', { signature: sig, account: tokenAccount });
  return { ok: true, signature: sig };
}
