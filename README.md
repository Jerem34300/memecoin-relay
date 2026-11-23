# memecoin-relay

Backup runner for a small personal Solana trading bot. When the main computer is asleep,
this GitHub Actions workflow takes over for a few minutes at a time, with the same code and rules.

- Code only: no keys, no balances, no state in this repo. State lives in a private repo.
- Secrets (wallet key, Telegram) are GitHub Actions secrets, only exposed to `schedule` and
  `workflow_dispatch` runs of this repo (no pull_request triggers).
- Coordination: the main computer writes a heartbeat every minute; this relay only runs when the
  heartbeat is older than 8 minutes, and takes a lease with a compare-and-swap write, so the two
  never trade at the same time.

Not financial advice; personal experiment.
