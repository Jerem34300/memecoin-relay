#!/usr/bin/env bash
# One bounded relay trading session. Secrets come from env; nothing sensitive is printed.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
W="${RUNNER_TEMP:-/tmp}/wallet-$$.json"
LOG="${RUNNER_TEMP:-/tmp}/relay-$$.log"
cleanup() { rm -f "$W"; }
trap cleanup EXIT
if [[ -z "${WALLET_KEY_JSON:-}" ]]; then echo "[relay] wallet secret missing"; exit 1; fi
printf '%s' "$WALLET_KEY_JSON" > "$W"
unset WALLET_KEY_JSON
export WALLET_PATH="$W" RELAY_MODE=1
mkdir -p data
rc=0
node src/bot.mjs > "$LOG" 2>&1 || rc=$?
# Public log: coordination lines and a short summary only (no balances, no amounts).
grep -E '\] \[(relay|coord)\]' "$LOG" | sed -E 's/^\[[^]]*\] //' || true
echo "[relay] ticks=$(grep -c 'tick_complete' "$LOG" || true) buys=$(grep -c '\] OPEN ' "$LOG" || true) sells=$(grep -c '\] CLOSE ' "$LOG" || true) tick_errors=$(grep -c 'tick error' "$LOG" || true) exit=$rc"
rm -f "$LOG"
exit "$rc"
