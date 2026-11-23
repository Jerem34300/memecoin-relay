// Manual self-test (workflow_dispatch with selftest=true): checks the secrets without trading.
import { walletSelfCheck } from '../src/jupiter.mjs';
import { readCoord } from '../src/coord.mjs';

const out = [];
try { await walletSelfCheck(); out.push('wallet secret: OK (matches the trading wallet)'); } catch { out.push('wallet secret: FAILED'); }
try {
  const tok = process.env.TELEGRAM_BOT_TOKEN || '';
  const r = await fetch(`https://api.telegram.org/bot${tok}/getMe`, { signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  out.push(`telegram token: ${j.ok ? 'OK' : 'FAILED'}; chat id: ${process.env.TELEGRAM_CHAT_ID ? 'set' : 'missing'}`);
} catch { out.push('telegram token: FAILED (network)'); }
try { const { coord } = await readCoord(); out.push(`state repo: OK (${coord?.state ? 'state present' : 'no state yet'})`); } catch { out.push('state repo: FAILED'); }
for (const l of out) console.log(`[selftest] ${l}`);
if (out.some((l) => l.includes('FAILED'))) process.exit(1);
