import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, EXPECTED_ADDRESS, ROOT, SOL_MINT } from './config.mjs';
import { loadDeposits, totalInvested } from './deposits.mjs';
import { loadHoldings } from './holdings.mjs';
import { combinedView } from './perps_accounts.mjs';
import { loadState, loadTrades } from './state.mjs';
import { logLine, num, parisIso, parisParts, sleep } from './util.mjs';

export const TELEGRAM_ENV = path.join(ROOT, '.telegram.env');
const RATE_FILE = path.join(DATA_DIR, 'telegram-rate.json');
const LOG_FILE = path.join(DATA_DIR, 'telegram.log');
const WELCOME_LOCK = path.join(DATA_DIR, 'telegram-welcome.lock');
const API_BASE = 'https://api.telegram.org/bot';

const MAX_PER_MIN = 5;
const MAX_MSG = 3500;

const CASH_SOL_SWAP = {
  at: '2026-11-23T09:49:40+01:00',
  tx: '47kcxjRoEWrX5eUgYGQuWvsYPCZQA4t51wjSBSBqucxGbFULvdxBvRh8tbPrMN3swT86ZfxJpCQpR91rStS9fwKF',
  cash: 4.5,
  sol: 0.059266033,
};

function tgLog(msg, extra) {
  const line = `[${parisIso()}] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* ignore */
  }
  logLine(msg, extra);
}

export function loadTelegramEnv() {
  const out = { ...process.env };
  try {
    for (const line of fs.readFileSync(TELEGRAM_ENV, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
      if (k) out[k] = v;
    }
  } catch {
    /* missing file */
  }
  return out;
}

function writeTelegramEnv(patch) {
  const cur = loadTelegramEnv();
  Object.assign(cur, patch);
  const keys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_WELCOME_SENT', 'TELEGRAM_UPDATE_OFFSET'];
  const seen = new Set();
  const lines = [];
  for (const k of keys) {
    if (cur[k]) {
      lines.push(`${k}=${cur[k]}`);
      seen.add(k);
    }
  }
  fs.writeFileSync(TELEGRAM_ENV, `${lines.join('\n')}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(TELEGRAM_ENV, 0o600);
  } catch {
    /* already 600 */
  }
}

export function telegramChatId() {
  const id = loadTelegramEnv().TELEGRAM_CHAT_ID;
  return id ? String(id) : '';
}

function token() {
  return loadTelegramEnv().TELEGRAM_BOT_TOKEN || '';
}

export function eurStr(v, { sign = false } = {}) {
  const n = num(v, 0);
  const body = `${Math.abs(n).toFixed(2).replace('.', ',')} €`;
  if (!sign) return body;
  if (Math.abs(n) < 0.005) return '0,00 €';
  return `${n > 0 ? '+' : '−'}${body}`;
}

export function pctStr(frac) {
  const n = num(frac, 0) * 100;
  const body = `${Math.abs(n).toFixed(1).replace('.', ',')} %`;
  if (Math.abs(n) < 0.05) return '0,0 %';
  return `${n > 0 ? '+' : '−'}${body}`;
}

export function hourLabel(iso) {
  if (!iso) return '';
  const p = parisParts(new Date(iso));
  return `${Number(p.hour)} h ${p.minute}`;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function solscan(sig) {
  if (!sig || String(sig).length < 32) return '';
  return `\n<a href="https://solscan.io/tx/${esc(sig)}">Voir l'échange</a>`;
}

function usdToEur(usd, fx) {
  return num(usd, 0) * (num(fx, 0) || 0.90992);
}

async function api(method, body, { timeoutMs = 25_000 } = {}) {
  const tok = token();
  if (!tok) throw new Error('telegram token missing');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${tok}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ac.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.ok === false) {
      const desc = json?.description || `HTTP ${res.status}`;
      const err = new Error(desc);
      err.status = res.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

function loadRate() {
  try {
    return JSON.parse(fs.readFileSync(RATE_FILE, 'utf8'));
  } catch {
    return { times: [], queue: [] };
  }
}

function saveRate(r) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RATE_FILE, `${JSON.stringify(r)}\n`, { mode: 0o600 });
}

let flushTimer = null;

