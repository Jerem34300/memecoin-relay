// Combined accounting: spot wallet + Velocity perps test (internal transfers, not deposits).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { num } from './util.mjs';

export const INTERNAL_FILE = path.join(DATA_DIR, 'internal_transfers.jsonl');
const PERPS_STATE = path.join(DATA_DIR, 'perps_state.json');
const PERPS_PID = path.join(DATA_DIR, 'perps.pid');
const PERPS_JOURNAL = path.join(DATA_DIR, 'perps_journal.jsonl');

function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
export function loadInternalTransfers() { return readJsonl(INTERNAL_FILE); }
export function internalTxs() { return new Set(loadInternalTransfers().flatMap((t) => [t.tx, t.swapTx]).filter(Boolean)); }

// Net amount moved out of the spot wallet into perps (positive = out), at booked value.
export function netInternalOut(atIso = null) {
  const lim = atIso ? Date.parse(atIso) : Infinity;
  let usd = 0, eur = 0;
  for (const t of loadInternalTransfers()) {
    if (Date.parse(t.at) > lim) continue;
    usd -= num(t.usd, 0); eur -= num(t.eur, 0); // transfer_to_perps entries are negative
  }
  return { usd, eur };
}
export function firstTransferAt() { const t = loadInternalTransfers()[0]; return t?.at || null; }

function perpsRunning() {
  try { const pid = Number(fs.readFileSync(PERPS_PID, 'utf8').trim()); const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); return cmd.includes('perps.cjs') ? pid : null; } catch { return null; }
}

const e2 = (v) => `${(Math.round(v * 100) / 100).toFixed(2).replace('.', ',')} €`;
const signed = (v) => (Math.abs(v) < 0.005 ? '0,00 €' : `${v > 0 ? '+' : '−'}${e2(Math.abs(v))}`);

// solUsd/usdEur: live prices from the spot snapshot.
export function perpsSnapshot({ solUsd, usdEur }) {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(PERPS_STATE, 'utf8')); } catch { return null; }
  if (!st.deposited) return null;
  const fx = num(usdEur, 0) || num(st.last?.usdEur, 0.91);
  const killed = Boolean(st.killed);
  const equityUsd = killed ? 0 : num(st.last?.equityUsd, num(st.depositUsdt, 0));
  const rentSol = killed && st.rentRefunded ? 0 : num(st.rentSol, 0);
  const rentUsd = rentSol * num(solUsd, 0);
  const out = netInternalOut();
  const valueUsd = equityUsd + rentUsd;
  const valueEur = valueUsd * fx;
  const pnlEur = valueEur - out.eur;
  const closes = readJsonl(PERPS_JOURNAL).filter((x) => x.type === 'close' && x.reason !== 'selftest');
  const wins = closes.filter((x) => num(x.pnlEur, 0) > 0).length;
  const pid = perpsRunning();
  const p = st.position;
  const posTxt = killed
    ? `Test arrêté (${st.killedReason || ''}).`
    : p
      ? `Position ouverte : il parie sur la ${p.side === 'long' ? 'hausse' : 'baisse'} du SOL (x3), stop à ${num(p.sl).toFixed(2)} $, objectif ${num(p.tp).toFixed(2)} $.`
      : 'Aucune position ouverte, il attend une tendance nette du SOL.';
  const line = `Test Perps (SOL x3, la mise suit le solde du compte, les gains sont réinvestis) : ${e2(equityUsd * fx)} sur le compte Perps + ${e2(rentUsd * fx)} de caution rendue à la fermeture = ${e2(valueEur)}, pour ${e2(out.eur)} transférés depuis le robot, soit ${signed(pnlEur)}. ${closes.length} pari(s) terminé(s), ${wins} gagnant(s). ${posTxt}${killed ? '' : pid ? ` (tourne, PID ${pid})` : ' (processus arrêté)'}`;
  return { equityUsd, equityEur: equityUsd * fx, rentSol, rentUsd, rentEur: rentUsd * fx, valueUsd, valueEur, transferredEur: out.eur, transferredUsd: out.usd, pnlEur, trades: closes.length, wins, running: Boolean(pid), pid, killed, position: p || null, line, updatedAt: st.last?.at || null };
}

// Combined view against real external money in.
export function combinedView({ spotEquityUsd, spotEquityEur, investedEur, investedUsd, solUsd, usdEur }) {
  const perps = perpsSnapshot({ solUsd, usdEur });
  const out = netInternalOut();
  const totalEur = spotEquityEur + (perps?.valueEur || 0);
  const totalUsd = spotEquityUsd + (perps?.valueUsd || 0);
  const pnlEur = totalEur - investedEur;
  const pnlPct = investedEur > 0 ? (pnlEur / investedEur) * 100 : 0;
  const spotBasisEur = investedEur - out.eur;
  const spotPnlEur = spotEquityEur - spotBasisEur;
  const spotLine = `Robot memecoins : ${e2(spotEquityEur)} dans le portefeuille, pour ${e2(spotBasisEur)} qui lui restent (${e2(investedEur)} mis moins ${e2(out.eur)} prêtés au test Perps), soit ${signed(spotPnlEur)}.`;
  const totalLine = `Valeur totale : ${e2(totalEur)} pour ${e2(investedEur)} mis en tout, soit ${signed(pnlEur)} (${pnlPct >= 0 ? '+' : '−'}${Math.abs(pnlPct).toFixed(1).replace('.', ',')} %).`;
  return { totalEur, totalUsd, pnlEur, pnlPct, investedEur, investedUsd, spotEquityEur, spotBasisEur, spotPnlEur, spotLine, perps, totalLine, perpsLine: perps?.line || null };
}
