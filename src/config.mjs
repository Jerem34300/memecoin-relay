import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const WALLET_PATH = process.env.WALLET_PATH || '/home/box/memecoin-wallet/trading-wallet.json';
export const EXPECTED_ADDRESS = 'Dnq2jhCz9ggfxj7ifZnBE5mFhTTRnCY7DM27fUBnotbn';
export const SWEEP_DESTINATION = process.env.SWEEP_DESTINATION || '';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const CASH_MINT = 'CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH';

export const RPC_URL = 'https://api.mainnet-beta.solana.com';
export const JUPITER_ORDER_URL = 'https://api.jup.ag/swap/v2/order';
export const JUPITER_EXECUTE_URL = 'https://api.jup.ag/swap/v2/execute';
export const JUPITER_PRICE_URL = 'https://api.jup.ag/price/v3';
export const DEXSCREENER = 'https://api.dexscreener.com';
export const RUGCHECK = 'https://api.rugcheck.xyz/v1';

export const SOL_RESERVE = 0.02;
export const SOL_RESERVE_TARGET = 0.025;
export const CYCLE_MS = 4 * 60 * 1000;
export const FAST_TICK_MS = 15_000;
export const WATCHLIST_REFRESH_MS = 2 * 60 * 1000;
export const PRICE_HISTORY_MS = 20 * 60 * 1000;
export const DIP_LOOKBACK_MS = 8 * 60 * 1000;
export const DIP_SHORT_LOOKBACK_MS = 5 * 60 * 1000;

export const MIN_LIQ_USD = 80_000;
export const MIN_VOL_H24 = 20_000;
export const MIN_VOL_H1 = 5_000;
export const MIN_MCAP = 50_000;
export const MAX_MCAP = 12_000_000;
export const MIN_AGE_MS = 20 * 60 * 1000;
export const MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;
export const MAX_AGE_BOOSTED_MS = 60 * 24 * 60 * 60 * 1000;
export const MIN_H1_CHANGE = 8;
export const MIN_M5_CHANGE = -3;
export const MAX_H6_DUMP = -20;
export const MIN_ENTRY_SCORE = 16;

export const MAX_PRICE_IMPACT_FRAC = 0.05;
export const MAX_SLIPPAGE_FRAC = 0.08;
export const MAX_ENTRY_FRICTION = 0.06;
export const MAX_EXIT_FRICTION = 0.12;
export const MAX_SLIPPAGE_BPS_RESP = 900;