async function deliver(html) {
  const chat = telegramChatId();
  if (!chat) return { ok: false, reason: 'no chat' };
  const text = process.env.RELAY_MODE === '1'
    ? `☁️ <i>Relais GitHub (mon ordi dort)</i>\n${html}`
    : html;
  const res = await api('sendMessage', {
    chat_id: chat,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  return { ok: true, id: res?.result?.message_id };
}

async function flushQueue() {
  const now = Date.now();
  const r = loadRate();
  r.times = (r.times || []).filter((t) => now - t < 60_000);
  if (!(r.queue || []).length) return;
  if (r.times.length >= MAX_PER_MIN) {
    const wait = Math.max(1_000, 60_000 - (now - r.times[0]) + 200);
    if (!flushTimer) flushTimer = setTimeout(() => {
      flushTimer = null;
      flushQueue().catch((err) => tgLog(`telegram flush failed: ${err.message}`));
    }, wait);
    return;
  }
  const batch = r.queue.splice(0);
  saveRate(r);
  const chunks = splitMessages(batch.join('\n\n'));
  for (const chunk of chunks) {
    const r2 = loadRate();
    r2.times = (r2.times || []).filter((t) => Date.now() - t < 60_000);
    if (r2.times.length >= MAX_PER_MIN) {
      r2.queue = [chunk, ...(r2.queue || [])];
      saveRate(r2);
      await flushQueue();
      return;
    }
    try {
      await deliver(chunk);
      r2.times.push(Date.now());
      saveRate(r2);
      tgLog('telegram sent', { chars: chunk.length, batched: chunks.length > 1 || batch.length > 1 });
    } catch (err) {
      tgLog(`telegram send failed: ${err.message}`);
      const r3 = loadRate();
      r3.queue = [chunk, ...(r3.queue || [])];
      saveRate(r3);
      return;
    }
  }
  if (loadRate().queue?.length) await flushQueue();
}

export async function sendTelegram(html) {
  if (!html || !telegramChatId()) return { ok: false };
  const now = Date.now();
  const r = loadRate();
  r.times = (r.times || []).filter((t) => now - t < 60_000);
  r.queue = r.queue || [];
  if (r.times.length >= MAX_PER_MIN || r.queue.length) {
    r.queue.push(html);
    saveRate(r);
    await flushQueue();
    return { ok: true, queued: true };
  }
  try {
    await deliver(html);
    r.times.push(Date.now());
    saveRate(r);
    tgLog('telegram sent', { chars: html.length });
    return { ok: true };
  } catch (err) {
    tgLog(`telegram send failed: ${err.message}`);
    r.queue.push(html);
    saveRate(r);
    return { ok: false, error: err.message };
  }
}

function splitMessages(text) {
  if (text.length <= MAX_MSG) return [text];
  const parts = text.split('\n\n');
  const out = [];
  let buf = '';
  for (const p of parts) {
    if (buf && `${buf}\n\n${p}`.length > MAX_MSG) {
      out.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export async function liveAccount() {
  const state = loadState() || {};
  const invested = totalInvested(state.baselineUsd, state.baselineEur, loadDeposits());
  let snapshot = null;
  try {
    snapshot = await loadHoldings();
  } catch (err) {
    tgLog(`telegram holdings failed: ${err.message}`);
    try {
      const h = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'health.json'), 'utf8'));
      snapshot = {
        equityEur: num(h.equityEur, 0),
        equityUsd: num(h.equityUsd, 0),
        usdEur: invested.eur && state.baselineUsd ? state.baselineEur / state.baselineUsd : 0.90992,
        solUsd: 0,
        holdings: [],
      };
    } catch {
      snapshot = { equityEur: 0, equityUsd: 0, usdEur: 0.90992, solUsd: 0, holdings: [] };
    }
  }
  const fx = snapshot.usdEur || (snapshot.equityUsd > 0 ? snapshot.equityEur / snapshot.equityUsd : 0.90992);
  const combo = combinedView({
    spotEquityUsd: snapshot.equityUsd,
    spotEquityEur: snapshot.equityEur,
    investedEur: invested.eur,
    investedUsd: invested.usd,
    solUsd: snapshot.solUsd,
    usdEur: fx,
  });
  return { state, snapshot, invested, combo, fx };
}

function totalBlock(combo) {
  const pnl = combo.pnlEur;
  const word = pnl > 0.005 ? 'Gain' : pnl < -0.005 ? 'Perte' : 'Équilibre';
  return [
    `Le compte vaut <b>${esc(eurStr(combo.totalEur))}</b>`,
    `Mis en tout : ${esc(eurStr(combo.investedEur))}`,
    `${word} réel : <b>${esc(eurStr(pnl, { sign: true }))}</b> (${esc(pctStr((combo.pnlPct || 0) / 100))})`.replace(
      pctStr((combo.pnlPct || 0) / 100),
      // pnlPct from combinedView is already in percent points
      esc(pctStr(num(combo.pnlPct, 0) / 100)),
    ),
  ];
}

function totalBlockSafe(combo) {
  const pnl = num(combo.pnlEur, 0);
  const label = pnl > 0.005 ? 'Gain réel' : pnl < -0.005 ? 'Perte réelle' : 'Équilibre';
  // combinedView.pnlPct is already a percentage (e.g. -4.7)
  const pct = `${(combo.pnlPct > 0 ? '+' : combo.pnlPct < 0 ? '−' : '')}${Math.abs(num(combo.pnlPct, 0)).toFixed(1).replace('.', ',')} %`;
  return [
    `Le compte vaut <b>${esc(eurStr(combo.totalEur))}</b>`,
    `Mis en tout : ${esc(eurStr(combo.investedEur))}`,
    `${label} : <b>${esc(eurStr(pnl, { sign: true }))}</b> (${esc(pct)})`,
  ].join('\n');
}

function whyBuy(mode) {
  if (mode === 'dip') return 'Il a acheté après une petite baisse, pour revendre si ça remonte.';
  if (mode === 'momentum') return "Il a acheté parce que le jeton montrait encore de l'élan.";
  return "Il a acheté ce jeton selon les règles en vigueur à ce moment-là.";
}

function whySell(reason, pnlEur) {
  const map = {
    'take-profit': 'Il a pris le gain.',
    'hard-stop': 'Il s’est arrêté pour limiter la perte.',
    'trailing-stop': 'Le prix est redescendu un peu, il a sécurisé.',
    'time-stop': 'Le temps était écoulé sans assez de rebond.',
  };
  return map[reason] || (pnlEur >= 0 ? 'Il a clôturé la position.' : 'Il a clôturé la position, en perte.');
}

function openPositionsText(state, combo, fx) {
  const lines = [];
  for (const p of state?.positions || []) {
    const mode = (p.mode || 'momentum') === 'dip' ? 'petite baisse' : 'élan';
    const eur = usdToEur(p.entryUsd, fx);
    lines.push(`• ${esc(p.symbol)} — ouvert à ${esc(eurStr(eur))} (${mode})`);
  }
  const pp = combo?.perps?.position;
  if (pp) {
    const side = pp.side === 'short' ? 'short (baisse)' : 'long (hausse)';
    lines.push(`• Perps SOL — ${side}, ouvert à ${esc(hourLabel(pp.openedIso) || 'cette heure')}`);
  }
  if (!lines.length) return 'Aucune position ouverte.';
  return lines.join('\n');
}

export async function buildEtat() {
  const { state, combo, fx } = await liveAccount();
  return [
    '📊 <b>État du compte</b>',
    '',
    totalBlockSafe(combo),
    '',
    '<b>Positions ouvertes</b>',
    openPositionsText(state, combo, fx),
  ].join('\n');
}

export function buildAide() {
  return [
    'ℹ️ <b>Comment ça marche</b>',
    '',
    'Je t’écris à chaque achat et vente, en euros, avec un lien pour voir l’échange.',
    '',
    '🟢 achat  ·  ✅ gain  ·  🔴 perte',
    '📊 /etat — le compte et les positions ouvertes',
    'ℹ️ /aide — ce message',
  ].join('\n');
}

export async function notifySpotBuy({ symbol, eur, mode, tx, why }) {
  const html = [
    `🟢 <b>Achat</b> · ${esc(symbol)}`,
    `Montant : <b>${esc(eurStr(eur))}</b>`,
    esc(why || whyBuy(mode)),
    solscan(tx).trim(),
  ].filter(Boolean).join('\n');
  return sendTelegram(html);
}

export async function notifySpotSell({ symbol, pnlEur, pnlPct, tx, reason, combo }) {
  const gain = num(pnlEur, 0) >= 0;
  const icon = gain ? '✅' : '🔴';
  const word = gain ? 'Gain' : 'Perte';
  const acc = combo ? `\n${totalBlockSafe(combo)}` : '';
  const html = [
    `${icon} <b>Vente</b> · ${esc(symbol)}`,
    `${word} : <b>${esc(eurStr(pnlEur, { sign: true }))}</b> (${esc(pctStr(pnlPct))})`,
    esc(whySell(reason, pnlEur)),
    acc.trim(),
    solscan(tx).trim(),
  ].filter(Boolean).join('\n');
  return sendTelegram(html);
}

export async function notifyPerpsOpen({ side, tx, entry, eur }) {
  const long = side !== 'short';
  const html = [
    `🟢 <b>Perps</b> · ${long ? 'long' : 'short'} sur SOL`,
    long ? 'Il parie que le prix du SOL va monter.' : 'Il parie que le prix du SOL va baisser.',
    entry ? `Entrée vers ${esc(Number(entry).toFixed(2).replace('.', ','))} $` : '',
    eur != null ? `Compte Perps : environ <b>${esc(eurStr(eur))}</b>` : '',
    solscan(tx).trim(),
  ].filter(Boolean).join('\n');
  return sendTelegram(html);
}

export async function notifyPerpsClose({ side, pnlEur, reason, tx, combo }) {
  if (!combo) {
    try { combo = (await liveAccount()).combo; } catch { /* optional */ }
  }
  const gain = num(pnlEur, 0) >= 0;
  const icon = gain ? '✅' : '🔴';
  const word = gain ? 'Gain' : 'Perte';
  const dir = side === 'short' ? 'short' : 'long';
  const acc = combo ? `\n${totalBlockSafe(combo)}` : '';
  const html = [
    `${icon} <b>Perps clôturé</b> · ${dir} SOL`,
    `${word} : <b>${esc(eurStr(pnlEur, { sign: true }))}</b>`,
    esc(whySell(reason, pnlEur)),
    acc.trim(),
    solscan(tx).trim(),
  ].filter(Boolean).join('\n');
  return sendTelegram(html);
}

export async function notifyDeposit({ amount, asset, eur, tx }) {
  const html = [
    '📥 <b>Dépôt reçu</b>',
    `${esc(String(amount))} ${esc(asset || 'SOL')} · <b>${esc(eurStr(eur))}</b>`,
    'Cet argent s’ajoute au mis en tout, ce n’est pas un gain.',
    solscan(tx).trim(),
  ].filter(Boolean).join('\n');
  return sendTelegram(html);
}

export async function notifyPause(reason) {
  return sendTelegram(
    [
      '⏸️ <b>Le robot est en pause</b> pour aujourd’hui',
      esc(reason || 'Le compte a trop baissé sur la journée.'),
      'Il reprendra demain.',
    ].join('\n'),
  );
}

export async function notifyCrash(detail) {
  return sendTelegram(
    [
      '⚠️ <b>Le robot a rencontré un problème</b>',
      'Il va essayer de reprendre tout seul. Si ça dure, on regardera.',
      detail ? `<i>${esc(String(detail).slice(0, 180))}</i>` : '',
    ].filter(Boolean).join('\n'),
  );
}

export async function notifyRestart(kind = 'spot') {
  const label = kind === 'perps' ? 'Le test Perps a redémarré.' : 'Le robot comptant a redémarré.';
  return sendTelegram(`🔄 <b>Redémarrage</b>\n${label}`);
}

export async function notifyKill(reason) {
  return sendTelegram(
    [
      '🛑 <b>Arrêt d’urgence (Perps)</b>',
      esc(reason || 'Le test Perps a été arrêté pour protéger le compte.'),
    ].join('\n'),
  );
}

function soldAfter(trades, buy) {
  return trades.find((t) => t.side === 'sell' && t.symbol === buy.symbol && Date.parse(t.at) >= Date.parse(buy.at));
}

export async function buildRecapMessages(fxFallback) {
  const { state, combo, fx: liveFx } = await liveAccount();
  const fx = liveFx || fxFallback || 0.90992;
  const trades = loadTrades();
  const deposits = loadDeposits();
  const events = [];

  events.push({
    at: state.startedAt || '2026-11-23T09:49:47+01:00',
    html: `🕘 ${esc(hourLabel(state.startedAt || '2026-11-23T09:49:47+01:00'))} — Le robot a démarré avec <b>${esc(eurStr(state.baselineEur || 13.3512))}</b>.`,
  });
  events.push({
    at: CASH_SOL_SWAP.at,
    html: `🔄 ${esc(hourLabel(CASH_SOL_SWAP.at))} — Il a échangé 4,5 CASH contre 0,06 SOL, pour payer les frais des échanges.${solscan(CASH_SOL_SWAP.tx)}`,
  });

  for (const d of deposits) {
    events.push({
      at: d.at,
      html: `📥 ${esc(hourLabel(d.at))} — Tu as envoyé <b>${esc(eurStr(d.eur))}</b> de ${esc(d.asset || 'SOL')} depuis Revolut. Mis en tout : 41,37 €.${solscan(d.tx)}`,
    });
  }

  // UCASH: two buys then one sell — tell as one story at first buy time, plus the sell.
  const skip = new Set();
  const ucashBuys = trades.filter((t) => t.side === 'buy' && t.symbol === 'UCASH');
  if (ucashBuys.length >= 1) {
    const total = ucashBuys.reduce((s, t) => s + usdToEur(t.usd, fx), 0);
    const first = ucashBuys[0];
    events.push({
      at: first.at,
      html: `🟢 ${esc(hourLabel(first.at))} — Achat de UCASH en deux fois (environ <b>${esc(eurStr(total))}</b>). Le jeton montait très vite.${solscan(first.tx)}`,
    });
    for (const b of ucashBuys) skip.add(`${b.at}|${b.tx}`);
  }

  for (const t of trades) {
    if (skip.has(`${t.at}|${t.tx}`)) continue;
    if (t.side === 'buy') {
      const eur = usdToEur(t.usd, fx);
      const open = !soldAfter(trades, t);
      const tail = open ? ' Toujours ouvert.' : '';
      events.push({
        at: t.at,
        html: `🟢 ${esc(hourLabel(t.at))} — Achat de ${esc(t.symbol)} (environ <b>${esc(eurStr(eur))}</b>). ${esc(whyBuy(t.mode))}${tail}${solscan(t.tx)}`,
      });
    } else if (t.side === 'sell') {
      const pnlEur = t.pnlEur != null ? t.pnlEur : usdToEur(t.pnlUsd, fx);
      const icon = num(pnlEur, 0) >= 0 ? '✅' : '🔴';
      events.push({
        at: t.at,
        html: `${icon} ${esc(hourLabel(t.at))} — Vente de ${esc(t.symbol)} : <b>${esc(eurStr(pnlEur, { sign: true }))}</b> (${esc(pctStr(t.pnlPct))}). ${esc(whySell(t.reason, pnlEur))}${solscan(t.tx)}`,
      });
    }
  }

  // Perps setup (margin + rent) as one event
  events.push({
    at: '2026-11-23T12:14:14+01:00',
    html: `📈 ${esc(hourLabel('2026-11-23T12:14:14+01:00'))} — Lancement du test Perps : <b>5,00 €</b> de mise et environ <b>1,80 €</b> de caution (rendue à la fermeture du test).`,
  });

  try {
    const journal = fs.readFileSync(path.join(DATA_DIR, 'perps_journal.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    for (const j of journal) {
      if (j.type === 'open') {
        const long = j.side !== 'short';
        events.push({
          at: j.at,
          html: `🟢 ${esc(hourLabel(j.at))} — Pari Perps : il est en <b>${long ? 'long' : 'short'}</b> sur le SOL (il parie que le prix ${long ? 'monte' : 'baisse'}).${solscan(j.tx)}`,
        });
      } else if (j.type === 'close' && j.reason !== 'selftest') {
        const pnl = num(j.pnlEur, usdToEur(j.pnlUsd, fx));
        const icon = pnl >= 0 ? '✅' : '🔴';
        events.push({
          at: j.at,
          html: `${icon} ${esc(hourLabel(j.at))} — Perps clôturé (${j.side || ''}) : <b>${esc(eurStr(pnl, { sign: true }))}</b>. ${esc(whySell(j.reason, pnl))}${solscan(j.tx)}`,
        });
      }
    }
  } catch {
    /* no journal */
  }

  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const header = '📜 <b>Depuis ce matin</b>';
  const closer = `📊 Là, ${totalBlockSafe(combo)}`;
  const body = events.map((e) => e.html).join('\n\n');
  return splitMessages(`${header}\n\n${body}\n\n${closer}`);
}

export async function sendWelcomeAndRecap() {
  if (!telegramChatId()) return { ok: false, reason: 'no chat' };
  try {
    fs.writeFileSync(WELCOME_LOCK, parisIso(), { flag: 'wx', mode: 0o600 });
  } catch {
    tgLog('telegram welcome already claimed');
    return { ok: false, reason: 'already' };
  }
  try {
    const { combo, state, fx } = await liveAccount();
    const welcome = [
      '📊 <b>Ton robot est branché</b>',
      'Tu recevras ici chaque achat et vente.',
      '',
      totalBlockSafe(combo),
      '',
      '<b>Positions ouvertes</b>',
      openPositionsText(state, combo, fx),
    ].join('\n');
    await sendTelegram(welcome);
    const recap = await buildRecapMessages(fx);
    for (const msg of recap) {
      await sendTelegram(msg);
    }
    writeTelegramEnv({ TELEGRAM_WELCOME_SENT: parisIso() });
    tgLog('telegram welcome and recap sent', { recapParts: recap.length });
    return { ok: true, recapParts: recap.length };
  } catch (err) {
    tgLog(`telegram welcome failed: ${err.message}`);
    try {
      fs.unlinkSync(WELCOME_LOCK);
    } catch {
      /* ignore */
    }
    return { ok: false, error: err.message };
  }
}

export function welcomeAlreadySent() {
  return Boolean(loadTelegramEnv().TELEGRAM_WELCOME_SENT);
}

export function welcomeInProgress() {
  return fs.existsSync(WELCOME_LOCK) && !welcomeAlreadySent();
}

export async function notifyStartup(kind = 'spot') {
  if (!telegramChatId()) return { ok: false, reason: 'no chat' };
  if (welcomeInProgress()) return { ok: false, reason: 'welcome in progress' };
  if (!welcomeAlreadySent()) return sendWelcomeAndRecap();
  return notifyRestart(kind);
}

function commandName(text) {
  const t = String(text || '').trim().split(/\s+/)[0] || '';
  const base = t.split('@')[0].toLowerCase();
  return base.startsWith('/') ? base.slice(1) : base;
}

async function handleIncoming(msg) {
  const chat = msg?.chat || {};
  const allowed = telegramChatId();
  if (!allowed || String(chat.id) !== String(allowed)) return;
  const cmd = commandName(msg.text);
  if (cmd === 'etat' || cmd === 'état') {
    await sendTelegram(await buildEtat());
  } else if (cmd === 'aide' || cmd === 'help' || cmd === 'start') {
    if (cmd === 'start' && !welcomeAlreadySent()) await sendWelcomeAndRecap();
    else if (cmd === 'start') await sendTelegram(await buildEtat());
    else await sendTelegram(buildAide());
  }
}

let loopStarted = false;

export function startTelegramLoop() {
  if (loopStarted) return;
  if (!token()) {
    tgLog('telegram loop skipped: no token');
    return;
  }
  loopStarted = true;
  (async () => {
    while (loopStarted) {
      try {
        const env = loadTelegramEnv();
        const offset = Number(env.TELEGRAM_UPDATE_OFFSET || 0);
        const res = await api(
          'getUpdates',
          { timeout: 25, offset, allowed_updates: ['message'] },
          { timeoutMs: 40_000 },
        );
        let next = offset;
        for (const u of res?.result || []) {
          next = Math.max(next, Number(u.update_id) + 1);
          if (u.message) {
            try {
              await handleIncoming(u.message);
            } catch (err) {
              tgLog(`telegram command failed: ${err.message}`);
            }
          }
        }
        if (next !== offset) writeTelegramEnv({ TELEGRAM_UPDATE_OFFSET: String(next) });
      } catch (err) {
        tgLog(`telegram poll failed: ${err.message}`);
        await sleep(3_000);
      }
    }
  })();
}

export function stopTelegramLoop() {
  loopStarted = false;
}
