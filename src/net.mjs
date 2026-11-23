// Network hardening: every fetch() in this process gets a hard timeout, so a
// request left hanging (e.g. after the box was paused) can never block a tick forever.
// Must be the FIRST import of bot.mjs so other modules (and @solana/web3.js) see it.
export const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20_000);
// Outer cap for callers that already pass their own (possibly longer) abort signal.
const HARD_CAP_MS = 90_000;

const rawFetch = globalThis.fetch.bind(globalThis);

export function timedFetch(input, init = {}) {
  const own = init?.signal;
  const signal = own
    ? AbortSignal.any([own, AbortSignal.timeout(HARD_CAP_MS)])
    : AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS);
  return rawFetch(input, { ...init, signal });
}

if (!globalThis.__memecoinTimedFetch) {
  globalThis.fetch = timedFetch;
  globalThis.__memecoinTimedFetch = true;
}
