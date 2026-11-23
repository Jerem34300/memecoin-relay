import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parisParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });
  const map = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return map;
}

export function parisDayKey(date = new Date()) {
  const p = parisParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function parisIso(date = new Date()) {
  const p = parisParts(date);
  const offset = (p.timeZoneName || 'GMT+01:00').replace('GMT', '').replace('UTC', '') || '+01:00';
  const off = offset.includes(':') ? offset : `${offset}:00`;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}

export function logLine(msg, extra) {
  const suffix = extra !== undefined ? ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : '';
  const line = `[${parisIso()}] ${msg}${suffix}`;
  console.log(line);
  return line;
}

export function appendJsonl(file, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, { mode: 0o600 });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export async function fetchJson(url, { timeoutMs = 15_000, method = 'GET', headers = {}, body, retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i += 1) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          'user-agent': 'memecoin-bot/1.0',
          ...headers,
        },
        body,
        signal: ac.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text.slice(0, 500) };
      }
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} ${url}`);
        lastErr.status = res.status;
        lastErr.body = json;
        if (res.status >= 500 || res.status === 429) {
          await sleep(500 * (i + 1));
          continue;
        }
        throw lastErr;
      }
      return json;
    } catch (err) {
      lastErr = err;
      if (i < retries) await sleep(400 * (i + 1));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

export function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function fmtUsd(v) {
  return `$${num(v).toFixed(2)}`;
}

export function fmtEur(v) {
  return `€${num(v).toFixed(2)}`;
}

export function shortMint(mint) {
  if (!mint || mint.length < 10) return mint || '';
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}
