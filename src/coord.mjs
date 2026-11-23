// Box <-> GitHub relay coordination.
// The shared store is the private repo Jerem34300/memecoin-relay-state, branch `main`, holding ONE
// orphan commit with coord.json (+ prices.json). Every write replaces that commit with
// `git push --force-with-lease=main:<sha we read>`: the server only accepts it if nobody wrote in
// between (compare-and-swap), so the box and the relay can never both "win" a change.
// History never grows (old commits are dropped).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

export const COORD_REMOTE = process.env.COORD_REMOTE || 'https://github.com/Jerem34300/memecoin-relay-state.git';
export const COORD_DIR = process.env.COORD_DIR || path.join(ROOT, 'coord-repo');
const BRANCH = 'main';
const REF = `refs/heads/${BRANCH}`;
const TRACK = `refs/remotes/origin/${BRANCH}`;

// Protocol timings (shared by both sides).
export const BOX_PUBLISH_EVERY_MS = 60_000; // box heartbeat cadence
export const BOX_FRESH_MS = 5 * 60_000; // box opens/closes trades only if its last heartbeat write is newer than this
export const BOX_STALE_MS = 8 * 60_000; // relay may start only if the box heartbeat is older than this
export const RELAY_LEASE_MS = 13 * 60_000; // relay lease lifetime (> the job's hard timeout)
export const MAX_RELAY_TRADES = 400;

function run(args, { input, timeoutMs = 25_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: COORD_DIR,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${args[0]} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else {
        const e = new Error(`git ${args[0]} failed (${code}): ${err.replace(/https:\/\/[^@\s]+@/g, 'https://***@').slice(0, 300)}`);
        e.stderr = err;
        reject(e);
      }
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

let ready = false;
async function ensureRepo() {
  if (ready) return;
  fs.mkdirSync(COORD_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(COORD_DIR, '.git'))) {
    await run(['init', '--quiet']);
  }
  const remotes = (await run(['remote'])).split('\n').map((s) => s.trim());
  if (!remotes.includes('origin')) await run(['remote', 'add', 'origin', COORD_REMOTE]);
  else await run(['remote', 'set-url', 'origin', COORD_REMOTE]);
  await run(['config', 'user.name', process.env.RELAY_MODE === '1' ? 'memecoin-relay' : 'memecoin-box']);
  await run(['config', 'user.email', 'memecoin-bot@users.noreply.github.com']);
  if (COORD_REMOTE.startsWith('https://')) {
    // Box: authenticate through the gh CLI login (token never written here).
    await run(['config', '--replace-all', 'credential.helper', '']);
    await run(['config', '--add', 'credential.helper', '!gh auth git-credential']);
  }
  ready = true;
}

// Returns { sha, coord, prices } — sha null when the branch does not exist yet.
export async function readCoord() {
  await ensureRepo();
  const ls = (await run(['ls-remote', 'origin', REF])).trim();
  if (!ls) return { sha: null, coord: null, prices: null };
  await run(['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', `+${REF}:${TRACK}`]);
  const sha = (await run(['rev-parse', TRACK])).trim();
  let coord = null;
  let prices = null;
  try { coord = JSON.parse(await run(['show', `${sha}:coord.json`])); } catch { coord = null; }
  try { prices = JSON.parse(await run(['show', `${sha}:prices.json`])); } catch { prices = null; }
  return { sha, coord, prices };
}

async function blob(text) {
  return (await run(['hash-object', '-w', '--stdin'], { input: text })).trim();
}

// Compare-and-swap write. Returns { ok: true, sha } or { ok: false, conflict: true }.
export async function writeCoord(baseSha, coord, prices, message = 'update') {
  await ensureRepo();
  const files = { 'coord.json': `${JSON.stringify(coord)}\n` };
  if (prices) files['prices.json'] = `${JSON.stringify(prices)}\n`;
  let tree = '';
  for (const [name, text] of Object.entries(files)) {
    tree += `100644 blob ${await blob(text)}\t${name}\n`;
  }
  const treeSha = (await run(['mktree'], { input: tree })).trim();
  const commit = (await run(['commit-tree', treeSha, '-m', message])).trim();
  const lease = `--force-with-lease=${REF}:${baseSha || ''}`;
  try {
    await run(['push', '--quiet', '--no-verify', lease, 'origin', `${commit}:${REF}`]);
  } catch (err) {
    if (/stale info|rejected|fetch first|non-fast-forward/i.test(err.stderr || err.message)) {
      return { ok: false, conflict: true };
    }
    throw err;
  }
  try { await run(['update-ref', TRACK, commit]); } catch { /* cosmetic */ }
  return { ok: true, sha: commit };
}

// Read-modify-write with retries. `mutate(coord, prices)` returns
// { coord, prices } to write, or null to write nothing. Returns { written, coord, prices, result }.
export async function updateCoord(mutate, { retries = 4, message = 'update' } = {}) {
  let lastErr = null;
  for (let i = 0; i < retries; i += 1) {
    const cur = await readCoord();
    const next = await mutate(cur.coord ? structuredClone(cur.coord) : null, cur.prices, cur);
    if (!next) return { written: false, coord: cur.coord, prices: cur.prices, base: cur };
    const res = await writeCoord(cur.sha, next.coord, next.prices === undefined ? cur.prices : next.prices, message);
    if (res.ok) return { written: true, coord: next.coord, prices: next.prices, base: cur };
    lastErr = new Error('coord write conflict');
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 800));
  }
  throw lastErr || new Error('coord update failed');
}

export function relayLeaseActive(coord, now = Date.now()) {
  const l = coord?.lease;
  return Boolean(l && l.owner === 'relay' && Number(l.expiresAt) > now);
}

export function withTimeout(promise, ms, label = 'operation') {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out`)), ms); }),
  ]);
}