export const POSITION_PCT = 0.15;
export const MIN_TRADE_USD = 3.5;
// Per-trade target is capped below; POSITION_PCT is a ceiling on a slice of equity.
export const HARD_STOP = -0.12;
export const TAKE_PROFIT = 0.45;
export const TRAIL_ACTIVATE = 0.22;
export const TRAIL_GIVEBACK = 0.12;
export const TIME_STOP_MS = 8 * 60 * 60 * 1000;
export const TIME_STOP_MIN_PNL = 0.1;
export const DAILY_DRAWDOWN = -0.18;
export const MAX_ENTRIES_PER_DAY = 10;
export const MAX_MOMENTUM_ENTRIES_PER_DAY = 1;
export const MAX_POSITIONS_SMALL = 2;
export const SMALL_EQUITY_USD = 30;
export const MAX_POSITIONS_LARGE = 2;
export const MAX_RUG_SCORE = 35;
export const MAX_TOP_HOLDER_PCT = 18;
export const MAX_TOP10_PCT = 50;
export const COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const LOSS_COOLDOWN_MS = 12 * 60 * 60 * 1000;
export const DIP_COOLDOWN_MS = 45 * 60 * 1000;
export const DIP_LOSS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Buy-the-dip / sell-the-rebound (primary for new entries)
export const DIP_MIN_LIQ_USD = 80_000;
export const DIP_MIN_VOL_H24 = 60_000;
export const DIP_MIN_VOL_H1 = 10_000;
export const DIP_MIN_H1_CHANGE = 0;
export const DIP_MIN_H6_CHANGE = 0;
export const DIP_PULLBACK_MIN = -0.10;
export const DIP_PULLBACK_MAX = -0.05;
export const DIP_TAKE_PROFIT = 0.06;
export const DIP_TAKE_PROFIT_MAX = 0.07;
export const DIP_STOP = -0.05;
// Rebound confirmation (since 2026-11-23 19h): the low must be 5-12% under the recent high,
// price must already be back >=1.5% above that low with 2 rising samples in a row (>=15 s apart),
// at least 6 samples seen by the bot, and still >=3% under the high so there is room to rebound.
export const DIP_MIN_SAMPLES = 6;
export const DIP_BOUNCE_MIN = 0.015;
export const DIP_ROOM_BELOW_HIGH = 0.03;
export const DIP_KNIFE_MAX = -0.12;
export const DIP_MIN_BUY_RATIO = 1.1;
// Selection rules added 2026-11-24 (backtest + live review): never buy a token that is
// more than 30 % under its 24 h high (collapsing), require h1 >= 0 and h6 >= 0 at the
// moment of the buy, and no momentum (chasing) buys at all.
export const DIP_MAX_BELOW_24H_HIGH = -0.30;
export const MOMENTUM_ENABLED = false;
export const DIP_TRAIL_ACTIVATE = 0.05;
export const DIP_TRAIL_GIVEBACK = 0.025;
export const DIP_TIME_STOP_MS = 20 * 60 * 1000;
export const DIP_TIME_STOP_MIN_PNL = 0.03;
export const DIP_MAX_ROUND_TRIP = 0.02;
export const DIP_TP_BUFFER = 0.045;
export const DIP_MAX_TRADE_USD = 4.5;
export const DIP_MAX_ENTRIES_PER_TICK = 1;
export const DIP_WATCHLIST_SIZE = 20;
export const NET_FEE_LAMPORTS_PER_TX = 25_000;

// Master switch for NEW spot buys (open positions are always managed).
export const SPOT_ENTRIES_ENABLED = true;
export const STRATEGY_MODE = 'dip-rebound';
export const STRATEGY_BLURB_FR = "Le robot est devenu plus sélectif (règles du 24/11) : il n'achète plus jamais un jeton qui s'effondre. Il faut au moins 80 000 $ de liquidité, beaucoup d'échanges, un prix stable ou en hausse sur 1 heure ET sur 6 heures, plus d'acheteurs que de vendeurs (au moins 1,1 acheteur pour 1 vendeur), et un prix à moins de 30 % de son plus haut des dernières 24 heures. Il n'achète qu'après une petite baisse de 5 à 12 % suivie d'un rebond déjà confirmé. Plus aucun achat « coup de folie » (mode momentum, coupé). Il revend vers +6 à 7 %, coupe la perte à −5 %, refuse un échange dont les frais aller-retour dépassent 2 %, au plus 2 positions à la fois et 10 achats par jour. Un jeton qui a fait perdre est interdit pour 24 h. Il paie d'abord en CASH, garde un peu de SOL pour les frais, s'arrête pour la journée si le compte baisse de 18 % et surveille les prix toutes les 15 secondes. Moins d'achats qu'avant, mais mieux choisis : rien n'est garanti.";
export const RUGCHECK_CACHE_MS = 20 * 60 * 1000;

export const ALLOWED_DEX = new Set([
  'raydium',
  'raydium-clmm',
  'raydium-cpmm',
  'raydium-launchlab',
  'meteora',
  'meteora-dlmm',
  'meteora-damm',
  'pumpswap',
  'pumpfun',
  'orca',
  'whirlpool',
  'moonshot',
]);

export const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT]);

export const BASE_MINTS = new Set([
  SOL_MINT,
  USDC_MINT,
  USDT_MINT,
  CASH_MINT,
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  'bSo13r4TkiE4KumL71LsHTPpL2euVFx9icQjy2v1eFt',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMijf',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
